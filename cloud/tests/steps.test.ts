import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RECIPE_DIR, loadRecipe, placeholdersIn, renderPlaceholders } from '../src/steps/recipe';
import { normalizePages, slugForRoute } from '../src/steps/plan';
import { MAX_STEP_ROWS_PER_BUILD } from '../src/steps/store';
import { FP_B, MINUTE, PAGES, buildRequest, startStepsCloud, type StepsCloud } from './steps-harness';

const recipe = loadRecipe();
const session = 'session-aaaa-0001';

/** Every recipe canary (one per recipe file). */
function recipeCanaries(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else for (const match of readFileSync(full, 'utf8').matchAll(/tbr-canary-[0-9a-f]{12}/g)) found.add(match[0]);
    }
  };
  walk(DEFAULT_RECIPE_DIR);
  return [...found];
}

describe('the recipe', () => {
  it('loads, has a version, and every fragment it defines reaches some step (no know-how dropped)', () => {
    expect(recipe.version).toMatch(/^\d{4}\.\d{2}\.\d{2}/);
    const unused = recipe.fragments.defined.filter((id) => !recipe.fragments.used.includes(id));
    expect(unused).toEqual([]);
    for (let rule = 1; rule <= 16; rule += 1) expect(recipe.fragments.used).toContain(`rule-${rule}`);
    expect(recipeCanaries().length).toBeGreaterThanOrEqual(14);
  });

  it('renders placeholders in one pass and leaves Liquid alone', () => {
    expect(renderPlaceholders('{{NAME}} / {{ a == b }} / {{ l.url }}', { NAME: '{{ROOT}}' })).toBe('{{ROOT}} / {{ a == b }} / {{ l.url }}');
    expect(renderPlaceholders('{{NOPE}}', {})).toBe('(unknown)');
  });

  it('sends each step only the know-how it needs', () => {
    const values = { NAME: 'X', PREFIX: 'ws', ROOT: '/r', REACT_URL: 'https://r.example', STORE_URL: 'https://s.myshopify.com', STORE_HOST: 's.myshopify.com', DEV_THEME_NAME: 'X dev', SIGNAL: 'factory/steps/x.done', STEP_ID: 'x', RECIPE_VERSION: recipe.version };
    const page = { ...values, PAGE_ROUTE: '/about', PAGE_NAME: 'About', PAGE_SLUG: 'about', PAGE_HANDLE: 'about', PAGE_TEMPLATE: 'page.ws_about.json', PAGE_REACT_FILE: 'src/pages/AboutPage.tsx', PAGE_BANDS: '3', REACT_PAGE_URL: 'https://r.example/about', REBUILD_NOTE: '' };
    const preflight = recipe.step('preflight', values).prompt;
    const build = recipe.step('page', page).prompt;
    const final = recipe.step('final', values).prompt;
    // The page step carries all 16 patterns and the code lessons; preflight and final carry none.
    for (const marker of ['full-width', 'cubic-bezier(.165,.84,.44,1)', 'document.currentScript && document.currentScript.closest', 'white-space: nowrap', "removeAttribute('hidden')", 'image_picker']) {
      expect(build).toContain(marker);
      expect(final).not.toContain(marker);
    }
    expect(preflight).not.toContain('cubic-bezier');
    expect(preflight).toContain('canary');
    expect(preflight).toContain('ABORTED.md');
    expect(build).not.toContain('PROJECT IDENTITY CHECK');
    expect(recipe.step('verify', page).prompt).toContain('Fixer');
    expect(recipe.step('store-setup', values).prompt).toContain('model: "haiku"');
    expect(recipe.step('inventory', values).prompt).toContain('"model": "opus"');
    for (const kind of ['preflight', 'inventory', 'bootstrap', 'store-setup', 'final'] as const) expect(placeholdersIn(recipe.step(kind, values).prompt)).toEqual([]);
    expect(placeholdersIn(build)).toEqual([]);
  });
});

describe('pages', () => {
  it('slugs routes stably and drops junk', () => {
    expect(slugForRoute('/')).toBe('home');
    expect(slugForRoute('/Our_Team/')).toBe('our-team');
    expect(slugForRoute('/products/blue-mug')).toBe('products-blue-mug');
    const pages = normalizePages([{ route: '/a' }, { route: '/a' }, { route: 'nope' }, { route: '/a b' }, null, { route: '/A' }, { route: '/x', model: 'gpt' }]);
    expect(pages.map((page) => [page.route, page.slug])).toEqual([['/a', 'a'], ['/A', 'a-2'], ['/x', 'x']]);
    expect(pages[2].model).toBeNull();
  });
});

describe('the step engine', () => {
  let t: StepsCloud;
  let pass: string;
  let owner: Awaited<ReturnType<StepsCloud['account']>>;
  beforeEach(async () => { t = await startStepsCloud(); owner = await t.account('owner@example.com'); pass = owner.pass; });
  afterEach(async () => { await t.close(); });

  const next = (buildId: string, body: Record<string, unknown> = {}) => t.builds(pass, 'POST', `/${buildId}/next`, { session, ...body });
  const done = (buildId: string, stepId: string, outcome = 'done', extra: Record<string, unknown> = {}) => t.builds(pass, 'POST', `/${buildId}/result`, { stepId, outcome, session, ...extra });
  const create = async (overrides: Record<string, unknown> = {}) => {
    const created = await t.builds(pass, 'POST', '', buildRequest(overrides));
    expect(created.status).toBe(201);
    return created.body.buildId as string;
  };
  const runCore = async (buildId: string) => {
    for (const id of ['preflight', 'inventory', 'bootstrap', 'store-setup']) {
      const answer = await next(buildId);
      expect(answer.body.step?.id).toBe(id);
      await done(buildId, id);
      if (id === 'inventory') expect((await t.builds(pass, 'POST', `/${buildId}/pages`, { pages: PAGES })).status).toBe(200);
    }
  };

  it('hands out the steps in order with rendered placeholders, then fans out one step per page', async () => {
    const buildId = await create();
    const first = await next(buildId);
    expect(first.status).toBe(200);
    expect(first.body.recipeVersion).toBe(recipe.version);
    const step = first.body.step;
    expect(step).toMatchObject({ id: 'preflight', kind: 'preflight', title: 'Getting ready', model: 'sonnet', signal: 'factory/steps/preflight.done', attempt: 1 });
    expect(step.parallelGroup).toBeUndefined();
    expect(step.prompt).toContain('Wild & Sacred');
    expect(step.prompt).toContain('C:\\builds\\wild_sacred');
    expect(step.prompt).toContain('https://wild-sacred.example.com');
    expect(step.prompt).toContain('https://wild-sacred.myshopify.com');
    expect(step.prompt).toContain('`ws-`');
    expect(step.prompt).toContain('`factory/steps/preflight.done`');
    expect(placeholdersIn(step.prompt)).toEqual([]);
    expect(first.body.plan.map((entry: { id: string }) => entry.id)).toEqual(['preflight', 'inventory', 'bootstrap', 'store-setup', 'final']);
    expect(first.body.plan[0].status).toBe('running');
    // Without a result and without saying it is running, asking again re-issues it (attempt 2).
    expect((await next(buildId, { running: ['preflight'] })).body.wait).toBe(true);
    await done(buildId, 'preflight');

    for (const id of ['inventory', 'bootstrap', 'store-setup']) {
      const answer = await next(buildId);
      expect(answer.body.step.id).toBe(id);
      await done(buildId, id);
      if (id === 'inventory') await t.builds(pass, 'POST', `/${buildId}/pages`, { pages: PAGES });
    }

    // Pages: up to N at once (the app says what's running); each page's check before new pages.
    const a = (await next(buildId)).body.step;
    expect(a).toMatchObject({ id: 'page:home', kind: 'page', parallelGroup: 'pages', model: 'opus', page: { route: '/', slug: 'home', name: 'Home' } });
    expect(a.title).toBe('Building page: Home');
    expect(a.prompt).toContain('templates/index.json');
    const b = (await next(buildId, { running: ['page:home'] })).body.step;
    expect(b).toMatchObject({ id: 'page:about', model: 'sonnet' });
    expect(b.prompt).toContain('https://wild-sacred.example.com/about');
    expect(b.prompt).toContain('templates/page.ws_about.json');
    expect(placeholdersIn(b.prompt)).toEqual([]);
    await done(buildId, 'page:about');
    const c = (await next(buildId, { running: ['page:home'] })).body.step;
    expect(c.id).toBe('verify:about');
    expect(c.title).toBe('Checking page: About');
    const d = (await next(buildId, { running: ['page:home', 'verify:about'] })).body.step;
    expect(d).toMatchObject({ id: 'page:our-team', model: 'opus', page: { name: 'Our Team' } });
    expect(d.prompt).toContain('templates/page.ws_our_team.json');
    expect((await next(buildId, { running: ['page:home', 'verify:about', 'page:our-team'] })).body.wait).toBe(true);
    for (const id of ['page:home', 'verify:about', 'page:our-team']) await done(buildId, id);
    expect((await next(buildId)).body.step.id).toBe('verify:home');
    await done(buildId, 'verify:home');
    expect((await next(buildId, { running: ['verify:our-team'] })).body.wait).toBe(true);
    expect((await next(buildId)).body.step.id).toBe('verify:our-team');
    await done(buildId, 'verify:our-team');
    const final = (await next(buildId)).body;
    expect(final.step).toMatchObject({ id: 'final', model: 'haiku', signal: 'factory/steps/final.done' });
    await done(buildId, 'final');
    const finished = await next(buildId);
    expect(finished.body.done).toBe(true);
    expect(finished.body.plan.every((entry: { status: string }) => entry.status === 'done')).toBe(true);
    const status = await t.builds(pass, 'GET', `/${buildId}`);
    expect(status.body.build.status).toBe('done');
    expect(JSON.stringify(status.body)).not.toContain('tbr-canary');
  });

  it('re-issues a failed step, blocks after two failures in a session, and tries again on resume', async () => {
    const buildId = await create();
    expect((await next(buildId)).body.step.id).toBe('preflight');
    await done(buildId, 'preflight', 'failed', { detail: 'exited without the signal file' });
    const again = (await next(buildId)).body.step;
    expect(again).toMatchObject({ id: 'preflight', attempt: 2 });
    await done(buildId, 'preflight', 'failed');
    const blocked = await next(buildId);
    expect(blocked.body.blocked).toMatch(/Getting ready.*2 tries/);
    expect(blocked.body.code).toBe('STEP_FAILED');
    // Resume = a new app session: the step is handed out again.
    const resumed = await t.builds(pass, 'POST', `/${buildId}/next`, { session: 'session-bbbb-0002' });
    expect(resumed.body.step).toMatchObject({ id: 'preflight', attempt: 3 });
  });

  it('skips a page that keeps failing so the others finish', async () => {
    const buildId = await create();
    await runCore(buildId);
    expect((await next(buildId)).body.step.id).toBe('page:home');
    await done(buildId, 'page:home', 'failed');
    expect((await next(buildId)).body.step.id).toBe('page:home');
    await done(buildId, 'page:home', 'failed');
    const answer = await next(buildId);
    expect(answer.body.step.id).toBe('page:about');
    const plan = Object.fromEntries(answer.body.plan.map((entry: { id: string; status: string }) => [entry.id, entry.status]));
    expect(plan['page:home']).toBe('skipped');
    expect(plan['verify:home']).toBe('skipped');
  });

  it('resumes after an aborted or blocked run at the step that stopped', async () => {
    const buildId = await create();
    expect((await next(buildId)).body.step.id).toBe('preflight');
    await done(buildId, 'preflight', 'aborted', { detail: 'identity mismatch' });
    const stopped = await next(buildId, { facts: { aborted: 'Identity mismatch: the store is someone else\'s' } });
    expect(stopped.body).toMatchObject({ code: 'ABORTED' });
    expect(stopped.body.step).toBeUndefined();
    expect((await t.builds(pass, 'GET', `/${buildId}`)).body.build.status).toBe('aborted');
    // The user fixed it and pressed Resume: ABORTED.md is gone, preflight runs again.
    expect((await next(buildId)).body.step).toMatchObject({ id: 'preflight', attempt: 2 });
    await done(buildId, 'preflight');
    expect((await next(buildId, { facts: { blocked: 'missing write_themes' } })).body.code).toBe('BLOCKED');
    expect((await next(buildId)).body.step.id).toBe('inventory');
  });

  it('blocks when the plan has no pages, and accepts results it never saw handed out', async () => {
    const buildId = await create();
    const answer = await next(buildId, { finished: [{ id: 'preflight', outcome: 'done' }, { id: 'inventory', outcome: 'done' }, { id: 'nope', outcome: 'done' }] });
    expect(answer.body.step.id).toBe('bootstrap');
    await done(buildId, 'bootstrap');
    await done(buildId, 'store-setup');
    expect((await next(buildId)).body.blocked).toMatch(/no pages/);
  });

  it('treats a core step that reports done without its required files as a failed attempt', async () => {
    const buildId = await create();
    const all = { inventory: true, handles: true, images: true, theme: true, bootstrap: true, final: false };
    for (const id of ['preflight', 'inventory']) { expect((await next(buildId, { facts: { files: all } })).body.step.id).toBe(id); await done(buildId, id); }
    await t.builds(pass, 'POST', `/${buildId}/pages`, { pages: PAGES });
    expect((await next(buildId, { facts: { files: all } })).body.step.id).toBe('bootstrap');
    await done(buildId, 'bootstrap');
    // bootstrap said done, but push.mjs's qa/state/theme.json isn't there: bootstrap runs again.
    const again = await next(buildId, { facts: { files: { ...all, theme: false } } });
    expect(again.body.step).toMatchObject({ id: 'bootstrap', attempt: 2 });
    expect(again.body.plan.find((entry: { id: string }) => entry.id === 'bootstrap').status).toBe('running');
    await done(buildId, 'bootstrap');
    // Still missing after the second try (both files this time): blocked, naming the files.
    const blocked = await next(buildId, { facts: { files: { ...all, theme: false, bootstrap: false } } });
    expect(blocked.body.code).toBe('STEP_FAILED');
    expect(blocked.body.blocked).toMatch(/qa\/state\/theme\.json and qa\/state\/bootstrap\.json are missing/);
    // Resume (a new session) once the files exist: bootstrap is handed out again, then store-setup.
    const resumed = await t.builds(pass, 'POST', `/${buildId}/next`, { session: 'session-cccc-0003', facts: { files: all } });
    expect(resumed.body.step).toMatchObject({ id: 'bootstrap', attempt: 3 });
    await t.builds(pass, 'POST', `/${buildId}/result`, { stepId: 'bootstrap', outcome: 'done', session: 'session-cccc-0003' });
    expect((await t.builds(pass, 'POST', `/${buildId}/next`, { session: 'session-cccc-0003', facts: { files: all } })).body.step.id).toBe('store-setup');
    // store-setup without qa/state/handles.json, inventory without inventory.json: same rule.
    await t.builds(pass, 'POST', `/${buildId}/result`, { stepId: 'store-setup', outcome: 'done', session: 'session-cccc-0003' });
    const redo = await t.builds(pass, 'POST', `/${buildId}/next`, { session: 'session-cccc-0003', facts: { files: { ...all, handles: false, inventory: false } } });
    expect(redo.body.step).toMatchObject({ id: 'inventory', attempt: 2 });
    // An app that reports no files (older versions) is trusted as before.
    const legacy = await create();
    expect((await next(legacy, { finished: [{ id: 'preflight', outcome: 'done' }, { id: 'inventory', outcome: 'done' }, { id: 'bootstrap', outcome: 'done' }] })).body.step.id).toBe('store-setup');
  });

  it('ignores repeated late results and caps the rows a build can collect', async () => {
    const buildId = await create();
    const late = (entries: Array<Record<string, unknown>>) => next(buildId, { running: ['preflight'], finished: entries });
    // The same late result over and over adds one row.
    await late(Array.from({ length: 150 }, () => ({ id: 'bootstrap', outcome: 'failed' })));
    await late([{ id: 'bootstrap', outcome: 'failed' }]);
    const history = (await t.builds(pass, 'GET', `/${buildId}`)).body.history as Array<{ step: string }>;
    expect(history.filter((entry) => entry.step === 'bootstrap')).toHaveLength(1);
    // Alternating outcomes would add a row each — up to the per-build cap, then nothing more.
    const flipping = Array.from({ length: 200 }, (_, index) => ({ id: 'store-setup', outcome: index % 2 ? 'failed' : 'killed' }));
    for (let call = 0; call < 27; call += 1) expect((await late(flipping)).status).toBe(200);
    const capped = (await t.builds(pass, 'GET', `/${buildId}`)).body.history as unknown[];
    expect(capped).toHaveLength(MAX_STEP_ROWS_PER_BUILD);
  }, 60_000);

  it('renders rebuild notes only for pages already built', async () => {
    const buildId = await create({ rebuiltRoutes: ['/about'] });
    await runCore(buildId);
    const home = (await next(buildId)).body.step;
    const about = (await next(buildId, { running: ['page:home'] })).body.step;
    expect(home.prompt).not.toContain('THIS IS A REBUILD');
    expect(about.prompt).toContain('THIS IS A REBUILD');
  });

  it('renders the fix prompt with the report path, the inline conventions and the regression banner', async () => {
    const buildId = await create();
    const fix = await t.builds(pass, 'POST', `/${buildId}/fix`, { iter: 3, summary: { reportPath: 'qa/reports/factory/qa-summary-3.md', issueCount: 7, regressed: true } });
    expect(fix.status).toBe(200);
    expect(fix.body).toMatchObject({ model: 'opus', signal: 'qa/reports/fix-complete-3.md', title: 'Fix round 3' });
    const prompt: string = fix.body.prompt;
    expect(prompt).toContain('C:\\builds\\wild_sacred\\qa\\reports\\factory\\qa-summary-3.md');
    expect(prompt).toContain('iteration 3 for Wild & Sacred');
    expect(prompt).toContain('7 finding(s)');
    expect(prompt).toContain('REGRESSION WARNING');
    expect(prompt).toContain('`qa/reports/fix-complete-3.md`');
    expect(prompt).not.toContain('seed/CONVENTIONS.md');
    for (let rule = 1; rule <= 16; rule += 1) expect(prompt).toMatch(new RegExp(`\\n${rule}\\. \\*\\*`));
    expect(prompt.indexOf('Mandatory patterns')).toBeLessThan(prompt.indexOf('Completion signal'));
    expect(placeholdersIn(prompt)).toEqual([]);
    const calm = await t.builds(pass, 'POST', `/${buildId}/fix`, { iter: 4, summary: { reportPath: 'qa/reports/factory/qa-summary-4.md' } });
    expect(calm.body.prompt).not.toContain('REGRESSION WARNING');
    expect((await t.builds(pass, 'POST', `/${buildId}/fix`, { iter: 5, summary: { reportPath: '../../etc/passwd' } })).status).toBe(400);
  });

  it('does not expand placeholders smuggled in through job details', async () => {
    const buildId = await create({ name: 'Evil {{ROOT}} {{SIGNAL}}' });
    const prompt: string = (await next(buildId)).body.step.prompt;
    expect(prompt).toContain('Evil {{ROOT}} {{SIGNAL}}');
  });

  it('validates build requests', async () => {
    expect((await t.builds(pass, 'POST', '', buildRequest({ prefix: 'toolong' }))).status).toBe(400);
    expect((await t.builds(pass, 'POST', '', buildRequest({ storeHost: 'example.com' }))).status).toBe(400);
    expect((await t.builds(pass, 'POST', '', buildRequest({ reactUrl: 'javascript:alert(1)' }))).status).toBe(400);
    expect((await t.builds(pass, 'POST', '', buildRequest({ root: '' }))).status).toBe(400);
    const buildId = await create();
    expect((await t.builds(pass, 'POST', `/${buildId}/next`, { session: 'x' })).status).toBe(400);
    expect((await t.builds(pass, 'POST', `/${buildId}/result`, { stepId: 'page:../x', outcome: 'done' })).status).toBe(400);
    expect((await t.builds(pass, 'POST', `/${buildId}/result`, { stepId: 'preflight', outcome: 'great' })).status).toBe(400);
  });

  describe('entitlement', () => {
    it('refuses calls without a pass, or with a forged one', async () => {
      const buildId = await create();
      expect((await t.call('POST', `/v1/builds/${buildId}/next`, { session })).body.code).toBe('PASS_REQUIRED');
      expect((await t.call('POST', '/v1/builds', buildRequest())).status).toBe(401);
      const forged = await t.builds(`${pass.split('.')[0]}.${'A'.repeat(86)}`, 'POST', `/${buildId}/next`, { session });
      expect(forged.status).toBe(401);
      expect(forged.body.code).toBe('PASS_INVALID');
    });

    it("hides one account's builds from another account", async () => {
      const buildId = await create();
      const other = await t.account('other@example.com', FP_B);
      for (const [method, route, body] of [['POST', `/${buildId}/next`, { session }], ['POST', `/${buildId}/fix`, { iter: 1, summary: { reportPath: 'qa/reports/x.md' } }], ['POST', `/${buildId}/result`, { stepId: 'preflight', outcome: 'done' }], ['GET', `/${buildId}`, undefined], ['POST', `/${buildId}/pages`, { pages: PAGES }]] as const) {
        const answer = await t.builds(other.pass, method, route, body);
        expect(answer.status, `${method} ${route}`).toBe(404);
        expect(answer.body.code).toBe('NOT_FOUND');
        expect(JSON.stringify(answer.body)).not.toContain('prompt');
      }
      expect((await next(buildId)).body.step.id).toBe('preflight'); // the owner still can
    });

    it('refuses an expired pass and a revoked account', async () => {
      const buildId = await create();
      t.advance(16 * MINUTE);
      const expired = await next(buildId);
      expect(expired.status).toBe(401);
      expect(expired.body.code).toBe('PASS_EXPIRED');
      // The app's next heartbeat brings a fresh pass, and the build carries on…
      pass = await t.pass(owner.refreshToken, owner.fingerprint);
      expect((await next(buildId)).body.step.id).toBe('preflight');
      // …until the account is revoked: even an unexpired pass is refused at once, with nothing handed out.
      expect((await t.admin('POST', `/accounts/${owner.accountId}/revoke`)).status).toBe(200);
      for (const answer of [await next(buildId), await t.builds(pass, 'POST', `/${buildId}/fix`, { iter: 1, summary: { reportPath: 'qa/reports/x.md' } }), await t.builds(pass, 'POST', '', buildRequest())]) {
        expect(answer.status).toBe(403);
        expect(answer.body.code).toBe('ACCOUNT_INACTIVE');
        expect(answer.body.step).toBeUndefined();
        expect(answer.body.prompt).toBeUndefined();
      }
    });
  });

  it('passes every prompt through decoratePrompt with the build context', async () => {
    await t.close();
    const seen: Array<Record<string, unknown>> = [];
    t = await startStepsCloud({ decoratePrompt: (prompt, context) => { seen.push({ ...context }); return `${prompt}\n<!-- mark:${context.accountId}:${context.stepId} -->`; } });
    owner = await t.account('owner@example.com');
    pass = owner.pass;
    const buildId = await create();
    const step = (await next(buildId)).body.step;
    expect(step.prompt).toContain(`<!-- mark:${owner.accountId}:preflight -->`);
    const fix = await t.builds(pass, 'POST', `/${buildId}/fix`, { iter: 1, summary: { reportPath: 'qa/reports/factory/qa-summary-1.md' } });
    expect(fix.body.prompt).toContain(`<!-- mark:${owner.accountId}:fix:1 -->`);
    expect(seen[0]).toMatchObject({ accountId: owner.accountId, buildId, stepId: 'preflight', kind: 'preflight', attempt: 1, recipeVersion: recipe.version });
    expect(typeof seen[0].deviceId).toBe('string');
  });
});
