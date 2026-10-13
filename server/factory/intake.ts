// Easy-mode intake helpers — LOCAL OPERATOR TOOL (factory router is loopback-only).
//
//  1. Shopify sign-in check against the app's managed browser (the one the easy autopilot drives).
//  2. Zip intake: save the upload, extract it, and describe the React project inside.
//  3. Project preview: install + start the project, screenshot its landing page, stop it — so a
//     non-technical user can visually confirm "yes, that's my site" before anything is created.
//     The same runner can keep a project alive (keepAlive) to serve as the QA reference site
//     when the user has no public link for it.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { browserManager } from '../browser';
import { buildSpawnEnv } from './runner';
import { ingestReactSource } from './scaffolder';
import { killTree, ownProcessGroup } from '../platform/proc';

async function exists(target: string) { return access(target).then(() => true, () => false); }

export const INTAKE_ROOT = () => path.join(config.factory.workspaceRoot, '_intake');

// ---------------------------------------------------------------------------
// 1. Shopify sign-in check
// ---------------------------------------------------------------------------

export interface LoginStatus { signedIn: boolean; checkedAt: number; url: string | null; detail: string; browserAvailable: boolean }

let loginCache: LoginStatus | null = null;
let loginInflight: Promise<LoginStatus> | null = null;
const LOGIN_CACHE_MS = 45_000;
const LOGIN_PAGE = /accounts\.shopify\.com|\/login|\/lookup|\/signup|identity/i;

/** Is the managed browser signed into Shopify? Loads the admin root and looks at where it lands:
 *  signed-in sessions stay on admin.shopify.com, everyone else is bounced to accounts.shopify.com. */
export async function checkShopifyLogin(fresh = false): Promise<LoginStatus> {
  if (!fresh && loginCache && Date.now() - loginCache.checkedAt < LOGIN_CACHE_MS) return loginCache;
  if (loginInflight) return loginInflight;
  loginInflight = (async () => {
    if (!config.browser.enabled) {
      return { signedIn: false, checkedAt: Date.now(), url: null, detail: 'The built-in browser is turned off on this install, so the sign-in check cannot run.', browserAvailable: false };
    }
    try {
      const result = await browserManager.probe('https://admin.shopify.com/', { timeoutMs: 25_000 });
      let host = '';
      try { host = new URL(result.finalUrl).hostname.toLowerCase(); } catch { host = ''; }
      const signedIn = host === 'admin.shopify.com' && !LOGIN_PAGE.test(result.finalUrl) && !result.loginForm && !/log in|sign in/i.test(result.title);
      return {
        signedIn, checkedAt: Date.now(), url: result.finalUrl, browserAvailable: true,
        detail: signedIn ? 'Signed in to Shopify in the built-in browser.' : 'The built-in browser is not signed in to Shopify yet.',
      };
    } catch (error) {
      return { signedIn: false, checkedAt: Date.now(), url: null, browserAvailable: false, detail: `Could not open the built-in browser: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
  })().then((status) => { loginCache = status; return status; }).finally(() => { loginInflight = null; });
  return loginInflight;
}

export function forgetLoginStatus() { loginCache = null; }

/** Open the Shopify sign-in page in a visible tab of the managed browser so the user can log in
 *  from the app's Browser view. Returns the tab list so the UI can jump straight there. */
export async function openShopifySignIn() {
  await browserManager.newTab('https://admin.shopify.com/');
  forgetLoginStatus();
  return browserManager.status();
}

// ---------------------------------------------------------------------------
// 2. Zip intake + project inspection
// ---------------------------------------------------------------------------

export type Framework = 'next' | 'vite' | 'cra' | 'remix' | 'gatsby' | 'astro' | 'unknown';

export interface ProjectInfo {
  root: string;            // folder that holds package.json
  name: string | null;     // package.json "name"
  framework: Framework;
  devScript: string | null;
  pages: string[];         // best-effort route list for the confirmation screen
  hasNodeModules: boolean;
}

/** Find the first folder (depth ≤ 3) containing a package.json — mirrors containsPackageJson. */
export async function findProjectRoot(root: string, depth = 3): Promise<string | null> {
  if (await exists(path.join(root, 'package.json'))) return root;
  if (depth === 0) return null;
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const found = await findProjectRoot(path.join(root, entry.name), depth - 1);
      if (found) return found;
    }
  } catch { /* unreadable */ }
  return null;
}

async function listRoutes(projectRoot: string): Promise<string[]> {
  const routes = new Set<string>();
  const walk = async (dir: string, base: string, depth: number) => {
    if (depth > 4) return;
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.') || entry.name === 'api') continue;
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(path.join(dir, entry.name), rel, depth + 1); continue; }
      const match = entry.name.match(/^(page|index)\.(tsx|jsx|ts|js|mdx?)$/) ?? entry.name.match(/^([a-z0-9-]+)\.(tsx|jsx|ts|js)$/i);
      if (!match) continue;
      const stem = match[1];
      const segment = stem === 'page' || stem === 'index' ? base : (base ? `${base}/${stem}` : stem);
      routes.add('/' + segment.replace(/\(.*?\)\/?/g, '').replace(/\/+$/, ''));
    }
  };
  for (const candidate of ['app', 'src/app', 'pages', 'src/pages', 'src/routes', 'app/routes']) {
    const dir = path.join(projectRoot, candidate);
    if (await exists(dir)) await walk(dir, '', 0);
  }
  const list = [...routes].map((route) => (route === '' ? '/' : route)).filter((route) => !/\[|\$/.test(route));
  return list.sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 24);
}

export async function inspectProject(folder: string): Promise<ProjectInfo> {
  const root = await findProjectRoot(folder);
  if (!root) throw new Error('No package.json was found inside the upload — make sure the zip holds the project source, not a build export.');
  let pkg: { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try { pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')); } catch { /* unreadable → unknown */ }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const framework: Framework = deps.next ? 'next' : deps['@remix-run/dev'] || deps['@remix-run/react'] ? 'remix' : deps.gatsby ? 'gatsby' : deps.astro ? 'astro' : deps.vite ? 'vite' : deps['react-scripts'] ? 'cra' : 'unknown';
  const scripts = pkg.scripts ?? {};
  const devScript = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.develop ? 'develop' : scripts.serve ? 'serve' : null;
  // An empty node_modules/ (an interrupted install) must not count as installed: npm writes
  // .package-lock.json and .bin/ only once packages are actually in place.
  const hasNodeModules = (await exists(path.join(root, 'node_modules', '.package-lock.json'))) || (await exists(path.join(root, 'node_modules', '.bin')));
  return { root, name: pkg.name ?? null, framework, devScript, pages: await listRoutes(root), hasNodeModules };
}

/** Persist an uploaded zip under _intake/<id>/ and extract it into react_files/. */
export async function ingestUpload(buffer: Buffer, originalName: string): Promise<{ intakeId: string; dir: string; reactFilesPath: string; info: ProjectInfo }> {
  const intakeId = randomUUID();
  const dir = path.join(INTAKE_ROOT(), intakeId);
  await mkdir(dir, { recursive: true });
  const safeName = (originalName || 'upload.zip').replace(/[^a-z0-9._-]+/gi, '_').replace(/^\.+/, '') || 'upload.zip';
  const zipPath = path.join(dir, /\.zip$/i.test(safeName) ? safeName : `${safeName}.zip`);
  await writeFile(zipPath, buffer);
  const reactFilesPath = path.join(dir, 'react_files');
  await ingestReactSource(zipPath, reactFilesPath);
  const info = await inspectProject(reactFilesPath);
  await writeFile(path.join(dir, 'intake.json'), JSON.stringify({ intakeId, originalName, zipPath, reactFilesPath, info, createdAt: new Date().toISOString() }, null, 2));
  return { intakeId, dir, reactFilesPath, info };
}

// ---------------------------------------------------------------------------
// 3. Preview runner (install → start → screenshot → stop) + keep-alive sites
// ---------------------------------------------------------------------------

export type PreviewPhase = 'queued' | 'installing' | 'starting' | 'capturing' | 'done' | 'failed' | 'stopped';

export interface PreviewRun {
  id: string;
  phase: PreviewPhase;
  source: { path?: string; url?: string };
  keepAlive: boolean;
  url: string | null;          // the running site (local dev server or the given link)
  screenshotPath: string | null;
  log: string[];
  /** Timestamped, typed activity — what the "What's happening" panel shows. */
  events: ActivityEvent[];
  /** Stage bar: which part of the check is running and how long each part took. */
  stages: PreviewStage[];
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  child: ChildProcess | null;
  projectRoot: string | null;
}

/** step = a stage began, cmd = a command we ran, net = a network call, out = raw program output,
 *  ok = something succeeded, err = something failed, info = a plain note. */
export type ActivityKind = 'step' | 'cmd' | 'net' | 'out' | 'ok' | 'err' | 'info';
export interface ActivityEvent { at: number; kind: ActivityKind; text: string }
export type PreviewStageId = 'prepare' | 'install' | 'start' | 'check' | 'capture';
export interface PreviewStage { id: PreviewStageId; label: string; state: 'pending' | 'active' | 'done' | 'failed' | 'skipped'; startedAt: number | null; endedAt: number | null }

const STAGE_LABELS: Record<PreviewStageId, string> = { prepare: 'Read the project', install: 'Install packages', start: 'Start the site', check: 'Wait for it to answer', capture: 'Take a picture' };
const EVENT_LIMIT = 400;

function newStages(source: { path?: string; url?: string }): PreviewStage[] {
  const ids: PreviewStageId[] = source.path ? ['prepare', 'install', 'start', 'check', 'capture'] : ['check', 'capture'];
  return ids.map((id) => ({ id, label: STAGE_LABELS[id], state: 'pending', startedAt: null, endedAt: null }));
}

/** Close the active stage (done) and open `id`. */
function enterStage(run: PreviewRun, id: PreviewStageId, note?: string) {
  const now = Date.now();
  for (const stage of run.stages) if (stage.state === 'active') { stage.state = 'done'; stage.endedAt = now; }
  const stage = run.stages.find((entry) => entry.id === id);
  if (stage) { stage.state = 'active'; stage.startedAt = now; }
  event(run, 'step', note ?? STAGE_LABELS[id]);
}
function skipStage(run: PreviewRun, id: PreviewStageId) {
  const stage = run.stages.find((entry) => entry.id === id);
  if (stage && stage.state === 'pending') stage.state = 'skipped';
}
function closeStages(run: PreviewRun, failed: boolean) {
  const now = Date.now();
  for (const stage of run.stages) {
    if (stage.state === 'active') { stage.state = failed ? 'failed' : 'done'; stage.endedAt = now; }
    else if (stage.state === 'pending' && !failed) stage.state = 'skipped';
  }
}

function event(run: PreviewRun, kind: ActivityKind, text: string) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!clean) return;
  const last = run.events[run.events.length - 1];
  if (last && last.text === clean && last.kind === kind) return;
  run.events.push({ at: Date.now(), kind, text: clean.slice(0, 300) });
  if (run.events.length > EVENT_LIMIT) run.events = run.events.slice(-EVENT_LIMIT);
}

/** Classify a line of program output: npm's registry calls become `net`, errors `err`. */
function classify(line: string): ActivityKind {
  if (/^Preview ready/.test(line)) return 'ok';
  if (/^Local site stopped|^The project's lockfile/.test(line)) return 'info';
  if (/^npm (http|sill)? ?fetch|^npm http /i.test(line) || /\bGET \d{3} https?:\/\//.test(line)) return 'net';
  if (/\b(ERR!|error)\b/i.test(line) && !/0 errors?/i.test(line)) return 'err';
  if (/^npm warn/i.test(line)) return 'info';
  return 'out';
}

/** npm's http log lines are long; keep them readable: "GET 200 registry.npmjs.org/react · 84ms". */
function tidyNet(line: string) {
  const match = line.match(/(GET|POST|PUT)\s+(\d{3})\s+https?:\/\/([^\s]+)\s*(\d+ms)?(.*)$/);
  if (!match) return line.replace(/^npm (http )?/, '');
  const [, method, code, target, ms, rest] = match;
  const cache = /cache (hit|revalidated|stale)/i.test(rest ?? '') ? ' · from cache' : '';
  return `${method} ${code} ${target.replace(/\?.*$/, '')}${ms ? ` · ${ms}` : ''}${cache}`;
}

/** Count installed packages (incl. @scope/*) so a quiet install still shows movement. */
async function countPackages(root: string): Promise<number> {
  const dir = path.join(root, 'node_modules');
  let entries: string[] = [];
  try { entries = await readdir(dir); } catch { return 0; }
  let count = 0;
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) { try { count += (await readdir(path.join(dir, name))).length; } catch { /* racing the installer */ } }
    else count += 1;
  }
  return count;
}

const runs = new Map<string, PreviewRun>();
const INSTALL_TIMEOUT_MS = 6 * 60_000;
const START_TIMEOUT_MS = 3 * 60_000;
const READY_TIMEOUT_MS = 90_000;
const LOG_LIMIT = 80;

function pushLog(run: PreviewRun, line: string) {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!clean) return;
  if (run.log[run.log.length - 1] === clean) return;
  run.log.push(clean.slice(0, 200));
  if (run.log.length > LOG_LIMIT) run.log = run.log.slice(-LOG_LIMIT);
  const kind: ActivityKind = clean.startsWith('$ ') ? 'cmd' : clean.startsWith('✗') ? 'err' : classify(clean);
  event(run, kind, kind === 'net' ? tidyNet(clean) : clean);
}


async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** AI site builders (Kimi, Bolt, …) export lockfiles resolved against their own private npm
 *  mirrors, which are unreachable from a user's machine and make `npm install` die with
 *  ENOTFOUND. If any resolved URL points somewhere other than the public registry, set the
 *  lockfile aside (kept as a .bak) so npm resolves from registry.npmjs.org instead. */
async function neutralizePrivateLockfile(run: PreviewRun, root: string) {
  const lock = path.join(root, 'package-lock.json');
  if (!(await exists(lock))) return;
  let text = '';
  try { text = await readFile(lock, 'utf8'); } catch { return; }
  const hosts = new Set<string>();
  for (const match of text.matchAll(/"resolved":\s*"(https?:\/\/[^/"]+)/g)) hosts.add(match[1].toLowerCase());
  const foreign = [...hosts].filter((host) => !/registry\.npmjs\.org|registry\.yarnpkg\.com/.test(host));
  if (foreign.length === 0) return;
  await rename(lock, `${lock}.private-mirror.bak`);
  pushLog(run, `The project's lockfile points at a private package mirror (${foreign[0].replace(/^https?:\/\//, '')}) — installing from the public registry instead.`);
}

/** Run an npm command to completion, streaming its output into the run log. */
function runNpm(run: PreviewRun, args: string, cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // loglevel=http makes npm print every registry request, so the user sees real calls happening.
    const command = `npm ${args} --loglevel=http`;
    pushLog(run, `$ ${command}`);
    event(run, 'info', `Downloading from registry.npmjs.org into ${path.join(path.basename(cwd), 'node_modules')}`);
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: ownProcessGroup, env: buildSpawnEnv({ CI: '1', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_registry: 'https://registry.npmjs.org/' }) });
    run.child = child;
    const onData = (chunk: Buffer) => { for (const line of chunk.toString('utf8').split(/\r?\n/)) pushLog(run, line); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    let lastCount = -1;
    const counter = setInterval(() => {
      void countPackages(cwd).then((count) => { if (count !== lastCount && count > 0) { lastCount = count; event(run, 'info', `${count} packages in place so far`); } });
    }, 4000);
    const timer = setTimeout(() => { clearInterval(counter); killTree(child); reject(new Error(`npm ${args} took longer than ${Math.round(timeoutMs / 60_000)} minutes.`)); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); clearInterval(counter); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer); clearInterval(counter); run.child = null;
      if (code === 0) void countPackages(cwd).then((count) => { event(run, 'ok', `Install finished — ${count} packages installed`); resolve(); });
      else reject(new Error(`npm ${args} exited with code ${code ?? 'n/a'}.`));
    });
  });
}

const URL_IN_OUTPUT = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?\/?/i;

/** Start the project's dev server and resolve with the URL it announces (or the port we assigned). */
function startDevServer(run: PreviewRun, info: ProjectInfo, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const script = info.devScript!;
    // Frameworks that accept --port on the CLI get it explicitly; everyone else honours PORT.
    const portArg = ['vite', 'next', 'remix', 'astro', 'gatsby'].includes(info.framework) ? ` -- --port ${port}` : '';
    const command = `npm run ${script}${portArg}`;
    pushLog(run, `$ ${command}`);
    const child = spawn(command, { cwd: info.root, shell: true, windowsHide: true, detached: ownProcessGroup, env: buildSpawnEnv({ PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none', CI: '1', FORCE_COLOR: '0' }) });
    run.child = child;
    let settled = false;
    const finish = (error: Error | null, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { killTree(child); run.child = null; reject(error); } else resolve(url!);
    };
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        pushLog(run, line);
        // Vite colours the port with ANSI codes between host and port, so strip them before matching.
        const match = line.replace(/\x1b\[[0-9;]*m/g, '').match(URL_IN_OUTPUT);
        if (match && !settled) { const found = match[0].replace(/0\.0\.0\.0|\[::1?\]/, 'localhost').replace(/\/$/, ''); event(run, 'ok', `The site says it is running at ${found}`); finish(null, found); }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => finish(new Error('The project started but never printed a local address — it may need manual setup.')), START_TIMEOUT_MS);
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => { if (!settled) finish(new Error(`The dev server exited early (code ${code ?? 'n/a'}). See the log for the reason.`)); else { run.child = null; if (run.keepAlive && run.phase === 'done') { run.phase = 'stopped'; pushLog(run, 'Local site stopped.'); } } });
  });
}

async function waitUntilReady(url: string, timeoutMs: number, run?: PreviewRun) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const began = Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (run) event(run, response.status < 500 ? 'ok' : 'net', `GET ${url} → ${response.status} ${response.statusText || ''}`.trim() + ` · ${Date.now() - began}ms`);
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : 'unreachable';
      if (run) event(run, 'net', `GET ${url} → not answering yet (${lastError.replace(/^connect /, '')}) · try ${attempt}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`The site at ${url} never answered (${lastError}).`);
}

export function startPreview(source: { path?: string; url?: string }, keepAlive = false): PreviewRun {
  const run: PreviewRun = { id: randomUUID(), phase: 'queued', source, keepAlive, url: null, screenshotPath: null, log: [], events: [], stages: newStages(source), error: null, startedAt: Date.now(), finishedAt: null, child: null, projectRoot: null };
  runs.set(run.id, run);
  void (async () => {
    try {
      if (source.path) {
        enterStage(run, 'prepare', 'Reading the project');
        event(run, 'info', `Folder: ${source.path}`);
        const info = await inspectProject(source.path);
        run.projectRoot = info.root;
        event(run, 'ok', `Found package.json${info.name ? ` for "${info.name}"` : ''} — ${info.framework === 'unknown' ? 'framework not recognised' : `${info.framework} project`}${info.devScript ? `, start command "npm run ${info.devScript}"` : ''}`);
        if (info.pages.length) event(run, 'info', `${info.pages.length} page${info.pages.length === 1 ? '' : 's'} found: ${info.pages.slice(0, 6).join(', ')}${info.pages.length > 6 ? '…' : ''}`);
        if (!info.devScript) throw new Error('This project has no "dev" or "start" script, so ThemeBot cannot run it.');
        if (!info.hasNodeModules) {
          run.phase = 'installing';
          enterStage(run, 'install', 'Installing the project\'s packages (first time only)');
          await neutralizePrivateLockfile(run, info.root);
          await runNpm(run, 'install --no-audit --no-fund', info.root, INSTALL_TIMEOUT_MS);
        } else {
          skipStage(run, 'install');
          event(run, 'info', 'Packages are already installed — skipping the install');
        }
        run.phase = 'starting';
        const port = await freePort();
        enterStage(run, 'start', `Starting the project on port ${port}`);
        run.url = await startDevServer(run, info, port);
        enterStage(run, 'check', `Checking that ${run.url} answers`);
        await waitUntilReady(run.url, READY_TIMEOUT_MS, run);
      } else if (source.url) {
        run.url = source.url;
        enterStage(run, 'check', `Checking that ${run.url} answers`);
        await waitUntilReady(run.url, READY_TIMEOUT_MS, run);
      } else {
        throw new Error('Nothing to preview.');
      }
      run.phase = 'capturing';
      enterStage(run, 'capture', 'Taking a picture of the landing page');
      event(run, 'cmd', `Opening a hidden Chrome window → ${run.url}`);
      const shotStarted = Date.now();
      const shot = await browserManager.probe(run.url, { timeoutMs: 40_000, screenshot: true, settleMs: 1500 });
      event(run, 'ok', `Page loaded${shot.title ? ` — "${shot.title}"` : ''} · ${((Date.now() - shotStarted) / 1000).toFixed(1)}s`);
      if (shot.finalUrl && shot.finalUrl.replace(/\/$/, '') !== run.url.replace(/\/$/, '')) event(run, 'info', `Redirected to ${shot.finalUrl}`);
      if (!shot.screenshot) throw new Error('The page loaded but could not be captured.');
      event(run, 'ok', `Picture saved (${Math.round(shot.screenshot.length / 1024)} KB)`);
      const dir = path.join(INTAKE_ROOT(), '_previews');
      await mkdir(dir, { recursive: true });
      run.screenshotPath = path.join(dir, `${run.id}.png`);
      await writeFile(run.screenshotPath, shot.screenshot);
      run.phase = 'done';
      run.finishedAt = Date.now();
      closeStages(run, false);
      pushLog(run, keepAlive && source.path ? 'Preview ready — the local site stays running for the clone.' : 'Preview ready.');
      if (!keepAlive && source.path) { killTree(run.child); run.child = null; }
    } catch (error) {
      run.phase = 'failed';
      run.error = error instanceof Error ? error.message : String(error);
      run.finishedAt = Date.now();
      closeStages(run, true);
      pushLog(run, `✗ ${run.error}`);
      killTree(run.child); run.child = null;
    }
  })();
  return run;
}

export function getPreview(id: string): PreviewRun | undefined { return runs.get(id); }

export function stopPreview(id: string) {
  const run = runs.get(id);
  if (!run) return false;
  killTree(run.child); run.child = null;
  if (run.phase !== 'done' && run.phase !== 'failed') { run.phase = 'stopped'; run.finishedAt = Date.now(); }
  else if (run.keepAlive) run.phase = 'stopped';
  return true;
}

export function publicPreview(run: PreviewRun) {
  const { child: _child, ...rest } = run;
  return { ...rest, elapsedSec: Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000), hasScreenshot: Boolean(run.screenshotPath) };
}

/** Wait for a preview run to reach a terminal phase (used by the easy orchestrator). */
export async function awaitPreview(id: string, timeoutMs = INSTALL_TIMEOUT_MS + START_TIMEOUT_MS + READY_TIMEOUT_MS): Promise<PreviewRun> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = runs.get(id);
    if (!run) throw new Error('Preview run vanished.');
    if (run.phase === 'done' || run.phase === 'failed' || run.phase === 'stopped') return run;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for the project to start.');
}

/** Stop every dev server we started (shutdown hook). */
export async function stopAllPreviews() {
  const stopping = [...runs.values()].map((run) => { const child = run.child; run.child = null; return killTree(child); });
  await Promise.all(stopping);
}
