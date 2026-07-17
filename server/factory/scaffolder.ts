import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config';
import { hmac } from '../security';
import type { FactoryJobRecord } from '../db';

/**
 * Per-job capability key for the localhost-only token-mint endpoint. Deterministically derived
 * from the job id under the app session secret, so the server can recompute it and the workspace
 * scripts can carry it without any reusable Shopify secret ever touching disk. This is NOT a
 * Shopify credential: it only authorizes minting a short-lived shpat_ token for THIS job, and
 * only from loopback while the app is running.
 */
export function mintKeyFor(jobId: string) { return hmac(`factory-mint:${jobId}`); }

export const TEMPLATES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates/factory');

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

// ---------- react_files intake: folder OR .zip (flat / single-root / zip-of-zips) ----------

/** True when the path looks like a zip archive (wizard may hand us a .zip instead of a folder). */
export function isZipPath(target: string) { return /\.zip$/i.test(target.trim()); }

/** Shared package.json probe (also used by routes' /validate + intake): searches `depth` levels deep. */
export async function containsPackageJson(root: string, depth = 3): Promise<boolean> {
  if (await exists(path.join(root, 'package.json'))) return true;
  if (depth === 0) return false;
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (await containsPackageJson(path.join(root, entry.name), depth - 1)) return true;
    }
  } catch { /* unreadable dir */ }
  return false;
}

function runExtractor(command: string, args: string[]) {
  return new Promise<{ code: number | null; stderr: string; spawnError?: Error }>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command, args, { shell: false, windowsHide: true }); }
    catch (error) { resolve({ code: null, stderr: '', spawnError: error as Error }); return; }
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => resolve({ code: null, stderr, spawnError: error }));
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

/**
 * Extract a zip without adding npm deps: PowerShell Expand-Archive on win32 (spawn, shell:false),
 * falling back to `unzip` when present. Throws an actionable error when neither works.
 */
async function extractZip(zipPath: string, destDir: string) {
  await mkdir(destDir, { recursive: true });
  const attempts: Array<{ label: string; command: string; args: string[] }> = [];
  if (process.platform === 'win32') {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    attempts.push({
      label: 'PowerShell Expand-Archive', command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destDir)} -Force`],
    });
  }
  attempts.push({ label: 'unzip', command: 'unzip', args: ['-o', '-q', zipPath, '-d', destDir] });
  const failures: string[] = [];
  for (const attempt of attempts) {
    const result = await runExtractor(attempt.command, attempt.args);
    if (result.code === 0) return;
    failures.push(`${attempt.label}: ${result.spawnError ? result.spawnError.message : `exit ${result.code}${result.stderr.trim() ? ` — ${result.stderr.trim().slice(0, 300)}` : ''}`}`);
  }
  throw new Error(`Could not extract ${zipPath} (${failures.join('; ')}). Install PowerShell 5+ (Expand-Archive) or the "unzip" CLI, or extract the archive yourself and pass the folder path instead.`);
}

/** Zip archives usually wrap everything in one root folder — unwrap it so react_files/ holds the project directly. */
async function unwrapSingleRoot(dir: string, maxLevels = 3) {
  for (let level = 0; level < maxLevels; level++) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const meaningful = entries.filter((entry) => !/^(__MACOSX|\.DS_Store|Thumbs\.db)$/i.test(entry.name));
    if (meaningful.length !== 1 || !meaningful[0].isDirectory()) return;
    // Rename to a staging name first so a child with the same name as the wrapper can't collide.
    const staging = path.join(dir, `.__unwrap_${level}_${Date.now()}`);
    await rename(path.join(dir, meaningful[0].name), staging);
    for (const child of await readdir(staging)) {
      await rename(path.join(staging, child), path.join(dir, child));
    }
    await rm(staging, { recursive: true, force: true });
  }
}

/** One level of zip-of-zips (mirrors shopify_folder_init): extract each top-level inner zip into a folder named after it. */
async function extractInnerZips(dir: string) {
  let extracted = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !isZipPath(entry.name)) continue;
    const zipPath = path.join(dir, entry.name);
    const target = path.join(dir, entry.name.replace(/\.zip$/i, ''));
    await extractZip(zipPath, target);
    await unwrapSingleRoot(target);
    await rm(zipPath, { force: true });
    extracted++;
  }
  return extracted;
}

/**
 * Ingest the wizard's react_files source into the workspace: a folder is copied as-is; a .zip is
 * extracted (handling single-root wrappers and one level of zip-of-zips), then validated to
 * actually contain a React project (package.json within 3 levels).
 */
export async function ingestReactSource(source: string, target: string) {
  if (!(await exists(source))) throw new Error(`react_files source not found: ${source}`);
  if (isZipPath(source)) {
    if (!(await stat(source)).isFile()) throw new Error(`react_files source ends in .zip but is not a file: ${source}`);
    await extractZip(source, target);
    await unwrapSingleRoot(target);
    if (await extractInnerZips(target)) await unwrapSingleRoot(target);
    if (!(await containsPackageJson(target))) {
      throw new Error(`The extracted zip does not contain a package.json within 3 levels: ${source}. Make sure the archive holds the React project source (not a build output).`);
    }
    return;
  }
  await cp(source, target, { recursive: true });
}

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
  // clientSecret is accepted for API compatibility but deliberately never persisted to disk.
  const { job, clientId, reactFilesPath, storefrontPassword, extraAllow = [] } = input;
  const root = job.workspace_path;
  const adopting = await isNonEmptyDir(root);

  // Standalone clone-theme project layout — matches shopify_folder_init so the folder is
  // usable manually (cd in, run `claude` / `/clone-theme`) independent of this app, and
  // Claude Code keeps its conversation history keyed to this folder automatically.
  for (const dir of ['react_files', 'references', 'sections', 'templates', 'snippets', 'assets', 'layout', 'config', 'seed', 'qa/state', 'qa/reports', 'qa/screenshots', 'qa/factory', 'factory/logs', '.claude', '.claude/commands']) {
    await mkdir(path.join(root, dir), { recursive: true });
  }

  // Inputs in the exact shopify_folder_init template shape (labels on their own lines) —
  // always refreshed so retries after user edits pick up current values.
  await writeFile(path.join(root, 'TARGET_SITE_INFO.txt'),
    `target site:\n\n${job.react_url}\n\nshopify store:\n\n${job.store_url}/\n\nstore pass:\n\n${storefrontPassword ?? ''}\n`);
  // SECURITY: the Client Secret is NEVER written to disk. It stays encrypted in the job record;
  // workspace scripts fetch a short-lived shpat_ token from the localhost-only mint endpoint
  // (see qa/lib.mjs `mint()` + POST /api/factory/jobs/:id/mint-token). The Client ID is a public
  // app identifier (not a secret) and is kept only as non-sensitive target info for reference.
  await writeFile(path.join(root, 'API.txt'),
    `# Shopify custom-app info for ${job.name}.\n` +
    `# NOTE: the Client Secret is intentionally NOT stored here. Workspace scripts mint a fresh,\n` +
    `# short-lived shpat_ token from the local factory app (POST /api/factory/jobs/<id>/mint-token),\n` +
    `# which decrypts the credentials in memory. Nothing reusable lives on disk.\n\n` +
    `Client ID\n${clientId}\n`);
  await writeFile(path.join(root, 'job.json'), JSON.stringify({
    factory: true, approved: true, name: job.name, react_url: job.react_url, store_url: job.store_url,
    autoswap: job.autoswap, prefix: job.prefix, dev_theme_name: job.dev_theme_name,
    // Token-mint wiring for workspace scripts (no Shopify secret on disk — see API.txt note).
    job_id: job.id,
    mint_url: `http://127.0.0.1:${config.port}/api/factory/jobs/${job.id}/mint-token`,
    mint_key: mintKeyFor(job.id),
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

  // Bundle the /clone-theme slash command INTO the workspace so headless `claude -p /clone-theme`
  // runs are self-contained and reproducible (no dependency on a user-global ~/.claude/commands
  // file). App-owned — always refreshed so bundled fixes propagate to retried/adopted workspaces.
  await cp(path.join(TEMPLATES_ROOT, 'commands/clone-theme.md'), path.join(root, '.claude/commands/clone-theme.md'));

  // Scoped permission allowlist — the sandbox for headless runs. Always refreshed.
  const template = await readFile(path.join(TEMPLATES_ROOT, 'workspace/.claude/settings.json.tpl'), 'utf8');
  const settings = JSON.parse(template.replaceAll('{{REACT_HOST}}', hostOf(job.react_url)).replaceAll('{{SHOP_HOST}}', hostOf(job.store_url)));
  if (extraAllow.length) settings.permissions.allow.push(...extraAllow);
  await writeFile(path.join(root, '.claude/settings.json'), JSON.stringify(settings, null, 2) + '\n');

  await trustWorkspace(root);

  // React source ingestion (copy/extract once; adopted workspaces may already have it).
  // Folder sources are copied recursively; .zip sources are extracted in place (single-root
  // wrappers unwrapped, one level of zip-of-zips handled) and validated for a package.json.
  if (reactFilesPath) {
    const reactTarget = path.join(root, 'react_files');
    if (!(await isNonEmptyDir(reactTarget))) {
      await ingestReactSource(reactFilesPath, reactTarget);
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
