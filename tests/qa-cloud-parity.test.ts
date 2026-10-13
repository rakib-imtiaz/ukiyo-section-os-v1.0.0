// End-to-end parity: the OLD local QA scripts (templates/factory/qa) and the NEW capture + Cloud
// scoring path (templates/factory/qa-capture + cloud/src/qa via server/factory/qa-cloud.ts) run
// against the same two local fixture sites and must produce the same scores, issues and reports.
//
// Drives real Chromium for about a minute, so it is opt-in:  QA_E2E=1 npx vitest run tests/qa-cloud-parity.test.ts
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startQaCloud, type QaTestCloud } from '../cloud/tests/qa-harness';
import { segmentLayout } from '../cloud/src/qa/segment';
import { compositeScore } from '../server/factory/qa';
import { startFixtureSites, type FixtureSites } from './fixtures/qa/fixture-sites';

const E2E = process.env.QA_E2E === '1';
const repo = path.resolve(import.meta.dirname, '..');
const OLD_QA = path.join(repo, 'templates', 'factory', 'qa');
const HANDLES = { '/about': 'about' };

function runNode(script: string, cwd: string, env: Record<string, string>, timeoutMs = 240_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '1'], { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${script} timed out\n${output}`)); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`${script} exited ${code}\n${output}`)); });
  });
}

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

function workspace(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(dir, 'qa', 'state'), { recursive: true });
  writeFileSync(path.join(dir, 'qa', 'state', 'handles.json'), JSON.stringify(HANDLES));
  return dir;
}

describe.skipIf(!E2E)('QA parity: local scripts vs capture + ThemeBot Cloud', () => {
  let sites: FixtureSites;
  let cloud: QaTestCloud;
  let oldWs: string;
  let newWs: string;
  const env: Record<string, string | undefined> = {};

  beforeAll(async () => {
    sites = await startFixtureSites();
    cloud = await startQaCloud();
    oldWs = workspace('tb-qa-old-');
    newWs = workspace('tb-qa-new-');
    env.url = process.env.THEMEBOT_CLOUD_URL; env.key = process.env.THEMEBOT_CLOUD_PUBKEY;
  }, 60_000);

  afterAll(async () => {
    if (env.url === undefined) delete process.env.THEMEBOT_CLOUD_URL; else process.env.THEMEBOT_CLOUD_URL = env.url;
    if (env.key === undefined) delete process.env.THEMEBOT_CLOUD_PUBKEY; else process.env.THEMEBOT_CLOUD_PUBKEY = env.key;
    await cloud?.close();
    await sites?.close();
    for (const dir of [oldWs, newWs]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('scores the fixture identically (sections, interactions, composite, reports)', async () => {
    const siteEnv = { REACT_BASE: sites.reactBase, SHOPIFY_BASE: sites.shopifyBase, ITER: '1', STORE_PASSWORD: '' };

    // OLD: the local scripts, exactly as server/factory/qa.ts runs them.
    await runNode(path.join(OLD_QA, 'section-compare.mjs'), oldWs, siteEnv);
    await runNode(path.join(OLD_QA, 'interaction-verify.mjs'), oldWs, siteEnv);
    const reports = (ws: string) => path.join(ws, 'qa', 'reports', 'factory');
    const oldSections = readJson(path.join(reports(oldWs), 'sections-1.json'));
    const oldInteractions = readJson(path.join(reports(oldWs), 'interactions-1.json'));
    const oldSubscores = { presence: oldSections.presence, text: oldSections.text, interaction: oldInteractions.interaction };
    const oldScore = compositeScore(oldSubscores);

    // NEW: capture on "the PC", scoring in the Cloud, through the real pass-carrying cloudFetch.
    process.env.THEMEBOT_CLOUD_URL = cloud.base;
    process.env.THEMEBOT_CLOUD_PUBKEY = cloud.publicKey;
    vi.resetModules();
    const client = await import('../server/cloud-client');
    const { runQaCloudPipeline } = await import('../server/factory/qa-cloud');
    expect(client.handleHostMessage({ type: 'pass', token: await cloud.pass(), account: { email: 'qa@example.com', plan: 'studio', seats: 3 } })).toBe(true);
    const result = await runQaCloudPipeline({
      workspace: newWs, reactBase: sites.reactBase, shopifyBase: sites.shopifyBase, storePassword: null, iteration: 1, qaMode: 'both',
      headed: false, weights: { presence: 0.5, text: 0.3, interaction: 0.2 }, jobName: 'Parity fixture', scoreThreshold: 0.9,
      buildRef: 'parity-job', timeoutMin: 4, captureDir: path.join(repo, 'templates', 'factory', 'qa-capture'), playwrightRoot: path.join(repo, 'node_modules'),
    });
    const newSections = readJson(path.join(reports(newWs), 'sections-1.json'));
    const newInteractions = readJson(path.join(reports(newWs), 'interactions-1.json'));

    console.log(`[parity] old composite=${oldScore.toFixed(4)} ${JSON.stringify(oldSubscores)}`);
    console.log(`[parity] new composite=${result.score.toFixed(4)} ${JSON.stringify(result.subscores)}`);
    console.log(`[parity] payload bytes ${JSON.stringify(result.payloadBytes)}`);

    // Same reports, field for field (ids, titles, details, per-page numbers).
    expect(newSections).toEqual(oldSections);
    expect(newInteractions).toEqual(oldInteractions);
    expect(readFileSync(path.join(reports(newWs), 'sections-1.md'), 'utf8')).toBe(readFileSync(path.join(reports(oldWs), 'sections-1.md'), 'utf8'));
    expect(readFileSync(path.join(reports(newWs), 'interactions-1.md'), 'utf8')).toBe(readFileSync(path.join(reports(oldWs), 'interactions-1.md'), 'utf8'));
    expect(result.subscores).toEqual(oldSubscores);
    expect(result.score).toBe(oldScore);
    expect(result.issueCount).toBe(oldSections.issues.length + oldInteractions.issues.length);

    // The fixture's planted defects were all found.
    const kinds = [...newSections.issues, ...newInteractions.issues].map((issue: { kind: string }) => issue.kind).sort();
    expect(kinds).toEqual(['interaction_noop', 'interaction_target', 'missing_interaction', 'missing_section', 'text_drift']);
    expect(newInteractions.informational.map((issue: { kind: string }) => issue.kind)).toEqual(['extra_interaction', 'extra_interaction']);
    expect(newInteractions.pages.find((page: { route: string }) => page.route === '/').verifiedStatic).toBe(1); // Add to cart: never clicked

    // Summary written where the fix agent reads it; screenshots where the Pictures tab looks.
    const summary = readFileSync(path.join(newWs, result.summaryPath), 'utf8');
    expect(summary).toContain(`**Composite score: ${(oldScore * 100).toFixed(1)}%**`);
    expect(summary).toContain(`## FIX THESE (${result.issueCount}, in priority order)`);
    for (const shot of ['_home/react-desktop.png', '_home/shopify-mobile.png', '_about/shopify-desktop.png']) {
      expect(existsSync(path.join(oldWs, 'qa', 'screenshots', 'factory', '1', shot))).toBe(true);
      expect(existsSync(path.join(newWs, 'qa', 'screenshots', 'factory', '1', shot))).toBe(true);
    }
    // Small uploads, no screenshots.
    const total = Object.values(result.payloadBytes).reduce((sum, bytes) => sum + bytes, 0);
    expect(total).toBeLessThan(1024 * 1024);
  }, 300_000);

  it('segments real pages exactly like the old in-page segmenter', async () => {
    // @ts-expect-error — plain-JS templates
    const oldLib = await import('../templates/factory/qa/qa-shared.mjs');
    // @ts-expect-error — plain-JS templates
    const capture = await import('../templates/factory/qa-capture/capture-lib.mjs');
    const { chromium } = await capture.loadPlaywright();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const band = (text: string, style = 'min-height:200px') => `<section style="${style}"><h2>${text}</h2><p>${text} body copy with enough words to count.</p><img alt="${text}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></section>`;
      const layouts = [
        // plain main with bands, one too short, one too narrow
        `<main>${band('Alpha')}${band('Short', 'height:80px')}${band('Narrow', 'width:40%;min-height:300px')}${band('Omega')}</main>`,
        // no main: body > #root > .app > [header, .content > bands] (wrapper chain)
        `<div id="root"><div class="app"><header>Top</header><div class="content">${band('One')}${band('Two')}${band('Three')}</div><footer>Bottom</footer></div></div>`,
        // a single wrapper with a single child (the old segmenter stops there)
        `<div id="root"><div class="only">${band('Solo')}</div></div>`,
        // a deep chain of wrappers (deeper than the unwrap limit)
        `<div><div><div><div><div><div>${band('Deep A')}${band('Deep B')}</div></div></div></div></div></div>`,
        // empty page
        '',
      ];
      for (const body of layouts) {
        await page.setContent(`<!doctype html><html><body style="margin:0">${body}</body></html>`);
        const before = await oldLib.segmentSections(page);
        const after = segmentLayout(await capture.dumpLayout(page));
        expect(after).toEqual(before);
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});
