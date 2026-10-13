// ThemeBot Engine inside the factory: the runner starts it in place of the Claude Code CLI only when a
// build opted in (setting or THEMEBOT_BUILD_ENGINE), tracks it like a Claude session (activity,
// usage), enforces the per-build budget, and the build loop turns a budget stop into a blocked job.
// The engine plays back a scripted model (THEMEBOT_ENGINE_FAKE_SCRIPT) — no API call, no Shopify.
// Everything lives in this test's temp folder.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScriptedTurn } from '../engine/src/client';

type Runner = typeof import('../server/factory/runner');
type Db = typeof import('../server/db');
type Settings = typeof import('../server/factory/settings');
type Scaffolder = typeof import('../server/factory/scaffolder');
type Convergence = typeof import('../server/factory/convergence');

let tmp: string;
let runner: Runner; let dbm: Db; let settings: Settings; let scaffolder: Scaffolder; let convergence: Convergence;
const ENV = ['THEMEBOT_CLOUD_URL', 'THEMEBOT_CLOUD_PUBKEY', 'THEMEBOT_FAKE_CLAUDE', 'FACTORY_CLAUDE_PATH', 'CLAUDE_CONFIG_DIR', 'CLAUDE_FAKE_LOG', 'CLAUDE_FAKE_STATE', 'FACTORY_WORKSPACE_ROOT', 'THEMEBOT_BUILD_ENGINE', 'THEMEBOT_ENGINE_BUDGET_USD', 'THEMEBOT_ENGINE_FAKE_SCRIPT', 'THEMEBOT_ENGINE_API_KEY'];
const savedEnv: Record<string, string | undefined> = {};
const root = () => path.join(tmp, 'workspace-root');

async function script(turns: ScriptedTurn[]) {
  const file = path.join(tmp, `script-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify(turns));
  process.env.THEMEBOT_ENGINE_FAKE_SCRIPT = file;
}

async function newJob(name: string, recipe: 'cloud' | 'local' = 'cloud') {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const job = await dbm.db.createFactoryJob({
    name, slug, workspace_path: path.join(tmp, 'builds', slug),
    react_url: 'https://engine-site.example.com', store_url: `https://${slug.replace(/_/g, '-')}.myshopify.com`,
    client_id_cipher: 'x', client_secret_cipher: 'x', storefront_password_cipher: null,
    prefix: 'en', dev_theme_name: `${name} (dev)`, autoswap: false, auto_qa: false, qa_mode: 'both', qa_engine: 'playwright',
    max_iterations: 3, score_threshold: 0.92,
  }, 'draft');
  await scaffolder.scaffoldWorkspace({ job, clientId: 'a'.repeat(32), clientSecret: 'shpss_never_on_disk', recipe });
  return job;
}
const preflight = { id: 'preflight', kind: 'preflight', title: 'Getting ready', prompt: 'Check things, then write `factory/steps/preflight.done`.', model: 'sonnet', signal: 'factory/steps/preflight.done' };

async function usageLines(): Promise<Array<Record<string, any>>> {
  const text = await readFile(path.join(root(), '.factory', 'usage.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
async function waitFor(check: () => Promise<boolean> | boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('timed out waiting');
}

beforeAll(async () => {
  for (const key of ENV) savedEnv[key] = process.env[key];
  tmp = await mkdtemp(path.join(tmpdir(), 'tb-engine-runner-'));
  delete process.env.THEMEBOT_CLOUD_URL; // the local recipe (no ThemeBot Cloud)
  delete process.env.THEMEBOT_CLOUD_PUBKEY;
  process.env.THEMEBOT_FAKE_CLAUDE = '1';
  process.env.FACTORY_CLAUDE_PATH = path.resolve('tests/fixtures/fake-claude.mjs');
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude-config');
  process.env.CLAUDE_FAKE_LOG = path.join(tmp, 'fake.log');
  process.env.CLAUDE_FAKE_STATE = path.join(tmp, 'fake-state');
  process.env.FACTORY_WORKSPACE_ROOT = root();
  for (const key of ['THEMEBOT_BUILD_ENGINE', 'THEMEBOT_ENGINE_BUDGET_USD', 'THEMEBOT_ENGINE_FAKE_SCRIPT', 'THEMEBOT_ENGINE_API_KEY']) delete process.env[key];
  vi.resetModules();
  dbm = await import('../server/db');
  settings = await import('../server/factory/settings');
  scaffolder = await import('../server/factory/scaffolder');
  runner = await import('../server/factory/runner');
  convergence = await import('../server/factory/convergence');
}, 60_000);

afterEach(() => { for (const key of ['THEMEBOT_BUILD_ENGINE', 'THEMEBOT_ENGINE_BUDGET_USD', 'THEMEBOT_ENGINE_FAKE_SCRIPT']) delete process.env[key]; });

afterAll(async () => {
  for (const key of ENV) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('choosing the engine', () => {
  it('without the opt-in, sessions still run on the Claude Code CLI', async () => {
    const job = await newJob('Default Engine Shop');
    const result = await runner.spawnStep(job, preflight, 'sonnet').result;
    expect(result.outcome).toBe('sentinel');
    const log = await readFile(path.join(job.workspace_path, 'factory', 'logs', 'clone-0.log'), 'utf8');
    expect(log).toContain(`spawn ${process.env.FACTORY_CLAUDE_PATH}`);
    expect(log).not.toContain('ThemeBot Engine');
    expect(existsSync(runner.engineLedgerPath(job.id))).toBe(false);
  }, 60_000);

  it('the setting opts in; an env choice wins while set but is never written into the saved settings', async () => {
    expect((await settings.getFactorySettings()).buildEngine).toBe('claude-code');
    await settings.updateFactorySettings({ buildEngine: 'themebot', engineBudgetUsd: 3 });
    expect(await settings.getFactorySettings()).toMatchObject({ buildEngine: 'themebot', engineBudgetUsd: 3 });
    process.env.THEMEBOT_BUILD_ENGINE = 'claude-code';
    process.env.THEMEBOT_ENGINE_BUDGET_USD = '7.5';
    expect(await settings.getFactorySettings()).toMatchObject({ buildEngine: 'claude-code', engineBudgetUsd: 7.5 });
    expect(settings.lockedFields()).toMatchObject({ buildEngine: true, engineBudgetUsd: true });
    await settings.updateFactorySettings({ buildEngine: 'themebot', concurrency: 2 }); // locked field ignored
    delete process.env.THEMEBOT_BUILD_ENGINE;
    delete process.env.THEMEBOT_ENGINE_BUDGET_USD;
    expect(await settings.getFactorySettings()).toMatchObject({ buildEngine: 'themebot', engineBudgetUsd: 3, concurrency: 2 });
    const base = settings.factoryDefaults();
    expect(settings.sanitizeSettings({ buildEngine: 'gpt' as never, engineBudgetUsd: -4 }, base)).toMatchObject({ buildEngine: 'claude-code', engineBudgetUsd: 0 });
    expect(settings.sanitizeSettings({ engineBudgetUsd: 1e9 }, base).engineBudgetUsd).toBe(2000);
    await settings.updateFactorySettings({ buildEngine: 'claude-code', engineBudgetUsd: settings.DEFAULT_ENGINE_BUDGET_USD });
  });
});

describe('a session on ThemeBot Engine', () => {
  it('runs a Cloud step to its signal file, with readable activity, exact usage and the build ledger', async () => {
    process.env.THEMEBOT_BUILD_ENGINE = 'themebot';
    await script([
      { content: [{ type: 'text', text: 'Writing the step signal.' }, { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'factory/steps/preflight.done', content: 'ok\n' } }], usage: { input_tokens: 1500, output_tokens: 200, cache_creation_input_tokens: 4000 } },
      { content: [{ type: 'text', text: 'Preflight done.' }], usage: { input_tokens: 80, output_tokens: 30, cache_read_input_tokens: 5500 } },
    ]);
    const job = await newJob('Engine Step Shop');
    const result = await runner.spawnStep(job, preflight, 'sonnet').result;
    expect(result.outcome).toBe('sentinel');
    const logs = path.join(job.workspace_path, 'factory', 'logs');
    const events = await readFile(path.join(logs, 'clone-0.events.jsonl'), 'utf8');
    expect(events).toContain('Session started (ThemeBot Engine · claude-sonnet-5-5)');
    expect(events).toContain('Writing factory/steps/preflight.done');
    expect(events).toContain('Preflight done.');
    const log = await readFile(path.join(logs, 'clone-0.log'), 'utf8');
    expect(log).toMatch(/spawn ThemeBot Engine -p --model sonnet --no-session-persistence --output-format stream-json --verbose \(prompt on stdin\)/);
    expect(log).not.toContain('Check things'); // a Cloud step's prompt never reaches the log

    // Exact cost: (1500+80)×2 + (200+30)×10 + 5500×0.2 + 4000×2.5 = 16,560 → $0.01656
    expect(await (await import('../engine/src/cost')).ledgerTotal(runner.engineLedgerPath(job.id))).toBeCloseTo(0.01656, 9);
    await waitFor(async () => (await usageLines()).some((line) => line.jobId === job.id));
    const entries = (await usageLines()).filter((line) => line.jobId === job.id && line.type === 'session');
    const tokens = entries.reduce((sum, line) => ({ input: sum.input + line.inputTokens, output: sum.output + line.outputTokens, read: sum.read + line.cacheReadTokens, write: sum.write + line.cacheWriteTokens }), { input: 0, output: 0, read: 0, write: 0 });
    expect(entries.every((line) => line.engine === 'themebot')).toBe(true);
    expect(tokens).toEqual({ input: 1580, output: 230, read: 5500, write: 4000 });
    expect(entries.reduce((sum, line) => sum + (line.estUsd ?? 0), 0)).toBeCloseTo(0.01656, 9);
  }, 60_000);

  it('a build that already spent its cap stops before the session starts', async () => {
    process.env.THEMEBOT_BUILD_ENGINE = 'themebot';
    process.env.THEMEBOT_ENGINE_BUDGET_USD = '2';
    await script([{ content: [{ type: 'text', text: 'never' }] }]);
    const job = await newJob('Spent Shop');
    await mkdir(path.dirname(runner.engineLedgerPath(job.id)), { recursive: true });
    await writeFile(runner.engineLedgerPath(job.id), `${JSON.stringify({ v: 1, usd: 2.5 })}\n`);
    const result = await runner.spawnFix(job, 1, true, {}, 'opus', 'Fix, then write `qa/reports/fix-complete-1.md`.').result;
    expect(result).toMatchObject({ outcome: 'budget', exitCode: null, detail: expect.stringMatching(/^Build budget reached: \$2\.50 of the \$2\.00 cap is spent/) });
    expect(existsSync(path.join(job.workspace_path, 'factory', 'logs', 'fix-1.events.jsonl'))).toBe(false);
  }, 60_000);

  it('needs an Anthropic key for a real session, and says where to add one', async () => {
    process.env.THEMEBOT_BUILD_ENGINE = 'themebot';
    const job = await newJob('Keyless Shop');
    const result = await runner.spawnStep(job, preflight, 'sonnet').result;
    expect(result).toMatchObject({ outcome: 'spawn_error', detail: expect.stringMatching(/needs an Anthropic API key/) });
  }, 60_000);

  it('a /clone-theme build that runs out of budget mid-session leaves the job blocked with the reason', async () => {
    process.env.THEMEBOT_BUILD_ENGINE = 'themebot';
    process.env.THEMEBOT_ENGINE_BUDGET_USD = '1';
    await script([
      // One expensive Opus turn ($0.904), after which less than a minimal request is left.
      { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'qa/state/inventory.json', content: '{}' } }], usage: { input_tokens: 1000, output_tokens: 45_000 } },
      { content: [{ type: 'text', text: 'never sent' }] },
    ]);
    const job = await newJob('Budget Clone Shop', 'local');
    await convergence.driveJob(job.id, { signal: new AbortController().signal, registerKill: () => {} });
    const after = (await dbm.db.getFactoryJob(job.id))!;
    expect(after.status, after.status_detail ?? '').toBe('blocked');
    expect(after.status_detail).toMatch(/^Build budget reached: \$0\.90 spent of the \$1\.00 cap/);
    expect(after.status_detail).toMatch(/Raise "Budget per build" in Settings, then press Resume\.$/);
    expect(existsSync(path.join(job.workspace_path, 'qa', 'state', 'inventory.json'))).toBe(true);
    const events = await readFile(path.join(job.workspace_path, 'factory', 'logs', 'clone-0.events.jsonl'), 'utf8');
    expect(events).toContain('Session started (ThemeBot Engine · claude-opus-5-5)');
  }, 60_000);
});
