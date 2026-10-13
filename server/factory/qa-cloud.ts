// QA scored by ThemeBot Cloud. The PC only CAPTURES evidence (templates/factory/qa-capture/
// capture.mjs: layout dumps, click inventories, click effects, page health, screenshots); the
// rubric — segmentation, alignment, click planning, verdicts, weights, the summary — runs in the
// Cloud (cloud/src/qa). Nothing from cloud/src/qa is imported here at runtime (types only), so no
// scoring code ships in the desktop app.
//
// Output is identical in place and shape to the local runQa (server/factory/qa.ts):
//   qa/reports/factory/sections-<iter>.{json,md}, interactions-<iter>.{json,md}, qa-summary-<iter>.md
//   qa/screenshots/factory/<iter>/<route>/{react,shopify}-{desktop,mobile}.png
// plus the raw evidence in qa/capture/factory/<iter>/ (kept for the current and previous round).
//
// Flow for one iteration:
//   sections:      capture sections  → POST /v1/qa/sections            → sections-N.json/.md
//   interactions:  capture inventory → POST /v1/qa/interactions/plan   → plan.json
//                  capture clicks    → POST /v1/qa/interactions/score  → interactions-N.json/.md
//   summary:       POST /v1/qa/summary (with the N-1 issues read from disk) → qa-summary-N.md
//
// When nothing could be captured (site down, password wall stuck, React blank) the Cloud says
// captureFailed: the reports are still written (the summary as qa-summary-N.capture-failed.md, so
// the round doesn't count as scored), then QaCaptureError is thrown so the job shows a failed check
// instead of a false 0% score.
import { spawn } from 'node:child_process';
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CalibrateResponse, ClickPlan, InteractionsReport, QaIssue, SectionsReport, SummaryResponse,
} from '../../cloud/src/qa/types';
import { cloudFetch, CloudRequestError } from '../cloud-client';
import { config } from '../config';
import type { FactoryJobRecord } from '../db';
import { killTree, ownProcessGroup } from '../platform/proc';
import { resourcePath } from '../runtime-paths';
import { decrypt } from '../security';
import { readLocalBuild } from './progress';
import { buildSpawnEnv, scrubSecrets } from './runner';
import { DEFAULT_SCORE_WEIGHTS, type FactorySettings, type QaResult, type QaSubscores } from './types';

/** Where capture.mjs lives (shipped with the app's templates; never copied into workspaces). */
export const QA_CAPTURE_DIR = resourcePath('templates', 'factory', 'qa-capture');

export type CloudPost = <T>(route: string, body: unknown) => Promise<T>;

/** Thrown after the reports are written when the Cloud could not score anything. */
export class QaCaptureError extends Error {
  constructor(message: string, readonly summaryPath: string) { super(message); }
}

// At most 2 capture browsers machine-wide (same budget as the local QA).
let qaSlots = 2;
const qaWaiters: Array<() => void> = [];
async function acquireQaSlot() {
  if (qaSlots > 0) { qaSlots--; return; }
  await new Promise<void>((resolve) => qaWaiters.push(resolve));
  qaSlots--;
}
function releaseQaSlot() { qaSlots++; qaWaiters.shift()?.(); }

export interface QaCloudOptions {
  workspace: string;
  reactBase: string;
  shopifyBase: string;
  storePassword: string | null;
  iteration: number;
  qaMode: string;
  headed: boolean;
  weights: { presence: number; text: number; interaction: number };
  jobName: string;
  scoreThreshold: number;
  /** Identifies the build to the Cloud: the step engine's build id (factory/steps/build.json), else the job id. */
  buildRef: string;
  /** Per capture run (each run is retried up to 3 times). */
  timeoutMin: number;
  signal?: AbortSignal;
  /** Cloud call; defaults to cloudFetch (attaches the pass). Tests inject their own. */
  post?: CloudPost;
  captureDir?: string;
  playwrightRoot?: string;
}

export interface QaCloudResult extends QaResult {
  captureFailed: boolean;
  /** Request body sizes per Cloud call, in bytes (for monitoring payload growth). */
  payloadBytes: Record<string, number>;
}

const reportsDirOf = (workspace: string) => path.join(workspace, 'qa', 'reports', 'factory');
const captureDirOf = (workspace: string, iteration: number) => path.join(workspace, 'qa', 'capture', 'factory', String(iteration));
const exists = (target: string) => access(target).then(() => true, () => false);

async function readJson<T>(target: string): Promise<T | null> {
  try { return JSON.parse(await readFile(target, 'utf8')) as T; } catch { return null; }
}

function runCapture(options: QaCloudOptions, args: string[], logPath: string, timeoutMin: number): Promise<void> {
  const { signal } = options;
  const script = path.join(options.captureDir ?? QA_CAPTURE_DIR, 'capture.mjs');
  const pwRoot = options.playwrightRoot ?? config.factory.playwrightRoot;
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.workspace, shell: false, windowsHide: true, detached: ownProcessGroup,
      // SECURITY: explicit allowlisted env (no process.env spread) — app secrets never reach the browser.
      env: buildSpawnEnv({
        REACT_BASE: options.reactBase,
        SHOPIFY_BASE: options.shopifyBase,
        STORE_PASSWORD: options.storePassword ?? '',
        ITER: String(options.iteration),
        PW_ROOT: pwRoot,
        FACTORY_PW_ROOT: pwRoot,
        QA_HEADED: options.headed ? '1' : '',
      }),
    });
    // A stopped capture (cancel / timeout) settles only once its browser tree has been told to stop:
    // a retry must not race the old capture's browser, and on quit the server must not exit before
    // taskkill is done (Windows) — its exit in between doesn't settle it.
    let stopping = false;
    const stop = (error: Error) => {
      if (stopping) return;
      stopping = true; done();
      void killTree(child).then(() => reject(error));
    };
    const onAbort = () => stop(new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop(new Error(`QA capture (${args[0]}) exceeded ${timeoutMin}m`)), timeoutMin * 60_000);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
    child.stdout?.on('data', (chunk: Buffer) => void appendFile(logPath, chunk).catch(() => {}));
    child.stderr?.on('data', (chunk: Buffer) => void appendFile(logPath, chunk).catch(() => {}));
    child.on('error', (error) => { if (stopping) return; done(); reject(error); });
    child.on('exit', (code) => { if (stopping) return; done(); code === 0 ? resolve() : reject(new Error(`QA capture (${args[0]}) exited ${code}`)); });
  });
}

/** Runs one capture (up to 3 attempts, never retrying a cancel) and returns the file it wrote. */
async function capture<T>(options: QaCloudOptions, mode: 'sections' | 'inventory' | 'clicks', logPath: string): Promise<T> {
  const target = path.join(captureDirOf(options.workspace, options.iteration), mode === 'clicks' ? 'effects.json' : `${mode}.json`);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (options.signal?.aborted) throw new Error('aborted');
    await rm(target, { force: true }).catch(() => {});
    try {
      await runCapture(options, [mode, String(options.iteration)], logPath, options.timeoutMin);
      const data = await readJson<T>(target);
      if (!data) throw new Error(`QA capture (${mode}) wrote no ${path.basename(target)}`);
      return data;
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || (error instanceof Error && error.message === 'aborted')) throw error;
      await appendFile(logPath, `[qa-cloud] capture ${mode} attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}\n`).catch(() => {});
    }
  }
  throw lastError;
}

const transient = (error: unknown) => error instanceof CloudRequestError && (error.status === 0 || error.status === 429 || error.status >= 500);

/** One Cloud call, retried on network trouble / 5xx (never on a refusal). Records the body size. */
async function callCloud<T>(options: QaCloudOptions, route: string, body: unknown, sizes: Record<string, number>, logPath: string): Promise<T> {
  const post = options.post ?? cloudFetch;
  const bytes = Buffer.byteLength(JSON.stringify(body));
  const key = route.replace(/^\/v1\/qa\//, '');
  sizes[key] = (sizes[key] ?? 0) + bytes;
  await appendFile(logPath, `[qa-cloud] POST ${route} (${(bytes / 1024).toFixed(1)} kB)\n`).catch(() => {});
  const delays = [2000, 5000];
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new Error('aborted');
    try { return await post<T>(route, body); } catch (error) {
      if (!transient(error) || attempt >= delays.length) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`ThemeBot Cloud could not score this check (${route}): ${message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

interface SectionsCapture { reactBase: string; shopifyBase: string; handles: Record<string, string>; handlesMissing: boolean; routes: unknown[] }
interface InventoryCapture { reactBase: string; shopifyBase: string; handles: Record<string, string>; routes: unknown[] }
interface EffectsCapture { effects: unknown[] }

const issueRef = (issue: QaIssue) => ({ kind: issue.kind, page: issue.page, title: issue.title });

/** Capture → Cloud scoring → reports, for one iteration. */
export async function runQaCloudPipeline(options: QaCloudOptions): Promise<QaCloudResult> {
  const { workspace, iteration } = options;
  const reportsDir = reportsDirOf(workspace);
  await mkdir(reportsDir, { recursive: true });
  await mkdir(path.join(workspace, 'factory', 'logs'), { recursive: true });
  const logPath = path.join(workspace, 'factory', 'logs', `qa-${iteration}.log`);
  const captureDir = captureDirOf(workspace, iteration);
  await rm(captureDir, { recursive: true, force: true }).catch(() => {}); // never score a previous run's evidence
  await mkdir(captureDir, { recursive: true });
  const sizes: Record<string, number> = {};
  const write = (name: string, data: string) => writeFile(path.join(reportsDir, name), data);

  const handlesMissing = !(await exists(path.join(workspace, 'qa', 'state', 'handles.json')));
  if (handlesMissing) {
    await appendFile(logPath, `[qa] WARNING: handles.json missing — falling back to heuristic route mapping; scores may be unreliable (expected at qa/state/handles.json)\n`).catch(() => {});
  }

  const runSections = options.qaMode !== 'interactions';
  const runInteractions = options.qaMode !== 'sections';

  let sections: SectionsReport | null = null;
  if (runSections) {
    const captured = await capture<SectionsCapture>(options, 'sections', logPath);
    const scored = await callCloud<{ report: SectionsReport; markdown: string }>(options, '/v1/qa/sections', {
      buildRef: options.buildRef, iter: iteration, reactBase: captured.reactBase, shopifyBase: captured.shopifyBase, routes: captured.routes,
    }, sizes, logPath);
    sections = scored.report;
    await write(`sections-${iteration}.json`, JSON.stringify(sections, null, 2));
    await write(`sections-${iteration}.md`, scored.markdown);
  }

  let interactions: InteractionsReport | null = null;
  // Nothing could be captured for sections (site down, password wall): the clicks would fail the
  // same way, so go straight to the summary, which reports the failed capture.
  if (runInteractions && !sections?.capture?.failed) {
    const inventory = await capture<InventoryCapture>(options, 'inventory', logPath);
    const { plan } = await callCloud<{ plan: ClickPlan }>(options, '/v1/qa/interactions/plan', {
      buildRef: options.buildRef, iter: iteration, handles: inventory.handles, routes: inventory.routes,
    }, sizes, logPath);
    await writeFile(path.join(captureDir, 'plan.json'), JSON.stringify(plan));
    const effects = plan.clicks.length ? (await capture<EffectsCapture>(options, 'clicks', logPath)).effects : [];
    const scored = await callCloud<{ report: InteractionsReport; markdown: string }>(options, '/v1/qa/interactions/score', {
      buildRef: options.buildRef, plan, effects, reactBase: inventory.reactBase, shopifyBase: inventory.shopifyBase,
    }, sizes, logPath);
    interactions = scored.report;
    await write(`interactions-${iteration}.json`, JSON.stringify(interactions, null, 2));
    await write(`interactions-${iteration}.md`, scored.markdown);
  }

  // Fixed-issue delta: the N-1 reports on disk are what the fixer worked from, so they are sent
  // (kind/page/title only). With neither on disk the Cloud falls back to its own record of N-1.
  let prevIssues: Array<Pick<QaIssue, 'kind' | 'page' | 'title'>> | null = null;
  if (iteration > 1) {
    const previousSections = runSections ? await readJson<SectionsReport>(path.join(reportsDir, `sections-${iteration - 1}.json`)) : null;
    const previousInteractions = runInteractions ? await readJson<InteractionsReport>(path.join(reportsDir, `interactions-${iteration - 1}.json`)) : null;
    if (previousSections || previousInteractions) prevIssues = [...(previousSections?.issues ?? []), ...(previousInteractions?.issues ?? [])].map(issueRef);
  }

  const summary = await callCloud<SummaryResponse>(options, '/v1/qa/summary', {
    buildRef: options.buildRef,
    iter: iteration,
    jobName: options.jobName,
    scoreThreshold: options.scoreThreshold,
    sections: sections ? { presence: sections.presence, text: sections.text, pages: sections.pages.map((page) => ({ route: page.route, status: page.status })), issues: sections.issues, ...(sections.capture ? { capture: sections.capture } : {}) } : null,
    interactions: interactions ? { interaction: interactions.interaction, issues: interactions.issues, ...(interactions.capture ? { capture: interactions.capture } : {}) } : null,
    prevIssues,
    weights: options.weights ?? DEFAULT_SCORE_WEIGHTS,
    handlesMissing,
  }, sizes, logPath);
  // A round that captured nothing gets its summary under its own name: qa-summary-N.md means "round N
  // was scored" (Resume continues after the newest one, and a Fix run fixes from it), so a failed
  // capture must not look like one — Resume runs round N again.
  const failedName = `qa-summary-${iteration}.capture-failed.md`;
  const summaryRelative = path.join('qa', 'reports', 'factory', summary.captureFailed ? failedName : `qa-summary-${iteration}.md`);
  await writeFile(path.join(workspace, summaryRelative), summary.summaryMarkdown);
  if (!summary.captureFailed) await rm(path.join(reportsDir, failedName), { force: true }).catch(() => {});
  await appendFile(logPath, `[qa-cloud] scored by ThemeBot Cloud: ${(summary.score * 100).toFixed(1)}% (${summary.issueCount} issue(s)); payload ${Object.entries(sizes).map(([route, bytes]) => `${route}=${(bytes / 1024).toFixed(1)}kB`).join(' ')}\n`).catch(() => {});
  await pruneOldCaptures(workspace, iteration);

  if (summary.captureFailed) {
    const reason = summary.breakdown.capture?.reason ?? 'nothing could be captured';
    throw new QaCaptureError(`QA capture failed — ${reason}. ${summary.captureProblems.slice(0, 3).map((problem) => `${problem.route} (${problem.site}): ${problem.problem}`).join('; ')}`.trim(), summaryRelative);
  }

  const subscores: QaSubscores = summary.subscores;
  return {
    score: summary.score,
    subscores,
    breakdown: summary.breakdown as unknown as Record<string, unknown>,
    summaryPath: summaryRelative,
    issueCount: summary.issueCount,
    captureFailed: false,
    payloadBytes: sizes,
  };
}

/** Keeps the raw evidence of this round and the previous one; older rounds are dropped. */
async function pruneOldCaptures(workspace: string, iteration: number) {
  const root = path.join(workspace, 'qa', 'capture', 'factory');
  let entries: string[] = [];
  try { entries = await readdir(root); } catch { return; }
  await Promise.all(entries.filter((name) => /^\d+$/.test(name) && Number(name) < iteration - 1)
    .map((name) => rm(path.join(root, name), { recursive: true, force: true }).catch(() => {})));
}

/**
 * Which build the Cloud files this round under (its fixed-since-last-round fallback is per build):
 * the Cloud build this job's run created (factory/steps/build.json — a Rebuild makes a new one, and
 * its rounds start again at 1), else the job id (a job checked without a Cloud build).
 */
export async function qaBuildRef(job: FactoryJobRecord): Promise<string> {
  const build = await readLocalBuild(job.workspace_path).catch(() => null);
  return build?.buildId && /^[A-Za-z0-9_.:-]{1,100}$/.test(build.buildId) ? build.buildId : job.id;
}

/** The pipeline options for one of this job's QA rounds (what runQaViaCloud runs). */
export async function qaCloudOptions(job: FactoryJobRecord, iteration: number, settings: FactorySettings, signal?: AbortSignal): Promise<QaCloudOptions> {
  return {
    workspace: job.workspace_path,
    reactBase: job.react_url,
    shopifyBase: `https://${new URL(job.store_url).host}`,
    storePassword: job.storefront_password_cipher ? decrypt(job.storefront_password_cipher) : null,
    iteration,
    qaMode: job.qa_mode,
    headed: job.qa_engine === 'headed',
    weights: settings.scoreWeights ?? DEFAULT_SCORE_WEIGHTS,
    jobName: job.name,
    scoreThreshold: job.score_threshold,
    buildRef: await qaBuildRef(job),
    timeoutMin: settings.qaTimeoutMin,
    signal,
  };
}

/** Drop-in for runQa (server/factory/qa.ts) when ThemeBot Cloud scores the QA. */
export async function runQaViaCloud(job: FactoryJobRecord, iteration: number, settings: FactorySettings, signal?: AbortSignal): Promise<QaResult> {
  const options = await qaCloudOptions(job, iteration, settings, signal);
  await acquireQaSlot();
  try {
    const { payloadBytes: _sizes, captureFailed: _failed, ...result } = await runQaCloudPipeline(options);
    return result;
  } finally {
    releaseQaSlot();
  }
}

// ---------- self-test ----------

export interface SelftestOutcome {
  ok: boolean;
  score: number | null;
  subscores: QaSubscores | null;
  log: string;
  error?: string;
}

const SELFTEST_TIMEOUT_MS = 5 * 60_000;

/**
 * The QA self-test with Cloud scoring: capture the known-good fixture pair locally, let the Cloud
 * score it. Same result shape as the local calibration (POST /api/factory/qa-selftest).
 */
export async function runSelftestViaCloud(options: { post?: CloudPost; captureDir?: string; playwrightRoot?: string; timeoutMs?: number } = {}): Promise<SelftestOutcome> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tb-qa-selftest-'));
  const outFile = path.join(dir, 'calibration.json');
  const script = path.join(options.captureDir ?? QA_CAPTURE_DIR, 'capture.mjs');
  const pwRoot = options.playwrightRoot ?? config.factory.playwrightRoot;
  const timeoutMs = options.timeoutMs ?? SELFTEST_TIMEOUT_MS;
  let output = '';
  const finish = (outcome: Omit<SelftestOutcome, 'log'>): SelftestOutcome => ({ ...outcome, log: scrubSecrets(output) });
  try {
    const exit = await new Promise<{ code: number | null; timedOut: boolean; error?: string }>((resolve) => {
      const child = spawn(process.execPath, [script, 'calibrate', outFile], {
        cwd: dir, shell: false, windowsHide: true, detached: ownProcessGroup,
        env: buildSpawnEnv({ PW_ROOT: pwRoot, FACTORY_PW_ROOT: pwRoot }),
      });
      const append = (chunk: Buffer) => { if (output.length < 64 * 1024) output += chunk.toString('utf8'); };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      const timer = setTimeout(() => { void killTree(child); resolve({ code: null, timedOut: true }); }, timeoutMs);
      child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, timedOut: false, error: error.message }); });
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, timedOut: false }); });
    });
    if (exit.timedOut) return finish({ ok: false, score: null, subscores: null, error: `QA self-test exceeded ${timeoutMs / 60_000} minutes — Playwright/Chromium may not be installed (check GET /api/factory/browser).` });
    if (exit.error) return finish({ ok: false, score: null, subscores: null, error: `Could not launch the calibration capture: ${exit.error}` });
    const captured = await readJson<{ reference?: unknown; candidate?: unknown; mode?: string; error?: string }>(outFile);
    if (!captured || captured.error || !captured.reference) {
      return finish({ ok: false, score: null, subscores: null, error: captured?.error ? `The calibration capture failed: ${captured.error.split('\n')[0]}` : `The calibration capture exited ${exit.code ?? 'n/a'} without a result — see log.` });
    }
    let result: CalibrateResponse;
    try { result = await (options.post ?? cloudFetch)<CalibrateResponse>('/v1/qa/calibrate', captured); }
    catch (error) { return finish({ ok: false, score: null, subscores: null, error: `ThemeBot Cloud could not score the self-test: ${error instanceof Error ? error.message : String(error)}` }); }
    const pct = (value: number | null | undefined) => (value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
    output += [
      '',
      `sections: reference=${result.sections?.reference ?? 0} candidate=${result.sections?.candidate ?? 0} matched=${result.sections?.matched ?? 0} (scored by ThemeBot Cloud)`,
      `subscore presence:    ${pct(result.subscores?.presence)}`,
      `subscore text:        ${pct(result.subscores?.text)}`,
      'subscore interaction: n/a (not exercised by calibration)',
      `composite score:      ${pct(result.score)} (threshold ${pct(result.threshold)})`,
      result.ok ? 'CALIBRATION PASSED: the QA scoring pipeline is healthy.' : `CALIBRATION FAILED: ${result.error ?? 'below threshold'}`,
      '',
    ].join('\n');
    return finish({ ok: result.ok, score: result.score, subscores: result.subscores, ...(result.ok ? {} : { error: result.error ?? 'Calibration score fell below the 0.95 threshold — the QA scoring pipeline is not trustworthy on this machine.' }) });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
