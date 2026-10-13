// Lifecycle edges of a ThemeBot Cloud build, with the FAKE Claude CLI (tests/fixtures/fake-claude.mjs
// — no AI, no Shopify) and a real step Cloud behind a small pass-through proxy, so a test can act
// while a Cloud answer is on its way:
//   - a Pause that lands while the Cloud is handing out a step: the step never starts, the paused
//     status stays, and Resume carries on (the step is closed as "killed" first);
//   - a kill that lands before a session has started: the session never starts;
//   - a page step that runs out of time is one failed try (retried, the build carries on), while a
//     core step that runs out of time still stops the build;
//   - the activity says once when the user's model setting lowers a step's model.
// Everything lives in this test's temp folder (workspace root, Claude config, fake CLI state).
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startStepsCloud, type StepsCloud } from '../cloud/tests/steps-harness';
import type { RunTimeouts } from '../server/factory/runner';

type CloudClient = typeof import('../server/cloud-client');
type Convergence = typeof import('../server/factory/convergence');
type Scaffolder = typeof import('../server/factory/scaffolder');
type Runner = typeof import('../server/factory/runner');
type Progress = typeof import('../server/factory/progress');
type Db = typeof import('../server/db');
type Settings = typeof import('../server/factory/settings');
type Scheduler = typeof import('../server/factory/scheduler');

let t: StepsCloud;
let tmp: string;
let proxy: Server;
let account: Awaited<ReturnType<StepsCloud['account']>>;
let client: CloudClient; let convergence: Convergence; let scaffolder: Scaffolder; let runner: Runner; let progress: Progress; let dbm: Db; let settings: Settings; let scheduler: Scheduler;
let reactSource: string;
/** Runs (once) when the next POST /next reaches the proxy, before it is passed on. */
let onNext: (() => Promise<void> | void) | null = null;
/** Short step time limits for the time-out tests (null: the settings' own). */
let stepTimeouts: RunTimeouts | null = null;
const fakeLog = () => path.join(tmp, 'fake.log');

async function fakeRuns(workspace: string) {
  const text = await readFile(fakeLog(), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>).filter((entry) => path.resolve(entry.cwd ?? '') === path.resolve(workspace));
}
const startsIn = async (workspace: string) => (await fakeRuns(workspace)).filter((entry) => entry.event === 'start').map((entry) => entry.step as string);

async function waitFor(check: () => Promise<boolean> | boolean, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('timed out waiting');
}

async function newJob(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const job = await dbm.db.createFactoryJob({
    name, slug, workspace_path: path.join(tmp, 'builds', slug),
    react_url: 'https://e2e-site.example.com', store_url: `https://${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.myshopify.com`,
    client_id_cipher: 'x', client_secret_cipher: 'x', storefront_password_cipher: null,
    prefix: 'lc', dev_theme_name: `${name} (dev)`, autoswap: false, auto_qa: false, qa_mode: 'both', qa_engine: 'playwright',
    max_iterations: 3, score_threshold: 0.92,
  }, 'draft'); // a draft is never picked up by a scheduler — each test starts its own run
  await scaffolder.scaffoldWorkspace({ job, clientId: 'a'.repeat(32), clientSecret: 'shpss_never_on_disk', reactFilesPath: reactSource });
  return job;
}

function control() {
  const abort = new AbortController();
  let kill: ((reason?: string) => void | Promise<void>) | null = null;
  return { stop: () => { abort.abort(); void kill?.('killed'); }, value: { signal: abort.signal, registerKill: (fn: typeof kill) => { kill = fn; } } };
}

/** Each test its own fake-CLI state folder (the "hang once" markers live there). */
function freshFakeState(name: string) { process.env.CLAUDE_FAKE_STATE = path.join(tmp, `fake-state-${name}`); }

const ENV = ['THEMEBOT_CLOUD_URL', 'THEMEBOT_CLOUD_PUBKEY', 'THEMEBOT_FAKE_CLAUDE', 'FACTORY_CLAUDE_PATH', 'CLAUDE_CONFIG_DIR', 'CLAUDE_FAKE_LOG', 'CLAUDE_FAKE_STATE', 'CLAUDE_FAKE_DELAY_MS', 'CLAUDE_FAKE_HANG', 'FACTORY_WORKSPACE_ROOT'];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ENV) savedEnv[key] = process.env[key];
  t = await startStepsCloud({ clock: 'real' });
  tmp = await mkdtemp(path.join(tmpdir(), 'tb-steps-lifecycle-'));
  reactSource = path.join(tmp, 'react-src');
  await mkdir(path.join(reactSource, 'src', 'pages'), { recursive: true });
  await writeFile(path.join(reactSource, 'package.json'), '{"name":"lifecycle-site"}');
  await writeFile(path.join(reactSource, 'src', 'pages', 'HomePage.tsx'), 'export default () => null;');

  // The pass-through proxy in front of the step Cloud.
  proxy = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => void (async () => {
      try {
        if (onNext && /\/next$/.test(request.url ?? '')) { const hook = onNext; onNext = null; await hook(); }
        const headers: Record<string, string> = {};
        for (const name of ['authorization', 'content-type', 'content-encoding']) { const value = request.headers[name]; if (typeof value === 'string') headers[name] = value; }
        const upstream = await fetch(`${t.base}${request.url}`, { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
        response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        response.writeHead(502, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ code: 'PROXY', message: String(error) }));
      }
    })());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));

  // The server under test reads these once, at import.
  process.env.THEMEBOT_CLOUD_URL = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  process.env.THEMEBOT_CLOUD_PUBKEY = t.publicKey;
  process.env.THEMEBOT_FAKE_CLAUDE = '1';
  process.env.FACTORY_CLAUDE_PATH = path.resolve('tests/fixtures/fake-claude.mjs');
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude-config');
  process.env.CLAUDE_FAKE_LOG = fakeLog();
  process.env.CLAUDE_FAKE_DELAY_MS = '200';
  delete process.env.CLAUDE_FAKE_HANG;
  // Usage lines go to <workspace root>/.factory/usage.jsonl — this test's temp folder, never a real one.
  process.env.FACTORY_WORKSPACE_ROOT = path.join(tmp, 'workspace-root');
  freshFakeState('setup');
  vi.resetModules();
  // Step time limits are minutes long in the settings; the time-out tests shorten them here.
  vi.doMock('../server/factory/runner', async (importOriginal) => {
    const original = await importOriginal<Runner>();
    return { ...original, spawnStep: (...args: Parameters<Runner['spawnStep']>) => original.spawnStep(args[0], args[1], args[2], args[3], stepTimeouts ?? args[4]) };
  });
  client = await import('../server/cloud-client');
  dbm = await import('../server/db');
  settings = await import('../server/factory/settings');
  scaffolder = await import('../server/factory/scaffolder');
  runner = await import('../server/factory/runner');
  progress = await import('../server/factory/progress');
  convergence = await import('../server/factory/convergence');
  scheduler = await import('../server/factory/scheduler');
  account = await t.account('lifecycle@example.com');
  expect(client.acceptPass(account.pass, { email: 'lifecycle@example.com', plan: 'standard', seats: 3, expiresAt: null })).toBe(true);
  expect(convergence.recipeFromCloud()).toBe(true);
  await settings.updateFactorySettings({ pageConcurrency: 2, cloneModel: 'opus', secretScrub: true, concurrency: 1, launchStaggerSec: 0 });
}, 60_000);

afterAll(async () => {
  vi.doUnmock('../server/factory/runner');
  for (const key of ENV) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  if (proxy) { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); }
  await t?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('stopping a ThemeBot Cloud build at awkward moments', () => {
  it('Pause while the Cloud hands out a step: the step never starts, the job stays paused, Resume carries on', async () => {
    freshFakeState('pause');
    const job = await newJob('Pause Mid Answer Shop');
    await dbm.db.updateFactoryJob(job.id, { status: 'queued' });
    const queue = new scheduler.FactoryScheduler();
    // The user presses Pause while the first "what's next?" is on its way to the Cloud.
    let paused = false;
    onNext = async () => { await queue.stop(job.id, 'paused'); paused = true; };
    await queue.tick();
    await waitFor(async () => paused && (await progress.readStepProgress(job.workspace_path))?.state === 'stopped');

    const after = (await dbm.db.getFactoryJob(job.id))!;
    expect(after.status, after.status_detail ?? '').toBe('paused');
    expect(await startsIn(job.workspace_path)).toEqual([]); // the handed-out step never ran
    const saved = await progress.readStepProgress(job.workspace_path);
    expect(saved?.unacked).toEqual([{ id: 'preflight', outcome: 'killed', detail: 'stopped before it started' }]);

    // Resume: the Cloud hears the step was stopped, hands it out again, and the build finishes.
    await queue.retry(job.id);
    await waitFor(async () => (await dbm.db.getFactoryJob(job.id))!.status === 'converged');
    const steps = await startsIn(job.workspace_path);
    expect(steps.filter((step) => step === 'preflight')).toHaveLength(1);
    expect(steps.at(-1)).toBe('final');
    const buildId = (await progress.readLocalBuild(job.workspace_path))!.buildId;
    const history = (await t.builds(account.pass, 'GET', `/${buildId}`)).body.history as Array<{ step: string; status: string; attempt: number }>;
    expect(history.filter((entry) => entry.step === 'preflight').map((entry) => [entry.status, entry.attempt])).toEqual([['killed', 1], ['done', 2]]);
    await waitFor(() => !queue.isRunning(job.id));
  }, 120_000);

  it('a kill that lands before the session has started means it never starts', async () => {
    freshFakeState('early-kill');
    const job = await newJob('Early Kill Shop');
    const handle = runner.spawnStep(job, { id: 'preflight', kind: 'preflight', title: 'Getting ready', prompt: 'Write `factory/steps/preflight.done` when done.', model: 'sonnet', signal: 'factory/steps/preflight.done' }, 'sonnet');
    await handle.kill('killed'); // e.g. Pause in the instant between "start this step" and the process existing
    const result = await handle.result;
    expect(result).toMatchObject({ outcome: 'killed', detail: 'stopped before the session started' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await startsIn(job.workspace_path)).toEqual([]);
    expect(existsSync(path.join(job.workspace_path, 'factory', 'steps', 'preflight.done'))).toBe(false);
  }, 60_000);
});

describe('steps that run out of time', () => {
  it('a page step that runs out of time is one failed try: retried, and the build carries on', async () => {
    freshFakeState('page-timeout');
    process.env.CLAUDE_FAKE_HANG = 'page-about'; // hangs (still "thinking") the first time only
    stepTimeouts = { wallClockMs: 4000 };
    try {
      const job = await newJob('Slow Page Shop');
      await convergence.driveJob(job.id, control().value);
      const after = (await dbm.db.getFactoryJob(job.id))!;
      expect(after.status, after.status_detail ?? '').toBe('converged');
      const steps = await startsIn(job.workspace_path);
      expect(steps.filter((step) => step === 'page-about')).toHaveLength(2);
      expect(steps.at(-1)).toBe('final');
      const buildId = (await progress.readLocalBuild(job.workspace_path))!.buildId;
      const history = (await t.builds(account.pass, 'GET', `/${buildId}`)).body.history as Array<{ step: string; status: string; attempt: number; detail: string | null }>;
      const about = history.filter((entry) => entry.step === 'page:about');
      expect(about.map((entry) => [entry.status, entry.attempt])).toEqual([['failed', 1], ['done', 2]]);
      expect(about[0].detail).toMatch(/ran out of time: wall-clock cap/);
    } finally {
      delete process.env.CLAUDE_FAKE_HANG;
      stepTimeouts = null;
    }
  }, 120_000);

  it('a core step that runs out of time still stops the build', async () => {
    freshFakeState('core-timeout');
    process.env.CLAUDE_FAKE_HANG = 'bootstrap';
    stepTimeouts = { wallClockMs: 3000 };
    try {
      const job = await newJob('Slow Core Shop');
      await convergence.driveJob(job.id, control().value);
      const after = (await dbm.db.getFactoryJob(job.id))!;
      expect(after.status).toBe('blocked');
      expect(after.status_detail).toMatch(/CLI stalled: wall-clock cap/);
      expect(await startsIn(job.workspace_path)).toEqual(['preflight', 'inventory', 'bootstrap']);
    } finally {
      delete process.env.CLAUDE_FAKE_HANG;
      stepTimeouts = null;
    }
  }, 120_000);
});

describe('the model setting', () => {
  it('caps every step at the chosen model, and the activity says so once', async () => {
    freshFakeState('model-cap');
    await settings.updateFactorySettings({ cloneModel: 'sonnet' });
    try {
      const job = await newJob('Sonnet Only Shop');
      await convergence.driveJob(job.id, control().value);
      expect((await dbm.db.getFactoryJob(job.id))!.status).toBe('converged');
      const models = (await fakeRuns(job.workspace_path)).filter((entry) => entry.event === 'start').map((entry) => entry.model as string);
      expect(models).not.toContain('opus');
      const note = 'Using Sonnet for all steps (your setting) — complex pages normally use Opus.';
      const events = (await readFile(path.join(job.workspace_path, 'factory', 'logs', 'clone-0.events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; text: string });
      expect(events.filter((entry) => entry.text === note)).toEqual([{ at: expect.any(Number), kind: 'info', text: note }]);
      expect(await readFile(path.join(job.workspace_path, 'factory', 'logs', 'clone-0.log'), 'utf8')).toContain(note);
    } finally {
      await settings.updateFactorySettings({ cloneModel: 'opus' });
    }
  }, 120_000);
});
