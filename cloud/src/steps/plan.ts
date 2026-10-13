// The build plan and the "what runs next" decision — pure functions, no I/O.
//
//   preflight → inventory → bootstrap → store-setup → for every page: page:<slug> → verify:<slug> → final
//
// Core steps and `final` run alone. Page and verify steps share the "pages" group: the app may run
// several at once (its own setting), telling the Cloud which ones are running so nothing is handed
// out twice. A step that ends without its signal file ("failed") is handed out again; after
// MAX_TRIES failures in one app session a core step blocks the build, while a page (and its check)
// is skipped so the other pages still finish — the final report lists it, and the next Resume (a new
// session) tries it again.
import type { RecipeModel, StepKind } from './recipe';

export const CORE_STEPS = ['preflight', 'inventory', 'bootstrap', 'store-setup'] as const;
export const MAX_TRIES = 2;
export const MAX_PAGES = 200;

export interface BuildPage {
  route: string;
  slug: string;
  name: string;
  handle: string | null;
  template: string | null;
  file: string | null;
  bands: number | null;
  model: 'opus' | 'sonnet' | null;
  type: string | null;
}

export interface PlannedStep { id: string; kind: StepKind; page?: BuildPage }

/** What the database knows about one step id. */
export interface StepRecord {
  done: boolean;
  /** Results that ended without the step's signal file, in the asking app session. */
  failuresThisSession: number;
  attempts: number;
  lastStatus: string | null;
  lastDetail: string | null;
}

export type Decision =
  | { kind: 'issue'; step: PlannedStep }
  | { kind: 'wait' }
  | { kind: 'done' }
  | { kind: 'blocked'; reason: string };

export type PlanStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

const clip = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** '/' → 'home', '/our-team' → 'our-team', '/products/x' → 'products-x'. */
export function slugForRoute(route: string): string {
  if (route === '/' || route === '') return 'home';
  return route.toLowerCase().replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'page';
}

function nameFor(route: string, file: string | null): string {
  if (route === '/') return 'Home';
  const base = (file ?? route).split('/').filter(Boolean).pop() ?? route;
  const words = base.replace(/\.(tsx|jsx|ts|js)$/, '').replace(/Page$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : route;
}

/**
 * Validates the page list the app uploads (from qa/state/inventory.json) and gives every page a
 * stable, unique slug. Bad entries are dropped, not fatal; duplicate routes keep the first.
 */
export function normalizePages(input: unknown): BuildPage[] {
  if (!Array.isArray(input)) return [];
  const seenRoutes = new Set<string>();
  const seenSlugs = new Set<string>();
  const pages: BuildPage[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const route = clip(entry.route, 200);
    if (!route.startsWith('/') || /[\s<>"'`]/.test(route) || seenRoutes.has(route)) continue;
    seenRoutes.add(route);
    let slug = slugForRoute(route);
    for (let n = 2; seenSlugs.has(slug); n += 1) slug = `${slugForRoute(route)}-${n}`;
    seenSlugs.add(slug);
    const file = clip(entry.file, 200) || null;
    const bands = Number(entry.bands);
    const model = entry.model === 'opus' || entry.model === 'sonnet' ? entry.model : null;
    pages.push({
      route, slug, file,
      name: clip(entry.name, 60).replace(/[\r\n]+/g, ' ') || nameFor(route, file),
      handle: clip(entry.handle, 120).replace(/[^a-z0-9-]/gi, '') || null,
      template: clip(entry.template, 120).replace(/[^\w.\-/]/g, '') || null,
      bands: Number.isInteger(bands) && bands > 0 && bands < 200 ? bands : null,
      model,
      type: clip(entry.type, 20).replace(/[^a-z-]/gi, '') || null,
    });
    if (pages.length >= MAX_PAGES) break;
  }
  return pages;
}

export function planSteps(pages: BuildPage[]): PlannedStep[] {
  return [
    ...CORE_STEPS.map((kind) => ({ id: kind, kind } as PlannedStep)),
    ...pages.flatMap((page) => [{ id: `page:${page.slug}`, kind: 'page' as const, page }, { id: `verify:${page.slug}`, kind: 'verify' as const, page }]),
    { id: 'final', kind: 'final' },
  ];
}

/**
 * Files a step must leave behind, as the app reports them in /next `facts.files` (keys from
 * server/factory/convergence.ts). A step that reports done without them did not really finish:
 * the next steps would fail on the missing file (push.mjs needs theme.json; the page steps read
 * bootstrap.json and handles.json), so its "done" counts as a failed attempt and the step runs
 * again under the usual retry/block rules. `images` is not required: a site without images has none.
 */
export const REQUIRED_OUTPUTS: Readonly<Record<string, ReadonlyArray<{ fact: string; file: string }>>> = {
  inventory: [{ fact: 'inventory', file: 'qa/state/inventory.json' }],
  bootstrap: [{ fact: 'theme', file: 'qa/state/theme.json' }, { fact: 'bootstrap', file: 'qa/state/bootstrap.json' }],
  'store-setup': [{ fact: 'handles', file: 'qa/state/handles.json' }],
  final: [{ fact: 'final', file: 'qa/reports/final.md' }],
};

/**
 * The required outputs of `stepId` that the app says are missing. Only an explicit `false` counts
 * (an app that doesn't report a file — older versions send no `files` at all — is trusted).
 */
export function missingOutputs(stepId: string, files: Record<string, unknown>): string[] {
  return (REQUIRED_OUTPUTS[stepId] ?? []).filter((output) => files[output.fact] === false).map((output) => output.file);
}

/** Workspace-relative signal file a step writes when it is done. */
export function signalFor(stepId: string): string {
  return `factory/steps/${stepId.replace(/:/g, '-')}.done`;
}

/** The page's session model: what the inventory chose, else by size (complex pages on opus). */
export function pageModel(page: BuildPage): RecipeModel {
  if (page.model) return page.model;
  return page.bands != null && page.bands <= 4 ? 'sonnet' : 'opus';
}

const record = (records: Map<string, StepRecord>, id: string): StepRecord => records.get(id) ?? { done: false, failuresThisSession: 0, attempts: 0, lastStatus: null, lastDetail: null };

/**
 * Decides what the app runs next. Also returns the steps given up on in this session (their page
 * failed MAX_TRIES times) so the plan view can show them as skipped.
 */
export function decideNext(plan: PlannedStep[], records: Map<string, StepRecord>, running: Set<string>, titles: (step: PlannedStep) => string): { decision: Decision; skipped: Set<string> } {
  const skipped = new Set<string>();
  const exhausted = (id: string) => record(records, id).failuresThisSession >= MAX_TRIES;

  for (const id of CORE_STEPS) {
    const state = record(records, id);
    if (state.done) continue;
    if (running.size) return { decision: { kind: 'wait' }, skipped };
    if (exhausted(id)) {
      const step = plan.find((entry) => entry.id === id)!;
      return { decision: { kind: 'blocked', reason: `"${titles(step)}" did not finish after ${MAX_TRIES} tries${state.lastDetail ? ` (${state.lastDetail})` : ''}. Check qa/reports, then press Resume.` }, skipped };
    }
    return { decision: { kind: 'issue', step: plan.find((entry) => entry.id === id)! }, skipped };
  }

  const pageSteps = plan.filter((step) => step.kind === 'page');
  if (!pageSteps.length) return { decision: { kind: 'blocked', reason: 'The build plan has no pages: qa/state/inventory.json lists none (see qa/reports/inventory.md). Fix the plan, then press Resume.' }, skipped };

  // Depth first: a built page is checked before the next page starts, so pages finish one by one.
  const candidates: PlannedStep[] = [];
  for (const build of pageSteps) {
    const verifyId = `verify:${build.page!.slug}`;
    const verify = plan.find((step) => step.id === verifyId)!;
    if (!record(records, build.id).done) {
      if (running.has(build.id)) continue;
      if (exhausted(build.id)) { skipped.add(build.id); skipped.add(verifyId); continue; }
      candidates.push(build);
      continue;
    }
    if (record(records, verifyId).done || running.has(verifyId)) continue;
    if (exhausted(verifyId)) { skipped.add(verifyId); continue; }
    candidates.push(verify);
  }
  // Checks of built pages first (in page order), then pages still to build.
  candidates.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'verify' ? -1 : 1));
  if (candidates.length) return { decision: { kind: 'issue', step: candidates[0] }, skipped };
  if ([...running].some((id) => id.startsWith('page:') || id.startsWith('verify:'))) return { decision: { kind: 'wait' }, skipped };

  const final = record(records, 'final');
  if (final.done) return { decision: { kind: 'done' }, skipped };
  if (running.size) return { decision: { kind: 'wait' }, skipped };
  if (exhausted('final')) return { decision: { kind: 'blocked', reason: `"Wrapping up" did not finish after ${MAX_TRIES} tries${final.lastDetail ? ` (${final.lastDetail})` : ''}. Press Resume to try again.` }, skipped };
  return { decision: { kind: 'issue', step: plan.find((step) => step.id === 'final')! }, skipped };
}

/** The plan as the app shows it: ids, titles and states — never prompts. */
export function planView(plan: PlannedStep[], records: Map<string, StepRecord>, running: Set<string>, skipped: Set<string>, titles: (step: PlannedStep) => string) {
  return plan.map((step) => {
    const state = record(records, step.id);
    const stopped = state.lastStatus != null && !['issued', 'killed', 'done'].includes(state.lastStatus);
    const status: PlanStatus = state.done ? 'done' : running.has(step.id) ? 'running' : skipped.has(step.id) ? 'skipped' : stopped ? 'failed' : 'pending';
    return { id: step.id, kind: step.kind, title: titles(step), status, attempts: state.attempts, ...(step.page ? { page: step.page.route } : {}) };
  });
}

/**
 * Most steps a build may be handed (retries and fix rounds included) — a scraping guard, generous
 * for real builds. A heavy real build — 40 pages (85 steps), retries, three Resume sessions that
 * each re-run a few interrupted steps, pages that fail their two tries in every session, 6 fix
 * rounds — stays well under 60 + 40 × 12 = 540; even every page step failing twice in each of
 * three sessions (85 × 6 = 510) fits. A Rebuild starts a new build with a fresh count.
 */
export function issueCap(pageCount: number): number {
  return 60 + pageCount * 12;
}
