import { spawn } from 'node:child_process';
import { recordBuild, recordStage } from './engines';
import { access, appendFile, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config';
import { db, type FactoryJobRecord } from '../db';
import { decrypt } from '../security';
import { runQa } from './qa';
import { buildSpawnEnv, clearSignalFiles, cloneBlockerSignals, spawnClone, spawnFix, type RunHandle } from './runner';
import { trustWorkspace } from './scaffolder';
import { getFactorySettings } from './settings';
import type { FactorySettings } from './types';

const min = (minutes: number) => minutes * 60_000;

const PROMPT_TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates/factory/prompts/fix-session.md');

async function fileExists(target: string) { return access(target).then(() => true, () => false); }

/**
 * Post-convergence live swap (Task 2). The bundled /clone-theme command no longer publishes to
 * the live theme during the initial clone (that shipped an un-converged clone to customers and
 * the fix loop only ever pushed to the dev theme). Instead the swap happens HERE, exactly once,
 * after the QA↔fix loop converges — and only when the job opted into autoswap. Publishing the dev
 * theme (role=main) atomically makes the converged clone the live theme.
 */
async function publishDevThemeToLive(job: FactoryJobRecord): Promise<{ ok: boolean; detail: string }> {
  try {
    const clientId = decrypt(job.client_id_cipher);
    const clientSecret = decrypt(job.client_secret_cipher);
    const shop = new URL(job.store_url).host;
    const mintResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
    });
    if (!mintResponse.ok) return { ok: false, detail: `token mint HTTP ${mintResponse.status}` };
    const token = ((await mintResponse.json()) as { access_token: string }).access_token;
    const api = `https://${shop}/admin/api/${config.shopify.apiVersion}`;
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

    let devThemeId: number | undefined;
    try {
      const state = JSON.parse(await readFile(path.join(job.workspace_path, 'qa', 'state', 'theme.json'), 'utf8')) as { dev_theme_id?: number };
      devThemeId = state.dev_theme_id;
    } catch { /* fall through to name lookup */ }
    if (!devThemeId) {
      const list = (await (await fetch(`${api}/themes.json`, { headers })).json()) as { themes?: Array<{ id: number; name: string }> };
      devThemeId = list.themes?.find((theme) => theme.name === job.dev_theme_name)?.id;
    }
    if (!devThemeId) return { ok: false, detail: 'dev theme id not found (qa/state/theme.json missing and no name match)' };

    const publish = await fetch(`${api}/themes/${devThemeId}.json`, {
      method: 'PUT', headers, body: JSON.stringify({ theme: { id: devThemeId, role: 'main' } }),
    });
    if (!publish.ok) return { ok: false, detail: `publish HTTP ${publish.status}: ${(await publish.text()).slice(0, 150)}` };
    return { ok: true, detail: `dev theme ${devThemeId} published to live` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'unknown publish error' };
  }
}

/** Runs the guarded live swap when autoswap is on; returns a suffix for the converged status_detail. */
async function autoswapSuffix(job: FactoryJobRecord): Promise<string> {
  if (!job.autoswap) return '';
  // HARD GUARD: never publish an unverified clone. Intake (routes POST /jobs) rejects
  // autoswap without auto-QA, but a legacy or hand-edited job row could still carry the
  // combination — refuse here too so no code path can swap an un-QA'd clone to live.
  if (!job.auto_qa) return ' · autoswap SKIPPED: auto-QA is off, so this clone is unverified and will not be published live.';
  const result = await publishDevThemeToLive(job);
  return result.ok
    ? ` · Published to live (${result.detail}).`
    : ` · WARNING: autoswap to live FAILED — clone left on the dev theme (${result.detail}).`;
}

// --- Keep-BEST iteration (snapshot/restore of the dev theme across the QA<->fix loop) ---

const SNAPSHOT_TIMEOUT_MS = 10 * 60_000;
/** Restore the best iteration only when the final score fell below it by MORE than this. */
const BEST_RESTORE_EPSILON = 0.005;

/** Kill a snapshot node process and any children (plain kill orphans them on Windows). */
function killSnapshotTree(child: ReturnType<typeof spawn>) {
  if (child.pid == null || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, env: buildSpawnEnv() });
  else child.kill('SIGKILL');
}

/**
 * Run `node qa/snapshot.mjs <save|restore> <iter>` in the workspace (contract:
 * templates/factory/workspace/qa/snapshot.mjs — save captures the dev theme's installable
 * files to qa/state/theme-snapshots/iter-<n>/, restore pushes that snapshot back to the dev
 * theme). Bounded, output appended to the iteration log; failure is NON-FATAL — a missed
 * snapshot must never break the convergence loop — but always logged.
 */
async function runSnapshot(job: FactoryJobRecord, action: 'save' | 'restore', iteration: number, logPath: string): Promise<{ ok: boolean; detail: string }> {
  const log = (text: string) => appendFile(logPath, text).catch(() => {});
  const script = path.join(job.workspace_path, 'qa', 'snapshot.mjs');
  if (!(await fileExists(script))) {
    const detail = 'qa/snapshot.mjs not found in workspace';
    await log(`[factory ${new Date().toISOString()}] snapshot ${action} ${iteration} skipped: ${detail}\n`);
    return { ok: false, detail };
  }
  await log(`[factory ${new Date().toISOString()}] snapshot ${action} ${iteration}\n`);
  return new Promise((resolve) => {
    const finish = (ok: boolean, detail: string) => { void log(`[factory ${new Date().toISOString()}] snapshot ${action} ${iteration}: ${ok ? 'ok' : `FAILED — ${detail}`}\n`); resolve({ ok, detail }); };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(process.execPath, [script, action, String(iteration)], { cwd: job.workspace_path, shell: false, windowsHide: true, env: buildSpawnEnv() }); }
    catch (error) { finish(false, error instanceof Error ? error.message : 'spawn failed'); return; }
    let settled = false;
    const once = (ok: boolean, detail: string) => { if (!settled) { settled = true; clearTimeout(timer); finish(ok, detail); } };
    const timer = setTimeout(() => { killSnapshotTree(child); once(false, `timed out after ${SNAPSHOT_TIMEOUT_MS / 60_000}m`); }, SNAPSHOT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => void log(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => void log(chunk.toString('utf8')));
    child.on('error', (error) => once(false, error.message));
    child.on('exit', (code) => once(code === 0, `exited ${code ?? 'n/a'}`));
  });
}

/**
 * When a loop stops without converging and an earlier iteration scored meaningfully better
 * than the final one, push that iteration's theme snapshot back to the dev theme so the job
 * ends on its BEST state, not its last. Returns a status_detail suffix describing what happened.
 */
async function maybeRestoreBest(job: FactoryJobRecord, best: { iteration: number; score: number } | null, finalScore: number, finalIteration: number, logPath: string): Promise<string> {
  if (!best || best.iteration === finalIteration || best.score - finalScore <= BEST_RESTORE_EPSILON) return '';
  const result = await runSnapshot(job, 'restore', best.iteration, logPath);
  return result.ok
    ? ` · restored best iteration ${best.iteration} (score ${(best.score * 100).toFixed(1)}%) over final (score ${(finalScore * 100).toFixed(1)}%)`
    : ` · WARNING: best iteration ${best.iteration} scored ${(best.score * 100).toFixed(1)}% but its snapshot could not be restored (${result.detail}) — dev theme left on the final state`;
}

/**
 * keepIterations pruning (Task 3). Iteration artifacts (screenshots, QA/section/interaction
 * reports, per-iteration logs, fix prompts/sentinels) grew unbounded because keepIterations was
 * persisted but never consumed. After each iteration, drop artifacts for iterations older than the
 * keep window. The floor of 2 guarantees the previous iteration survives — runQa reads iter-1 for
 * its "fixed since last iteration" delta.
 */
async function pruneIterationArtifacts(job: FactoryJobRecord, keep: number, currentIteration: number, preserveSnapshotIteration: number | null = null) {
  const cutoff = currentIteration - Math.max(2, keep);
  if (cutoff < 1) return;
  const root = job.workspace_path;
  const factoryReports = path.join(root, 'qa', 'reports', 'factory');
  const logs = path.join(root, 'factory', 'logs');
  const targets: string[] = [];
  for (let n = 1; n <= cutoff; n++) {
    // Theme snapshots ride the same window, EXCEPT the best iteration's — it must survive
    // until the loop ends so keep-BEST restore can push it back to the dev theme.
    if (n !== preserveSnapshotIteration) targets.push(path.join(root, 'qa', 'state', 'theme-snapshots', `iter-${n}`));
    targets.push(
      path.join(root, 'qa', 'screenshots', 'factory', String(n)),
      path.join(factoryReports, `qa-summary-${n}.md`),
      path.join(factoryReports, `sections-${n}.md`),
      path.join(factoryReports, `sections-${n}.json`),
      path.join(factoryReports, `interactions-${n}.md`),
      path.join(factoryReports, `interactions-${n}.json`),
      path.join(root, 'qa', 'reports', `fix-complete-${n}.md`),
      path.join(logs, `qa-${n}.log`),
      path.join(logs, `fix-${n}.log`),
      path.join(root, 'factory', `fix-prompt-${n}.md`),
    );
  }
  await Promise.all(targets.map((target) => rm(target, { recursive: true, force: true }).catch(() => {})));
}

async function firstLines(target: string, count = 6) {
  try { return (await readFile(target, 'utf8')).split(/\r?\n/).filter(Boolean).slice(0, count).join(' | ').slice(0, 500); } catch { return ''; }
}

/** A run the user started by hand from the build panel: one check, or fix rounds (each fix is
 *  followed by a check). Both work from what is on disk and never re-run the first build step. */
export type RunMode = { kind: 'check' } | { kind: 'fix'; rounds: number };
export interface DriveControl { signal: AbortSignal; registerKill: (kill: ((reason?: string) => void) | null) => void; onUsageLimit?: () => void; mode?: RunMode; }

async function transition(jobId: string, status: string, detail: string | null = null, extra: Partial<FactoryJobRecord> = {}) {
  const job = await db.updateFactoryJob(jobId, { status, status_detail: detail, ...extra });
  // A finished build (converged / exhausted / failed / aborted / canceled) → one usage 'build' line.
  if (job && extra.finished_at) void recordBuild(job, null).catch(() => {});
  // Keep the clone-project mirror (kind='clone', linked by factory_job_id) in step with the
  // job on every lifecycle transition — cloning/qa/fixing/converged/exhausted/blocked/failed.
  // Best-effort: a mirror hiccup must never break the convergence loop itself.
  if (job) await db.syncCloneProjectFromJob(job).catch(() => {});
  return job;
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

    // Hand-started check / fix rounds: straight to the loop, never the first build step.
    if (control.mode) { await runConvergenceLoop(job, settings, control); return; }

    // --- Stage 1: initial clone (skipped when final.md already exists) ---
    const finalPath = path.join(job.workspace_path, 'qa', 'reports', 'final.md');
    // A blocked run can write final.md too ("run ended BLOCKED") — that is not a finished clone.
    // Only a final.md with no blocker file beside it, and not itself reporting a block, counts.
    const blockerLeft = (await Promise.all(cloneBlockerSignals(job).map(fileExists))).some(Boolean);
    const finalText = await readFile(finalPath, 'utf8').catch(() => null);
    const cloneDone = finalText !== null && !blockerLeft && !/status:\s*\**\s*(blocked|aborted)/i.test(finalText.slice(0, 1500));
    if (!cloneDone) {
      if (finalText !== null) await rm(finalPath, { force: true }).catch(() => {});
      // A prior blocked/aborted run leaves BLOCKED.md/ABORTED.md on disk; without clearing
      // them the signal poller would instantly re-settle the fresh CLI on the stale file,
      // making retry-after-block impossible. Clear before re-spawning.
      await clearSignalFiles(cloneBlockerSignals(job));
      await transition(job.id, 'cloning', 'Headless /clone-theme run in progress', { started_at: job.started_at ?? new Date().toISOString() });
      const iterationRow = await recordIteration(job, 0, 'clone', path.join('factory', 'logs', 'clone-0.log'));
      const outcome = await awaitRun(spawnClone(job, settings.secretScrub, { inactivityMs: min(settings.inactivityTimeoutMin), wallClockMs: min(settings.cloneTimeoutMin) }, settings.cloneModel), control);

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
      // Check rounds from before this clone compared an empty theme — set them aside, start over.
      const roundReports = path.join(job.workspace_path, 'qa', 'reports', 'factory');
      if (await fileExists(roundReports)) await rename(roundReports, `${roundReports}-before-clone-${Date.now()}`).catch(() => {});
      await db.updateFactoryJob(job.id, { score_history: [], last_score: null });
    }

    job = (await db.getFactoryJob(jobId))!;
    if (!job.auto_qa) {
      const swap = await autoswapSuffix(job);
      await transition(job.id, 'converged', `Clone complete — QA skipped (auto-QA off)${swap}`, { finished_at: new Date().toISOString() });
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
  // Keep-BEST: track the best-scoring iteration across the loop (seeded from persisted
  // history so resumed jobs keep their earlier best) — restored on a non-converged stop.
  let best: { iteration: number; score: number } | null = null;
  for (const entry of history) if (!best || entry.score > best.score) best = { iteration: entry.iter, score: entry.score };

  const lastDone = await lastCompletedQaIteration(job);
  const startIteration = lastDone + 1;
  const mode = control.mode;
  // The pass that ends the run: one check → that check; N fix rounds → the check after the Nth fix.
  let limit = mode?.kind === 'check' ? startIteration : mode?.kind === 'fix' ? startIteration + mode.rounds : job.max_iterations;
  let fixesDone = 0;
  const fixLabel = (iteration: number) => mode?.kind === 'fix' ? `Fix round ${++fixesDone} of ${mode.rounds}` : `Iteration ${iteration}/${job.max_iterations}`;
  // Fix rounds right after a check: the theme hasn't changed since, so fix from that report
  // instead of paying for (well, waiting on) the same check again.
  if (mode?.kind === 'fix' && lastDone > 0 && job.last_score != null) {
    const summaryPath = path.join('qa', 'reports', 'factory', `qa-summary-${lastDone}.md`);
    const checkedAt = await stat(path.join(job.workspace_path, summaryPath)).then((info) => info.mtimeMs, () => 0);
    if (checkedAt && (await newestThemeChange(job)) <= checkedAt) {
      const lastRow = (await db.listFactoryIterations(job.id)).filter((row) => row.kind === 'qa' && row.iteration === lastDone).at(-1);
      const issues = Number((lastRow?.breakdown as { issues?: number } | null)?.issues ?? 0);
      if (!(await runFixSession(job, lastDone, summaryPath, issues, false, settings, control, fixLabel(lastDone)))) return;
      limit = startIteration + mode.rounds - 1;
    }
  }
  // Retrying an already-exhausted job (all iterations used) would skip the loop entirely
  // and strand the job in the transient 'scaffolding' status. Give it more headroom so a
  // manual retry actually runs at least one more QA+fix pass.
  if (!mode && startIteration > job.max_iterations) {
    const bumped = job.max_iterations + Math.max(1, settings.defaultMaxIterations);
    await db.updateFactoryJob(job.id, { max_iterations: bumped });
    job = { ...job, max_iterations: bumped };
  }

  for (let iteration = startIteration; iteration <= limit; iteration++) {
    if (control.signal.aborted) return;

    // a) QA pass
    await transition(job.id, 'qa_running', mode ? 'Checking against your website' : `Iteration ${iteration}/${job.max_iterations} — running QA comparison`, { iteration });
    const qaRow = await recordIteration(job, iteration, 'qa', path.join('factory', 'logs', `qa-${iteration}.log`));
    let qa;
    try {
      const qaStarted = Date.now();
      try { qa = await runQa(job, iteration, settings, control.signal); }
      finally { void recordStage({ kind: `check ${iteration}`, jobId: job.id, jobName: job.name, durationMs: Date.now() - qaStarted, score: qa?.score ?? null, ok: qa != null }).catch(() => {}); }
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
    const scored = await db.updateFactoryJob(job.id, { last_score: qa.score, score_history: history });
    if (scored) await db.syncCloneProjectFromJob(scored).catch(() => {}); // mirror the fresh score immediately

    const qaLogPath = path.join(job.workspace_path, 'factory', 'logs', `qa-${iteration}.log`);

    // Keep-BEST bookkeeping: record every improvement. best_iteration/best_score are
    // nullable columns added alongside this feature — a missing column (older DB) must
    // never break the loop, hence the try/catch.
    if (!best || qa.score > best.score) {
      best = { iteration, score: qa.score };
      // Cast via unknown so this compiles whether or not the record type has the new fields yet.
      try { await db.updateFactoryJob(job.id, { best_iteration: iteration, best_score: qa.score } as unknown as Partial<FactoryJobRecord>); } catch { /* column may not exist yet */ }
    }

    // Bound disk growth: drop artifacts for iterations older than the keep window
    // (preserving the best iteration's theme snapshot for a potential restore).
    await pruneIterationArtifacts(job, settings.keepIterations, iteration, best?.iteration ?? null);

    // b) Exit conditions
    if (qa.score >= job.score_threshold) {
      const swap = await autoswapSuffix(job);
      await transition(job.id, 'converged', `Converged at ${(qa.score * 100).toFixed(1)}% after ${iteration} iteration(s)${swap}`, { finished_at: new Date().toISOString() });
      return;
    }
    if (regressionStreak >= 2) {
      const restoreNote = await maybeRestoreBest(job, best, qa.score, iteration, qaLogPath);
      await transition(job.id, 'exhausted', `Stopped: two consecutive score regressions (now ${(qa.score * 100).toFixed(1)}%) — manual review needed. Report: ${qa.summaryPath}${restoreNote}`, { finished_at: new Date().toISOString() });
      return;
    }
    if (settings.earlyStopOnNoProgress && history.length >= 3) {
      const [a, b, c] = history.slice(-3).map((entry) => entry.score);
      if (Math.abs(c - b) < settings.noProgressEpsilon && Math.abs(b - a) < settings.noProgressEpsilon) {
        const restoreNote = await maybeRestoreBest(job, best, qa.score, iteration, qaLogPath);
        await transition(job.id, 'exhausted', `Stopped: score stalled at ${(qa.score * 100).toFixed(1)}% for two iterations. Report: ${qa.summaryPath}${restoreNote}`, { finished_at: new Date().toISOString() });
        return;
      }
    }
    if (mode && iteration === limit) {
      // A hand-started check / fix run ends here, resting with the fresh score.
      await transition(job.id, 'checked', `${mode.kind === 'check' ? 'Checked' : `Checked after ${mode.rounds} fix round${mode.rounds === 1 ? '' : 's'}`} — ${(qa.score * 100).toFixed(1)}% match, ${qa.issueCount} difference${qa.issueCount === 1 ? '' : 's'} left`, { finished_at: new Date().toISOString() });
      return;
    }
    if (iteration === job.max_iterations) {
      const restoreNote = await maybeRestoreBest(job, best, qa.score, iteration, qaLogPath);
      await transition(job.id, 'exhausted', `Iterations exhausted at ${(qa.score * 100).toFixed(1)}% (< ${(job.score_threshold * 100).toFixed(0)}%). Report: ${qa.summaryPath}${restoreNote}`, { finished_at: new Date().toISOString() });
      return;
    }

    // c) Fix session (then the next pass re-checks)
    if (!(await runFixSession(job, iteration, qa.summaryPath, qa.issueCount, regressed, settings, control, fixLabel(iteration)))) return;
  }
}

/** One fix session for `iteration`'s check report. Returns false when the run must stop. */
async function runFixSession(job: FactoryJobRecord, iteration: number, summaryPath: string, issueCount: number, regressed: boolean, settings: FactorySettings, control: DriveControl, label: string): Promise<boolean> {
  const qaLogPath = path.join(job.workspace_path, 'factory', 'logs', `qa-${iteration}.log`);
  // Snapshot the scored dev-theme state BEFORE the fix session mutates it, so a later
  // keep-BEST restore can bring this exact state back. Non-fatal on failure (logged).
  await runSnapshot(job, 'save', iteration, qaLogPath);
  await transition(job.id, 'fixing', `${label} — fixing ${issueCount} issue(s)`);
  await renderFixPrompt(job, iteration, summaryPath, regressed);
  // Clear a prior run's sentinel so this fix session isn't instantly re-settled by it.
  await clearSignalFiles([path.join(job.workspace_path, 'qa', 'reports', `fix-complete-${iteration}.md`)]);
  const fixRow = await recordIteration(job, iteration, 'fix', path.join('factory', 'logs', `fix-${iteration}.log`));
  const outcome = await awaitRun(spawnFix(job, iteration, settings.secretScrub, { inactivityMs: min(settings.inactivityTimeoutMin), wallClockMs: min(settings.fixTimeoutMin) }, settings.cloneModel), control);
  if (outcome.outcome === 'killed') { await db.finishFactoryIteration(fixRow.id, 'killed'); return false; }
  if (outcome.outcome === 'spawn_error') {
    await db.finishFactoryIteration(fixRow.id, 'failed');
    await transition(job.id, 'failed', outcome.detail ?? 'Could not launch the AI for the fix session.', { error: outcome.detail ?? null, finished_at: new Date().toISOString() });
    return false;
  }
  if (outcome.outcome === 'usage_limit') {
    await db.finishFactoryIteration(fixRow.id, 'failed');
    await transition(job.id, 'blocked', 'Usage limit reached during fix session — retry later');
    control.onUsageLimit?.();
    return false;
  }
  if (outcome.outcome === 'timeout' || outcome.outcome === 'inactivity') {
    await db.finishFactoryIteration(fixRow.id, 'timed_out');
    await transition(job.id, 'blocked', `Fix session stalled: ${outcome.detail ?? outcome.outcome}`);
    return false;
  }
  // sentinel or exit-without-sentinel: proceed to re-QA either way — QA is the ground truth.
  await db.finishFactoryIteration(fixRow.id, outcome.outcome === 'sentinel' ? 'succeeded' : 'failed', { report_path: path.join('qa', 'reports', `fix-complete-${iteration}.md`) });
  return true;
}

/** Newest change to any theme file on disk (ms). */
async function newestThemeChange(job: FactoryJobRecord) {
  let newest = 0;
  for (const dir of ['layout', 'sections', 'blocks', 'snippets', 'templates', 'config', 'locales', 'assets']) {
    let names: string[] = [];
    try { names = await readdir(path.join(job.workspace_path, dir)); } catch { continue; }
    for (const name of names) newest = Math.max(newest, await stat(path.join(job.workspace_path, dir, name)).then((info) => info.mtimeMs, () => 0));
  }
  return newest;
}
