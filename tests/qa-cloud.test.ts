// The desktop side of Cloud-scored QA (server/factory/qa-cloud.ts), without a browser: a stub
// capture (tests/fixtures/qa/stub-capture) writes a canned real capture, the adapter uploads it
// through the real pass-carrying cloudFetch to a test Cloud, and the reports must land where the
// UI and the fix agent read them — identical to what the local scripts wrote.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startQaCloud, type QaTestCloud } from '../cloud/tests/qa-harness';
import { compositeScore } from '../server/factory/qa';

const repo = path.resolve(import.meta.dirname, '..');
const canned = path.join(repo, 'tests', 'fixtures', 'qa', 'canned');
const stubDir = path.join(repo, 'tests', 'fixtures', 'qa', 'stub-capture');
const golden = (name: string) => JSON.parse(readFileSync(path.join(canned, name), 'utf8'));
const capture = golden('capture-sections.json');

type Adapter = typeof import('../server/factory/qa-cloud');
type Client = typeof import('../server/cloud-client');
let cloud: QaTestCloud;
let adapter: Adapter;
let client: Client;
const saved = { url: process.env.THEMEBOT_CLOUD_URL, key: process.env.THEMEBOT_CLOUD_PUBKEY };
let ws: string;

beforeAll(async () => {
  cloud = await startQaCloud();
  process.env.THEMEBOT_CLOUD_URL = cloud.base;
  process.env.THEMEBOT_CLOUD_PUBKEY = cloud.publicKey;
  vi.resetModules();
  client = await import('../server/cloud-client');
  adapter = await import('../server/factory/qa-cloud');
}, 60_000);

afterAll(async () => {
  if (saved.url === undefined) delete process.env.THEMEBOT_CLOUD_URL; else process.env.THEMEBOT_CLOUD_URL = saved.url;
  if (saved.key === undefined) delete process.env.THEMEBOT_CLOUD_PUBKEY; else process.env.THEMEBOT_CLOUD_PUBKEY = saved.key;
  await cloud?.close();
});

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'tb-qa-cloud-ws-'));
  mkdirSync(path.join(ws, 'qa', 'state'), { recursive: true });
  writeFileSync(path.join(ws, 'qa', 'state', 'handles.json'), JSON.stringify({ '/about': 'about' }));
  return () => rmSync(ws, { recursive: true, force: true });
});

const options = (overrides: Partial<Parameters<Adapter['runQaCloudPipeline']>[0]> = {}) => ({
  workspace: ws, reactBase: capture.reactBase, shopifyBase: capture.shopifyBase, storePassword: null, iteration: 1, qaMode: 'both',
  headed: false, weights: { presence: 0.5, text: 0.3, interaction: 0.2 }, jobName: 'Tea shop', scoreThreshold: 0.92, buildRef: 'job-1',
  timeoutMin: 1, captureDir: stubDir, ...overrides,
});
const report = (name: string) => JSON.parse(readFileSync(path.join(ws, 'qa', 'reports', 'factory', name), 'utf8'));
const signIn = async () => { expect(client.handleHostMessage({ type: 'pass', token: await cloud.pass(), account: { email: 'qa@example.com', plan: 'studio', seats: 3 } })).toBe(true); };

describe('runQaCloudPipeline', () => {
  it('captures, lets the Cloud score, and writes the same reports the local scripts wrote', async () => {
    await signIn();
    const result = await adapter.runQaCloudPipeline(options());
    const sections = golden('golden-sections-1.json');
    const interactions = golden('golden-interactions-1.json');
    expect(report('sections-1.json')).toEqual(sections);
    expect(report('interactions-1.json')).toEqual(interactions);
    expect(readFileSync(path.join(ws, 'qa/reports/factory/sections-1.md'), 'utf8')).toBe(readFileSync(path.join(canned, 'golden-sections-1.md'), 'utf8'));
    expect(readFileSync(path.join(ws, 'qa/reports/factory/interactions-1.md'), 'utf8')).toBe(readFileSync(path.join(canned, 'golden-interactions-1.md'), 'utf8'));

    const subscores = { presence: sections.presence, text: sections.text, interaction: interactions.interaction };
    expect(result.score).toBe(compositeScore(subscores));
    expect(result.subscores).toEqual(subscores);
    expect(result.issueCount).toBe(5);
    expect(result.summaryPath).toBe(path.join('qa', 'reports', 'factory', 'qa-summary-1.md'));
    expect(result.breakdown).toEqual({ issues: 5, fixed: 0, unreachable: 0, pages: 2, subscores, handlesMissing: false });
    const summary = readFileSync(path.join(ws, result.summaryPath), 'utf8');
    expect(summary).toContain('# QA summary — iteration 1 for Tea shop');
    expect(summary).toContain('## FIX THESE (5, in priority order)\n\n1. **[missing_section]**');
    expect(Object.keys(result.payloadBytes).sort()).toEqual(['interactions/plan', 'interactions/score', 'sections', 'summary']);
    expect(existsSync(path.join(ws, 'qa/capture/factory/1/plan.json'))).toBe(true);
    expect(readFileSync(path.join(ws, 'factory/logs/qa-1.log'), 'utf8')).toMatch(/scored by ThemeBot Cloud: \d+\.\d% \(5 issue\(s\)\)/);
  });

  it('lists what was fixed since the previous iteration from the N-1 reports on disk, and retries a crashed capture', async () => {
    await signIn();
    const reports = path.join(ws, 'qa', 'reports', 'factory');
    mkdirSync(reports, { recursive: true });
    const previous = golden('golden-sections-1.json');
    previous.issues.push({ id: 's1-9', kind: 'missing_page', page: '/faq', title: 'Shopify page /pages/faq does not exist (HTTP 404)', detail: 'x' });
    writeFileSync(path.join(reports, 'sections-1.json'), JSON.stringify(previous));
    writeFileSync(path.join(reports, 'interactions-1.json'), JSON.stringify(golden('golden-interactions-1.json')));
    writeFileSync(path.join(ws, 'qa', 'stub-scenario.json'), JSON.stringify({ failFirst: 'sections' }));

    const result = await adapter.runQaCloudPipeline(options({ iteration: 2 }));
    expect(result.breakdown).toMatchObject({ fixed: 1, issues: 5 });
    expect(readFileSync(path.join(ws, result.summaryPath), 'utf8')).toContain('## Fixed since last iteration (1)\n\n- ~~/faq — Shopify page /pages/faq does not exist (HTTP 404)~~');
    expect(readFileSync(path.join(ws, 'factory/logs/qa-2.log'), 'utf8')).toContain('capture sections attempt 1 failed');
    expect(report('sections-2.json').issues[0].id).toBe('s2-1');
  });

  it('runs only the sections check in sections mode, and warns when handles.json is missing', async () => {
    await signIn();
    rmSync(path.join(ws, 'qa', 'state', 'handles.json'));
    const result = await adapter.runQaCloudPipeline(options({ qaMode: 'sections' }));
    expect(result.subscores.interaction).toBeNull();
    expect(existsSync(path.join(ws, 'qa/reports/factory/interactions-1.json'))).toBe(false);
    expect(result.breakdown).toMatchObject({ handlesMissing: true });
    expect(Object.keys(result.payloadBytes).sort()).toEqual(['sections', 'summary']);
  });

  it('reports a failed capture instead of a 0% score', async () => {
    await signIn();
    writeFileSync(path.join(ws, 'qa', 'stub-scenario.json'), JSON.stringify({ reactBlank: true }));
    const error = await adapter.runQaCloudPipeline(options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(adapter.QaCaptureError);
    expect((error as Error).message).toMatch(/QA capture failed — no page could be captured \(2 of 2 failed\)/);
    // The summary is kept for the person to read, but not as qa-summary-1.md: that name means "round
    // 1 was scored" — Resume would skip the round, and a Fix run would fix from this report.
    expect((error as InstanceType<Adapter['QaCaptureError']>).summaryPath).toBe(path.join('qa', 'reports', 'factory', 'qa-summary-1.capture-failed.md'));
    expect(readFileSync(path.join(ws, 'qa/reports/factory/qa-summary-1.capture-failed.md'), 'utf8')).toContain('CAPTURE FAILED — no score this round.');
    expect(existsSync(path.join(ws, 'qa/reports/factory/qa-summary-1.md'))).toBe(false);
    expect(report('sections-1.json').capture).toMatchObject({ failed: true });
    expect(existsSync(path.join(ws, 'qa/reports/factory/interactions-1.json'))).toBe(false); // no click capture on a dead site

    // The site is back: the same round now scores, and the failed summary is cleared away.
    rmSync(path.join(ws, 'qa', 'stub-scenario.json'));
    const retried = await adapter.runQaCloudPipeline(options());
    expect(retried.summaryPath).toBe(path.join('qa', 'reports', 'factory', 'qa-summary-1.md'));
    expect(existsSync(path.join(ws, 'qa/reports/factory/qa-summary-1.capture-failed.md'))).toBe(false);
  });

  it('says so when this PC is not signed in to ThemeBot', async () => {
    client.handleHostMessage({ type: 'signed-out' });
    await expect(adapter.runQaCloudPipeline(options())).rejects.toThrow(/ThemeBot Cloud could not score this check \(\/v1\/qa\/sections\): Sign in to ThemeBot/);
  });

  it('runs the self-test with Cloud scoring', async () => {
    await signIn();
    const outcome = await adapter.runSelftestViaCloud({ captureDir: stubDir });
    expect(outcome).toMatchObject({ ok: true, score: 1, subscores: { presence: 1, text: 1, interaction: null } });
    expect(outcome.log).toContain('CALIBRATION PASSED');
  });
});

describe('no rubric on the PC', () => {
  it('the adapter imports Cloud QA code for types only', () => {
    const source = readFileSync(path.join(repo, 'server', 'factory', 'qa-cloud.ts'), 'utf8');
    const cloudImports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']*cloud\/src\/qa[^']*)'/gms)];
    expect(cloudImports.length).toBeGreaterThan(0);
    for (const match of cloudImports) expect(match[1]).toBe('type ');
  });

  it('the capture scripts carry no scoring code', () => {
    const dir = path.join(repo, 'templates', 'factory', 'qa-capture');
    for (const file of ['capture.mjs', 'capture-lib.mjs']) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      expect(source).not.toMatch(/qa-shared\.mjs['"]/);
      expect(source).not.toMatch(/alignSections|diceSimilarity|pairScore|textDiffSamples|effectsEquivalent|MAX_CLICKS|0\.55|textScore|presence/);
      expect(source).not.toMatch(/rect\.height < 120|innerWidth \* 0\.6/);
    }
  });
});
