// Build progress: the plan (qa/state/inventory.json — every page and how many sections it needs,
// with page → template from qa/state/handles.json) against what exists on disk. Used by the build
// panel's progress card and by Rebuild, which tells the AI which pages are already done.
//
// ThemeBot Cloud builds also keep the step model locally (factory/steps/): build.json (which Cloud
// build this job is) and progress.json (the latest step list and states the Cloud reported, with
// the steps running right now). Neither holds any recipe text — only ids, titles and states.
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FactoryJobRecord } from '../db';

export interface PageProgress { route: string; name: string; template: string | null; planned: number; built: number; hasTemplate: boolean; sections: string[] }

type PlanPage = { route?: string; name?: string; react_file?: string; shopify_template?: string; template?: string; band_count?: number; bands?: unknown };

/** route → template path (relative to the workspace), from handles.json in any shape a build wrote:
 *  an array of { route, template }, { routes: { "/x": { template } } }, or a flat { "/x": { template } }. */
function templatesByRoute(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (route: unknown, template: unknown) => { if (typeof route === 'string' && typeof template === 'string' && template) out[route] = template; };
  if (Array.isArray(raw)) { for (const entry of raw) if (entry && typeof entry === 'object') add((entry as Record<string, unknown>).route, (entry as Record<string, unknown>).template); return out; }
  if (!raw || typeof raw !== 'object') return out;
  const map = ((raw as { routes?: unknown }).routes ?? raw) as Record<string, unknown>;
  for (const [route, value] of Object.entries(map)) if (value && typeof value === 'object') add(route, (value as Record<string, unknown>).template);
  return out;
}

/** "page.x_about.json" → "templates/page.x_about.json"; paths already under templates/ stay. */
function templatePath(template: string): string {
  const clean = template.replace(/\\/g, '/').replace(/^\/+/, '');
  return clean.startsWith('templates/') ? clean : `templates/${clean}`;
}

export async function pageProgress(workspace: string) {
  let plan: PlanPage[] = [];
  try { plan = ((JSON.parse(await readFile(path.join(workspace, 'qa', 'state', 'inventory.json'), 'utf8')) as { pages?: PlanPage[] }).pages ?? []); } catch { /* not planned yet */ }
  if (!Array.isArray(plan)) plan = [];
  // Most plan entries don't name their template; handles.json maps every route to one.
  let routeTemplates: Record<string, string> = {};
  try { routeTemplates = templatesByRoute(JSON.parse(await readFile(path.join(workspace, 'qa', 'state', 'handles.json'), 'utf8'))); } catch { /* none yet */ }

  const files: Record<string, number> = {};
  const sectionTimes = new Map<string, number>();
  for (const dir of ['layout', 'sections', 'blocks', 'snippets', 'templates', 'config', 'locales', 'assets']) {
    try {
      const names = await readdir(path.join(workspace, dir));
      files[dir] = names.length;
      if (dir === 'sections') for (const name of names) { try { sectionTimes.set(name.replace(/\.liquid$/, ''), (await stat(path.join(workspace, dir, name))).mtimeMs); } catch { /* gone */ } }
    } catch { files[dir] = 0; }
  }

  const pages: PageProgress[] = await Promise.all(plan.map(async (page) => {
    const planned = Math.max(1, Number(page.band_count ?? (Array.isArray(page.bands) ? page.bands.length : 1)) || 1);
    const named = page.shopify_template ?? page.template ?? (page.route ? routeTemplates[page.route] ?? null : null);
    const template = named ? templatePath(named) : null;
    let sections: string[] = []; let hasTemplate = false;
    if (template) {
      try {
        const json = JSON.parse((await readFile(path.join(workspace, template), 'utf8')).replace(/^\/\*[\s\S]*?\*\/\s*/, '')) as { sections?: Record<string, { type?: string }> };
        hasTemplate = true;
        sections = Object.values(json.sections ?? {}).map((section) => section.type ?? '').filter((type) => type && sectionTimes.has(type));
      } catch { /* not written yet */ }
    }
    const derived = (page.react_file ?? page.route ?? 'Page').split('/').pop()!.replace(/\.(tsx|jsx|ts|js)$/, '').replace(/Page$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
    const name = page.route === '/' ? 'Home' : typeof page.name === 'string' && page.name.trim() ? page.name.trim() : derived;
    return { route: page.route ?? '', name, template, planned, built: Math.min(sections.length, planned), hasTemplate, sections };
  }));
  return { planned: plan.length > 0, pages, files, sectionTimes };
}

/** Before a Rebuild: record which pages already have every planned section, so the AI verifies
 *  them instead of writing them again. Returns how many pages were marked done. */
export async function writeAlreadyBuilt(job: FactoryJobRecord): Promise<{ done: number; total: number }> {
  const { pages } = await pageProgress(job.workspace_path);
  const done = pages.filter((page) => page.built >= page.planned);
  const target = path.join(job.workspace_path, 'qa', 'state', 'already-built.json');
  await writeFile(target, JSON.stringify({
    _note: 'Written by ThemeBot when Rebuild was pressed. These pages already have their template and every planned section on disk from an earlier run. Verify each one renders; do not rewrite them unless the check finds a real problem.',
    written_at: new Date().toISOString(),
    pages: done.map((page) => ({ route: page.route, template: page.template, sections: page.sections })),
    still_to_build: pages.filter((page) => page.built < page.planned).map((page) => ({ route: page.route, template: page.template, have: page.built, planned: page.planned })),
  }, null, 2)).catch(() => {});
  return { done: done.length, total: pages.length };
}

// --- ThemeBot Cloud step model ------------------------------------------------------------------

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export interface StepEntry { id: string; kind: string; title: string; status: StepState; page?: string }

/** factory/steps/build.json — which Cloud build this job runs. */
export interface LocalBuild {
  buildId: string;
  /** The job's started_at when the build was created: a Rebuild resets it, which starts a new build. */
  jobStartedAt: string | null;
  createdAt: string;
  recipeVersion: string | null;
  /** Hash of the page list last uploaded from qa/state/inventory.json. */
  pagesHash: string | null;
}

/** factory/steps/progress.json — the step list for the build panel. */
export interface StepProgress {
  buildId: string;
  recipeVersion: string | null;
  updatedAt: string;
  state: 'running' | 'done' | 'blocked' | 'stopped';
  detail: string | null;
  steps: StepEntry[];
  /** Results the Cloud hasn't acknowledged yet (sent with the next request). */
  unacked: Array<{ id: string; outcome: string; detail?: string }>;
}

export const stepsDir = (workspace: string) => path.join(workspace, 'factory', 'steps');

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { return null; }
}

/** Atomic-ish write (temp file + rename) so the progress endpoint never reads half a file. */
async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n');
  await rename(temp, file);
}

export const readLocalBuild = (workspace: string) => readJson<LocalBuild>(path.join(stepsDir(workspace), 'build.json'));
export const writeLocalBuild = (workspace: string, build: LocalBuild) => writeJson(path.join(stepsDir(workspace), 'build.json'), build);
export const readStepProgress = (workspace: string) => readJson<StepProgress>(path.join(stepsDir(workspace), 'progress.json'));
export const writeStepProgress = (workspace: string, progress: StepProgress) => writeJson(path.join(stepsDir(workspace), 'progress.json'), progress);

/** For GET /jobs/:id/progress: the current step(s) in words, and the step list. Null for builds
 *  that don't run on Cloud steps. */
export async function stepProgressSummary(workspace: string): Promise<{ step: { n: string; label: string } | null; steps: StepEntry[]; done: number; total: number } | null> {
  const progress = await readStepProgress(workspace);
  if (!progress || !Array.isArray(progress.steps)) return null;
  const steps = progress.steps;
  const done = steps.filter((entry) => entry.status === 'done' || entry.status === 'skipped').length;
  const running = steps.filter((entry) => entry.status === 'running');
  let step: { n: string; label: string } | null = null;
  if (progress.state === 'running') {
    const label = running.length === 0 ? null
      : running.length === 1 ? running[0].title
      : `${running.slice(0, 2).map((entry) => entry.title).join(' · ')}${running.length > 2 ? ` +${running.length - 2} more` : ''}`;
    if (label) step = { n: `${Math.min(done + 1, steps.length)}/${steps.length}`, label };
  }
  return { step, steps, done, total: steps.length };
}
