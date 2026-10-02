// Build progress: the plan (qa/state/inventory.json — every page and how many sections it needs,
// with page → template from qa/state/handles.json) against what exists on disk. Used by the build
// panel's progress card and by Rebuild, which tells the AI which pages are already done.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FactoryJobRecord } from '../db';

export interface PageProgress { route: string; name: string; template: string | null; planned: number; built: number; hasTemplate: boolean; sections: string[] }

export async function pageProgress(workspace: string) {
  type PlanPage = { route?: string; react_file?: string; shopify_template?: string; band_count?: number };
  let plan: PlanPage[] = [];
  try { plan = ((JSON.parse(await readFile(path.join(workspace, 'qa', 'state', 'inventory.json'), 'utf8')) as { pages?: PlanPage[] }).pages ?? []); } catch { /* not planned yet */ }
  // Most plan entries don't name their template; handles.json maps every route to one.
  let routeTemplates: Record<string, { template?: string }> = {};
  try { routeTemplates = (JSON.parse(await readFile(path.join(workspace, 'qa', 'state', 'handles.json'), 'utf8')) as { routes?: Record<string, { template?: string }> }).routes ?? {}; } catch { /* none yet */ }

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
    const planned = Math.max(1, Number(page.band_count ?? 1));
    const template = page.shopify_template ?? (page.route ? routeTemplates[page.route]?.template ?? null : null);
    let sections: string[] = []; let hasTemplate = false;
    if (template) {
      try {
        const json = JSON.parse((await readFile(path.join(workspace, template), 'utf8')).replace(/^\/\*[\s\S]*?\*\/\s*/, '')) as { sections?: Record<string, { type?: string }> };
        hasTemplate = true;
        sections = Object.values(json.sections ?? {}).map((section) => section.type ?? '').filter((type) => type && sectionTimes.has(type));
      } catch { /* not written yet */ }
    }
    const name = (page.react_file ?? page.route ?? 'Page').split('/').pop()!.replace(/\.(tsx|jsx|ts|js)$/, '').replace(/Page$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
    return { route: page.route ?? '', name: page.route === '/' ? 'Home' : name, template, planned, built: Math.min(sections.length, planned), hasTemplate, sections };
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
