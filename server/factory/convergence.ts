import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { recordBuild, recordStage } from './engines';
import { access, appendFile, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { db, type FactoryJobRecord } from '../db';
import { decrypt } from '../security';
import { CloudPassError, CloudRequestError, cloudFetch, cloudRequired } from '../cloud-client';
import { runQa } from './qa';
import { QaCaptureError, runQaViaCloud } from './qa-cloud';
import { buildSpawnEnv, clearSignalFiles, cloneBlockerSignals, effectiveModel, modelCapNote, noteActivity, removeWorkspaceTranscripts, spawnClone, spawnFix, spawnStep, stepSignalPath, type CloudStep, type RunHandle } from './runner';
import { trustWorkspace } from './scaffolder';
import { getFactorySettings } from './settings';
import { readLocalBuild, readStepProgress, stepsDir, writeLocalBuild, writeStepProgress, type LocalBuild, type StepEntry, type StepProgress } from './progress';
import type { FactorySettings, RunResult } from './types';
import { resourcePath } from '../runtime-paths';
import { killTree, ownProcessGroup } from '../platform/proc';

const min = (minutes: number) => minutes * 60_000;

const PROMPT_TEMPLATE = resourcePath('templates', 'factory', 'prompts', 'fix-session.md');

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
  killTree(child);
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
    try { child = spawn(process.execPath, [script, action, String(iteration)], { cwd: job.workspace_path, shell: false, windowsHide: true, detached: ownProcessGroup, env: buildSpawnEnv() }); }
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
      path.join(factoryReports, `qa-summary-${n}.capture-failed.md`),
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
/** registerKill: the hook that stops whatever runs right now (resolves once the process trees were
 *  told to stop — the scheduler waits for that on quit, so nothing outlives the app). */
export interface DriveControl { signal: AbortSignal; registerKill: (kill: ((reason?: string) => void | Promise<void>) | null) => void; onUsageLimit?: () => void; mode?: RunMode; }

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
  // Paused / cancelled / quitting while this session was being set up: the stop already called the
  // (then empty) kill hook, so stop this session now instead of letting it run unwatched.
  if (control.signal.aborted) void handle.kill('killed');
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

    // --- Stage 1: the build. ThemeBot Cloud configured → the recipe arrives one step at a time;
    // otherwise (internal edition, dev) one headless /clone-theme session from the local templates.
    const built = recipeFromCloud() ? await runCloudBuild(job, settings, control) : await runLocalClone(job, settings, control);
    if (!built) return;

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

/** Check rounds from before this clone compared an empty theme — set them aside, start over. */
async function setAsideEarlierChecks(job: FactoryJobRecord) {
  const roundReports = path.join(job.workspace_path, 'qa', 'reports', 'factory');
  if (await fileExists(roundReports)) await rename(roundReports, `${roundReports}-before-clone-${Date.now()}`).catch(() => {});
  await db.updateFactoryJob(job.id, { score_history: [], last_score: null });
}

/**
 * Stage 1 without ThemeBot Cloud: one headless `claude -p /clone-theme` session (the bundled
 * command in .claude/commands). Skipped when final.md already exists. True = the clone is ready.
 */
async function runLocalClone(job: FactoryJobRecord, settings: FactorySettings, control: DriveControl): Promise<boolean> {
  const finalPath = path.join(job.workspace_path, 'qa', 'reports', 'final.md');
  // A blocked run can write final.md too ("run ended BLOCKED") — that is not a finished clone.
  // Only a final.md with no blocker file beside it, and not itself reporting a block, counts.
  const blockerLeft = (await Promise.all(cloneBlockerSignals(job).map(fileExists))).some(Boolean);
  const finalText = await readFile(finalPath, 'utf8').catch(() => null);
  const cloneDone = finalText !== null && !blockerLeft && !/status:\s*\**\s*(blocked|aborted)/i.test(finalText.slice(0, 1500));
  if (cloneDone) return true;

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
    return false;
  }

  if (outcome.outcome === 'aborted') {
    await db.finishFactoryIteration(iterationRow.id, 'failed');
    await transition(job.id, 'aborted', await firstLines(outcome.signalFile!) || 'Identity mismatch (ABORTED.md)', { finished_at: new Date().toISOString() });
    return false;
  }
  if (outcome.outcome === 'blocked') {
    await db.finishFactoryIteration(iterationRow.id, 'failed');
    await transition(job.id, 'blocked', await firstLines(outcome.signalFile!) || 'Blocked (BLOCKED.md)');
    return false;
  }
  if (outcome.outcome === 'usage_limit') {
    await db.finishFactoryIteration(iterationRow.id, 'failed');
    await transition(job.id, 'blocked', 'Usage limit reached — retry later');
    control.onUsageLimit?.();
    return false;
  }
  if (outcome.outcome === 'budget') {
    await db.finishFactoryIteration(iterationRow.id, 'failed');
    await transition(job.id, 'blocked', outcome.detail ?? 'Build budget reached');
    return false;
  }
  if (outcome.outcome === 'timeout' || outcome.outcome === 'inactivity') {
    await db.finishFactoryIteration(iterationRow.id, 'timed_out');
    await transition(job.id, 'blocked', `CLI stalled: ${outcome.detail ?? outcome.outcome}`);
    return false;
  }
  if (outcome.outcome === 'killed') {
    await db.finishFactoryIteration(iterationRow.id, 'killed');
    return false; // pause/cancel already set the job status
  }
  if (outcome.outcome !== 'final') {
    await db.finishFactoryIteration(iterationRow.id, 'failed');
    await transition(job.id, 'failed', outcome.detail ?? `Clone run exited (${outcome.exitCode ?? 'n/a'}) without writing final.md`, { error: outcome.detail ?? null, finished_at: new Date().toISOString() });
    return false;
  }
  await db.finishFactoryIteration(iterationRow.id, 'succeeded', { report_path: path.join('qa', 'reports', 'final.md') });
  await setAsideEarlierChecks(job);
  return true;
}

// --- Stage 1 with ThemeBot Cloud: the recipe one step at a time ----------------------------------
//
// The recipe never touches this computer's disk. For each step the Cloud hands out (after checking
// the pass and that this account owns the build) the prompt is piped into `claude -p` on stdin;
// the step ends when it writes its signal file (factory/steps/<id>.done), and the result goes back
// to the Cloud, which decides what comes next. Page steps run side by side (pageConcurrency). The
// Cloud keeps the step history, so Resume continues at the first unfinished step. After every step
// Claude Code's transcript for this workspace is deleted (the CLI also runs with
// --no-session-persistence); logs hold only the readable events, never the raw stream.

/** True when this server talks to ThemeBot Cloud (THEMEBOT_CLOUD_URL) — the recipe then comes from
 *  there. Not tied to the edition: an internal build with a Cloud configured uses it too. */
export const recipeFromCloud = () => cloudRequired;

type PlanEntry = { id: string; kind: string; title: string; status: StepEntry['status']; page?: string };
interface NextAnswer { step?: CloudStep; wait?: boolean; done?: boolean; blocked?: string; code?: string; plan?: PlanEntry[]; recipeVersion?: string }

/** What to tell the person when the Cloud said no (or couldn't be reached). */
function cloudProblem(error: unknown): string {
  // No usable pass while a build runs (its text is about starting builds — this one stopped).
  if (error instanceof CloudPassError) {
    if (error.code === 'OFFLINE') return "ThemeBot can't reach its servers, so the build paused before its next step. Check your internet connection, then press Resume.";
    if (error.code === 'SIGNED_OUT') return 'Sign in to ThemeBot again, then press Resume — the build carries on where it stopped.';
    return error.message;
  }
  if (error instanceof CloudRequestError) {
    switch (error.code) {
      case 'ACCOUNT_INACTIVE': return 'Your ThemeBot plan is not active, so the build stopped before its next step. Renew it, then press Resume.';
      case 'SIGNED_OUT': case 'PASS_REQUIRED': case 'PASS_INVALID': return 'Sign in to ThemeBot again, then press Resume — the build carries on where it stopped.';
      case 'PASS_EXPIRED': case 'OFFLINE': return "ThemeBot can't reach its servers, so the build paused before its next step. Check your internet connection, then press Resume.";
      case 'RATE_LIMITED': return 'ThemeBot Cloud asked the app to slow down. Press Resume in a few minutes.';
      case 'NOT_CONFIGURED': return 'ThemeBot Cloud is not configured for this copy of ThemeBot.';
      default: return `ThemeBot Cloud: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : 'ThemeBot Cloud could not be reached.';
}

const sameInstant = (a: unknown, b: unknown) => a != null && b != null && new Date(String(a)).getTime() === new Date(String(b)).getTime();

/** The page list from qa/state/inventory.json, in the compact shape POST /v1/builds/:id/pages takes. */
async function inventoryPages(workspace: string): Promise<Array<Record<string, unknown>> | null> {
  let raw: { pages?: unknown };
  try { raw = JSON.parse(await readFile(path.join(workspace, 'qa', 'state', 'inventory.json'), 'utf8')) as { pages?: unknown }; } catch { return null; }
  if (!Array.isArray(raw.pages)) return null;
  const str = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
  return raw.pages.filter((page): page is Record<string, unknown> => Boolean(page) && typeof page === 'object' && typeof (page as { route?: unknown }).route === 'string').slice(0, 200).map((page) => {
    const bands = Number(page.band_count ?? (Array.isArray(page.bands) ? page.bands.length : NaN));
    const model = page.model === 'opus' || page.model === 'sonnet' ? page.model : page.complexity === 'complex' ? 'opus' : page.complexity === 'simple' ? 'sonnet' : undefined;
    return {
      route: str(page.route, 200), name: str(page.name, 60), handle: str(page.shopify_handle ?? page.handle, 120),
      template: str(page.template ?? page.shopify_template, 120), file: str(page.react_file, 200),
      ...(Number.isInteger(bands) && bands > 0 ? { bands } : {}), ...(model ? { model } : {}), type: str(page.type, 20),
    };
  });
}

/** Creates the Cloud build for this job's run and resets the local step state. */
async function createCloudBuild(job: FactoryJobRecord, startedAt: string, keepSteps = false): Promise<LocalBuild> {
  // Old signal files would end the new build's steps the moment they start.
  if (!keepSteps) await rm(stepsDir(job.workspace_path), { recursive: true, force: true }).catch(() => {});
  // A Rebuild lists the pages already built: their page steps check them instead of rewriting.
  let rebuiltRoutes: string[] = [];
  try {
    const already = JSON.parse(await readFile(path.join(job.workspace_path, 'qa', 'state', 'already-built.json'), 'utf8')) as { pages?: Array<{ route?: unknown }> };
    rebuiltRoutes = withinBudget((already.pages ?? []).map((page) => page.route).filter((route): route is string => typeof route === 'string' && route.length <= 200).slice(0, 200));
  } catch { /* not a rebuild */ }
  const created = await cloudFetch<{ buildId: string; recipeVersion?: string; plan?: PlanEntry[] }>('/v1/builds', {
    name: job.name, prefix: job.prefix, storeHost: new URL(job.store_url).host, reactUrl: job.react_url,
    root: job.workspace_path, devThemeName: job.dev_theme_name, qaEngine: job.qa_engine, rebuiltRoutes,
  });
  const build: LocalBuild = { buildId: created.buildId, jobStartedAt: startedAt, createdAt: new Date().toISOString(), recipeVersion: created.recipeVersion ?? null, pagesHash: null };
  await writeLocalBuild(job.workspace_path, build);
  return build;
}

/** Uploads the inventory's pages whenever they changed since the last upload (chunked: the Cloud
 *  takes small bodies). The Cloud plans one build step and one check step per page. */
async function syncPages(job: FactoryJobRecord, build: LocalBuild): Promise<LocalBuild> {
  const pages = await inventoryPages(job.workspace_path);
  if (!pages?.length) return build;
  const hash = createHash('sha256').update(JSON.stringify(pages)).digest('hex').slice(0, 32);
  if (hash === build.pagesHash) return build;
  const chunks: Array<Array<Record<string, unknown>>> = [[]];
  let size = 0;
  for (const page of pages) {
    const bytes = JSON.stringify(page).length + 1;
    if (size + bytes > 12_000 && chunks[chunks.length - 1].length) { chunks.push([]); size = 0; }
    chunks[chunks.length - 1].push(page);
    size += bytes;
  }
  for (const [index, chunk] of chunks.entries()) await cloudFetch(`/v1/builds/${build.buildId}/pages`, { pages: chunk, replace: index === 0 });
  const next = { ...build, pagesHash: hash };
  await writeLocalBuild(job.workspace_path, next);
  return next;
}

/** Deletes Claude Code's transcripts for this job's workspace (never anything else). */
async function cleanTranscripts(job: FactoryJobRecord, sessionIds?: string[]) {
  await removeWorkspaceTranscripts(job.workspace_path, sessionIds ? { sessionIds } : {}).catch(() => []);
}

/** Step requests go through the Cloud's 16 kB JSON parser (measured after gzip is inflated), so
 *  everything this app sends to /v1/builds stays well under it: ~8 kB of lists per request. */
const STEP_BODY_BUDGET = 8 * 1024;

/** The results to deliver late with the next /next call: as many as fit the budget (at most 150). */
function unackedBatch(unacked: StepProgress['unacked']): StepProgress['unacked'] {
  const batch: StepProgress['unacked'] = [];
  let bytes = 0;
  for (const entry of unacked.slice(0, 150)) {
    bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes > STEP_BODY_BUDGET && batch.length) break;
    batch.push(entry);
  }
  return batch;
}

/** As many routes as fit the step-request budget (a Rebuild of a big site lists every built page). */
function withinBudget(routes: string[]): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const route of routes) {
    bytes += Buffer.byteLength(JSON.stringify(route)) + 1;
    if (bytes > STEP_BODY_BUDGET) break;
    kept.push(route);
  }
  return kept;
}

/** Page build and page check steps: the Cloud retries them, then skips just that page. */
const isPageStep = (step: CloudStep) => step.kind === 'page' || step.kind === 'verify' || /^(page|verify):/.test(step.id);

const STEP_OUTCOME: Record<RunResult['outcome'], string> = {
  sentinel: 'done', final: 'done', blocked: 'blocked', aborted: 'aborted', exit: 'failed',
  timeout: 'timeout', inactivity: 'inactivity', killed: 'killed', usage_limit: 'usage_limit', spawn_error: 'spawn_error',
  // ThemeBot Engine stopped at the build's budget cap: the Cloud knows it as a blocked step.
  budget: 'blocked',
};

/** Stage 1 on ThemeBot Cloud steps. True when the Cloud says every step is finished. */
async function runCloudBuild(job: FactoryJobRecord, settings: FactorySettings, control: DriveControl): Promise<boolean> {
  const workspace = job.workspace_path;
  const startedAt = job.started_at ?? new Date().toISOString();
  // Resume after a blocker: the old BLOCKED.md / ABORTED.md must not end the new run at once.
  await clearSignalFiles(cloneBlockerSignals(job));

  // Same run (Resume, a restart) → the same Cloud build, continuing at its first unfinished step.
  // A Rebuild resets started_at → a new build.
  let build: LocalBuild;
  try {
    const existing = await readLocalBuild(workspace);
    build = existing && sameInstant(existing.jobStartedAt, startedAt) ? existing : await createCloudBuild(job, startedAt);
  } catch (error) {
    if (control.signal.aborted) return false; // stopped meanwhile: the stop set the status
    await transition(job.id, 'blocked', cloudProblem(error), { started_at: startedAt });
    return false;
  }
  // Stopped while the Cloud build was being looked up / created: keep the status the stop set, but
  // remember the run's start so Resume continues this Cloud build instead of creating another.
  if (control.signal.aborted) { if (!job.started_at) await db.updateFactoryJob(job.id, { started_at: startedAt }); return false; }

  const session = randomUUID();
  const saved = await readStepProgress(workspace);
  const progress: StepProgress = saved?.buildId === build.buildId ? { ...saved, unacked: saved.unacked ?? [] } : { buildId: build.buildId, recipeVersion: build.recipeVersion, updatedAt: '', state: 'running', detail: null, steps: [], unacked: [] };
  progress.state = 'running';
  progress.detail = null;
  const running = new Map<string, { step: CloudStep; handle: RunHandle; ended: Promise<{ id: string; result: RunResult }> }>();
  const limit = Math.max(1, settings.pageConcurrency ?? 2);
  let ranSteps = 0;
  let recreated = false;

  const save = async (plan?: PlanEntry[]) => {
    if (plan) progress.steps = plan.map((entry) => ({ id: entry.id, kind: entry.kind, title: entry.title, status: entry.status, ...(entry.page ? { page: entry.page } : {}) }));
    progress.steps = progress.steps.map((entry) => (running.has(entry.id) ? { ...entry, status: 'running' as const } : entry.status === 'running' ? { ...entry, status: 'pending' as const } : entry));
    progress.updatedAt = new Date().toISOString();
    await writeStepProgress(workspace, progress).catch(() => {});
  };
  const describe = () => {
    const titles = [...running.values()].map((entry) => entry.step.title);
    const done = progress.steps.filter((entry) => entry.status === 'done').length;
    const where = progress.steps.length ? ` (${done} of ${progress.steps.length} steps done)` : '';
    return titles.length ? `${titles.slice(0, 2).join(' · ')}${titles.length > 2 ? ` +${titles.length - 2} more` : ''}${where}` : `Building with ThemeBot Cloud${where}`;
  };
  const report = async (stepId: string, outcome: string, detail?: string, later = false) => {
    try {
      if (later) throw new Error('deliver later');
      const answer = await cloudFetch<{ plan?: PlanEntry[] }>(`/v1/builds/${build.buildId}/result`, { stepId, outcome, session, ...(detail ? { detail: detail.slice(0, 400) } : {}) });
      await save(answer.plan);
    } catch {
      // Delivered with the next request instead (the Cloud would otherwise hand this step out again).
      // Meanwhile the local list shows how it ended (and a lost Cloud build can carry it over).
      progress.unacked.push({ id: stepId, outcome, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
      progress.steps = progress.steps.map((entry) => (entry.id !== stepId ? entry : { ...entry, status: outcome === 'done' ? 'done' : outcome === 'killed' ? 'pending' : 'failed' }));
      await save();
    }
  };
  const facts = async () => {
    const [blocked, aborted] = await Promise.all(cloneBlockerSignals(job).map((file) => firstLines(file, 3)));
    const present = async (...parts: string[]) => fileExists(path.join(workspace, ...parts));
    return {
      blocked: blocked || null, aborted: aborted || null,
      files: { inventory: await present('qa', 'state', 'inventory.json'), handles: await present('qa', 'state', 'handles.json'), images: await present('qa', 'state', 'images.json'), theme: await present('qa', 'state', 'theme.json'), bootstrap: await present('qa', 'state', 'bootstrap.json'), final: await present('qa', 'reports', 'final.md') },
    };
  };
  // A step handed out but never started (the build was stopped while the Cloud answered): its
  // "killed" goes with the next request, so the Cloud closes it.
  const notedCaps = new Set<string>();
  const notStarted = (step: CloudStep) => { progress.unacked.push({ id: step.id, outcome: 'killed', detail: 'stopped before it started' }); };
  const start = async (step: CloudStep) => {
    const signal = stepSignalPath(workspace, step.signal);
    if (signal) await clearSignalFiles([signal]);
    if (control.signal.aborted) { notStarted(step); return; }
    const model = effectiveModel(step.model, settings.cloneModel);
    // The user's model setting caps every step; say so once (per model it lowered) in the activity.
    const capNote = notedCaps.has(String(step.model)) ? null : modelCapNote(step.model, settings.cloneModel, step.kind === 'page' && step.model === 'opus' ? 'complex pages' : 'some steps');
    if (capNote) { notedCaps.add(String(step.model)); await noteActivity(workspace, capNote); }
    const handle = spawnStep(job, step, model, settings.secretScrub, { inactivityMs: min(settings.inactivityTimeoutMin), wallClockMs: min(settings.cloneTimeoutMin) });
    running.set(step.id, { step, handle, ended: handle.result.then((result) => ({ id: step.id, result })) });
    ranSteps += 1;
    await save();
    // Stopped during those awaits: the kill hook already ran — stop this one too, and leave the
    // status the stop set (paused / canceled / queued on quit) alone.
    if (control.signal.aborted) { void handle.kill('killed'); return; }
    await transition(job.id, 'cloning', describe());
  };

  if (control.signal.aborted) await db.updateFactoryJob(job.id, { started_at: startedAt });
  else await transition(job.id, 'cloning', 'Building with ThemeBot Cloud', { started_at: startedAt });
  const iterationRow = await recordIteration(job, 0, 'clone', path.join('factory', 'logs', 'clone-0.log'));
  const killAll = (reason?: string) => Promise.all([...running.values()].map((entry) => entry.handle.kill(reason))).then(() => {});
  control.registerKill(killAll);
  // Belt and braces: every stop aborts the signal, so steps that start after the kill hook ran
  // (or between two of its calls) are stopped too.
  const onAbort = () => { void killAll('killed'); };
  control.signal.addEventListener('abort', onAbort);

  let stop: { status: 'blocked' | 'aborted' | 'failed'; detail: string; iteration: 'failed' | 'timed_out'; usageLimit?: boolean } | null = null;
  let done = false;
  try {
    for (;;) {
      // 1. Fill the free slots — never while stopping, and never past a step that must run alone.
      let answer: NextAnswer | null = null;
      while (!stop && !control.signal.aborted && running.size < limit) {
        try {
          build = await syncPages(job, build);
          const finished = unackedBatch(progress.unacked);
          answer = await cloudFetch<NextAnswer>(`/v1/builds/${build.buildId}/next`, { session, running: [...running.keys()], finished, facts: await facts() });
          progress.unacked = progress.unacked.slice(finished.length);
        } catch (error) {
          if (control.signal.aborted) break; // stopped meanwhile: not a Cloud problem
          // The Cloud lost this build (e.g. its data was reset): start a new one once, carrying over
          // what is already done here (delivered or not) so those steps don't run again.
          if (error instanceof CloudRequestError && error.status === 404 && !recreated && running.size === 0) {
            recreated = true;
            try {
              build = await createCloudBuild(job, startedAt, true);
              progress.buildId = build.buildId;
              const doneIds = new Set([...progress.steps.filter((entry) => entry.status === 'done').map((entry) => entry.id), ...progress.unacked.filter((entry) => entry.outcome === 'done').map((entry) => entry.id)]);
              progress.unacked = [...doneIds].map((id) => ({ id, outcome: 'done' }));
              continue;
            } catch (retryError) { stop = { status: 'blocked', detail: cloudProblem(retryError), iteration: 'failed' }; break; }
          }
          stop = { status: 'blocked', detail: cloudProblem(error), iteration: 'failed' };
          break;
        }
        progress.recipeVersion = answer.recipeVersion ?? progress.recipeVersion;
        await save(answer.plan);
        if (answer.step) {
          if (control.signal.aborted) { notStarted(answer.step); await save(); break; }
          await start(answer.step);
          if (!answer.step.parallelGroup) break;
          continue;
        }
        if (answer.blocked && running.size === 0) stop = { status: answer.code === 'ABORTED' ? 'aborted' : 'blocked', detail: answer.blocked, iteration: 'failed' };
        break; // wait / done / blocked
      }

      if (running.size === 0) {
        if (!stop && !control.signal.aborted) {
          if (answer?.done) done = true;
          else stop = { status: 'blocked', detail: answer?.blocked ?? 'ThemeBot Cloud had no step to run. Press Resume to try again.', iteration: 'failed' };
        }
        break;
      }

      // 2. Wait for a running step to end, report it, then go round again.
      const ended = await Promise.race([...running.values()].map((entry) => entry.ended));
      const entry = running.get(ended.id)!;
      running.delete(ended.id);
      // Transcripts: just this session's while other steps still run in the same folder.
      const sessionId = entry.handle.sessionId();
      await cleanTranscripts(job, running.size ? (sessionId ? [sessionId] : []) : undefined);
      const { result } = ended;
      let outcome = STEP_OUTCOME[result.outcome] ?? 'failed';
      let detail = result.outcome === 'blocked' || result.outcome === 'aborted'
        ? await firstLines(result.signalFile!, 3)
        : result.detail ?? (outcome === 'failed' ? `ended (exit ${result.exitCode ?? 'n/a'}) without writing ${entry.step.signal}` : undefined);
      if (result.outcome === 'timeout' || result.outcome === 'inactivity') {
        // Make sure the stalled session is gone before anything runs in its place.
        await entry.handle.kill(result.outcome);
        // A page (or its check) that ran out of time is one failed try: the Cloud hands it out again
        // and, after its tries, skips just that page — the other pages carry on. Core steps (and the
        // final one) can't be skipped, so for them it still stops the build.
        if (isPageStep(entry.step)) { outcome = 'failed'; detail = `ran out of time: ${result.detail ?? result.outcome}`; }
      }
      // Stopped (pause, cancel, quit): no network on the way out — the result goes with the next run's
      // first request instead.
      await report(entry.step.id, outcome, detail, control.signal.aborted);
      if (outcome === 'done' || outcome === 'failed') { if (running.size && !control.signal.aborted) await transition(job.id, 'cloning', describe()); continue; }
      if (outcome === 'killed' || stop) continue; // paused/cancelled, or already stopping: let the rest end
      // Anything else stops the build once the steps still running have ended (no new ones start).
      if (result.outcome === 'aborted') stop = { status: 'aborted', detail: detail || 'Identity mismatch (ABORTED.md)', iteration: 'failed' };
      else if (result.outcome === 'blocked') stop = { status: 'blocked', detail: detail || 'Blocked (BLOCKED.md)', iteration: 'failed' };
      else if (result.outcome === 'usage_limit') stop = { status: 'blocked', detail: 'Usage limit reached — retry later', iteration: 'failed', usageLimit: true };
      else if (result.outcome === 'budget') stop = { status: 'blocked', detail: result.detail ?? 'Build budget reached', iteration: 'failed' };
      else if (result.outcome === 'spawn_error') stop = { status: 'failed', detail: result.detail ?? 'Could not launch the Claude CLI — check the path in Settings.', iteration: 'failed' };
      else stop = { status: 'blocked', detail: `CLI stalled: ${result.detail ?? result.outcome}`, iteration: 'timed_out' };
    }
  } catch (error) {
    // Something unexpected (e.g. the Cloud sent a step this app can't run): end like any other
    // stop — steps killed, step list saved, status set — instead of leaving "running" behind.
    stop = { status: 'failed', detail: error instanceof Error ? error.message : 'Unexpected error while building', iteration: 'failed' };
  } finally {
    control.signal.removeEventListener('abort', onAbort);
    // Never leave a step running behind an unexpected error.
    if (running.size) {
      await killAll('killed');
      await Promise.allSettled([...running.values()].map((entry) => entry.ended));
      running.clear();
    }
    control.registerKill(null);
    await cleanTranscripts(job);
  }

  progress.state = done ? 'done' : control.signal.aborted ? 'stopped' : 'blocked';
  progress.detail = stop?.detail ?? null;
  await save();
  if (control.signal.aborted) { await db.finishFactoryIteration(iterationRow.id, 'killed'); return false; } // pause/cancel set the status
  if (done) {
    await db.finishFactoryIteration(iterationRow.id, 'succeeded', { report_path: path.join('qa', 'reports', 'final.md') });
    // A run that built something replaces the theme the earlier checks compared against.
    if (ranSteps > 0) await setAsideEarlierChecks(job);
    return true;
  }
  const reason = stop ?? { status: 'blocked' as const, detail: 'The build stopped.', iteration: 'failed' as const };
  await db.finishFactoryIteration(iterationRow.id, reason.iteration);
  await transition(job.id, reason.status, reason.detail, reason.status === 'blocked' ? {} : { error: reason.status === 'failed' ? reason.detail : null, finished_at: new Date().toISOString() });
  if (reason.usageLimit) control.onUsageLimit?.();
  return false;
}

/** A fix round's prompt from ThemeBot Cloud (never written to disk). */
export async function fixPromptFromCloud(job: FactoryJobRecord, iteration: number, summaryPath: string, issueCount: number, regressed: boolean): Promise<{ prompt: string; model: string; signal: string }> {
  const ask = (build: LocalBuild) => cloudFetch<{ prompt: string; model: string; signal: string }>(`/v1/builds/${build.buildId}/fix`, {
    iter: iteration, summary: { reportPath: summaryPath.replace(/\\/g, '/'), issueCount, regressed },
  });
  const startedAt = job.started_at ?? new Date().toISOString();
  const build = (await readLocalBuild(job.workspace_path)) ?? await createCloudBuild(job, startedAt, true);
  try { return await ask(build); } catch (error) {
    if (error instanceof CloudRequestError && error.status === 404) return ask(await createCloudBuild(job, startedAt, true));
    throw error;
  }
}

/**
 * One QA pass. With ThemeBot Cloud this PC only captures the evidence and the Cloud scores it (the
 * scoring scripts don't ship); without it, the local scripts in qa/factory do everything. Same
 * result and the same report files either way. A Cloud capture that got nothing throws
 * QaCaptureError ("QA capture failed — …"), which the loop turns into a blocked check, never a 0%.
 */
export const checkAgainstSite = (job: FactoryJobRecord, iteration: number, settings: FactorySettings, signal?: AbortSignal) =>
  (cloudRequired ? runQaViaCloud : runQa)(job, iteration, settings, signal);

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
      try { qa = await checkAgainstSite(job, iteration, settings, control.signal); }
      finally { void recordStage({ kind: `check ${iteration}`, jobId: job.id, jobName: job.name, durationMs: Date.now() - qaStarted, score: qa?.score ?? null, ok: qa != null }).catch(() => {}); }
    } catch (error) {
      // A Cloud check that captured nothing still wrote its (capture-failed) summary: link it.
      await db.finishFactoryIteration(qaRow.id, 'failed', error instanceof QaCaptureError ? { report_path: error.summaryPath } : undefined);
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
  // The snapshot can take minutes: a pause/cancel meanwhile set the status — keep it.
  if (control.signal.aborted) return false;
  await transition(job.id, 'fixing', `${label} — fixing ${issueCount} issue(s)`);
  // ThemeBot Cloud builds get the fix prompt from the Cloud, on stdin; others render the local template.
  let cloudFix: { prompt: string; model: string } | null = null;
  if (recipeFromCloud()) {
    try { cloudFix = await fixPromptFromCloud(job, iteration, summaryPath, issueCount, regressed); }
    catch (error) {
      if (control.signal.aborted) return false;
      await transition(job.id, 'blocked', cloudProblem(error));
      return false;
    }
    if (control.signal.aborted) return false;
  } else {
    await renderFixPrompt(job, iteration, summaryPath, regressed);
  }
  // Clear a prior run's sentinel so this fix session isn't instantly re-settled by it.
  await clearSignalFiles([path.join(job.workspace_path, 'qa', 'reports', `fix-complete-${iteration}.md`)]);
  const fixRow = await recordIteration(job, iteration, 'fix', path.join('factory', 'logs', `fix-${iteration}.log`));
  const fixModel = cloudFix ? effectiveModel(cloudFix.model, settings.cloneModel) : settings.cloneModel;
  const capNote = cloudFix ? modelCapNote(cloudFix.model, settings.cloneModel, 'fix rounds') : null;
  if (capNote) await noteActivity(job.workspace_path, capNote, `fix-${iteration}`);
  const outcome = await awaitRun(spawnFix(job, iteration, settings.secretScrub, { inactivityMs: min(settings.inactivityTimeoutMin), wallClockMs: min(settings.fixTimeoutMin) }, fixModel, cloudFix?.prompt), control);
  if (cloudFix) {
    await cleanTranscripts(job);
    const buildId = (await readLocalBuild(job.workspace_path))?.buildId;
    // (Not on the way out of a pause/cancel/quit: no network after a stop.)
    if (buildId && !control.signal.aborted) await cloudFetch(`/v1/builds/${buildId}/result`, { stepId: `fix:${iteration}`, outcome: STEP_OUTCOME[outcome.outcome] ?? 'failed' }).catch(() => {});
  }
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
  if (outcome.outcome === 'budget') {
    await db.finishFactoryIteration(fixRow.id, 'failed');
    await transition(job.id, 'blocked', outcome.detail ?? 'Build budget reached during a fix session');
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
