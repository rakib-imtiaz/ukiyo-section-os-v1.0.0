// The build recipe (cloud/recipe/): loaded once, composed into one prompt per step.
//
// A step prompt = header + the step's body + its `include` fragments + finish (see
// cloud/recipe/manifest.json). Placeholders are rendered in ONE pass with a callback, so a value
// that itself contains "{{ROOT}}" (a project named that way) is never expanded again. Liquid in the
// recipe ("{{ a == b }}", "{{ l.url }}") is left alone: only {{UPPER_CASE}} names are placeholders.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type RecipeModel = 'opus' | 'sonnet' | 'haiku';
export type StepKind = 'preflight' | 'inventory' | 'bootstrap' | 'store-setup' | 'page' | 'verify' | 'final';
export const STEP_KINDS: readonly StepKind[] = ['preflight', 'inventory', 'bootstrap', 'store-setup', 'page', 'verify', 'final'];

interface StepSpec { title: string; body: string; model: RecipeModel | 'page'; parallelGroup?: string; include: string[] }
interface Manifest {
  recipe_version: string;
  header: string;
  finish: string;
  knowledge: string[];
  groups?: Record<string, string[]>;
  /** Placeholder → fragment rendered only when it applies (e.g. REBUILD_NOTE on a rebuilt page). */
  notes?: Record<string, string>;
  steps: Record<StepKind, StepSpec>;
  fix: { title: string; body: string; model: RecipeModel; include: string[] };
}

export interface ComposedPrompt { title: string; prompt: string; model: RecipeModel | 'page'; parallelGroup?: string }

export interface Recipe {
  version: string;
  /** Prompt for one build step. `values` are the placeholder values (NAME, PREFIX, PAGE_ROUTE, ...). */
  step(kind: StepKind, values: Record<string, string>): ComposedPrompt;
  /** Title only (for the plan the app shows) — no prompt text. */
  stepTitle(kind: StepKind, values: Record<string, string>): string;
  /** Prompt for one QA fix round. */
  fix(values: Record<string, string>): ComposedPrompt;
  /** A conditional note (manifest "notes"), rendered — the value for that placeholder. */
  note(name: string, values: Record<string, string>): string;
  /** Fragment ids the manifest defines vs. uses (tests: no know-how silently dropped). */
  fragments: { defined: string[]; used: string[] };
}

const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
const INCLUDE_HERE = '<!-- @include-here -->';
const FRAGMENT = /^<!-- @fragment ([a-z0-9-]+) -->\s*$/;

/** Single-pass placeholder rendering. Unknown names render as "(unknown)" (tests assert none are left). */
export function renderPlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : '(unknown)'));
}

/** Names of the {{PLACEHOLDERS}} a text still contains. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]);
}

function parseFragments(text: string, file: string, into: Map<string, string>) {
  let current: string | null = null;
  let lines: string[] = [];
  const flush = () => { if (current) into.set(current, lines.join('\n').trim()); };
  for (const line of text.split(/\r?\n/)) {
    const marker = FRAGMENT.exec(line);
    if (marker) {
      flush();
      if (into.has(marker[1])) throw new Error(`Recipe fragment "${marker[1]}" is defined twice (${file}).`);
      current = marker[1];
      lines = [];
    } else if (current) lines.push(line);
  }
  flush();
}

export const DEFAULT_RECIPE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'recipe');

export function loadRecipe(dir = process.env.CLOUD_RECIPE_DIR?.trim() || DEFAULT_RECIPE_DIR): Recipe {
  const read = (relative: string) => readFileSync(path.join(dir, relative), 'utf8').replace(/\r\n/g, '\n');
  const manifest = JSON.parse(read('manifest.json')) as Manifest;
  if (!manifest.recipe_version) throw new Error('Recipe manifest has no recipe_version.');

  const fragments = new Map<string, string>();
  for (const file of manifest.knowledge) parseFragments(read(file), file, fragments);
  const groups = manifest.groups ?? {};
  const expand = (ids: string[]): string[] => ids.flatMap((id) => {
    if (id.startsWith('@')) {
      const group = groups[id];
      if (!group) throw new Error(`Recipe group "${id}" is not defined.`);
      return group;
    }
    return [id];
  });
  const used = new Set<string>();
  const resolveIncludes = (ids: string[], where: string) => expand(ids).map((id) => {
    const text = fragments.get(id);
    if (text === undefined) throw new Error(`Recipe fragment "${id}" (used by ${where}) is not defined.`);
    used.add(id);
    return text;
  });

  const header = read(manifest.header).trim();
  const finish = read(manifest.finish).trim();
  // Resolve every body and include list now, so a broken recipe fails at startup, not mid-build.
  const steps = new Map<StepKind, { spec: StepSpec; body: string; includes: string[] }>();
  for (const kind of STEP_KINDS) {
    const spec = manifest.steps[kind];
    if (!spec) throw new Error(`Recipe step "${kind}" is missing from the manifest.`);
    steps.set(kind, { spec, body: read(spec.body).trim(), includes: resolveIncludes(spec.include ?? [], kind) });
  }
  const fixBody = read(manifest.fix.body).trim();
  const fixIncludes = resolveIncludes(manifest.fix.include ?? [], 'fix');
  const notes = new Map(Object.entries(manifest.notes ?? {}).map(([name, id]) => [name, resolveIncludes([id], `note ${name}`)[0]]));

  const join = (parts: string[]) => parts.filter((part) => part.trim()).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const place = (body: string, includes: string[]) => {
    const knowledge = includes.join('\n');
    return body.includes(INCLUDE_HERE) ? body.replace(INCLUDE_HERE, knowledge) : join([body, knowledge]);
  };

  return {
    version: manifest.recipe_version,
    step(kind, values) {
      const entry = steps.get(kind);
      if (!entry) throw new Error(`Unknown step kind "${kind}".`);
      const title = renderPlaceholders(entry.spec.title, values);
      const text = join([header, place(entry.body, entry.includes), finish]);
      return { title, prompt: renderPlaceholders(text, { ...values, STEP_TITLE: title }), model: entry.spec.model, parallelGroup: entry.spec.parallelGroup };
    },
    stepTitle(kind, values) {
      const entry = steps.get(kind);
      return entry ? renderPlaceholders(entry.spec.title, values) : kind;
    },
    fix(values) {
      const title = renderPlaceholders(manifest.fix.title, values);
      return { title, prompt: renderPlaceholders(join([place(fixBody, fixIncludes)]), { ...values, STEP_TITLE: title }), model: manifest.fix.model };
    },
    note(name, values) {
      const note = notes.get(name);
      if (note === undefined) throw new Error(`Recipe note "${name}" is not defined.`);
      return renderPlaceholders(`\n${note}\n`, values);
    },
    fragments: { defined: [...fragments.keys()], used: [...used] },
  };
}
