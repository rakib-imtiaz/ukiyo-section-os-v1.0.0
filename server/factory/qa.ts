import { spawn } from 'node:child_process';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { decrypt } from '../security';
import type { FactoryJobRecord } from '../db';
import { buildSpawnEnv } from './runner';
import { DEFAULT_SCORE_WEIGHTS, type FactorySettings, type QaResult, type QaSubscores } from './types';

// Global semaphore: at most 2 Playwright QA processes machine-wide regardless of job concurrency.
let qaSlots = 2;
const qaWaiters: Array<() => void> = [];
async function acquireQaSlot() {
  if (qaSlots > 0) { qaSlots--; return; }
  await new Promise<void>((resolve) => qaWaiters.push(resolve));
  qaSlots--;
}
function releaseQaSlot() { qaSlots++; qaWaiters.shift()?.(); }

export interface QaIssue { id: string; kind: string; page: string; title: string; detail?: string; }
interface SectionsReport { presence: number; text: number; pages: Array<{ route: string; status: string }>; issues: QaIssue[]; }
interface InteractionsReport { interaction: number; issues: QaIssue[]; }

/** Kill a QA node process AND its Playwright/Chromium children (child.kill leaves them orphaned on Windows). */
function killQaTree(child: ReturnType<typeof spawn>) {
  if (child.pid == null || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, env: buildSpawnEnv() });
  else child.kill('SIGKILL');
}

function runScript(job: FactoryJobRecord, script: string, iteration: number, storefrontPassword: string | null, logPath: string, timeoutMin: number, signal?: AbortSignal) {
  return new Promise<number>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const child = spawn(process.execPath, [path.join('qa', 'factory', script), String(iteration)], {
      cwd: job.workspace_path, shell: false, windowsHide: true,
      // SECURITY: explicit env, no process.env spread — the QA scripts get exactly the
      // variables they read (see templates/factory/qa/*.mjs) plus the OS basics from the
      // allowlist. App secrets (encryption key, DB URL, Shopify secrets) never leak in.
      env: buildSpawnEnv({
        REACT_BASE: job.react_url,
        SHOPIFY_BASE: `https://${new URL(job.store_url).host}`,
        STORE_PASSWORD: storefrontPassword ?? '',
        ITER: String(iteration),
        PW_ROOT: config.factory.playwrightRoot,
        FACTORY_PW_ROOT: config.factory.playwrightRoot,
        // 'headed' engine launches a visible Chrome window so you can watch the QA click through.
        QA_HEADED: job.qa_engine === 'headed' ? '1' : '',
      }),
    });
    const onAbort = () => { killQaTree(child); reject(new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { killQaTree(child); reject(new Error(`${script} exceeded ${timeoutMin}m`)); }, timeoutMin * 60_000);
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.stdout?.on('data', (chunk: Buffer) => void appendFile(logPath, chunk).catch(() => {}));
    child.stderr?.on('data', (chunk: Buffer) => void appendFile(logPath, chunk).catch(() => {}));
    child.on('error', (error) => { done(); reject(error); });
    child.on('exit', (code) => { done(); code === 0 ? resolve(0) : reject(new Error(`${script} exited ${code}`)); });
  });
}

async function runWithRetries(job: FactoryJobRecord, script: string, iteration: number, password: string | null, logPath: string, timeoutMin: number, signal?: AbortSignal) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new Error('aborted');
    try { await runScript(job, script, iteration, password, logPath, timeoutMin, signal); return; } catch (error) {
      lastError = error;
      if (signal?.aborted || (error instanceof Error && error.message === 'aborted')) throw error; // don't retry a user cancel
    }
  }
  throw lastError;
}

async function readReport<T>(job: FactoryJobRecord, name: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path.join(job.workspace_path, 'qa', 'reports', 'factory', name), 'utf8')) as T; } catch { return null; }
}

export function compositeScore(subscores: QaSubscores, weights = DEFAULT_SCORE_WEIGHTS) {
  const parts: Array<[number, number]> = [];
  if (subscores.presence != null) parts.push([subscores.presence, weights.presence]);
  if (subscores.text != null) parts.push([subscores.text, weights.text]);
  if (subscores.interaction != null) parts.push([subscores.interaction, weights.interaction]);
  const totalWeight = parts.reduce((sum, [, weight]) => sum + weight, 0);
  if (!totalWeight) return 0;
  return parts.reduce((sum, [score, weight]) => sum + score * weight, 0) / totalWeight;
}

function issueKey(issue: QaIssue) { return `${issue.kind}|${issue.page}|${issue.title}`; }

function renderSummary(job: FactoryJobRecord, iteration: number, score: number, subscores: QaSubscores, issues: QaIssue[], fixedKeys: string[], unreachable: string[], handlesMissing: boolean) {
  const pct = (value: number | null) => value == null ? 'n/a' : `${Math.round(value * 100)}%`;
  const lines = [
    `# QA summary — iteration ${iteration} for ${job.name}`,
    '',
    `**Composite score: ${(score * 100).toFixed(1)}%** (threshold ${(job.score_threshold * 100).toFixed(0)}%)`,
    `Subscores — section presence: ${pct(subscores.presence)} · text match: ${pct(subscores.text)} · interactions: ${pct(subscores.interaction)}`,
    '',
  ];
  if (handlesMissing) {
    lines.push('> **WARNING:** `qa/state/handles.json` missing — falling back to heuristic route mapping; scores may be unreliable.', '');
  }
  if (fixedKeys.length) {
    lines.push(`## Fixed since last iteration (${fixedKeys.length})`, '');
    fixedKeys.forEach((key) => lines.push(`- ~~${key.split('|').slice(1).join(' — ')}~~`));
    lines.push('');
  }
  if (unreachable.length) {
    lines.push('## Unreachable routes (excluded from score)', '');
    unreachable.forEach((route) => lines.push(`- ${route}`));
    lines.push('');
  }
  lines.push(`## FIX THESE (${issues.length}, in priority order)`, '');
  if (!issues.length) lines.push('Nothing — all checks passed.');
  const priority: Record<string, number> = { missing_section: 0, missing_page: 1, structure_drift: 2, text_drift: 3, missing_interaction: 4, interaction_noop: 5, interaction_target: 6, extra_section: 7 };
  [...issues].sort((a, b) => (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9)).forEach((issue, index) => {
    lines.push(`${index + 1}. **[${issue.kind}]** \`${issue.page}\` — ${issue.title}${issue.detail ? `\n   ${issue.detail.replace(/\n/g, '\n   ')}` : ''}`);
  });
  lines.push('', '## Detail reports', '', `- Sections: \`qa/reports/factory/sections-${iteration}.md\``, `- Interactions: \`qa/reports/factory/interactions-${iteration}.md\``, `- Screenshots: \`qa/screenshots/factory/${iteration}/\``, '');
  return lines.join('\n');
}

/** Run the QA workflows for one iteration and render the fixer-facing summary. */
export async function runQa(job: FactoryJobRecord, iteration: number, settings: FactorySettings, signal?: AbortSignal): Promise<QaResult> {
  await acquireQaSlot();
  try {
    const reportsDir = path.join(job.workspace_path, 'qa', 'reports', 'factory');
    await mkdir(reportsDir, { recursive: true });
    const logPath = path.join(job.workspace_path, 'factory', 'logs', `qa-${iteration}.log`);
    const password = job.storefront_password_cipher ? decrypt(job.storefront_password_cipher) : null;
    const timeoutMin = settings.qaTimeoutMin;

    // Route mapping ground truth: without handles.json the QA scripts fall back to heuristic
    // React-route -> Shopify-path guessing, which silently skews scores. Say so, loudly.
    const handlesMissing = !(await access(path.join(job.workspace_path, 'qa', 'state', 'handles.json')).then(() => true, () => false));
    if (handlesMissing) {
      await appendFile(logPath, `[qa] WARNING: handles.json missing — falling back to heuristic route mapping; scores may be unreliable (expected at qa/state/handles.json)\n`).catch(() => {});
    }

    const runSections = job.qa_mode !== 'interactions';
    const runInteractions = job.qa_mode !== 'sections';
    if (runSections) await runWithRetries(job, 'section-compare.mjs', iteration, password, logPath, timeoutMin, signal);
    if (runInteractions) await runWithRetries(job, 'interaction-verify.mjs', iteration, password, logPath, timeoutMin, signal);

    const sections = runSections ? await readReport<SectionsReport>(job, `sections-${iteration}.json`) : null;
    const interactions = runInteractions ? await readReport<InteractionsReport>(job, `interactions-${iteration}.json`) : null;
    if (runSections && !sections) throw new Error('section-compare produced no JSON report');
    if (runInteractions && !interactions) throw new Error('interaction-verify produced no JSON report');

    const subscores: QaSubscores = {
      presence: sections?.presence ?? null,
      text: sections?.text ?? null,
      interaction: interactions?.interaction ?? null,
    };
    const score = compositeScore(subscores, settings.scoreWeights);
    const issues = [...(sections?.issues ?? []), ...(interactions?.issues ?? [])];

    // Delta vs previous iteration: which issue keys disappeared?
    let fixedKeys: string[] = [];
    if (iteration > 1) {
      const previousSections = runSections ? await readReport<SectionsReport>(job, `sections-${iteration - 1}.json`) : null;
      const previousInteractions = runInteractions ? await readReport<InteractionsReport>(job, `interactions-${iteration - 1}.json`) : null;
      const previousKeys = new Set([...(previousSections?.issues ?? []), ...(previousInteractions?.issues ?? [])].map(issueKey));
      const currentKeys = new Set(issues.map(issueKey));
      fixedKeys = [...previousKeys].filter((key) => !currentKeys.has(key));
    }

    const unreachable = (sections?.pages ?? []).filter((page) => page.status === 'unreachable').map((page) => page.route);
    const summaryRelative = path.join('qa', 'reports', 'factory', `qa-summary-${iteration}.md`);
    await writeFile(path.join(job.workspace_path, summaryRelative), renderSummary(job, iteration, score, subscores, issues, fixedKeys, unreachable, handlesMissing));

    return {
      score,
      subscores,
      // subscores ride inside breakdown so they persist per-iteration in factory_iterations
      // and surface through GET /jobs/:id for the UI to chart presence/text/interaction.
      breakdown: { issues: issues.length, fixed: fixedKeys.length, unreachable: unreachable.length, pages: sections?.pages?.length ?? 0, subscores, handlesMissing },
      summaryPath: summaryRelative,
      issueCount: issues.length,
    };
  } finally {
    releaseQaSlot();
  }
}
