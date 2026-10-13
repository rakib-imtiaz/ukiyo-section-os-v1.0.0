// Integration: the REAL ThemeBot Cloud app (cloud/src/app.ts with every router wired: accounts,
// seats, passes, the step engine with watermarked prompts, QA scoring, security) + the local
// factory driving a job in Cloud mode with the FAKE Claude CLI (tests/fixtures/fake-claude.mjs — no
// AI, no Shopify, nothing beyond 127.0.0.1).
//
//   1. Piracy drills (always run, ~20 s): no pass, cracked app / forged / expired / cross-account
//      passes, revoke mid-build + restore and Resume, minimum app version, seats + anomaly flags.
//   2. The full build (opt-in, drives real Chromium ~1-2 min):
//        INTEGRATION_E2E=1 npx vitest run tests/integration-e2e.test.ts
//      steps from /v1/builds (watermarked), QA captured on "the PC" against the Phase 3 fixture
//      sites and scored by the Cloud, a fix round from /fix, leak attribution of a 30% excerpt, and
//      a canary leak scan of everything the run left on disk.
//
// QA note: the job's store must be a *.myshopify.com host (the Cloud validates it), so the QA
// adapter is wrapped to point only the Shopify side at the local fixture "store"; everything else —
// its options (buildRef from factory/steps/build.json), capture.mjs, Chromium, the Cloud scoring —
// is the real code path.
import { existsSync, mkdtempSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCloud } from '../cloud/src/app';
import { loadConfig } from '../cloud/src/config';
import type { MailMessage } from '../cloud/src/mailer';
import { PASS_TTL_SEC, rawPublicKey, signPass } from '../cloud/src/passes';
import { recordSecurityEvent } from '../cloud/src/security';
import { DEFAULT_RECIPE_DIR } from '../cloud/src/steps/recipe';
import { stripZeroWidth } from '../cloud/src/watermark';
import { startFixtureSites, type FixtureSites } from './fixtures/qa/fixture-sites';

// Drill (g) runs the desktop's real sign-in code (desktop/account.ts) outside Electron: the OS
// keychain (safeStorage) becomes a reversible seal.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`sealed:${text}`, 'utf8'),
    decryptString: (sealed: Buffer) => sealed.toString('utf8').replace(/^sealed:/, ''),
  },
}));

const FULL = process.env.INTEGRATION_E2E === '1';
const ADMIN = 'integration-admin-token-0123456789abcdef';
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const ZW = /[\u200B\u200C\u200D\u2060]/;
const silent = { info() {}, warn() {}, error() {} };

type Reply = { status: number; body: Record<string, any> };
type CloudClient = typeof import('../server/cloud-client');
type Convergence = typeof import('../server/factory/convergence');
type Scaffolder = typeof import('../server/factory/scaffolder');
type Progress = typeof import('../server/factory/progress');
type Db = typeof import('../server/db');
type Settings = typeof import('../server/factory/settings');

let tmp: string;
let cloud: ReturnType<typeof createCloud>;
let server: Server;
let base: string;
let sites: FixtureSites;
const sent: MailMessage[] = [];
let client: CloudClient; let convergence: Convergence; let scaffolder: Scaffolder; let progress: Progress; let dbm: Db; let settings: Settings;
let reactSource: string;
const qaCalls: Array<{ iteration: number; buildRef: string; shopifyBase: string }> = [];
const A = { email: 'owner-a@example.com', accountId: '', refreshToken: '', pass: '', deviceId: '' };

const fakeLog = () => path.join(tmp, 'fake.log');
const fakeState = () => path.join(tmp, 'fake-state');
const savedPrompts = () => path.join(tmp, 'received-prompts');
const claudeConfig = () => path.join(tmp, 'claude-config');
const localData = () => path.join(tmp, 'local-workspace-root');

async function call(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${base}${route}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) as Record<string, any> : {}; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}
const admin = (method: string, route: string, body?: unknown) => call(method, `/v1/admin${route}`, body, { Authorization: `Bearer ${ADMIN}` });
const withPass = (pass: string, method: string, route: string, body?: unknown) => call(method, route, body, { Authorization: `Pass ${pass}` });

function lastCode(email: string) {
  const message = [...sent].reverse().find((entry) => entry.to === email && /sign-in code/.test(entry.subject));
  const code = message && /^(\d{6}) is your/.exec(message.subject)?.[1];
  if (!code) throw new Error(`no code was emailed to ${email}`);
  return code;
}
async function signIn(email: string, fingerprint: string, appVersion = '1.0.0'): Promise<Reply> {
  await call('POST', '/v1/auth/start', { email });
  return call('POST', '/v1/auth/verify', { email, code: lastCode(email), device: { fingerprint, name: 'Test PC', platform: 'win32', appVersion } });
}
const heartbeat = (refreshToken: string, fingerprint: string, appVersion = '1.0.0') => call('POST', '/v1/devices/heartbeat', { refreshToken, fingerprint, appVersion });
async function newAccount(email: string, fingerprint: string, seats = 3) {
  const created = await admin('POST', '/accounts', { email, seats });
  if (created.status >= 300) throw new Error(`createAccount failed: ${JSON.stringify(created.body)}`);
  const verified = await signIn(email, fingerprint);
  if (verified.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(verified.body)}`);
  const beat = await heartbeat(verified.body.refreshToken, fingerprint);
  if (beat.status !== 200) throw new Error(`heartbeat failed: ${JSON.stringify(beat.body)}`);
  return { accountId: created.body.account.id as string, refreshToken: verified.body.refreshToken as string, deviceId: verified.body.device.id as string, pass: beat.body.pass as string };
}

/** Every canary in the recipe, plus headings only the recipe contains (headings are never watermarked). */
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

/** Files under `root` (hidden folders included) whose text contains any marker. */
async function filesContaining(root: string, markers: string[]): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if ((await stat(full)).size > 20_000_000) continue;
      const text = stripZeroWidth((await readFile(full)).toString('utf8'));
      if (markers.some((marker) => text.includes(marker))) hits.push(path.relative(root, full));
    }
  };
  await walk(root);
  return hits;
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full); else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  await walk(root);
  return out.sort();
}

async function fakeRuns(workspace: string) {
  const text = await readFile(fakeLog(), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>).filter((entry) => path.resolve(entry.cwd ?? '') === path.resolve(workspace));
}
const startsIn = async (workspace: string) => (await fakeRuns(workspace)).filter((entry) => entry.event === 'start');

async function waitFor(check: () => Promise<boolean> | boolean, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('timed out waiting');
}

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
async function newJob(name: string, overrides: Record<string, unknown> = {}, status = 'draft') {
  const job = await dbm.db.createFactoryJob({
    name, slug: slugOf(name), workspace_path: path.join(tmp, 'builds', slugOf(name)),
    react_url: sites.reactBase, store_url: `https://${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.myshopify.com`,
    client_id_cipher: 'x', client_secret_cipher: 'x', storefront_password_cipher: null,
    prefix: 'ie', dev_theme_name: `${name} (dev)`, autoswap: false, auto_qa: false, qa_mode: 'both', qa_engine: 'playwright',
    max_iterations: 2, score_threshold: 0.99, ...overrides,
  } as Parameters<Db['db']['createFactoryJob']>[0], status);
  await scaffolder.scaffoldWorkspace({ job, clientId: 'a'.repeat(32), clientSecret: 'shpss_never_on_disk', reactFilesPath: reactSource });
  // Keep-BEST snapshots talk to the Shopify Admin API through the local mint endpoint: not here.
  await rm(path.join(job.workspace_path, 'qa', 'snapshot.mjs'), { force: true });
  return job;
}

function control() {
  const abort = new AbortController();
  let kill: ((reason?: string) => void) | null = null;
  return { abort, stop: () => { abort.abort(); kill?.('killed'); }, value: { signal: abort.signal, registerKill: (fn: ((reason?: string) => void) | null) => { kill = fn; } } };
}

/** The page list as the app uploads it (convergence.ts inventoryPages), for a second account's build. */
async function uploadedPages(workspace: string) {
  const raw = JSON.parse(await readFile(path.join(workspace, 'qa', 'state', 'inventory.json'), 'utf8')) as { pages: Array<Record<string, any>> };
  const str = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
  return raw.pages.map((page) => {
    const bands = Number(page.band_count ?? (Array.isArray(page.bands) ? page.bands.length : NaN));
    const model = page.model === 'opus' || page.model === 'sonnet' ? page.model : page.complexity === 'complex' ? 'opus' : page.complexity === 'simple' ? 'sonnet' : undefined;
    return { route: str(page.route, 200), name: str(page.name, 60), handle: str(page.shopify_handle ?? page.handle, 120), template: str(page.template ?? page.shopify_template, 120), file: str(page.react_file, 200), ...(Number.isInteger(bands) && bands > 0 ? { bands } : {}), ...(model ? { model } : {}), type: str(page.type, 20) };
  });
}

const ENV_KEYS = ['THEMEBOT_CLOUD_URL', 'THEMEBOT_CLOUD_PUBKEY', 'THEMEBOT_FAKE_CLAUDE', 'FACTORY_CLAUDE_PATH', 'CLAUDE_CONFIG_DIR', 'CLAUDE_FAKE_LOG', 'CLAUDE_FAKE_STATE', 'CLAUDE_FAKE_DELAY_MS', 'CLAUDE_FAKE_WAIT', 'CLAUDE_FAKE_PAGES', 'CLAUDE_FAKE_SAVE_PROMPTS', 'FACTORY_WORKSPACE_ROOT'];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tmp = mkdtempSync(path.join(tmpdir(), 'tb-integration-'));
  const config = loadConfig({ NODE_ENV: 'test', CLOUD_DATA_DIR: path.join(tmp, 'cloud-data'), ADMIN_TOKEN: ADMIN });
  cloud = createCloud({ config, mailer: { async send(message) { sent.push(message); } }, log: silent });
  server = await new Promise<Server>((resolve) => { const listening = cloud.app.listen(0, '127.0.0.1', () => resolve(listening)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sites = await startFixtureSites();

  reactSource = path.join(tmp, 'react-src');
  await mkdir(path.join(reactSource, 'src', 'pages'), { recursive: true });
  await writeFile(path.join(reactSource, 'package.json'), '{"name":"integration-site"}');
  await writeFile(path.join(reactSource, 'src', 'pages', 'HomePage.tsx'), 'export default () => null;');

  // The local server under test reads these once, at import.
  process.env.THEMEBOT_CLOUD_URL = base;
  process.env.THEMEBOT_CLOUD_PUBKEY = cloud.publicKey;
  process.env.THEMEBOT_FAKE_CLAUDE = '1';
  process.env.FACTORY_CLAUDE_PATH = path.resolve('tests/fixtures/fake-claude.mjs');
  process.env.CLAUDE_CONFIG_DIR = claudeConfig();
  process.env.CLAUDE_FAKE_LOG = fakeLog();
  process.env.CLAUDE_FAKE_STATE = fakeState();
  process.env.CLAUDE_FAKE_DELAY_MS = '200';
  process.env.CLAUDE_FAKE_SAVE_PROMPTS = savedPrompts();
  process.env.FACTORY_WORKSPACE_ROOT = localData();
  // The fixture site has two pages: Home and About (↔ /pages/about on the "store").
  process.env.CLAUDE_FAKE_PAGES = JSON.stringify([
    { route: '/', name: 'Home', react_file: 'src/pages/HomePage.tsx', shopify_handle: '', template: 'index.json', band_count: 4, complexity: 'complex', model: 'opus' },
    { route: '/about', name: 'About', react_file: 'src/pages/AboutPage.tsx', shopify_handle: 'about', template: 'page.ie_about.json', band_count: 2, complexity: 'simple', model: 'sonnet' },
  ]);

  vi.resetModules();
  vi.doMock('../server/factory/qa-cloud', async (importOriginal) => {
    const original = await importOriginal<typeof import('../server/factory/qa-cloud')>();
    return {
      ...original,
      runQaViaCloud: async (job: Parameters<typeof original.runQaViaCloud>[0], iteration: number, factorySettings: Parameters<typeof original.runQaViaCloud>[2], signal?: AbortSignal) => {
        const options = await original.qaCloudOptions(job, iteration, factorySettings, signal);
        qaCalls.push({ iteration, buildRef: options.buildRef, shopifyBase: options.shopifyBase });
        const { payloadBytes: _bytes, captureFailed: _failed, ...result } = await original.runQaCloudPipeline({ ...options, shopifyBase: sites.shopifyBase, timeoutMin: 4 });
        return result;
      },
    };
  });
  client = await import('../server/cloud-client');
  dbm = await import('../server/db');
  settings = await import('../server/factory/settings');
  scaffolder = await import('../server/factory/scaffolder');
  progress = await import('../server/factory/progress');
  convergence = await import('../server/factory/convergence');

  Object.assign(A, await newAccount(A.email, FP_A));
  expect(client.acceptPass(A.pass, { email: A.email, plan: 'standard', seats: 3, expiresAt: null })).toBe(true);
  expect(convergence.recipeFromCloud()).toBe(true);
  await settings.updateFactorySettings({ pageConcurrency: 2, cloneModel: 'opus', secretScrub: true, earlyStopOnNoProgress: true });
}, 90_000);

afterAll(async () => {
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  vi.doUnmock('../server/factory/qa-cloud');
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  cloud?.close();
  await sites?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** A fresh pass for account A (a heartbeat), handed to the local server like the desktop host does. */
async function refreshA() {
  const beat = await heartbeat(A.refreshToken, FP_A);
  if (beat.status !== 200) throw new Error(`heartbeat failed: ${JSON.stringify(beat.body)}`);
  A.pass = beat.body.pass as string;
  client.acceptPass(A.pass, { email: A.email, plan: 'standard', seats: 3, expiresAt: null });
}

describe.skipIf(!FULL)('integrated build: real Cloud app + fake Claude CLI + real QA capture', () => {
  it('builds from watermarked Cloud steps, checks via Cloud QA, fixes from /fix, and leaves no recipe behind', async () => {
    await refreshA();
    const job = await newJob('Integration Shop', { auto_qa: true });
    const workspace = job.workspace_path;
    for (const file of ['.claude/commands/clone-theme.md', 'seed/CONVENTIONS.md', 'qa/factory/section-compare.mjs', 'qa/factory/calibrate.mjs']) expect(existsSync(path.join(workspace, file)), file).toBe(false);

    const run = control();
    await convergence.driveJob(job.id, run.value);
    const after = (await dbm.db.getFactoryJob(job.id))!;
    // Two checks (the fixture "store" has planted differences, threshold 99%) with one fix between.
    expect(after.status, after.status_detail ?? '').toBe('exhausted');
    expect(after.status_detail).toMatch(/Iterations exhausted at \d+\.\d%/);
    expect(after.score_history.map((entry) => entry.iter)).toEqual([1, 2]);

    // --- Build steps: from /v1/builds, on stdin, watermarked, signals intact.
    const buildId = (await progress.readLocalBuild(workspace))!.buildId;
    const starts = await startsIn(workspace);
    const order = starts.map((entry) => entry.step);
    expect(order.slice(0, 4)).toEqual(['preflight', 'inventory', 'bootstrap', 'store-setup']);
    expect([...order].sort()).toEqual(['bootstrap', 'final', 'fix-complete-1', 'inventory', 'page-about', 'page-home', 'preflight', 'store-setup', 'verify-about', 'verify-home']);
    for (const entry of starts) {
      expect(entry.stdinBytes, entry.step).toBeGreaterThan(1000);
      expect(entry.canaries.length, entry.step).toBeGreaterThan(0);
      expect(entry.noPersistence, entry.step).toBe(true);
      expect(entry.argv.every((arg: string) => arg.length < 60 && !arg.includes('tbr-canary')), entry.argv.join(' ')).toBe(true);
    }
    const promptFiles = await readdir(savedPrompts());
    const promptOf = async (step: string) => readFile(path.join(savedPrompts(), promptFiles.find((file) => file.startsWith(`${step}.`))!), 'utf8');
    for (const step of order) {
      const prompt = await promptOf(step);
      expect(ZW.test(prompt), `${step}: zero-width watermark present`).toBe(true);
      const signal = step.startsWith('fix-complete-') ? `qa/reports/${step}.md` : `factory/steps/${step}.done`;
      expect(prompt, `${step}: signal path intact`).toContain(`\`${signal}\``);
    }
    const remote = await withPass(A.pass, 'GET', `/v1/builds/${buildId}`);
    expect(remote.body.build.status).toBe('done');
    const issued = remote.body.history.map((entry: { step: string }) => entry.step);
    expect(issued).toContain('fix:1');
    // The Cloud logged one watermark send per issued prompt, for this account and build.
    const sends = cloud.ctx.db.sql.prepare('SELECT step_id, account_id FROM watermark_sends WHERE build_id = ? ORDER BY id').all(buildId) as Array<{ step_id: string; account_id: string }>;
    expect(sends.map((row) => row.step_id).sort()).toEqual([...issued].sort());
    expect(new Set(sends.map((row) => row.account_id))).toEqual(new Set([A.accountId]));
    const fixRun = starts.find((entry) => entry.step === 'fix-complete-1')!;
    expect(fixRun.model).toBeDefined();
    console.log(`[integration] build ${buildId}: ${starts.length} sessions, ${issued.length} prompts issued, ${sends.length} watermark sends`);

    // --- QA: captured locally, scored by the Cloud, filed under the Cloud build id.
    expect(qaCalls.map((entry) => entry.iteration)).toEqual([1, 2]);
    expect(new Set(qaCalls.map((entry) => entry.buildRef))).toEqual(new Set([buildId]));
    expect(qaCalls[0].shopifyBase).toBe('https://integration-shop.myshopify.com'); // what the real adapter would open
    const reports = path.join(workspace, 'qa', 'reports', 'factory');
    for (const iter of [1, 2]) for (const file of [`sections-${iter}.json`, `sections-${iter}.md`, `interactions-${iter}.json`, `interactions-${iter}.md`, `qa-summary-${iter}.md`]) expect(existsSync(path.join(reports, file)), file).toBe(true);
    const sections = JSON.parse(await readFile(path.join(reports, 'sections-1.json'), 'utf8'));
    const interactions = JSON.parse(await readFile(path.join(reports, 'interactions-1.json'), 'utf8'));
    const kinds = [...sections.issues, ...interactions.issues].map((issue: { kind: string }) => issue.kind).sort();
    expect(kinds).toEqual(['interaction_noop', 'interaction_target', 'missing_interaction', 'missing_section', 'text_drift']);
    const { compositeScore } = await import('../server/factory/qa');
    const expected = compositeScore({ presence: sections.presence, text: sections.text, interaction: interactions.interaction });
    const rounds = cloud.ctx.db.sql.prepare('SELECT iter, score, issue_count, capture_failed FROM qa_rounds WHERE account_id = ? AND build_ref = ? ORDER BY iter').all(A.accountId, buildId) as Array<{ iter: number; score: number; issue_count: number; capture_failed: number }>;
    expect(rounds.map((row) => row.iter)).toEqual([1, 2]);
    expect(rounds[0].score).toBeCloseTo(expected, 10);
    expect(after.score_history[0].score).toBeCloseTo(expected, 10);
    expect(rounds[0].issue_count).toBe(5);
    expect(rounds.every((row) => row.capture_failed === 0)).toBe(true);
    const summary = await readFile(path.join(reports, 'qa-summary-1.md'), 'utf8');
    expect(summary).toContain(`**Composite score: ${(expected * 100).toFixed(1)}%**`);
    console.log(`[integration] QA score ${(expected * 100).toFixed(1)}% (presence ${sections.presence}, text ${sections.text}, interaction ${interactions.interaction}); issues: ${kinds.join(', ')}`);

    // --- Leak attribution: a second account receives the SAME step text (same job details), so
    //     only the watermark can tell them apart.
    const B = await newAccount('owner-b@example.com', FP_B);
    const meta = { name: after.name, prefix: after.prefix, storeHost: new URL(after.store_url).host, reactUrl: after.react_url, root: workspace, devThemeName: after.dev_theme_name, qaEngine: after.qa_engine, rebuiltRoutes: [] };
    const bBuild = await withPass(B.pass, 'POST', '/v1/builds', meta);
    expect(bBuild.status).toBe(201);
    const bId = bBuild.body.buildId as string;
    expect((await withPass(B.pass, 'POST', `/v1/builds/${bId}/pages`, { pages: await uploadedPages(workspace), replace: true })).status).toBe(200);
    let bHome = '';
    for (let guard = 0; guard < 10 && !bHome; guard += 1) {
      const next = await withPass(B.pass, 'POST', `/v1/builds/${bId}/next`, { session: 'b-session-0001' });
      expect(next.status, JSON.stringify(next.body)).toBe(200);
      const step = next.body.step as { id: string; prompt: string };
      if (step.id === 'page:home') bHome = step.prompt;
      else expect((await withPass(B.pass, 'POST', `/v1/builds/${bId}/result`, { stepId: step.id, outcome: 'done', session: 'b-session-0001' })).status).toBe(200);
    }
    const aHome = await promptOf('page-home');
    expect(stripZeroWidth(bHome)).not.toBe(stripZeroWidth(aHome)); // same instructions, different wording marks
    const excerpt = (text: string) => text.slice(Math.floor(text.length * 0.35), Math.floor(text.length * 0.65));
    const leakA = await admin('POST', '/security/leak', { text: excerpt(aHome) });
    expect(leakA.status).toBe(200);
    expect(leakA.body.candidates[0].accountId).toBe(A.accountId);
    const strippedA = await admin('POST', '/security/leak', { text: stripZeroWidth(excerpt(aHome)) });
    expect(strippedA.body.candidates[0].accountId).toBe(A.accountId);
    const leakB = await admin('POST', '/security/leak', { text: excerpt(bHome) });
    expect(leakB.body.candidates[0].accountId).toBe(B.accountId);
    console.log(`[integration] leak: 30% excerpt (${excerpt(aHome).length} chars of ${aHome.length}) → A at ${leakA.body.candidates[0].confidence.toFixed(3)}; zero-width stripped → A at ${strippedA.body.candidates[0].confidence.toFixed(3)} (wording ${JSON.stringify(strippedA.body.candidates[0].wording)}); B's excerpt → B at ${leakB.body.candidates[0].confidence.toFixed(3)}`);

    // --- Leak scan: no canary or recipe heading anywhere the run wrote (workspace incl. logs and
    //     hidden folders, the Claude config dir, the local data folder). The scanner itself works.
    const markers = await recipeMarkers();
    expect(markers.filter((marker) => marker.startsWith('tbr-canary')).length).toBeGreaterThanOrEqual(14);
    const planted = path.join(tmp, 'scanner-check');
    await mkdir(planted, { recursive: true });
    await writeFile(path.join(planted, 'leak.txt'), `x ${markers.find((marker) => marker.startsWith('tbr-canary'))} y`);
    expect(await filesContaining(planted, markers)).toEqual(['leak.txt']);
    expect(await filesContaining(savedPrompts(), markers)).not.toEqual([]); // the test's own copies do hold it
    const hits = { workspace: await filesContaining(workspace, markers), claudeConfig: await filesContaining(claudeConfig(), markers), localData: await filesContaining(localData(), markers) };
    expect(hits).toEqual({ workspace: [], claudeConfig: [], localData: [] });
    const files = await listFiles(workspace);
    expect(files.filter((file) => /(^|\/)fix-prompt-\d+\.md$|clone-theme\.md$|CONVENTIONS\.md$|(^|\/)qa\/factory\/|section-compare|interaction-verify|qa-shared|calibrate\.mjs$/.test(file))).toEqual([]);
    expect(files.some((file) => file.endsWith('.jsonl') && file.includes('projects'))).toBe(false);
    expect(await listFiles(path.join(claudeConfig(), 'projects')).then((list) => list.filter((file) => file.includes(runnerSlug(workspace))))).toEqual([]);
    console.log(`[integration] job folder after the run (${files.length} files):\n  ${files.filter((file) => !file.startsWith('react_files/') && !file.startsWith('qa/screenshots/')).join('\n  ')}`);
  }, 600_000);
});

function runnerSlug(workspace: string) { return workspace.replace(/[^a-zA-Z0-9]/g, '-'); }

describe('piracy drills', () => {
  it('(a) no pass: build routes answer 403 and the scheduler starts nothing', async () => {
    client.clearPass();
    try {
      const { createFactoryRouter } = await import('../server/factory/routes');
      const { factoryScheduler } = await import('../server/factory/scheduler');
      const app = express();
      app.use(express.json());
      app.use('/api/factory', createFactoryRouter());
      const local = await new Promise<Server>((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
      const job = await newJob('No Pass Shop', {}, 'queued');
      try {
        const url = `http://127.0.0.1:${(local.address() as AddressInfo).port}/api/factory`;
        for (const route of ['/jobs', '/easy/start', '/easy/resume', `/jobs/${job.id}/check`, `/jobs/${job.id}/fix`, `/jobs/${job.id}/rebuild`, `/jobs/${job.id}/retry`, `/jobs/${job.id}/start`, '/qa-selftest']) {
          const response = await fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          expect(response.status, route).toBe(403);
        }
        await factoryScheduler.tick();
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(factoryScheduler.isRunning(job.id)).toBe(false);
        expect((await dbm.db.getFactoryJob(job.id))!.status).toBe('queued');
        expect(await startsIn(job.workspace_path)).toEqual([]);
      } finally {
        await dbm.db.updateFactoryJob(job.id, { status: 'canceled' });
        local.closeAllConnections();
        await new Promise((resolve) => local.close(resolve));
      }
    } finally {
      await refreshA();
    }
  }, 60_000);

  it('(b) the Cloud refuses build steps and QA without a valid signed pass: none, forged, expired, other account', async () => {
    await refreshA();
    const B = await newAccount('drill-b@example.com', FP_B);
    const forger = generateKeyPairSync('ed25519');
    const iat = Math.floor(Date.now() / 1000);
    const payload = { v: 1 as const, acc: A.accountId, dev: A.deviceId, plan: 'standard', seats: 3, ver: '1.0.0', iat, exp: iat + PASS_TTL_SEC };
    const forged = signPass(payload, forger.privateKey);
    const expired = signPass({ ...payload, iat: iat - 3600, exp: iat - 3600 + PASS_TTL_SEC }, cloud.ctx.config.signingKey);
    const build = { name: 'Drill', prefix: 'dr', storeHost: 'drill.myshopify.com', reactUrl: 'https://drill.example.com', root: 'C:\\builds\\drill' };
    const bBuild = await withPass(B.pass, 'POST', '/v1/builds', build);
    expect(bBuild.status).toBe(201);
    const routes: Array<[string, string, unknown]> = [
      ['POST', '/v1/builds', build], ['POST', `/v1/builds/${bBuild.body.buildId}/next`, { session: 'drill-session-1' }], ['POST', `/v1/builds/${bBuild.body.buildId}/fix`, { iter: 1, summary: { reportPath: 'qa/reports/factory/qa-summary-1.md' } }],
      ['POST', '/v1/qa/sections', { iter: 1, routes: [] }], ['POST', '/v1/qa/interactions/plan', { iter: 1, routes: [] }], ['POST', '/v1/qa/interactions/score', { plan: {} }], ['POST', '/v1/qa/summary', { iter: 1 }], ['POST', '/v1/qa/calibrate', {}],
    ];
    const results: string[] = [];
    for (const [method, route, body] of routes) {
      const none = await call(method, route, body);
      const fake = await withPass(forged, method, route, body);
      const old = await withPass(expired, method, route, body);
      expect([none.status, none.body.code], route).toEqual([401, 'PASS_REQUIRED']);
      expect([fake.status, fake.body.code], route).toEqual([401, 'PASS_INVALID']);
      expect([old.status, old.body.code], route).toEqual([401, 'PASS_EXPIRED']);
      results.push(`${route}: ${none.body.code}/${fake.body.code}/${old.body.code}`);
    }
    // Account A's (valid) pass on account B's build: as if it didn't exist.
    for (const [method, route, body] of routes.slice(1, 3)) expect((await withPass(A.pass, method, route, body)).body.code, route).toBe('NOT_FOUND');
    expect((await withPass(A.pass, 'GET', `/v1/builds/${bBuild.body.buildId}`)).status).toBe(404);
    // A click plan signed for account B can't be scored by account A.
    const plan = await withPass(B.pass, 'POST', '/v1/qa/interactions/plan', { iter: 1, handles: {}, routes: [] });
    expect(plan.status).toBe(200);
    expect((await withPass(A.pass, 'POST', '/v1/qa/interactions/score', { plan: plan.body.plan, effects: [] })).body.code).toBe('PLAN_INVALID');
    console.log(`[drill b] ${results.join(' · ')}`);

    // A "cracked" app: its built-in key swapped so it accepts a pass it forged itself. The local
    // checks pass; the Cloud still refuses, so no step ever runs and the job stops with the reason.
    const keep = { url: process.env.THEMEBOT_CLOUD_URL, key: process.env.THEMEBOT_CLOUD_PUBKEY };
    process.env.THEMEBOT_CLOUD_PUBKEY = rawPublicKey(forger.privateKey);
    vi.resetModules();
    try {
      const cracked = await import('../server/cloud-client');
      const crackedDb = await import('../server/db');
      const crackedConvergence = await import('../server/factory/convergence');
      const crackedScaffolder = await import('../server/factory/scaffolder');
      expect(cracked.acceptPass(forged, { email: A.email, plan: 'standard', seats: 3, expiresAt: null })).toBe(true);
      expect(cracked.buildsBlockedReason()).toBeNull();
      expect(() => cracked.requireValidPass()).not.toThrow();
      const job = await crackedDb.db.createFactoryJob({
        name: 'Cracked Shop', slug: 'cracked_shop', workspace_path: path.join(tmp, 'builds', 'cracked_shop'), react_url: sites.reactBase, store_url: 'https://cracked-shop.myshopify.com',
        client_id_cipher: 'x', client_secret_cipher: 'x', storefront_password_cipher: null, prefix: 'cr', dev_theme_name: 'Cracked (dev)', autoswap: false, auto_qa: true, qa_mode: 'both', qa_engine: 'playwright', max_iterations: 2, score_threshold: 0.9,
      } as Parameters<Db['db']['createFactoryJob']>[0], 'draft');
      await crackedScaffolder.scaffoldWorkspace({ job, clientId: 'c'.repeat(32), clientSecret: 'shpss_x' });
      await crackedConvergence.driveJob(job.id, control().value);
      const stopped = (await crackedDb.db.getFactoryJob(job.id))!;
      expect(stopped.status).toBe('blocked');
      expect(stopped.status_detail).toMatch(/Sign in to ThemeBot again/);
      expect(await startsIn(job.workspace_path)).toEqual([]);
      const qaRefusals: string[] = [];
      for (const route of ['/v1/qa/sections', '/v1/qa/interactions/plan', '/v1/qa/summary', '/v1/qa/calibrate']) {
        const refused = await cracked.cloudFetch(route, { iter: 1, routes: [] }).catch((error: unknown) => error);
        expect(refused, route).toMatchObject({ status: 401, code: 'PASS_INVALID' });
        qaRefusals.push(`${route} ${(refused as { code: string }).code}`);
      }
      console.log(`[drill b] cracked app: job ${stopped.status} — "${stopped.status_detail}"; steps run: 0; QA: ${qaRefusals.join(', ')}`);
    } finally {
      process.env.THEMEBOT_CLOUD_URL = keep.url;
      process.env.THEMEBOT_CLOUD_PUBKEY = keep.key;
    }
  }, 120_000);

  it('(c) a copied job folder holds nothing runnable from the recipe', async () => {
    await refreshA();
    const job = await newJob('Copy Shop');
    await convergence.driveJob(job.id, control().value);
    expect((await dbm.db.getFactoryJob(job.id))!.status).toBe('converged');
    const copy = path.join(tmp, 'copied-elsewhere');
    await cp(job.workspace_path, copy, { recursive: true });
    const files = await listFiles(copy);
    expect(await filesContaining(copy, await recipeMarkers())).toEqual([]);
    expect(files.filter((file) => /clone-theme\.md$|CONVENTIONS\.md$|fix-prompt|(^|\/)qa\/factory\/|section-compare|interaction-verify|qa-shared|calibrate\.mjs$|(^|\/)prompts\//.test(file))).toEqual([]);
    // What is there: inputs, the generic workspace plumbing, the built theme, step ids/states.
    const steps = JSON.parse(await readFile(path.join(copy, 'factory', 'steps', 'progress.json'), 'utf8')) as { steps: Array<Record<string, unknown>> };
    expect(steps.steps.every((entry) => Object.keys(entry).every((key) => ['id', 'kind', 'title', 'status', 'page'].includes(key)))).toBe(true);
    console.log(`[drill c] copied job folder (${files.length} files, react_files/ omitted):\n  ${files.filter((file) => !file.startsWith('react_files/')).join('\n  ')}`);
  }, 120_000);

  it('(d) revoke mid-build: the next step and QA are refused, the job stops cleanly; restore + Resume continues', async () => {
    await refreshA();
    const job = await newJob('Revoke Shop');
    const workspace = job.workspace_path;
    process.env.CLAUDE_FAKE_WAIT = 'page-home';
    const run = control();
    const driving = convergence.driveJob(job.id, run.value);
    // Revoke while page-home is in progress and nothing else is (About is built and checked).
    await waitFor(async () => existsSync(path.join(fakeState(), 'waiting-page-home')) && (await fakeRuns(workspace)).some((entry) => entry.event === 'done' && entry.step === 'verify-about'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await admin('POST', `/accounts/${A.accountId}/revoke`)).status).toBe(200);
    const revokedAt = Date.now();
    const qa = await client.cloudFetch('/v1/qa/summary', { iter: 1 }).catch((error: unknown) => error);
    expect(qa).toMatchObject({ status: 403, code: 'ACCOUNT_INACTIVE' });
    expect((await heartbeat(A.refreshToken, FP_A)).body.code).toBe('ACCOUNT_INACTIVE');
    await writeFile(path.join(fakeState(), 'release-page-home'), '1');
    await driving;
    delete process.env.CLAUDE_FAKE_WAIT;
    const stopped = (await dbm.db.getFactoryJob(job.id))!;
    expect(stopped.status).toBe('blocked');
    expect(stopped.status_detail).toMatch(/plan is not active/);
    const afterRevoke = (await startsIn(workspace)).filter((entry) => entry.at > revokedAt);
    expect(afterRevoke).toEqual([]);
    const ranBefore = (await startsIn(workspace)).map((entry) => entry.step);

    expect((await admin('POST', `/accounts/${A.accountId}/restore`)).status).toBe(200);
    await refreshA();
    await convergence.driveJob(job.id, control().value);
    const resumed = (await dbm.db.getFactoryJob(job.id))!;
    expect(resumed.status, resumed.status_detail ?? '').toBe('converged');
    const all = (await startsIn(workspace)).map((entry) => entry.step);
    const rerun = all.slice(ranBefore.length);
    for (const step of ['preflight', 'inventory', 'bootstrap', 'store-setup', 'page-home']) expect(rerun, step).not.toContain(step);
    expect(rerun).toContain('final');
    console.log(`[drill d] before revoke: ${ranBefore.join(', ')} | stopped: "${stopped.status_detail}" | after restore + Resume: ${rerun.join(', ')}`);
  }, 120_000);

  it('(e) an app below the minimum version gets UPDATE_REQUIRED', async () => {
    expect((await admin('POST', '/settings', { minAppVersion: '9.0.0' })).status).toBe(200);
    try {
      const beat = await heartbeat(A.refreshToken, FP_A, '1.0.0');
      expect([beat.status, beat.body.code, beat.body.minAppVersion]).toEqual([426, 'UPDATE_REQUIRED', '9.0.0']);
      const fresh = await signIn(A.email, FP_A, '1.0.0');
      expect([fresh.status, fresh.body.code]).toEqual([426, 'UPDATE_REQUIRED']);
      expect((await heartbeat(A.refreshToken, FP_A, '9.0.0')).status).toBe(200);
    } finally {
      await admin('POST', '/settings', { minAppVersion: '0.0.0' });
    }
    await refreshA();
  });

  it('(f) seats: a computer over the limit gets SEATS_FULL; the real call sites record events; flags show anomalies', async () => {
    const email = 'one-seat@example.com';
    const created = await admin('POST', '/accounts', { email, seats: 1 });
    const accountId = created.body.account.id as string;
    const first = await signIn(email, 'c'.repeat(64));
    expect(first.status).toBe(200);
    expect((await heartbeat(first.body.refreshToken, 'c'.repeat(64))).status).toBe(200);
    const second = await signIn(email, 'd'.repeat(64));
    expect([second.status, second.body.code, second.body.devices?.length]).toEqual([409, 'SEATS_FULL', 1]);
    // The first computer's token presented by another machine: refused, and recorded.
    expect((await heartbeat(first.body.refreshToken, 'e'.repeat(64))).body.code).toBe('SIGNED_OUT');
    expect((await call('POST', '/v1/devices/release', { refreshToken: first.body.refreshToken })).status).toBe(200);
    const nowSecond = await signIn(email, 'd'.repeat(64));
    expect(nowSecond.status).toBe(200);
    expect((await call('POST', '/v1/devices/signout', { refreshToken: nowSecond.body.refreshToken })).status).toBe(200);
    expect((await admin('POST', `/devices/${first.body.device.id}/release`)).status).toBe(200);
    const events = await admin('GET', `/security/events?account=${accountId}`);
    const kinds = new Set((events.body.events as Array<{ kind: string; network: string }>).map((event) => event.kind));
    expect([...kinds].sort()).toEqual(['admin_release', 'fingerprint_mismatch', 'heartbeat', 'release', 'seats_full', 'signin', 'signout']);
    expect((events.body.events as Array<{ network: string }>).every((event) => event.network === '127.0.0.0/24')).toBe(true);

    // Suspicious use (many networks and machines — not reproducible from one PC, so recorded directly).
    const shared = await admin('POST', '/accounts', { email: 'shared-login@example.com', seats: 1 });
    const sharedId = shared.body.account.id as string;
    for (let index = 0; index < 9; index += 1) {
      recordSecurityEvent(cloud.ctx, { kind: 'signin', accountId: sharedId, deviceId: `dev_shared_${index}`, ip: `198.51.${index}.20`, fingerprintHash: `fp_shared_${index}` });
      recordSecurityEvent(cloud.ctx, { kind: 'seats_full', accountId: sharedId, deviceId: `dev_shared_${index}`, ip: `198.51.${index}.20`, fingerprintHash: `fp_shared_${index}` });
    }
    recordSecurityEvent(cloud.ctx, { kind: 'fingerprint_mismatch', accountId: sharedId, deviceId: 'dev_shared_0', ip: '203.0.113.9', fingerprintHash: 'fp_cloned' });
    const flags = await admin('GET', '/security/flags?hours=24');
    expect(flags.status).toBe(200);
    const report = (flags.body.accounts as Array<{ account: { id: string }; flags: Array<{ rule: string }> }>);
    const sharedFlags = report.find((entry) => entry.account.id === sharedId)?.flags.map((flag) => flag.rule) ?? [];
    expect(sharedFlags).toEqual(expect.arrayContaining(['many_networks', 'many_fingerprints', 'seats_full', 'token_reuse']));
    expect(report[0].account.id).toBe(sharedId); // worst first
    const oneSeatFlags = report.find((entry) => entry.account.id === accountId)?.flags.map((flag) => flag.rule) ?? [];
    expect(oneSeatFlags).toContain('token_reuse'); // from the real heartbeat refusal above
    console.log(`[drill f] events recorded by the real routes: ${[...kinds].sort().join(', ')} · flags: shared-login → ${sharedFlags.join(', ')}; one-seat → ${oneSeatFlags.join(', ')}`);
  });

  it('(g) copied sign-in files: the computer and its copy are both signed out within one heartbeat cycle', async () => {
    const { Account } = await import('../desktop/account');
    type Beat = Awaited<ReturnType<InstanceType<typeof Account>['heartbeat']>>;
    const passOf = (beat: Beat) => { if (!beat.ok) throw new Error(`heartbeat refused: ${beat.code}`); return beat.pass; };
    const cloudConfig = { url: base, publicKey: cloud.publicKey };
    // The copy also reports the original's machine id (a cloned disk or VM, or a patched app), so its
    // fingerprint matches — the case that used to be only flagged, never stopped.
    const machineId = async () => 'machine-guid-of-pc-a';
    const kindsFor = async (accountId: string) => ((await admin('GET', `/security/events?account=${accountId}`)).body.events as Array<{ kind: string }>).map((event) => event.kind);
    const reuseFlag = async (accountId: string) => ((await admin('GET', `/security/flags?account=${accountId}`)).body.accounts as Array<{ flags: Array<Record<string, any>> }>)[0]?.flags.find((flag) => flag.rule === 'token_reuse');
    const pc = async (email: string, name: string) => {
      const created = await admin('POST', '/accounts', { email, seats: 1 });
      const machine = new Account(path.join(tmp, `${name}-userdata`), cloudConfig, '1.0.0', { machineId });
      expect((await machine.start(email)).ok).toBe(true);
      expect((await machine.verify(email, lastCode(email))).ok).toBe(true);
      return { accountId: created.body.account.id as string, machine };
    };
    const copyOf = async (name: string, copy: string) => {
      await cp(path.join(tmp, `${name}-userdata`), path.join(tmp, `${copy}-userdata`), { recursive: true }); // account.json + device.json
      return new Account(path.join(tmp, `${copy}-userdata`), cloudConfig, '1.0.0', { machineId });
    };

    // 1. A and its copy B both hold T0. A heartbeats (T0 → T1, saved) and, 5 minutes later, uses T1.
    const { accountId, machine: a } = await pc('copied-signin@example.com', 'pc-a');
    const b = await copyOf('pc-a', 'pc-b');
    await copyOf('pc-a', 'pc-b-kept'); // a second copy, kept for later
    expect(await b.fingerprint()).toBe(await a.fingerprint());
    passOf(await a.heartbeat());
    const aPass = passOf(await a.heartbeat());
    expect((await withPass(aPass, 'GET', '/v1/session')).status).toBe(200);
    // B presents T0 → caught: B is signed out, and so is A — its pass stops at once, its next heartbeat is refused.
    expect(await b.heartbeat()).toMatchObject({ ok: false, code: 'SIGNED_OUT', reason: 'token_reuse' });
    for (const [method, route] of [['GET', '/v1/session'], ['POST', '/v1/builds']]) expect((await withPass(aPass, method, route, method === 'POST' ? {} : undefined)).body.code, route).toBe('SIGNED_OUT');
    const aNext = await a.heartbeat();
    expect(aNext).toMatchObject({ ok: false, code: 'SIGNED_OUT', reason: 'token_reuse', message: "This computer's sign-in was used somewhere else, so it was signed out. Sign in again." });
    expect([a.hasSession(), b.hasSession()]).toEqual([false, false]);
    expect(await kindsFor(accountId)).toContain('token_reuse');
    expect(await reuseFlag(accountId)).toMatchObject({ severity: 'high', detail: { reused: 1 } });
    // The owner signs in again on A (a new token family). The kept copy of the old files gets
    // nowhere — and can't knock the owner out again either.
    expect((await a.start('copied-signin@example.com')).ok).toBe(true);
    expect((await a.verify('copied-signin@example.com', lastCode('copied-signin@example.com'))).ok).toBe(true);
    expect((await a.heartbeat()).ok).toBe(true);
    const kept = new Account(path.join(tmp, 'pc-b-kept-userdata'), cloudConfig, '1.0.0', { machineId });
    expect(await kept.heartbeat()).toMatchObject({ ok: false, code: 'SIGNED_OUT' });
    expect((await a.heartbeat()).ok).toBe(true);

    // 2. Worst case: the copy is taken right after A saved a new token, and B heartbeats first. B
    //    rotates; A's heartbeat looks exactly like a lost-answer retry and gets the same token. Each
    //    then draws its own rotation key, so the next round catches them — one cycle later.
    const second = await pc('copied-mid-cycle@example.com', 'pc-c');
    const c = second.machine;
    passOf(await c.heartbeat());
    const d = await copyOf('pc-c', 'pc-d');
    passOf(await d.heartbeat()); // the copy first
    passOf(await c.heartbeat()); // the original: a retry, same token
    passOf(await c.heartbeat()); // next cycle: the original rotates on…
    expect(await d.heartbeat()).toMatchObject({ ok: false, code: 'SIGNED_OUT', reason: 'token_reuse' }); // …and the copy is caught
    expect(await c.heartbeat()).toMatchObject({ ok: false, code: 'SIGNED_OUT', reason: 'token_reuse' });
    expect(await kindsFor(second.accountId)).toContain('token_reuse');
    console.log(`[drill g] copied sign-in: copy presenting the replaced token → both computers signed out (event + token_reuse flag); copy taken mid-cycle → caught at the copy's 2nd heartbeat`);
  });
});
