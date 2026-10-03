// Workspace service — LOCAL OPERATOR TOOL.
// Lets the user choose/create a working directory (server-backed folder browser — this is a
// web app, no native dialogs), remembers it via a `.sectionos/workspace.json` marker inside
// the folder (re-selecting a folder restores its cached context), discovers project folders
// by the factory/`shopify_folder_init` anatomy (job.json is the definitive marker), and
// summarizes each project once with a cheap Haiku scan (cached by mtime; manual rescan).
import fs from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { config } from './config';
import { db } from './db';
import { desktopSettingsFile, readDesktopSettings } from './runtime-paths';
import { runQuickClaude, claudeEnv } from './claude-connect';
import { trustWorkspace } from './factory/scaffolder';
import { addProgress, beginTask } from './progress';

const MARKER_DIR = '.sectionos';
const MARKER_FILE = 'workspace.json';
const MARKER_VERSION = 1;
const ACTIVE_SETTING = 'active_workspace';
const RECENTS_SETTING = 'recent_workspaces';
const SCAN_TIMEOUT_MS = 90_000;
const SCAN_CONCURRENCY = 2;

export interface ProjectEntry {
  path: string; name: string; reactUrl: string; storeUrl: string;
  status: 'cloned' | 'partial' | 'fresh' | 'blocked' | 'unknown';
  mtimeKey: number; summary: string; sectionsCount: number; scannedAt: string | null; error: string | null;
}
interface Marker { version: number; id: string; name: string; createdAt: string; lastOpenedAt: string; projects: Record<string, ProjectEntry> }
export interface WorkspaceState { path: string | null; name: string | null; ready: boolean; scanning: boolean; returning?: boolean; projects: Array<ProjectEntry & { createdAt: string | null; updatedAt: string | null }> }

const SCAN_PROMPT = 'Index this Shopify clone project folder for a dashboard. You may READ job.json, TARGET_SITE_INFO.txt, seed/CONVENTIONS.md and LIST the sections/, templates/ and react_files/ directories. Do not open large files. Do not modify anything. Reply ONLY with minified JSON, no prose: {"summary":"2-3 sentence description of the project and its state","target_site":"url or empty","store":"url or empty","sections_count":<number of .liquid files in sections/>,"has_react_source":<bool>,"state":"cloned"|"partial"|"fresh"}';

// ---- helpers ----
async function exists(target: string) { return stat(target).then(() => true, () => false); }
async function dirMtime(target: string): Promise<number> { try { return Math.round((await stat(target)).mtimeMs); } catch { return 0; } }

function isValidAbsolute(input: string): boolean {
  if (!input || input.includes('\0')) return false;
  const normalized = path.normalize(input);
  return path.isAbsolute(normalized) && !normalized.split(path.sep).includes('..');
}

// ---- browse ----
export async function browse(target?: string): Promise<{ path: string | null; parent: string | null; dirs: Array<{ name: string; path: string }>; drives?: string[] }> {
  if (!target) {
    if (process.platform === 'win32') {
      const drives: string[] = [];
      for (let code = 65; code <= 90; code += 1) { const drive = `${String.fromCharCode(code)}:\\`; if (fs.existsSync(drive)) drives.push(drive); }
      return { path: null, parent: null, dirs: drives.map((drive) => ({ name: drive, path: drive })), drives };
    }
    target = homedir(); // macOS/Linux: start at home (Desktop/Documents/projects live there)
  }
  if (!isValidAbsolute(target)) throw new Error('Path must be absolute.');
  const normalized = path.normalize(target);
  const entries = await readdir(normalized, { withFileTypes: true }).catch(() => { throw new Error('That folder could not be read.'); });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'System Volume Information', '$RECYCLE.BIN', '$Recycle.Bin'].includes(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(normalized, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(normalized);
  return { path: normalized, parent: parent === normalized ? null : parent, dirs };
}

// ---- marker ----
function markerPath(workspace: string) { return path.join(workspace, MARKER_DIR, MARKER_FILE); }

async function readMarker(workspace: string): Promise<Marker | null> {
  try {
    const parsed = JSON.parse(await readFile(markerPath(workspace), 'utf8')) as Marker;
    if (typeof parsed !== 'object' || !parsed) return null;
    // Version mismatch: rewrite shape but preserve the projects cache.
    return { version: MARKER_VERSION, id: parsed.id || `ws_${randomBytes(5).toString('hex')}`, name: parsed.name || path.basename(workspace), createdAt: parsed.createdAt || new Date().toISOString(), lastOpenedAt: parsed.lastOpenedAt || new Date().toISOString(), projects: parsed.projects || {} };
  } catch { return null; }
}

async function writeMarker(workspace: string, marker: Marker) {
  await mkdir(path.join(workspace, MARKER_DIR), { recursive: true });
  await writeFile(markerPath(workspace), JSON.stringify(marker, null, 2));
}

// ---- select ----
export async function selectWorkspace(target: string, options: { create?: boolean } = {}): Promise<{ state: WorkspaceState; returning: boolean }> {
  if (!isValidAbsolute(target)) throw new Error('Choose an absolute folder path.');
  const workspace = path.normalize(target);
  if (!(await exists(workspace))) {
    if (!options.create) throw new Error('That folder does not exist.');
    await mkdir(workspace, { recursive: true });
    addProgress(`Created workspace folder ${workspace}`);
  }
  // Writability test — a workspace we cannot write to is useless.
  const probeFile = path.join(workspace, `.sectionos-write-test-${Date.now()}`);
  try { await writeFile(probeFile, 'ok'); await rm(probeFile, { force: true }); }
  catch { throw new Error('That folder is not writable.'); }

  let marker = await readMarker(workspace);
  const returning = !!marker;
  if (!marker) {
    marker = { version: MARKER_VERSION, id: `ws_${randomBytes(5).toString('hex')}`, name: path.basename(workspace), createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), projects: {} };
    addProgress(`Initializing workspace "${marker.name}"…`);
  } else {
    addProgress(`Welcome back — restoring workspace "${marker.name}" (${Object.keys(marker.projects).length} known project(s)).`);
  }
  marker.lastOpenedAt = new Date().toISOString();
  await writeMarker(workspace, marker);

  await db.setSetting(ACTIVE_SETTING, workspace);
  if (config.desktop) await useAsBuildsFolder(workspace);
  const recents = ((await db.getSetting(RECENTS_SETTING)) as string[] | null) ?? [];
  await db.setSetting(RECENTS_SETTING, [workspace, ...recents.filter((item) => item !== workspace)].slice(0, 6));
  await db.audit(null, 'workspace.select', 'app', { path: workspace, returning });

  void refreshWorkspace().catch((error) => addProgress(`Workspace scan failed: ${error instanceof Error ? error.message : 'unknown error'}`));
  return { state: await getWorkspaceState(), returning };
}

// Desktop app: the workspace the user picks is also where builds go. Saved outside the folder
// (in the app's data folder) so the next launch starts there; applied live — every factory path
// reads config.factory.workspaceRoot at call time.
async function useAsBuildsFolder(workspace: string) {
  const settings = { ...readDesktopSettings(), workspaceRoot: workspace };
  await mkdir(path.dirname(desktopSettingsFile), { recursive: true });
  await writeFile(desktopSettingsFile, JSON.stringify(settings, null, 2));
  config.factory.workspaceRoot = workspace;
}

export async function activeWorkspace(): Promise<string | null> {
  const value = await db.getSetting(ACTIVE_SETTING);
  return typeof value === 'string' && value ? value : null;
}

export async function recentWorkspaces(): Promise<string[]> {
  const value = (await db.getSetting(RECENTS_SETTING)) as string[] | null;
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

export async function clearActiveWorkspace() { await db.setSetting(ACTIVE_SETTING, ''); }

// ---- discovery + scan ----
let scanning = false;
let refreshQueued = false;

async function discoverProjects(workspace: string): Promise<Array<{ dirName: string; dirPath: string; jobMeta: Record<string, unknown> | null }>> {
  const entries = await readdir(workspace, { withFileTypes: true }).catch(() => []);
  const found: Array<{ dirName: string; dirPath: string; jobMeta: Record<string, unknown> | null }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dirPath = path.join(workspace, entry.name);
    const jobFile = path.join(dirPath, 'job.json');
    if (await exists(jobFile)) {
      let jobMeta: Record<string, unknown> | null = null;
      try { jobMeta = JSON.parse(await readFile(jobFile, 'utf8')); } catch { /* corrupt job.json — still a project */ }
      found.push({ dirName: entry.name, dirPath, jobMeta });
      continue;
    }
    // Older/hand-made clone projects (shopify_folder_init anatomy, pre-factory): any of the
    // canonical markers qualifies — react_files/, sections/, or TARGET_SITE_INFO.txt.
    const markers = await Promise.all([exists(path.join(dirPath, 'react_files')), exists(path.join(dirPath, 'sections')), exists(path.join(dirPath, 'TARGET_SITE_INFO.txt'))]);
    if (markers.some(Boolean)) found.push({ dirName: entry.name, dirPath, jobMeta: null });
  }
  return found;
}

async function projectMtimeKey(dirPath: string): Promise<number> {
  const keys = await Promise.all([dirMtime(path.join(dirPath, 'job.json')), dirMtime(path.join(dirPath, 'TARGET_SITE_INFO.txt')), dirMtime(path.join(dirPath, 'sections')), dirMtime(path.join(dirPath, 'qa', 'reports'))]);
  return Math.max(...keys, 0);
}

async function statusHint(dirPath: string): Promise<ProjectEntry['status']> {
  if (await exists(path.join(dirPath, 'qa', 'reports', 'BLOCKED.md'))) return 'blocked';
  if (await exists(path.join(dirPath, 'qa', 'reports', 'final.md'))) return 'cloned';
  if (await exists(path.join(dirPath, 'sections'))) return 'partial';
  return 'fresh';
}

async function scanProject(entry: ProjectEntry): Promise<Partial<ProjectEntry>> {
  await trustWorkspace(entry.path).catch(() => { /* scan may still work if already trusted */ });
  const result = await runQuickClaude({
    args: ['-p', SCAN_PROMPT, '--model', 'haiku', '--output-format', 'json', '--max-turns', '8', '--allowedTools', 'Read,Glob'],
    cwd: entry.path, env: await claudeEnv(), timeoutMs: SCAN_TIMEOUT_MS,
  });
  if (!result.ok) return { error: result.timedOut ? 'Scan timed out.' : (result.stderr || `exit ${result.exitCode}`).slice(0, 200), summary: entry.summary || 'Scan failed — retry from the dashboard.', scannedAt: new Date().toISOString() };
  try {
    // --output-format json wraps the reply: {..., result: "<model text>"}
    const envelope = JSON.parse(result.stdout) as { result?: string };
    const text = typeof envelope.result === 'string' ? envelope.result : result.stdout;
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as { summary?: string; target_site?: string; store?: string; sections_count?: number; has_react_source?: boolean; state?: string };
    return {
      summary: (parsed.summary || '').slice(0, 500) || 'No summary produced.',
      sectionsCount: typeof parsed.sections_count === 'number' ? parsed.sections_count : 0,
      reactUrl: entry.reactUrl || parsed.target_site || '',
      storeUrl: entry.storeUrl || parsed.store || '',
      status: (['cloned', 'partial', 'fresh'].includes(parsed.state ?? '') ? parsed.state : entry.status) as ProjectEntry['status'],
      scannedAt: new Date().toISOString(), error: null,
    };
  } catch { return { error: 'Scan reply was not valid JSON.', summary: entry.summary || 'Scan failed — retry from the dashboard.', scannedAt: new Date().toISOString() }; }
}

export async function refreshWorkspace(force = false): Promise<void> {
  if (scanning) { refreshQueued = true; return; }
  const workspace = await activeWorkspace();
  if (!workspace || !(await exists(workspace))) return;
  scanning = true;
  const done = beginTask();
  try {
    addProgress('Discovering projects in the workspace…');
    const marker = (await readMarker(workspace)) ?? { version: MARKER_VERSION, id: `ws_${randomBytes(5).toString('hex')}`, name: path.basename(workspace), createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), projects: {} as Record<string, ProjectEntry> };
    const discovered = await discoverProjects(workspace);
    addProgress(discovered.length ? `Found ${discovered.length} project folder(s).` : 'No project folders found yet — create one from Theme Builder.');

    const nextProjects: Record<string, ProjectEntry> = {};
    const toScan: ProjectEntry[] = [];
    for (const item of discovered) {
      const previous = marker.projects[item.dirName];
      const mtimeKey = await projectMtimeKey(item.dirPath);
      const entry: ProjectEntry = {
        path: item.dirPath,
        name: String(item.jobMeta?.name ?? previous?.name ?? item.dirName),
        reactUrl: String(item.jobMeta?.react_url ?? previous?.reactUrl ?? ''),
        storeUrl: String(item.jobMeta?.store_url ?? previous?.storeUrl ?? ''),
        status: previous?.status ?? 'unknown',
        mtimeKey, summary: previous?.summary ?? '', sectionsCount: previous?.sectionsCount ?? 0,
        scannedAt: previous?.scannedAt ?? null, error: previous?.error ?? null,
      };
      entry.status = await statusHint(item.dirPath);
      const changed = !previous || previous.mtimeKey !== mtimeKey || !previous.scannedAt;
      if (force || changed) toScan.push(entry);
      nextProjects[item.dirName] = entry;
    }
    marker.projects = nextProjects;
    await writeMarker(workspace, marker);

    if (toScan.length) {
      addProgress(`Summarizing ${toScan.length} project(s) with Haiku…`);
      let index = 0;
      const workers = Array.from({ length: Math.min(SCAN_CONCURRENCY, toScan.length) }, async () => {
        while (index < toScan.length) {
          const entry = toScan[index]; index += 1;
          addProgress(`Scanning ${entry.name}…`);
          const update = await scanProject(entry);
          Object.assign(entry, update);
          addProgress(update.error ? `⚠ ${entry.name}: ${update.error}` : `✓ ${entry.name}: indexed (${entry.sectionsCount} sections).`);
          await writeMarker(workspace, marker); // persist incrementally
        }
      });
      await Promise.all(workers);
    }
    addProgress(`✓ Workspace ready — ${discovered.length} project(s) indexed.`);
  } finally {
    scanning = false; done();
    if (refreshQueued) { refreshQueued = false; void refreshWorkspace(); }
  }
}

export async function getWorkspaceState(): Promise<WorkspaceState> {
  const workspace = await activeWorkspace();
  if (!workspace || !(await exists(workspace))) return { path: null, name: null, ready: false, scanning, projects: [] };
  const marker = await readMarker(workspace);
  const entries = Object.values(marker?.projects ?? {}).sort((a, b) => b.mtimeKey - a.mtimeKey);
  // Dates for the Projects page: when the folder was created, and its latest real work.
  const projects = await Promise.all(entries.map(async (entry) => {
    const info = await stat(entry.path).catch(() => null);
    const created = info ? (info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs) : 0;
    const updated = Math.max(entry.mtimeKey || 0, 0) || (info?.mtimeMs ?? 0);
    return { ...entry, createdAt: created ? new Date(created).toISOString() : null, updatedAt: updated ? new Date(updated).toISOString() : null };
  }));
  return { path: workspace, name: marker?.name ?? path.basename(workspace), ready: true, scanning, projects };
}
