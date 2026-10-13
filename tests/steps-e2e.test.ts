// End to end: a real ThemeBot Cloud (step routes wired, real clock) + the local factory driving a
// build with the FAKE Claude CLI (tests/fixtures/fake-claude.mjs — no AI, no Shopify, no network
// beyond 127.0.0.1). Proves: every step comes from the Cloud on stdin, no recipe text lands on disk
// (canaries), logs hold no raw prompts, transcript cleanup touches only this job's folder, resume
// continues at the right step, and a revoked account stops the next step cleanly.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RECIPE_DIR } from '../cloud/src/steps/recipe';
import { startStepsCloud, type StepsCloud } from '../cloud/tests/steps-harness';

type CloudClient = typeof import('../server/cloud-client');
type Convergence = typeof import('../server/factory/convergence');
type Scaffolder = typeof import('../server/factory/scaffolder');
type Runner = typeof import('../server/factory/runner');
type Progress = typeof import('../server/factory/progress');
type Db = typeof import('../server/db');
type Settings = typeof import('../server/factory/settings');

let t: StepsCloud;
let tmp: string;
let account: Awaited<ReturnType<StepsCloud['account']>>;
let client: CloudClient; let convergence: Convergence; let scaffolder: Scaffolder; let runner: Runner; let progress: Progress; let dbm: Db; let settings: Settings;
let reactSource: string;
const fakeLog = () => path.join(tmp, 'fake.log');
const fakeState = () => path.join(tmp, 'fake-state');
const projects = () => path.join(tmp, 'claude-config', 'projects');

/** Every canary embedded in the recipe, plus phrases only the recipe contains. */
async function recipeMarkers(): Promise<string[]> {
  // Not 'PROJECT IDENTITY CHECK': preflight writes that heading into qa/reports/identity.md on
  // purpose (it is the report's required format), so it is output, not a leak.
  const found = new Set<string>(['Header & footer — MANDATORY', 'Mandatory patterns — enforced', 'Section Completeness']);
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else for (const match of (await readFile(full, 'utf8')).matchAll(/tbr-canary-[0-9a-f]{12}/g)) found.add(match[0]);
    }
  };
  await walk(DEFAULT_RECIPE_DIR);
  return [...found];
}

/** Files under `root` whose text contains any marker. */
async function filesContaining(root: string, markers: string[]): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if ((await stat(full)).size > 5_000_000) continue;
      const text = await readFile(full, 'utf8');
      if (markers.some((marker) => text.includes(marker))) hits.push(path.relative(root, full));
    }
  };
  await walk(root);
  return hits;
}

async function fakeRuns(workspace: string) {
  const text = await readFile(fakeLog(), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>).filter((entry) => path.resolve(entry.cwd ?? '') === path.resolve(workspace));
}
const startsIn = async (workspace: string) => (await fakeRuns(workspace)).filter((entry) => entry.event === 'start');

async function waitFor(check: () => Promise<boolean> | boolean, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('timed out waiting');
}

async function newJob(name: string) {
  const job = await dbm.db.createFactoryJob({
    name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), workspace_path: path.join(tmp, 'builds', name.toLowerCase().replace(/[^a-z0-9]+/g, '_')),
    react_url: 'https://e2e-site.example.com', store_url: `https://${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.myshopify.com`,
    client_id_cipher: 'x', client_secret_cipher: 'x', storefront_password_cipher: null,
    prefix: 'ee', dev_theme_name: `${name} (dev)`, autoswap: false, auto_qa: false, qa_mode: 'both', qa_engine: 'playwright',
    max_iterations: 3, score_threshold: 0.92,
  });
  await scaffolder.scaffoldWorkspace({ job, clientId: 'a'.repeat(32), clientSecret: 'shpss_never_on_disk', reactFilesPath: reactSource });
  return job;
}

function control() {
  const abort = new AbortController();
  let kill: ((reason?: string) => void) | null = null;
  return {
    abort, stop: () => { abort.abort(); kill?.('killed'); },
    value: { signal: abort.signal, registerKill: (fn: ((reason?: string) => void) | null) => { kill = fn; } },
  };
}

beforeAll(async () => {
  t = await startStepsCloud({ clock: 'real' });
  tmp = await mkdtemp(path.join(tmpdir(), 'tb-steps-e2e-'));
  reactSource = path.join(tmp, 'react-src');
  await mkdir(path.join(reactSource, 'src', 'pages'), { recursive: true });
  await writeFile(path.join(reactSource, 'package.json'), '{"name":"e2e-site"}');
  await writeFile(path.join(reactSource, 'src', 'pages', 'HomePage.tsx'), 'export default () => null;');
  // The server under test reads these once, at import.
  process.env.THEMEBOT_CLOUD_URL = t.base;
  process.env.THEMEBOT_CLOUD_PUBKEY = t.publicKey;
  process.env.THEMEBOT_FAKE_CLAUDE = '1';
  process.env.FACTORY_CLAUDE_PATH = path.resolve('tests/fixtures/fake-claude.mjs');
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude-config');
  process.env.CLAUDE_FAKE_LOG = fakeLog();
  process.env.CLAUDE_FAKE_STATE = fakeState();
  process.env.CLAUDE_FAKE_DELAY_MS = '400';
  // Usage lines (recordBuild/recordStage) go to <workspace root>/.factory/usage.jsonl — keep them in
  // the test's temp folder, never the developer's real builds folder.
  process.env.FACTORY_WORKSPACE_ROOT = path.join(tmp, 'workspace-root');
  vi.resetModules();
  client = await import('../server/cloud-client');
  dbm = await import('../server/db');
  settings = await import('../server/factory/settings');
  scaffolder = await import('../server/factory/scaffolder');
  runner = await import('../server/factory/runner');
  progress = await import('../server/factory/progress');
  convergence = await import('../server/factory/convergence');
  account = await t.account('builder@example.com');
  expect(client.acceptPass(account.pass, { email: 'builder@example.com', plan: 'standard', seats: 3, expiresAt: null })).toBe(true);
  expect(convergence.recipeFromCloud()).toBe(true);
  await settings.updateFactorySettings({ pageConcurrency: 2, cloneModel: 'opus', secretScrub: true });
}, 60_000);

afterAll(async () => {
  for (const name of ['THEMEBOT_CLOUD_URL', 'THEMEBOT_CLOUD_PUBKEY', 'THEMEBOT_FAKE_CLAUDE', 'FACTORY_CLAUDE_PATH', 'CLAUDE_CONFIG_DIR', 'CLAUDE_FAKE_LOG', 'CLAUDE_FAKE_STATE', 'CLAUDE_FAKE_DELAY_MS', 'CLAUDE_FAKE_HANG', 'CLAUDE_FAKE_WAIT', 'FACTORY_WORKSPACE_ROOT']) delete process.env[name];
  await t?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('a ThemeBot Cloud build with the fake Claude CLI', () => {
  it('runs every step from the Cloud, leaves no recipe on disk and cleans only its own transcripts', async () => {
    const job = await newJob('Full Run Shop');
    const workspace = job.workspace_path;
    // Scaffold placed the plumbing, not the recipe.
    for (const file of ['push.mjs', 'pull.mjs', 'preflight.mjs', 'qa/lib.mjs', 'qa/bootstrap-theme.mjs', '.claude/settings.json']) expect(existsSync(path.join(workspace, file)), file).toBe(true);
    for (const file of ['.claude/commands/clone-theme.md', 'seed/CONVENTIONS.md', 'qa/factory/section-compare.mjs']) expect(existsSync(path.join(workspace, file)), file).toBe(false);

    // Decoys next to this job's transcript folder: they must survive.
    const slug = runner.transcriptSlug(workspace);
    await mkdir(path.join(projects(), 'C--some-other-project'), { recursive: true });
    await writeFile(path.join(projects(), 'C--some-other-project', 'keep.jsonl'), '{}');
    await mkdir(path.join(projects(), `${slug}-other`), { recursive: true });
    await writeFile(path.join(projects(), `${slug}-other`, 'keep.jsonl'), '{}');

    const run = control();
    await convergence.driveJob(job.id, run.value);
    const after = (await dbm.db.getFactoryJob(job.id))!;
    expect(after.status, after.status_detail ?? '').toBe('converged');
    expect(after.status_detail).toMatch(/Clone complete/);

    // Every step came from the Cloud, in order, with the prompt on stdin (never in argv).
    const starts = await startsIn(workspace);
    const order = starts.map((entry) => entry.step);
    expect(order.slice(0, 4)).toEqual(['preflight', 'inventory', 'bootstrap', 'store-setup']);
    expect(order.at(-1)).toBe('final');
    expect([...order].sort()).toEqual(['bootstrap', 'final', 'inventory', 'page-about', 'page-contact', 'page-home', 'preflight', 'store-setup', 'verify-about', 'verify-contact', 'verify-home']);
    for (const entry of starts) {
      expect(entry.stdinBytes, entry.step).toBeGreaterThan(1000);
      expect(entry.canaries.length, entry.step).toBeGreaterThan(0);
      expect(entry.noPersistence).toBe(true);
      expect(entry.argv.every((arg: string) => arg.length < 60 && !arg.includes('tbr-canary')), entry.argv.join(' ')).toBe(true);
    }
    // Models: the Cloud's per-step choice, capped at the user's tier (opus here).
    const modelOf = (step: string) => starts.find((entry) => entry.step === step)?.model;
    expect([modelOf('preflight'), modelOf('page-home'), modelOf('page-about'), modelOf('final')]).toEqual(['sonnet', 'opus', 'sonnet', 'haiku']);
    // Page steps ran side by side (pageConcurrency 2).
    const runs = await fakeRuns(workspace);
    const startedAt = (step: string) => runs.find((entry) => entry.event === 'start' && entry.step === step)!.at as number;
    const doneAt = (step: string) => runs.find((entry) => entry.event === 'done' && entry.step === step)!.at as number;
    const pageSteps = ['page-home', 'verify-home', 'page-about', 'verify-about', 'page-contact', 'verify-contact'];
    const overlapped = pageSteps.some((a) => pageSteps.some((b) => a !== b && startedAt(b) > startedAt(a) && startedAt(b) < doneAt(a)));
    expect(overlapped).toBe(true);

    // The Cloud's record agrees: every step done, each handed out once.
    const buildId = (await progress.readLocalBuild(workspace))!.buildId;
    const remote = await t.builds(account.pass, 'GET', `/${buildId}`);
    expect(remote.body.build.status).toBe('done');
    expect(remote.body.plan.every((entry: { status: string }) => entry.status === 'done')).toBe(true);
    expect(remote.body.history.filter((entry: { status: string }) => entry.status !== 'done')).toEqual([]);
    expect(remote.body.history).toHaveLength(11);

    // Nothing from the recipe on disk: not in the workspace, not in the logs.
    const markers = await recipeMarkers();
    expect(markers.filter((marker) => marker.startsWith('tbr-canary')).length).toBeGreaterThanOrEqual(14);
    const planted = path.join(tmp, 'scanner-check');
    await mkdir(planted, { recursive: true });
    await writeFile(path.join(planted, 'leak.txt'), `x ${markers.find((marker) => marker.startsWith('tbr-canary'))} y`);
    expect(await filesContaining(planted, markers)).toEqual(['leak.txt']); // the scanner does find a leak
    expect(await filesContaining(workspace, markers)).toEqual([]);
    const logs = await readdir(path.join(workspace, 'factory', 'logs'));
    expect(logs).toEqual(expect.arrayContaining(['clone-0.log', 'clone-0.events.jsonl']));
    const log = await readFile(path.join(workspace, 'factory', 'logs', 'clone-0.log'), 'utf8');
    expect(log).toMatch(/\(prompt on stdin\)/);
    expect(log).toContain('Working on preflight.');
    expect(log).toContain('[About] Working on page-about.');
    expect(log).not.toContain('"type":"user"');
    const events = await readFile(path.join(workspace, 'factory', 'logs', 'clone-0.events.jsonl'), 'utf8');
    expect(events).toContain('Writing factory/steps/page-home.done');

    // Transcripts: every step's (prompt-holding) transcript was written, then deleted; this job's
    // folder is gone, the decoys are untouched.
    const transcripts = runs.filter((entry) => entry.event === 'transcript').map((entry) => entry.file as string);
    expect(transcripts).toHaveLength(11);
    expect(transcripts.every((file) => path.dirname(file) === path.join(projects(), slug))).toBe(true);
    expect(transcripts.filter((file) => existsSync(file))).toEqual([]);
    expect(existsSync(path.join(projects(), slug))).toBe(false);
    expect(existsSync(path.join(projects(), 'C--some-other-project', 'keep.jsonl'))).toBe(true);
    expect(existsSync(path.join(projects(), `${slug}-other`, 'keep.jsonl'))).toBe(true);

    // Progress: the real step model, finished.
    const summary = await progress.stepProgressSummary(workspace);
    expect(summary).toMatchObject({ done: 11, total: 11, step: null });
    expect(summary!.steps.map((entry) => entry.title)).toContain('Building page: About');
    const pages = await progress.pageProgress(workspace);
    expect(pages.pages.map((page) => [page.route, page.built, page.planned])).toEqual([['/', 5, 5], ['/about', 2, 2], ['/contact', 2, 2]]);

    // A fix round's prompt also comes from the Cloud, on stdin, and is never written down.
    const fix = await convergence.fixPromptFromCloud(after, 1, path.join('qa', 'reports', 'factory', 'qa-summary-1.md'), 4, true);
    expect(fix.prompt).toContain(path.join(workspace, 'qa', 'reports', 'factory', 'qa-summary-1.md'));
    expect(fix.prompt).toContain('REGRESSION WARNING');
    expect(fix.signal).toBe('qa/reports/fix-complete-1.md');
    const fixRun = runner.spawnFix(after, 1, true, {}, 'opus', fix.prompt);
    expect((await fixRun.result).outcome).toBe('sentinel');
    expect(existsSync(path.join(workspace, 'factory', 'fix-prompt-1.md'))).toBe(false);
    expect(await filesContaining(workspace, markers)).toEqual([]);
    await runner.removeWorkspaceTranscripts(workspace);
    expect(existsSync(path.join(projects(), slug))).toBe(false);
  }, 120_000);

  it('resumes after being killed mid-step at that step, without redoing finished ones', async () => {
    await settings.updateFactorySettings({ pageConcurrency: 1 });
    process.env.CLAUDE_FAKE_HANG = 'page-about';
    try {
      const job = await newJob('Resume Shop');
      const first = control();
      const running = convergence.driveJob(job.id, first.value);
      await waitFor(() => existsSync(path.join(fakeState(), 'hung-page-about')));
      const stepsMid = await progress.stepProgressSummary(job.workspace_path);
      expect(stepsMid?.step?.label).toBe('Building page: About');
      first.stop(); // what Pause does: abort + kill the running step(s)
      await running;
      expect((await dbm.db.getFactoryJob(job.id))!.status).toBe('cloning'); // (the scheduler sets 'paused')

      const second = control();
      await convergence.driveJob(job.id, second.value);
      const after = (await dbm.db.getFactoryJob(job.id))!;
      expect(after.status, after.status_detail ?? '').toBe('converged');
      const counts: Record<string, number> = {};
      for (const entry of await startsIn(job.workspace_path)) counts[entry.step] = (counts[entry.step] ?? 0) + 1;
      expect(counts).toEqual({ preflight: 1, inventory: 1, bootstrap: 1, 'store-setup': 1, 'page-home': 1, 'verify-home': 1, 'page-about': 2, 'verify-about': 1, 'page-contact': 1, 'verify-contact': 1, final: 1 });
      const buildId = (await progress.readLocalBuild(job.workspace_path))!.buildId;
      const history = (await t.builds(account.pass, 'GET', `/${buildId}`)).body.history as Array<{ step: string; status: string; attempt: number }>;
      expect(history.filter((entry) => entry.step === 'page:about').map((entry) => [entry.status, entry.attempt])).toEqual([['killed', 1], ['done', 2]]);
      expect(existsSync(path.join(projects(), runner.transcriptSlug(job.workspace_path)))).toBe(false);
    } finally {
      delete process.env.CLAUDE_FAKE_HANG;
      await settings.updateFactorySettings({ pageConcurrency: 2 });
    }
  }, 120_000);

  it('stops cleanly before the next step when the account is revoked mid-build', async () => {
    process.env.CLAUDE_FAKE_WAIT = 'store-setup';
    try {
      const job = await newJob('Revoked Shop');
      const run = control();
      const building = convergence.driveJob(job.id, run.value);
      await waitFor(() => existsSync(path.join(fakeState(), 'waiting-store-setup')));
      expect((await t.admin('POST', `/accounts/${account.accountId}/revoke`)).status).toBe(200);
      await writeFile(path.join(fakeState(), 'release-store-setup'), 'go');
      await building;
      const after = (await dbm.db.getFactoryJob(job.id))!;
      expect(after.status).toBe('blocked');
      expect(after.status_detail).toMatch(/plan is not active/i);
      const steps = (await startsIn(job.workspace_path)).map((entry) => entry.step);
      expect(steps).toEqual(['preflight', 'inventory', 'bootstrap', 'store-setup']);
      // The finished step's result couldn't be delivered; it is kept for the next request.
      const saved = await progress.readStepProgress(job.workspace_path);
      expect(saved?.state).toBe('blocked');
      expect(saved?.unacked).toEqual([{ id: 'store-setup', outcome: 'done' }]);
      expect(existsSync(path.join(job.workspace_path, 'factory', 'steps', 'store-setup.done'))).toBe(true);

      // Plan renewed → Resume: the undelivered result goes in first, so store setup is not redone.
      delete process.env.CLAUDE_FAKE_WAIT;
      expect((await t.admin('POST', `/accounts/${account.accountId}/restore`)).status).toBe(200);
      await convergence.driveJob(job.id, control().value);
      expect((await dbm.db.getFactoryJob(job.id))!.status).toBe('converged');
      const all = (await startsIn(job.workspace_path)).map((entry) => entry.step);
      expect(all.filter((step) => step === 'store-setup')).toHaveLength(1);
      expect(all.at(-1)).toBe('final');
      expect((await progress.readStepProgress(job.workspace_path))?.unacked).toEqual([]);
    } finally {
      delete process.env.CLAUDE_FAKE_WAIT;
      await t.admin('POST', `/accounts/${account.accountId}/restore`);
    }
  }, 120_000);

  it('stops on BLOCKED.md with its reason, and Resume reruns just that step', async () => {
    process.env.CLAUDE_FAKE_BLOCK = 'bootstrap';
    try {
      const job = await newJob('Blocked Shop');
      await convergence.driveJob(job.id, control().value);
      const blocked = (await dbm.db.getFactoryJob(job.id))!;
      expect(blocked.status).toBe('blocked');
      expect(blocked.status_detail).toMatch(/write_online_store_navigation/);
      delete process.env.CLAUDE_FAKE_BLOCK;
      await convergence.driveJob(job.id, control().value); // Resume: BLOCKED.md is cleared first
      expect((await dbm.db.getFactoryJob(job.id))!.status).toBe('converged');
      const counts: Record<string, number> = {};
      for (const entry of await startsIn(job.workspace_path)) counts[entry.step] = (counts[entry.step] ?? 0) + 1;
      expect([counts.preflight, counts.inventory, counts.bootstrap, counts['store-setup'], counts.final]).toEqual([1, 1, 2, 1, 1]);
    } finally {
      delete process.env.CLAUDE_FAKE_BLOCK;
    }
  }, 120_000);

  it('starts a new Cloud build on Rebuild, telling already-built pages to check instead of rewrite', async () => {
    const job = await newJob('Rebuild Shop');
    await convergence.driveJob(job.id, control().value);
    expect((await dbm.db.getFactoryJob(job.id))!.status).toBe('converged');
    const firstBuild = (await progress.readLocalBuild(job.workspace_path))!.buildId;

    // What the Rebuild button does: note the pages already built, then reset the run.
    expect(await progress.writeAlreadyBuilt((await dbm.db.getFactoryJob(job.id))!)).toEqual({ done: 3, total: 3 });
    const { FactoryScheduler } = await import('../server/factory/scheduler');
    await new FactoryScheduler(async () => {}).rebuild(job.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await convergence.driveJob(job.id, control().value);
    expect((await dbm.db.getFactoryJob(job.id))!.status).toBe('converged');

    expect((await progress.readLocalBuild(job.workspace_path))!.buildId).not.toBe(firstBuild);
    const starts = await startsIn(job.workspace_path);
    expect(starts).toHaveLength(22);
    const second = starts.slice(11);
    expect(second.filter((entry) => entry.rebuildNote).map((entry) => entry.step).sort()).toEqual(['page-about', 'page-contact', 'page-home']);
  }, 120_000);
});
