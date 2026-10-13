// The QA scoring API over HTTP: pass required, golden parity end to end, signed click plans,
// the fixed-issue delta (client-sent or remembered by the Cloud), body limits and validation.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloudDb } from '../src/db';
import { QA_WORK_PER_HOUR } from '../src/qa/routes';
import { MAX_ROUNDS_PER_ACCOUNT, MAX_STORED_KEY_BYTES, ensureQaSchema, previousRoundKeys, saveRound } from '../src/qa/store';
import { startQaCloud, type QaTestCloud } from './qa-harness';

const canned = path.resolve(import.meta.dirname, '../../tests/fixtures/qa/canned');
const json = (name: string) => JSON.parse(readFileSync(path.join(canned, name), 'utf8'));
const text = (name: string) => readFileSync(path.join(canned, name), 'utf8');

let t: QaTestCloud;
let pass: string;
beforeAll(async () => { t = await startQaCloud(); pass = await t.pass('owner@example.com'); });
afterAll(async () => { await t.close(); });

const sectionsBody = () => { const capture = json('capture-sections.json'); return { buildRef: 'job-1', iter: 1, reactBase: capture.reactBase, shopifyBase: capture.shopifyBase, routes: capture.routes }; };
const planBody = () => { const inventory = json('capture-inventory.json'); return { buildRef: 'job-1', iter: 1, handles: inventory.handles, routes: inventory.routes }; };

describe('QA API', () => {
  it('requires a valid pass on every route', async () => {
    for (const route of ['/sections', '/interactions/plan', '/interactions/score', '/summary', '/calibrate']) {
      const anonymous = await t.call('POST', `/v1/qa${route}`, { iter: 1 });
      expect(anonymous.status).toBe(401);
      expect(anonymous.body.code).toBe('PASS_REQUIRED');
      expect((await t.call('POST', `/v1/qa${route}`, { iter: 1 }, { Authorization: 'Pass not.a-pass' })).body.code).toBe('PASS_INVALID');
    }
  });

  it('scores a real capture exactly like the old local scripts (sections, plan → clicks → score)', async () => {
    const sections = await t.qa('/sections', sectionsBody(), pass);
    expect(sections.status).toBe(200);
    expect(sections.body.report).toEqual(json('golden-sections-1.json'));
    expect(sections.body.markdown).toBe(text('golden-sections-1.md'));

    const planned = await t.qa('/interactions/plan', planBody(), pass);
    expect(planned.status).toBe(200);
    const { plan } = planned.body;
    expect(plan.sig).toMatch(/^[\w-]{43}$/);
    expect(plan.clicks.map((click: { react: { name: string } }) => click.react.name)).toEqual(['Show ingredients', 'Open gallery', 'Read more']);
    const inventory = json('capture-inventory.json');
    const scored = await t.qa('/interactions/score', { plan, effects: json('capture-effects.json').effects, reactBase: inventory.reactBase, shopifyBase: inventory.shopifyBase }, pass);
    expect(scored.status).toBe(200);
    expect(scored.body.report).toEqual(json('golden-interactions-1.json'));
    expect(scored.body.markdown).toBe(text('golden-interactions-1.md'));
    // what a typical round uploads
    expect(sections.bytes + planned.bytes + scored.bytes).toBeLessThan(64 * 1024);
  });

  it('refuses a changed click plan, or one issued to another account', async () => {
    const { plan } = (await t.qa('/interactions/plan', planBody(), pass)).body;
    const effects = json('capture-effects.json').effects;
    const tampered = structuredClone(plan);
    tampered.routes[0].page.same += 5;
    const refused = await t.qa('/interactions/score', { plan: tampered, effects }, pass);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('PLAN_INVALID');
    expect((await t.qa('/interactions/score', { plan: { ...plan, sig: undefined }, effects }, pass)).body.code).toBe('PLAN_INVALID');
    const otherPass = await t.pass('other@example.com', 'e'.repeat(64));
    expect((await t.qa('/interactions/score', { plan, effects }, otherPass)).body.code).toBe('PLAN_INVALID');
    expect((await t.qa('/interactions/score', { plan, effects }, pass)).status).toBe(200);
  });

  it('builds the summary with the client\'s N-1 issues, or with the round the Cloud remembers', async () => {
    const golden = json('golden-sections-1.json');
    const interactions = json('golden-interactions-1.json');
    const sections = { presence: golden.presence, text: golden.text, pages: golden.pages.map((page: { route: string; status: string }) => ({ route: page.route, status: page.status })), issues: golden.issues };
    const base = { buildRef: 'job-delta', jobName: 'Tea shop', scoreThreshold: 0.92, interactions: { interaction: interactions.interaction, issues: interactions.issues }, weights: { presence: 0.5, text: 0.3, interaction: 0.2 } };

    const first = await t.qa('/summary', { ...base, iter: 1, sections }, pass);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ issueCount: 5, captureFailed: false, deltaSource: 'none', breakdown: { issues: 5, fixed: 0, unreachable: 0, pages: 2, handlesMissing: false } });
    expect(first.body.score).toBeCloseTo(0.5 * golden.presence + 0.3 * golden.text + 0.2 * interactions.interaction, 12);
    expect(first.body.summaryMarkdown).toContain('# QA summary — iteration 1 for Tea shop');

    // Round 2 fixed the text drift. Without prevIssues the Cloud uses its record of round 1.
    const fixed = { ...sections, issues: sections.issues.filter((issue: { kind: string }) => issue.kind !== 'text_drift') };
    const second = await t.qa('/summary', { ...base, iter: 2, sections: fixed }, pass);
    expect(second.body).toMatchObject({ deltaSource: 'cloud', issueCount: 4, breakdown: { fixed: 1 } });
    expect(second.body.summaryMarkdown).toContain('## Fixed since last iteration (1)\n\n- ~~/ — "Wild & Sacred botanical rituals" text drifts from React');

    // The client's own N-1 issues win over the Cloud's record.
    const clientSays = await t.qa('/summary', { ...base, iter: 2, sections: fixed, prevIssues: [] }, pass);
    expect(clientSays.body).toMatchObject({ deltaSource: 'client', breakdown: { fixed: 0 } });

    // Another account never sees this build's rounds.
    const otherPass = await t.pass('stranger@example.com', 'd'.repeat(64));
    expect((await t.qa('/summary', { ...base, iter: 2, sections: fixed }, otherPass)).body.deltaSource).toBe('none');
  });

  it('runs the calibration rubric', async () => {
    const band = (id: number, words: string) => ({ id, parent: -1, tag: 'SECTION', x: 0, y: id * 300, w: 1440, h: 300, childCount: 3, headings: [words], text: `${words} with body copy`, imgCount: 0, imgAlts: [], linkCount: 1, shapeHash: 'a' });
    const layout = { viewportWidth: 1440, root: 'main', blocks: ['crystal jewelry', 'spring collection', 'customer reviews', 'care and repair', 'studio newsletter'].map((words, index) => band(index, words)) };
    const ok = await t.qa('/calibrate', { reference: { layout }, candidate: { layout }, mode: 'fixture' }, pass);
    expect(ok.body).toMatchObject({ ok: true, score: 1, threshold: 0.95, sections: { reference: 5, candidate: 5, matched: 5 } });
    const thin = await t.qa('/calibrate', { reference: { layout: { ...layout, blocks: layout.blocks.slice(0, 2) } } }, pass);
    expect(thin.body).toMatchObject({ ok: false, score: 1 });
    expect(thin.body.error).toMatch(/only 2 section/);
    expect((await t.qa('/calibrate', {}, pass)).status).toBe(400);
  });

  it('accepts uploads far above the app-wide 16 kB limit, and refuses oversized or malformed ones', async () => {
    const body = sectionsBody();
    const big = { ...body, routes: Array.from({ length: 40 }, (_, index) => ({ ...body.routes[0], route: `/r${index}` })) };
    const accepted = await t.qa('/sections', big, pass);
    expect(accepted.bytes).toBeGreaterThan(100 * 1024);
    expect(accepted.status).toBe(200);
    expect(accepted.body.report.pages).toHaveLength(40);

    // gzip-compressed bodies are inflated (the limit applies to the inflated size)
    const zipped = await fetch(`${t.base}/v1/qa/sections`, { method: 'POST', headers: { Authorization: `Pass ${pass}`, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: gzipSync(JSON.stringify(big)) });
    expect(zipped.status).toBe(200);
    expect(((await zipped.json()) as { report: { pages: unknown[] } }).report.pages).toHaveLength(40);

    const huge = await t.qa('/sections', { ...body, routes: [{ route: '/', shopifyPath: '/', error: 'x'.repeat(9 * 1024 * 1024) }] }, pass);
    expect(huge.status).toBe(413);
    // A gzip bomb: ~20 kB on the wire, 20 MB inflated — refused at the limit, not inflated whole.
    const bomb = gzipSync(JSON.stringify({ ...body, pad: ' '.repeat(20 * 1024 * 1024) }));
    expect(bomb.length).toBeLessThan(64 * 1024);
    const bombed = await fetch(`${t.base}/v1/qa/sections`, { method: 'POST', headers: { Authorization: `Pass ${pass}`, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: bomb });
    expect(bombed.status).toBe(413);
    expect(((await bombed.json()) as { code: string }).code).toBe('TOO_LARGE');
    expect((await t.qa('/sections', { ...body, routes: Array.from({ length: 301 }, () => body.routes[0]) }, pass)).body.code).toBe('TOO_LARGE');
    expect((await t.qa('/sections', { ...body, iter: 0 }, pass)).body.code).toBe('BAD_REQUEST');
    expect((await t.qa('/sections', { ...body, routes: 'all' }, pass)).body.code).toBe('BAD_REQUEST');
    expect((await t.qa('/sections', { ...body, routes: [{ route: 'no-slash' }] }, pass)).body.code).toBe('BAD_REQUEST');
    expect((await t.qa('/sections', '{"iter":', pass)).body.code).toBe('BAD_REQUEST');
    expect((await t.qa('/summary', { iter: 1, buildRef: 'bad ref!', sections: { presence: 1 } }, pass)).body.code).toBe('BAD_REQUEST');
    expect((await t.qa('/summary', { iter: 1, weights: { presence: -1, text: 0, interaction: 0 }, sections: { presence: 1 } }, pass)).body.code).toBe('BAD_REQUEST');
  });
});

describe('QA resource limits', () => {
  const accountOf = (token: string) => (JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as { acc: string }).acc;
  const band = (id: number, text: string) => ({ id, parent: -1, tag: 'SECTION', x: 0, y: id * 200, w: 1440, h: 200, childCount: 1, headings: [], text, imgCount: 0, imgAlts: [], linkCount: 0, shapeHash: 'a' });
  const layout = (count: number, text: (index: number) => string) => ({ viewportWidth: 1440, root: 'main', blocks: Array.from({ length: count }, (_, index) => band(index, text(index))) });
  const control = (name: string) => ({ tag: 'BUTTON', name, ordinal: 1, kind: 'action', visible: true });

  it('refuses uploads crafted to make the quadratic scorers run for minutes, before scoring them', async () => {
    const dense = (index: number) => `${'ab cd ef '.repeat(220)}${index}`;
    const sections = { iter: 1, reactBase: 'r', shopifyBase: 's', routes: [{ route: '/', shopifyPath: '/', react: { ok: true, status: 200, layout: layout(500, dense) }, shopify: { status: 200, layout: layout(500, dense) } }] };
    const started = Date.now();
    const refused = await t.qa('/sections', sections, pass);
    expect([refused.status, refused.body.code]).toEqual([413, 'TOO_LARGE']);
    const calibration = await t.qa('/calibrate', { reference: { layout: layout(500, dense) } }, pass);
    expect([calibration.status, calibration.body.code]).toEqual([413, 'TOO_LARGE']);
    const names = (side: string) => Array.from({ length: 3000 }, (_, index) => control(`${side} ${'xy '.repeat(60)}${index}`));
    const plan = await t.qa('/interactions/plan', { iter: 1, handles: {}, routes: [{ route: '/', shopifyPath: '/', react: { ok: true, status: 200, items: names('r') }, shopify: { status: 200, items: names('s') } }] }, pass);
    expect([plan.status, plan.body.code]).toEqual([413, 'TOO_LARGE']);
    expect(Date.now() - started).toBeLessThan(10_000); // refused up front, not after minutes of scoring
    // Real-sized uploads are scored as before.
    expect((await t.qa('/sections', sectionsBody(), pass)).status).toBe(200);
  }, 60_000);

  it('caps scoring work per account per hour', async () => {
    const own = await t.pass('busy-qa@example.com', '9'.repeat(64));
    // Spend almost the whole hour's budget, as a stream of large rounds would.
    expect(t.ctx.limiter.spend(`acc:qa-work:${accountOf(own)}`, QA_WORK_PER_HOUR - 10, QA_WORK_PER_HOUR, 60 * 60_000).ok).toBe(true);
    const refused = await t.qa('/sections', sectionsBody(), own);
    expect([refused.status, refused.body.code]).toEqual([429, 'RATE_LIMITED']);
    expect(refused.body.retryAfterSec).toBeGreaterThan(0);
    expect((await t.qa('/sections', sectionsBody(), pass)).status).toBe(200); // other accounts are not affected
    // The refused request cost nothing, and the budget comes back with the next hour.
    expect(t.ctx.limiter.spend(`acc:qa-work:${accountOf(own)}`, 10, QA_WORK_PER_HOUR, 60 * 60_000).ok).toBe(true);
    t.advance(61 * 60_000);
    expect(t.ctx.limiter.spend(`acc:qa-work:${accountOf(own)}`, QA_WORK_PER_HOUR, QA_WORK_PER_HOUR, 60 * 60_000).ok).toBe(true);
  });

  it('bounds what the Cloud remembers per round and per account', () => {
    const db = new CloudDb(':memory:');
    try {
      ensureQaSchema(db);
      db.sql.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES ('acc_q', 'q@example.com', 0, 0)").run();
      const keys = Array.from({ length: 5000 }, (_, index) => `text_drift|/page-${index}|${'x'.repeat(100)}`);
      saveRound(db, { accountId: 'acc_q', deviceId: null, buildRef: 'job-1', iter: 1, score: 0.5, subscores: {}, issueKeys: [...keys, ...keys], captureFailed: false }, 1);
      const remembered = previousRoundKeys(db, 'acc_q', 'job-1', 2)!;
      expect(remembered.length).toBeGreaterThan(1000);
      expect(remembered).toEqual(keys.slice(0, remembered.length)); // in order, no duplicates
      expect(Buffer.byteLength(JSON.stringify(remembered))).toBeLessThanOrEqual(MAX_STORED_KEY_BYTES);
      for (let index = 0; index < MAX_ROUNDS_PER_ACCOUNT + 5; index += 1) {
        saveRound(db, { accountId: 'acc_q', deviceId: null, buildRef: `job-${index % 50}`, iter: 10 + index, score: 1, subscores: {}, issueKeys: [], captureFailed: false }, 10 + index);
      }
      expect(Number((db.sql.prepare("SELECT COUNT(*) AS n FROM qa_rounds WHERE account_id = 'acc_q'").get() as { n: number }).n)).toBe(MAX_ROUNDS_PER_ACCOUNT);
      expect(previousRoundKeys(db, 'acc_q', 'job-1', 2)).toBeNull(); // the oldest round went first
    } finally { db.close(); }
  }, 30_000);
});
