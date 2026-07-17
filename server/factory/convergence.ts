import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, type FactoryJobRecord } from '../db';
import { runQa } from './qa';
import { clearSignalFiles, cloneBlockerSignals, spawnClone, spawnFix, type RunHandle } from './runner';
import { trustWorkspace } from './scaffolder';
import { getFactorySettings } from './settings';
import type { FactorySettings } from './types';

const min = (minutes: number) => minutes * 60_000;

const PROMPT_TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates/factory/prompts/fix-session.md');

async function fileExists(target: string) { return access(target).then(() => true, () => false); }

async function firstLines(target: string, count = 6) {
  try { return (await readFile(target, 'utf8')).split(/\r?\n/).filter(Boolean).slice(0, count).join(' | ').slice(0, 500); } catch { return ''; }
}

export interface DriveControl { signal: AbortSignal; registerKill: (kill: ((reason?: string) => void) | null) => void; onUsageLimit?: () => void; }

async function transition(jobId: string, status: string, detail: string | null = null, extra: Partial<FactoryJobRecord> = {}) {
  return db.updateFactoryJob(jobId, { status, status_detail: detail, ...extra });
}

async function awaitRun(handle: RunHandle, control: DriveControl) {
  control.registerKill(handle.kill);
  try { return await handle.result; } finally { control.registerKill(null); }
}

/** Highest iteration i for which qa-summary-<i>.md exists (resume-awareness). */
async function lastCompletedQaIteration(job: FactoryJobRecord) {
  try {
    const files = await readdir(path.join(job.workspace_path, 'qa', 'reports', 'factory'));
    const iterations = files.map((file) => /^qa-summary-(\d+)\.md$/.exec(file)?.[1]).filter(Boolean).map(Number);
    return iterations.length ? Math.max(...iterations) : 0;
  } catch { return 0; }
}

async function renderFixPrompt(job: FactoryJobRecord, iteration: number, summaryPath: string, regressed: boolean) {
  const template = await readFile(PROMPT_TEMPLATE, 'utf8');
  const banner = regressed
    ? '\n7. **REGRESSION WARNING:** the previous fix iteration LOWERED the match score. Re-read your previous edits in `seed/edits.log`, prefer restoring from `seed/.snapshots/` where your change broke something, and be conservative.'
    : '';
  const rendered = template
    .replaceAll('{{ITER}}', String(iteration))
    .replaceAll('{{NAME}}', job.name)
    .replaceAll('{{ROOT}}', job.workspace_path)
    .replaceAll('{{REACT_URL}}', job.react_url)
    .replaceAll('{{STORE_URL}}', job.store_url)
    .replaceAll('{{PREFIX}}', job.prefix)
    .replaceAll('{{REPORT_PATH}}', path.join(job.workspace_path, summaryPath))
    .replaceAll('{{REGRESSION_BANNER}}', banner);
  const promptPath = path.join(job.workspace_path, 'factory', `fix-prompt-${iteration}.md`);
  await writeFile(promptPath, rendered);
  return promptPath;
}

async function recordIteration(job: FactoryJobRecord, iteration: number, kind: string, logPath: string | null) {
  return db.createFactoryIteration({ job_id: job.id, iteration, kind, status: 'running', score: null, breakdown: null, report_path: null, log_path: logPath });
}

/**
 * The per-slot driver: scaffold -> clone -> (QA <-> fix)* -> converged/exhausted/blocked.
 * Scaffolding happens before queueing (routes) — this driver starts at the clone step and
 * is resume-aware: it inspects the workspace to skip completed stages on retry.
 */
export async function driveJob(jobId: string, control: DriveControl) {
  const settings = await getFactorySettings();
  let job = await db.getFactoryJob(jobId);
  if (!job) return;

  try {
    // Headless `claude -p` ignores the scoped allowlist unless the workspace is trusted.
    // Ensure it on every run (idempotent) so resumed jobs are covered too.
    await trustWorkspace(job.workspace_path);

    // --- Stage 1: initial clone (skipped when final.md already exists) ---
    const finalPath = path.join(job.workspace_path, 'qa', 'reports', 'final.md');
    if (!(await fileExists(finalPath))) {
      // A prior blocked/aborted run leaves BLOCKED.md/ABORTED.md on disk; without clearing
      // them the signal poller would instantly re-settle the fresh CLI on the stale file,
      // making retry-after-block impossible. Clear before re-spawning.
      await clearSignalFiles(cloneBlockerSignals(job));
      await transition(job.id, 'cloning', 'Headless /clone-theme run in progress', { started_at: job.started_at ?? new Date().toISOString() });
      const iterationRow = await recordIteration(job, 0, 'clone', path.join('factory', 'logs', 'clone-0.log'));
      const outcome = await awaitRun(spawnClone(job, settings.secretScrub, { inactivityMs: min(settings.inactivityTimeoutMin), wallClockMs: min(settings.cloneTimeoutMin) }), control);

      if (outcome.outcome === 'spawn_error') {
        await db.finishFactoryIteration(iterationRow.id, 'failed');
        await transition(job.id, 'failed', outcome.detail ?? 'Could not launch the Claude CLI — check the path in Settings.', { error: outcome.detail ?? null, finished_at: new Date().toISOString() });
        return;
      }

      if (outcome.outcome === 'aborted') {
        await db.finishFactoryIteration(iterationRow.id, 'failed');
        await transition(job.id, 'aborted', await firstLines(outcome.signalFile!) || 'Identity mismatch (ABORTED.md)', { finished_at: new Date().toISOString() });
        return;
      }
      if (outcome.outcome === 'blocked') {
        await db.finishFactoryIteration(iterationRow.id, 'failed');
        await transition(job.id, 'blocked', await firstLines(outcome.signalFile!) || 'Blocked (BLOCKED.md)');
        return;
      }
      if (outcome.outcome === 'usage_limit') {
        await db.finishFactoryIteration(iterationRow.id, 'failed');
        await transition(job.id, 'blocked', 'Usage limit reached — retry later');
        control.onUsageLimit?.();
        return;
      }
      if (outcome.outcome === 'timeout' || outcome.outcome === 'inactivity') {
        await db.finishFactoryIteration(iterationRow.id, 'timed_out');
        await transition(job.id, 'blocked', `CLI stalled: ${outcome.detail ?? outcome.outcome}`);
        return;
      }
      if (outcome.outcome === 'killed') {
        await db.finishFactoryIteration(iterationRow.id, 'killed');
        return; // pause/cancel already set the job status
      }
      if (outcome.outcome !== 'final') {
        await db.finishFactoryIteration(iterationRow.id, 'failed');
        await transition(job.id, 'failed', outcome.detail ?? `Clone run exited (${outcome.exitCode ?? 'n/a'}) without writing final.md`, { error: outcome.detail ?? null, finished_at: new Date().toISOString() });
        return;
      }
      await db.finishFactoryIteration(iterationRow.id, 'succeeded', { report_path: path.join('qa', 'reports', 'final.md') });
    }

    job = (await db.getFactoryJob(jobId))!;
    if (!job.auto_qa) {
      await transition(job.id, 'converged', 'Clone complete — QA skipped (auto-QA off)', { finished_at: new Date().toISOString() });
      return;
    }

    // --- Stage 2: QA <-> fix convergence loop (resume past completed iterations) ---
    await runConvergenceLoop(job, settings, control);
  } catch (error) {
    if (control.signal.aborted) return;
    await transition(jobId, 'failed', error instanceof Error ? error.message : 'Unexpected factory error', { error: error instanceof Error ? error.message : String(error), finished_at: new Date().toISOString() });
  }
}

async function runConvergenceLoop(job: FactoryJobRecord, settings: FactorySettings, control: DriveControl) {
  const history = [...job.score_history];
  let regressionStreak = 0;

  const startIteration = (await lastCompletedQaIteration(job)) + 1;
  // Retrying an already-exhausted job (all iterations used) would skip the loop entirely
  // and strand the job in the transient 'scaffolding' status. Give it more headroom so a
  // manual retry actually runs at least one more QA+fix pass.
  if (startIteration > job.max_iterations) {
    const bumped = job.max_iterations + Math.max(1, settings.defaultMaxIterations);
    await db.updateFactoryJob(job.id, { max_iterations: bumped });
    job = { ...job, max_iterations: bumped };
  }

  for (let iteration = startIteration; iteration <= job.max_iterations; iteration++) {
    if (control.signal.aborted) return;

    // a) QA pass
    await transition(job.id, 'qa_running', `Iteration ${iteration}/${job.max_iterations} — running QA comparison`, { iteration });
    const qaRow = await recordIteration(job, iteration, 'qa', path.join('factory', 'logs', `qa-${iteration}.log`));
    let qa;
    try {
      qa = await runQa(job, iteration, settings, control.signal);
    } catch (error) {
      await db.finishFactoryIteration(qaRow.id, 'failed');
      if (control.signal.aborted) return; // user paused/canceled mid-QA — don't overwrite their status
      await transition(job.id, 'blocked', `QA failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return;
    }
    // QA can run for minutes; a cancel/pause during it must not be overwritten by the
    // transitions below (which would resurrect a canceled job or spawn a new fix CLI).
    if (control.signal.aborted) { await db.finishFactoryIteration(qaRow.id, 'killed'); return; }

    const previousScore = history.at(-1)?.score ?? null;
    const regressed = previousScore != null && qa.score < previousScore - 0.02;
    regressionStreak = regressed ? regressionStreak + 1 : 0;
    history.push({ iter: iteration, score: qa.score, at: new Date().toISOString() });
    await db.finishFactoryIteration(qaRow.id, regressed ? 'regressed' : 'succeeded', { score: qa.score, breakdown: qa.breakdown, report_path: qa.summaryPath });
    await db.updateFactoryJob(job.id, { last_score: qa.score, score_history: history });

    // b) Exit conditions
    if (qa.score >= job.score_threshold) {
      await transition(job.id, 'converged', `Converged at ${(qa.score * 100).toFixed(1)}% after ${iteration} iteration(s)`, { finished_at: new Date().toISOString() });
      return;
    }
    if (regressionStreak >= 2) {
      await transition(job.id, 'exhausted', `Stopped: two consecutive score regressions (now ${(qa.score * 100).toFixed(1)}%) — manual review needed. Report: ${qa.summaryPath}`, { finished_at: new Date().toISOString() });
      return;
    }
    if (settings.earlyStopOnNoProgress && history.length >= 3) {
      const [a, b, c] = history.slice(-3).map((entry) => entry.score);
      if (Math.abs(c - b) < settings.noProgressEpsilon && Math.abs(b - a) < settings.noProgressEpsilon) {
        await transition(job.id, 'exhausted', `Stopped: score stalled at ${(qa.score * 100).toFixed(1)}% for two iterations. Report: ${qa.summaryPath}`, { finished_at: new Date().toISOString() });
        return;
      }
    }
    if (iteration === job.max_iterations) {
      await transition(job.id, 'exhausted', `Iterations exhausted at ${(qa.score * 100).toFixed(1)}% (< ${(job.score_threshold * 100).toFixed(0)}%). Report: ${qa.summaryPath}`, { finished_at: new Date().toISOString() });
      return;
    }

    // c) Fix session
    await transition(job.id, 'fixing', `Iteration ${iteration}/${job.max_iterations} — fixing ${qa.issueCount} issue(s)`);
    await renderFixPrompt(job, iteration, qa.summaryPath, regressed);
    // Clear a prior run's sentinel so this fix session isn't instantly re-settled by it.
    await clearSignalFiles([path.join(job.workspace_path, 'qa', 'reports', `fix-complete-${iteration}.md`)]);
    const fixRow = await recordIteration(job, iteration, 'fix', path.join('factory', 'logs', `fix-${iteration}.log`));
    const outcome = await awaitRun(spawnFix(job, iteration, settings.secretScrub, { inactivityMs: min(settings.inactivityTimeoutMin), wallClockMs: min(settings.fixTimeoutMin) }), control);

    if (outcome.outcome === 'killed') { await db.finishFactoryIteration(fixRow.id, 'killed'); return; }
    if (outcome.outcome === 'spawn_error') {
      await db.finishFactoryIteration(fixRow.id, 'failed');
      await transition(job.id, 'failed', outcome.detail ?? 'Could not launch the Claude CLI for the fix session.', { error: outcome.detail ?? null, finished_at: new Date().toISOString() });
      return;
    }
    if (outcome.outcome === 'usage_limit') {
      await db.finishFactoryIteration(fixRow.id, 'failed');
      await transition(job.id, 'blocked', 'Usage limit reached during fix session — retry later');
      control.onUsageLimit?.();
      return;
    }
    if (outcome.outcome === 'timeout' || outcome.outcome === 'inactivity') {
      await db.finishFactoryIteration(fixRow.id, 'timed_out');
      await transition(job.id, 'blocked', `Fix session stalled: ${outcome.detail ?? outcome.outcome}`);
      return;
    }
    // sentinel or exit-without-sentinel: proceed to re-QA either way — QA is the ground truth.
    await db.finishFactoryIteration(fixRow.id, outcome.outcome === 'sentinel' ? 'succeeded' : 'failed', { report_path: path.join('qa', 'reports', `fix-complete-${iteration}.md`) });
  }
}
