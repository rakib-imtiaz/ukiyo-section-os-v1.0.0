import { cp, mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config';
import type { FactoryJobRecord } from '../db';

const TEMPLATES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates/factory');

export function slugify(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!slug) throw new Error('The project name must contain letters or numbers.');
  return slug;
}

export function derivePrefix(name: string) {
  const words = name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const prefix = words.length >= 2 ? words.slice(0, 3).map((word) => word[0]).join('') : (words[0] ?? 'xx').slice(0, 3);
  return prefix.padEnd(2, 'x').slice(0, 3);
}

async function exists(target: string) { return access(target).then(() => true, () => false); }

async function isNonEmptyDir(target: string) {
  if (!(await exists(target))) return false;
  return (await readdir(target)).length > 0;
}

function hostOf(url: string) { return new URL(url).host; }

export interface ScaffoldInput { job: FactoryJobRecord; clientId: string; clientSecret: string; reactFilesPath?: string; storefrontPassword?: string; extraAllow?: string[]; }

/**
 * Headless `claude -p` refuses untrusted folders. Pre-trust the workspace in
 * ~/.claude.json (same edit the CLI's own error message instructs), scoped to
 * exactly this factory-created path.
 */
// Serialize edits to the shared ~/.claude.json so two concurrent scaffolds don't lose-update
// each other (one workspace ending up untrusted → its headless run stalls on permissions).
let trustChain: Promise<void> = Promise.resolve();
export function trustWorkspace(workspacePath: string) {
  if (process.env.VITEST) return Promise.resolve(); // tests must never edit the real user config
  const run = async () => {
    const configPath = path.join(homedir(), '.claude.json');
    try {
      const parsed = JSON.parse(await readFile(configPath, 'utf8')) as { projects?: Record<string, Record<string, unknown>> };
      const key = workspacePath.replace(/\\/g, '/');
      parsed.projects ??= {};
      if (parsed.projects[key]?.hasTrustDialogAccepted === true) return;
      parsed.projects[key] = { ...parsed.projects[key], hasTrustDialogAccepted: true };
      await writeFile(configPath, JSON.stringify(parsed, null, 2));
    } catch (error) {
      throw new Error(`Could not pre-trust the workspace in ~/.claude.json: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };
  const next = trustChain.then(run, run);
  trustChain = next.catch(() => {}); // keep the chain alive even if one link rejects
  return next;
}

/**
 * Creates (or adopts) the per-job workspace: dirs, clone-theme inputs (TARGET_SITE_INFO.txt,
 * API.txt, job.json), the six pre-placed headless scaffold files, QA scripts, and the scoped
 * .claude/settings.json allowlist. Idempotent for retries: existing files are only written
 * when missing, except job inputs which are always refreshed from the job record.
 */
export async function scaffoldWorkspace(input: ScaffoldInput) {
  const { job, clientId, clientSecret, reactFilesPath, storefrontPassword, extraAllow = [] } = input;
  const root = job.workspace_path;
  const adopting = await isNonEmptyDir(root);

  // Standalone clone-theme project layout — matches shopify_folder_init so the folder is
  // usable manually (cd in, run `claude` / `/clone-theme`) independent of this app, and
  // Claude Code keeps its conversation history keyed to this folder automatically.
  for (const dir of ['react_files', 'references', 'sections', 'templates', 'snippets', 'assets', 'layout', 'config', 'seed', 'qa/state', 'qa/reports', 'qa/screenshots', 'qa/factory', 'factory/logs', '.claude']) {
    await mkdir(path.join(root, dir), { recursive: true });
  }

  // Inputs in the exact shopify_folder_init template shape (labels on their own lines) —
  // always refreshed so retries after user edits pick up current values.
  await writeFile(path.join(root, 'TARGET_SITE_INFO.txt'),
    `target site:\n\n${job.react_url}\n\nshopify store:\n\n${job.store_url}/\n\nstore pass:\n\n${storefrontPassword ?? ''}\n`);
  await writeFile(path.join(root, 'API.txt'),
    `# Shopify custom-app credentials for ${job.name}.\n# push.mjs mints a fresh 24h shpat_ token from the Client ID + Secret below.\n# Format: label on one line, value on the next line (do not remove the labels).\n\nClient ID\n${clientId}\n\nClient Secret\n${clientSecret}\n`);
  await writeFile(path.join(root, 'job.json'), JSON.stringify({
    factory: true, approved: true, name: job.name, react_url: job.react_url, store_url: job.store_url,
    autoswap: job.autoswap, prefix: job.prefix, dev_theme_name: job.dev_theme_name,
  }, null, 2) + '\n');

  // Six pre-placed headless scaffold files (contract: use as-is, do not regenerate).
  const workspaceTemplates: Array<[string, string]> = [
    ['workspace/push.mjs', 'push.mjs'],
    ['workspace/pull.mjs', 'pull.mjs'],
    ['workspace/preflight.mjs', 'preflight.mjs'],
    ['workspace/qa/lib.mjs', 'qa/lib.mjs'],
    ['workspace/qa/bootstrap-theme.mjs', 'qa/bootstrap-theme.mjs'],
  ];
  for (const [source, target] of workspaceTemplates) {
    const destination = path.join(root, target);
    if (!(await exists(destination))) await cp(path.join(TEMPLATES_ROOT, source), destination);
  }

  const conventions = (await readFile(path.join(TEMPLATES_ROOT, 'workspace/seed/CONVENTIONS.md'), 'utf8'))
    .replaceAll('{{NAME}}', job.name).replaceAll('{{PREFIX}}', job.prefix);
  const conventionsPath = path.join(root, 'seed/CONVENTIONS.md');
  if (!(await exists(conventionsPath))) await writeFile(conventionsPath, conventions);

  // QA scripts (owned by the factory — always refreshed to the latest version).
  const qaDir = path.join(TEMPLATES_ROOT, 'qa');
  if (await exists(qaDir)) {
    for (const file of (await readdir(qaDir)).filter((name) => name.endsWith('.mjs'))) {
      await cp(path.join(qaDir, file), path.join(root, 'qa/factory', file));
    }
  }

  // Scoped permission allowlist — the sandbox for headless runs. Always refreshed.
  const template = await readFile(path.join(TEMPLATES_ROOT, 'workspace/.claude/settings.json.tpl'), 'utf8');
  const settings = JSON.parse(template.replaceAll('{{REACT_HOST}}', hostOf(job.react_url)).replaceAll('{{SHOP_HOST}}', hostOf(job.store_url)));
  if (extraAllow.length) settings.permissions.allow.push(...extraAllow);
  await writeFile(path.join(root, '.claude/settings.json'), JSON.stringify(settings, null, 2) + '\n');

  await trustWorkspace(root);

  // React source ingestion (copy once; adopted workspaces may already have it).
  if (reactFilesPath) {
    const reactTarget = path.join(root, 'react_files');
    if (!(await isNonEmptyDir(reactTarget))) {
      if (!(await exists(reactFilesPath))) throw new Error(`react_files source not found: ${reactFilesPath}`);
      await cp(reactFilesPath, reactTarget, { recursive: true });
    }
  }

  return { root, adopted: adopting };
}

/** Ensure the parent workspace root exists on app boot (shopify_folder_init's Dest). */
export async function ensureWorkspaceRoot() {
  await mkdir(config.factory.workspaceRoot, { recursive: true });
  return config.factory.workspaceRoot;
}

/** Resolve a unique workspace path for a new job (auto-suffix _2, _3 on collision). */
export async function resolveWorkspacePath(slug: string) {
  const base = config.factory.workspaceRoot;
  let candidate = slug;
  for (let attempt = 2; await isNonEmptyDir(path.join(base, candidate)); attempt++) {
    candidate = `${slug}_${attempt}`;
    if (attempt > 20) throw new Error('Could not find a free workspace folder name.');
  }
  return { slug: candidate, workspacePath: path.join(base, candidate) };
}
