// ThemeBot Cloud step engine — the build recipe, one step at a time, to a signed-in app.
//
//   POST /v1/builds               { name, prefix, storeHost|storeUrl, reactUrl, root, devThemeName?, qaEngine?, pages?, rebuiltRoutes?, appVersion? }
//                                 → 201 { buildId, recipeVersion, plan }
//   GET  /v1/builds/:id           → { build, plan, history }            (status only — never prompts)
//   POST /v1/builds/:id/pages     { pages: [...], replace?: true }      → { pages, plan }   (from qa/state/inventory.json)
//   POST /v1/builds/:id/next      { session, running?, finished?, facts?: { blocked?, aborted?, files?: { inventory, theme, bootstrap, handles, final, … } } }
//                                 → { step } | { wait: true } | { done: true } | { blocked: reason }   (+ plan, recipeVersion)
//   POST /v1/builds/:id/result    { stepId, outcome, detail?, session? } → { ok, plan }
//   POST /v1/builds/:id/fix       { iter, summary: { reportPath, issueCount?, regressed? }, session? }
//                                 → { prompt, model, signal, title, recipeVersion }
//
// Every call needs a valid pass (requirePass: signature, expiry, account usable, device signed in)
// and the build must belong to the pass's account — anyone else gets 404, as if it didn't exist.
// Prompts are rendered here (placeholders filled server-side), passed through `decoratePrompt`
// (identity by default; the watermark plugs in there) and never stored.
import { Router, type Express } from 'express';
import { CloudError, bodyOf, handle, iso, type CloudContext } from '../context';
import { requirePass, type PassLocals } from '../middleware';
import { limitByIp } from '../rate-limit';
import { decideNext, issueCap, missingOutputs, normalizePages, pageModel, planSteps, planView, signalFor, slugForRoute, MAX_PAGES, REQUIRED_OUTPUTS, type BuildPage, type PlannedStep } from './plan';
import { loadRecipe, type Recipe, type RecipeModel } from './recipe';
import { STEP_OUTCOMES, countFixIssues, createBuild, getBuildRow, loadBuild, recordIssue, recordResult, rejectDone, savePages, setBuildStatus, stepHistory, stepRecords, type BuildMeta, type LoadedBuild, type StepOutcome } from './store';

/** What a prompt decorator learns about the prompt it is decorating. */
export interface PromptContext {
  accountId: string;
  deviceId: string;
  buildId: string;
  /** 'preflight', 'page:about', 'fix:3', ... */
  stepId: string;
  kind: string;
  attempt: number;
  recipeVersion: string;
}
/** Hook for Phase 4's watermark: gets every prompt before it leaves the Cloud. Default: unchanged. */
export type PromptDecorator = (prompt: string, context: PromptContext) => string;
export const identityDecorator: PromptDecorator = (prompt) => prompt;

export interface StepRouteOptions {
  decoratePrompt?: PromptDecorator;
  /** A preloaded recipe (tests); default: loadRecipe() from cloud/recipe or CLOUD_RECIPE_DIR. */
  recipe?: Recipe;
}

/** Wire-up for cloud/src/app.ts: after the JSON body parser, before notFound. */
export function registerStepRoutes(app: Express, ctx: CloudContext, options: StepRouteOptions = {}) {
  app.use('/v1/builds', stepsRouter(ctx, options));
}

/** Fix rounds per build: auto rounds (≤ 10 per run) plus hand-started "Fix" runs (≤ 10 each) on the
 *  same build for weeks — a Rebuild is the only reset, and it re-runs every step, so be generous. */
const MAX_FIX_ROUNDS = 120;
/** New builds per account per hour: every Rebuild and every job start makes one (several PCs, several jobs). */
const BUILDS_PER_HOUR = 60;
/** Late results accepted per /next call. */
const MAX_LATE_RESULTS = 200;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
const STEP_ID = /^(preflight|inventory|bootstrap|store-setup|final|(page|verify):[a-z0-9-]{1,60}|fix:\d{1,3})$/;

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const bad = (message: string) => new CloudError(400, 'BAD_REQUEST', message);

function parseMeta(body: Record<string, unknown>): BuildMeta {
  const name = text(body.name, 120).replace(/[\r\n]+/g, ' ');
  if (!name) throw bad('name is required.');
  const prefix = text(body.prefix, 10).toLowerCase();
  if (!/^[a-z][a-z0-9]{1,2}$/.test(prefix)) throw bad('prefix must be 2-3 characters (letters/digits, starting with a letter).');
  const storeHost = (text(body.storeHost, 200) || text(body.storeUrl, 200).replace(/^https?:\/\//i, '').replace(/\/.*$/, '')).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(storeHost)) throw bad('storeHost must be a *.myshopify.com domain.');
  const reactUrl = text(body.reactUrl, 500).replace(/\/+$/, '');
  try { if (!/^https?:$/.test(new URL(reactUrl).protocol)) throw new Error(); } catch { throw bad('reactUrl must be an http(s) URL.'); }
  const root = text(body.root, 500);
  if (!root || /[\r\n`]/.test(root)) throw bad('root (the project folder) is required.');
  const rebuiltRoutes = Array.isArray(body.rebuiltRoutes) ? body.rebuiltRoutes.map((route) => text(route, 200)).filter((route) => route.startsWith('/')).slice(0, MAX_PAGES) : [];
  return {
    name, prefix, storeHost, reactUrl, root,
    devThemeName: text(body.devThemeName, 120).replace(/[\r\n]+/g, ' ') || `${name} Clone (dev)`,
    qaEngine: ['playwright', 'headed', 'chrome'].includes(text(body.qaEngine, 20)) ? text(body.qaEngine, 20) : 'playwright',
    rebuiltRoutes,
    appVersion: text(body.appVersion, 40) || null,
  };
}

function buildValues(meta: BuildMeta, recipe: Recipe): Record<string, string> {
  return {
    NAME: meta.name, PREFIX: meta.prefix, ROOT: meta.root, REACT_URL: meta.reactUrl,
    STORE_URL: `https://${meta.storeHost}`, STORE_HOST: meta.storeHost, DEV_THEME_NAME: meta.devThemeName,
    RECIPE_VERSION: recipe.version,
  };
}

function pageValues(meta: BuildMeta, page: BuildPage): Record<string, string> {
  const home = page.route === '/';
  const handle = page.handle ?? (home ? '' : slugForRoute(page.route));
  return {
    PAGE_ROUTE: page.route,
    PAGE_NAME: page.name,
    PAGE_SLUG: page.slug,
    PAGE_HANDLE: handle,
    PAGE_TEMPLATE: (page.template ?? (home ? 'index.json' : `page.${meta.prefix}_${handle.replace(/-/g, '_')}.json`)).replace(/^templates\//, ''),
    PAGE_REACT_FILE: page.file ?? 'src/pages/ (find the component for this route)',
    PAGE_BANDS: page.bands != null ? String(page.bands) : 'not counted — count them yourself',
    REACT_PAGE_URL: `${meta.reactUrl}${home ? '/' : page.route}`,
  };
}

/** Joins the project root and a workspace-relative path in the root's own separator style. */
function underRoot(root: string, relative: string) {
  const windows = /^[A-Za-z]:[\\/]/.test(root) || root.includes('\\');
  const sep = windows ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${relative.split('/').join(sep)}`;
}

export function stepsRouter(ctx: CloudContext, options: StepRouteOptions = {}) {
  const recipe = options.recipe ?? loadRecipe();
  const decorate = options.decoratePrompt ?? identityDecorator;
  try { ctx.db.sql.prepare('INSERT OR IGNORE INTO recipe_versions (id, version, notes, created_at) VALUES (?, ?, ?, ?)').run(`rv_${recipe.version}`, recipe.version, 'loaded by the step engine', ctx.now()); } catch { /* bookkeeping only */ }

  const router = Router();
  router.use(limitByIp(ctx, 'builds', 1200, 5 * 60_000), requirePass(ctx));

  const locals = (response: { locals: unknown }) => response.locals as PassLocals;
  /** The build, if it belongs to the pass's account (404 otherwise — no probing other accounts' ids). */
  const ownBuild = (id: string, accountId: string): LoadedBuild => {
    const row = /^bld_[A-Za-z0-9_-]{8,40}$/.test(id) ? getBuildRow(ctx, id) : null;
    if (!row || row.account_id !== accountId) throw new CloudError(404, 'NOT_FOUND', 'No such build.');
    return loadBuild(row);
  };
  const throttle = (accountId: string) => ctx.limiter.enforce(`acc:steps:${accountId}`, 900, 5 * 60_000);

  const titleFor = (build: LoadedBuild) => (step: PlannedStep) => recipe.stepTitle(step.kind, step.page ? { ...buildValues(build.meta, recipe), ...pageValues(build.meta, step.page) } : buildValues(build.meta, recipe));
  const viewOf = (build: LoadedBuild, session: string | null, running = new Set<string>()) => {
    const plan = planSteps(build.pages);
    const records = stepRecords(ctx, build.row.id, session);
    const { skipped } = decideNext(plan, records, running, titleFor(build));
    return planView(plan, records, running, skipped, titleFor(build));
  };

  /** Renders, decorates and returns one step for the app to run. */
  const issue = (build: LoadedBuild, step: PlannedStep, session: string, deviceId: string, accountId: string) => {
    const attempt = recordIssue(ctx, build.row.id, step.id, step.kind, session, deviceId);
    const rebuilt = Boolean(step.page && step.kind === 'page' && build.meta.rebuiltRoutes.includes(step.page.route));
    const values: Record<string, string> = { ...buildValues(build.meta, recipe), ...(step.page ? pageValues(build.meta, step.page) : {}), STEP_ID: step.id, SIGNAL: signalFor(step.id) };
    values.REBUILD_NOTE = rebuilt ? recipe.note('REBUILD_NOTE', values) : '';
    const composed = recipe.step(step.kind, values);
    const model: RecipeModel = composed.model === 'page' ? pageModel(step.page!) : composed.model;
    const prompt = decorate(composed.prompt, { accountId, deviceId, buildId: build.row.id, stepId: step.id, kind: step.kind, attempt, recipeVersion: recipe.version });
    return {
      id: step.id, kind: step.kind, title: composed.title, prompt, model, signal: signalFor(step.id), attempt,
      ...(composed.parallelGroup ? { parallelGroup: composed.parallelGroup } : {}),
      ...(step.page ? { page: { route: step.page.route, slug: step.page.slug, name: step.page.name } } : {}),
    };
  };

  router.post('/', handle((request, response) => {
    const { account, device } = locals(response);
    ctx.limiter.enforce(`acc:build-create:${account.id}`, BUILDS_PER_HOUR, 60 * 60_000);
    const body = bodyOf(request);
    const meta = parseMeta(body);
    const row = createBuild(ctx, account.id, device.id, meta, recipe.version);
    const pages = normalizePages(body.pages);
    if (pages.length) savePages(ctx, row.id, pages);
    ctx.db.audit(ctx.now(), 'device', 'build.created', account.id, { build: row.id, device: device.id, recipe: recipe.version, store: meta.storeHost });
    const build = loadBuild(getBuildRow(ctx, row.id)!);
    response.status(201).json({ buildId: row.id, recipeVersion: recipe.version, plan: viewOf(build, null) });
  }));

  router.get('/:id', handle((request, response) => {
    const { account } = locals(response);
    const build = ownBuild(String(request.params.id), account.id);
    response.json({
      build: { id: build.row.id, status: build.row.status, detail: build.row.detail, recipeVersion: build.row.recipe_version, createdAt: iso(build.row.created_at), updatedAt: iso(build.row.updated_at), pages: build.pages.length },
      plan: viewOf(build, null),
      history: stepHistory(ctx, build.row.id).map((entry) => ({ step: entry.step_id, kind: entry.kind, attempt: entry.attempt, status: entry.status, detail: entry.detail, issuedAt: iso(entry.issued_at), finishedAt: iso(entry.finished_at) })),
    });
  }));

  router.post('/:id/pages', handle((request, response) => {
    const { account } = locals(response);
    throttle(account.id);
    const build = ownBuild(String(request.params.id), account.id);
    const body = bodyOf(request);
    if (!Array.isArray(body.pages)) throw bad('pages must be an array.');
    const incoming = body.pages as unknown[];
    const merged = body.replace === false ? [...build.pages.map((page) => ({ ...page })), ...incoming] : incoming;
    const pages = normalizePages(merged);
    savePages(ctx, build.row.id, pages);
    response.json({ pages: pages.map((page) => ({ route: page.route, slug: page.slug, name: page.name })), plan: viewOf({ ...build, pages }, null) });
  }));

  router.post('/:id/next', handle((request, response) => {
    const { account, device } = locals(response);
    throttle(account.id);
    const build = ownBuild(String(request.params.id), account.id);
    const body = bodyOf(request);
    const session = text(body.session, 64);
    if (!SESSION.test(session)) throw bad('session must be 8-64 letters, digits, _ or -.');
    const running = new Set((Array.isArray(body.running) ? body.running : []).map((id) => text(id, 80)).filter((id) => STEP_ID.test(id)).slice(0, 20));
    const plan = planSteps(build.pages);
    const known = new Set(plan.map((step) => step.id));

    // Results the app couldn't deliver earlier (offline for a moment) arrive here. The app sends at
    // most 150 per call (server/factory/convergence.ts unackedBatch).
    for (const entry of (Array.isArray(body.finished) ? body.finished : []).slice(0, MAX_LATE_RESULTS)) {
      const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      const stepId = text(item.id, 80);
      const outcome = text(item.outcome, 20) as StepOutcome;
      if (!known.has(stepId) || !STEP_OUTCOMES.includes(outcome)) continue;
      const step = plan.find((candidate) => candidate.id === stepId)!;
      recordResult(ctx, build.row.id, stepId, step.kind, outcome, text(item.detail, 300) || 'reported later by the app', session, device.id);
    }

    const facts = body.facts && typeof body.facts === 'object' ? body.facts as Record<string, unknown> : {};
    // A core step that said "done" without leaving its required files behind did not finish: its
    // done becomes a failed attempt, so it is handed out again (and blocks after MAX_TRIES).
    const files = facts.files && typeof facts.files === 'object' && !Array.isArray(facts.files) ? facts.files as Record<string, unknown> : null;
    if (files) {
      for (const stepId of Object.keys(REQUIRED_OUTPUTS)) {
        const missing = missingOutputs(stepId, files);
        if (missing.length) rejectDone(ctx, build.row.id, stepId, `reported done, but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing`);
      }
    }
    const aborted = text(facts.aborted, 400);
    const blocked = text(facts.blocked, 400);
    const records = stepRecords(ctx, build.row.id, session);
    const titles = titleFor(build);
    const { decision, skipped } = decideNext(plan, records, running, titles);
    const view = planView(plan, records, running, skipped, titles);
    const answer = (payload: Record<string, unknown>) => response.json({ ...payload, plan: view, recipeVersion: recipe.version });

    // The workspace says it is stopped (BLOCKED.md / ABORTED.md): nothing more until it is cleared.
    if (aborted) { setBuildStatus(ctx, build.row.id, 'aborted', aborted); answer({ blocked: aborted, code: 'ABORTED' }); return; }
    if (blocked) { setBuildStatus(ctx, build.row.id, 'blocked', blocked); answer({ blocked, code: 'BLOCKED' }); return; }

    if (decision.kind === 'done') { if (build.row.status !== 'done') setBuildStatus(ctx, build.row.id, 'done', null); answer({ done: true }); return; }
    if (decision.kind === 'wait') { answer({ wait: true }); return; }
    if (decision.kind === 'blocked') { setBuildStatus(ctx, build.row.id, 'blocked', decision.reason); answer({ blocked: decision.reason, code: 'STEP_FAILED' }); return; }
    if (build.row.steps_issued >= issueCap(build.pages.length)) {
      const reason = 'This build has asked for its steps too many times. Start a new build (Rebuild) — if it keeps happening, contact support.';
      setBuildStatus(ctx, build.row.id, 'blocked', reason);
      answer({ blocked: reason, code: 'STEP_LIMIT' });
      return;
    }
    const step = issue(build, decision.step, session, device.id, account.id);
    running.add(step.id);
    response.json({ step, plan: planView(plan, stepRecords(ctx, build.row.id, session), running, skipped, titles), recipeVersion: recipe.version });
  }));

  router.post('/:id/result', handle((request, response) => {
    const { account, device } = locals(response);
    throttle(account.id);
    const build = ownBuild(String(request.params.id), account.id);
    const body = bodyOf(request);
    const stepId = text(body.stepId, 80);
    const outcome = text(body.outcome, 20) as StepOutcome;
    if (!STEP_ID.test(stepId)) throw bad('stepId is not a step of this build.');
    if (!STEP_OUTCOMES.includes(outcome)) throw bad(`outcome must be one of ${STEP_OUTCOMES.join(', ')}.`);
    const plan = planSteps(build.pages);
    const step = plan.find((candidate) => candidate.id === stepId);
    if (!step && !stepId.startsWith('fix:')) throw bad('stepId is not a step of this build.');
    const session = SESSION.test(text(body.session, 64)) ? text(body.session, 64) : null;
    recordResult(ctx, build.row.id, stepId, step?.kind ?? 'fix', outcome, text(body.detail, 500) || null, session, device.id);
    response.json({ ok: true, plan: viewOf(build, session) });
  }));

  router.post('/:id/fix', handle((request, response) => {
    const { account, device } = locals(response);
    throttle(account.id);
    const build = ownBuild(String(request.params.id), account.id);
    const body = bodyOf(request);
    const iter = Number(body.iter);
    if (!Number.isInteger(iter) || iter < 0 || iter > 999) throw bad('iter must be a whole number.');
    const summary = body.summary && typeof body.summary === 'object' ? body.summary as Record<string, unknown> : { reportPath: body.summary };
    const reportPath = text(summary.reportPath, 300).replace(/\\/g, '/');
    if (!/^qa\/reports\/[\w./-]+$/.test(reportPath) || reportPath.includes('..')) throw bad('summary.reportPath must be a report under qa/reports/.');
    if (countFixIssues(ctx, build.row.id) >= MAX_FIX_ROUNDS) throw new CloudError(429, 'FIX_LIMIT', 'This build has used all its fix rounds. Start a Rebuild to continue.');
    const issueCount = Number(summary.issueCount);
    const stepId = `fix:${iter}`;
    const session = SESSION.test(text(body.session, 64)) ? text(body.session, 64) : null;
    const attempt = recordIssue(ctx, build.row.id, stepId, 'fix', session, device.id);
    const signal = `qa/reports/fix-complete-${iter}.md`;
    const values: Record<string, string> = {
      ...buildValues(build.meta, recipe), STEP_ID: stepId, SIGNAL: signal, ITER: String(iter),
      REPORT_PATH: underRoot(build.meta.root, reportPath),
      ISSUE_COUNT: Number.isInteger(issueCount) && issueCount >= 0 ? String(issueCount) : 'every',
    };
    values.REGRESSION_BANNER = summary.regressed === true ? recipe.note('REGRESSION_BANNER', values) : '';
    const composed = recipe.fix(values);
    const prompt = decorate(composed.prompt, { accountId: account.id, deviceId: device.id, buildId: build.row.id, stepId, kind: 'fix', attempt, recipeVersion: recipe.version });
    response.json({ prompt, model: composed.model, signal, title: composed.title, recipeVersion: recipe.version });
  }));

  return router;
}

