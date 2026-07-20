import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, readdir, readFile, rm, stat, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { config } from '../config';
import { detectEngines, resolveExtensions } from '../browser';
import { db, type FactoryJobRecord } from '../db';
import { decrypt, encrypt, newSecret, normalizeShop, rateLimit, secureEqual } from '../security';
import { TEMPLATES_ROOT, containsPackageJson, derivePrefix, isZipPath, mintKeyFor, resolveWorkspacePath, scaffoldWorkspace, slugify, trustWorkspace } from './scaffolder';
import { factoryScheduler } from './scheduler';
import { getFactorySettings, lockedFields, updateFactorySettings } from './settings';
import { buildSpawnEnv, scrubSecrets } from './runner';
import { TERMINAL_STATUSES, type JobIntake } from './types';

type AsyncHandler = (request: Request, response: Response, next: NextFunction) => Promise<unknown>;
const handle = (handler: AsyncHandler) => (request: Request, response: Response, next: NextFunction) => handler(request, response, next).catch(next);

export function requireFactoryEnabled(_request: Request, response: Response, next: NextFunction) {
  if (!config.factory.enabled) { response.status(404).json({ error: 'The clone factory is disabled on this deployment.' }); return; }
  next();
}

function publicJob(job: FactoryJobRecord) {
  const { client_id_cipher, client_secret_cipher, storefront_password_cipher, ...rest } = job;
  return { ...rest, running: factoryScheduler.isRunning(job.id) };
}

async function fileExists(target: string) { return access(target).then(() => true, () => false); }

/** Loopback-only guard. Applied router-wide: the factory API mints live Shopify tokens,
 * spawns local CLI/browser processes, and can recursively delete workspaces — none of which
 * has any business being reachable from the LAN. */
function isLoopback(request: Request) {
  const address = request.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function requireLoopback(request: Request, response: Response, next: NextFunction) {
  if (!isLoopback(request)) { response.status(403).json({ error: 'The factory API is available on localhost only.' }); return; }
  next();
}

/** Resolve a workspace-relative file while refusing traversal outside the allowed prefix. */
function safeResolve(root: string, prefix: string, name: string) {
  const resolved = path.resolve(root, prefix, name);
  const boundary = path.resolve(root, prefix) + path.sep;
  if (!resolved.startsWith(boundary)) throw new Error('Invalid path.');
  return resolved;
}

async function tailFile(target: string, lines: number) {
  const info = await stat(target);
  const size = 128 * 1024;
  const start = Math.max(0, info.size - size);
  const handleFile = await open(target, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, info.size));
    await handleFile.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return text.split(/\r?\n/).slice(-lines).join('\n');
  } finally {
    await handleFile.close();
  }
}

const REQUIRED_SCOPES = ['write_themes', 'read_themes'];
const RECOMMENDED_SCOPES = ['write_online_store_navigation', 'write_content'];

let browserInstalling = false;
let qaSelftestRunning = false;

// --- QA calibration self-test (templates/factory/qa/calibrate.mjs) ---

const QA_SELFTEST_TIMEOUT_MS = 5 * 60_000;

interface CalibrationOutcome {
  ok: boolean;
  score: number | null;
  subscores: { presence: number | null; text: number | null; interaction: number | null } | null;
  log: string;
  error?: string;
}

/** Kill the calibration node process and its Chromium children (plain kill orphans them on Windows). */
function killSelftestTree(child: ReturnType<typeof spawn>) {
  if (child.pid == null || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, env: buildSpawnEnv() });
  else child.kill('SIGKILL');
}

/** Run calibrate.mjs (bounded) and parse its trailing `CALIBRATE_RESULT <json>` line. */
function runCalibration(script: string): Promise<CalibrationOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      shell: false, windowsHide: true, cwd: path.dirname(script),
      // Allowlisted env (no process.env spread) — app secrets never reach the QA pipeline.
      env: buildSpawnEnv({ PW_ROOT: config.factory.playwrightRoot, FACTORY_PW_ROOT: config.factory.playwrightRoot }),
    });
    let output = '';
    const append = (chunk: Buffer) => { if (output.length < 64 * 1024) output += chunk.toString('utf8'); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let settled = false;
    const finish = (outcome: CalibrationOutcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...outcome, log: scrubSecrets(outcome.log) }); } };
    const timer = setTimeout(() => {
      killSelftestTree(child);
      finish({ ok: false, score: null, subscores: null, log: output, error: `QA self-test exceeded ${QA_SELFTEST_TIMEOUT_MS / 60_000} minutes — Playwright/Chromium may not be installed (check GET /api/factory/browser).` });
    }, QA_SELFTEST_TIMEOUT_MS);
    child.on('error', (error) => finish({ ok: false, score: null, subscores: null, log: output, error: `Could not launch the calibration script: ${error.message}` }));
    child.on('exit', (code) => {
      const line = output.split(/\r?\n/).reverse().find((entry) => entry.startsWith('CALIBRATE_RESULT '));
      if (!line) { finish({ ok: false, score: null, subscores: null, log: output, error: `calibrate.mjs exited ${code ?? 'n/a'} without a result line — see log.` }); return; }
      try {
        const parsed = JSON.parse(line.slice('CALIBRATE_RESULT '.length)) as { ok?: boolean; score?: number; subscores?: CalibrationOutcome['subscores']; error?: string };
        finish({ ok: Boolean(parsed.ok) && code === 0, score: parsed.score ?? null, subscores: parsed.subscores ?? null, log: output, ...(parsed.ok && code === 0 ? {} : { error: parsed.error ?? 'Calibration score fell below the 0.95 threshold — the QA scoring pipeline is not trustworthy on this machine.' }) });
      } catch {
        finish({ ok: false, score: null, subscores: null, log: output, error: 'Could not parse the calibration result line.' });
      }
    });
  });
}

export function createFactoryRouter() {
  const router = Router();
  router.use(requireFactoryEnabled, requireLoopback, rateLimit(300));

  // --- Jobs ---
  router.post('/jobs', handle(async (request, response) => {
    const body = request.body as JobIntake;
    const name = String(body.name ?? '').trim();
    if (!name) { response.status(422).json({ error: 'A project name is required.' }); return; }
    let reactUrl: URL;
    try { reactUrl = new URL(String(body.reactUrl ?? '')); if (!/^https?:$/.test(reactUrl.protocol)) throw new Error(); } catch { response.status(422).json({ error: 'The React URL must be a valid http(s) URL.' }); return; }
    const shop = normalizeShop(String(body.storeUrl ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    if (!shop) { response.status(422).json({ error: 'The store URL must be a *.myshopify.com domain.' }); return; }
    // Credentials come either from the form, or from a saved store (savedStoreId) — in the
    // latter case the secret is decrypted server-side and never round-trips the browser.
    let clientId = String(body.clientId ?? '').trim();
    let clientSecret = String(body.clientSecret ?? '').trim();
    let storefrontPassword = body.storefrontPassword ? String(body.storefrontPassword) : null;
    if (body.savedStoreId) {
      const saved = await db.getFactoryStore(String(body.savedStoreId));
      if (!saved) { response.status(422).json({ error: 'The selected saved store no longer exists — pick another or enter credentials manually.' }); return; }
      if (saved.shop_domain !== shop) { response.status(422).json({ error: `The saved store "${saved.label}" is for ${saved.shop_domain}, not ${shop}.` }); return; }
      clientId = saved.client_id;
      try { clientSecret = decrypt(saved.client_secret_cipher); }
      catch { response.status(500).json({ error: 'Could not decrypt the stored credentials for this store.' }); return; }
      if (!storefrontPassword && saved.storefront_password_cipher) {
        try { storefrontPassword = decrypt(saved.storefront_password_cipher); } catch { storefrontPassword = null; }
      }
    }
    if (!/^[0-9a-f]{32}$/i.test(clientId)) { response.status(422).json({ error: 'The Client ID must be a 32-character hex string.' }); return; }
    if (!/^shpss_/.test(clientSecret)) { response.status(422).json({ error: 'The Client Secret must start with shpss_.' }); return; }
    const prefix = String(body.prefix ?? '').trim().toLowerCase() || derivePrefix(name);
    if (!/^[a-z][a-z0-9]{1,2}$/.test(prefix)) { response.status(422).json({ error: 'The prefix must be 2-3 characters (letters/digits, starting with a letter).' }); return; }
    const autoswap = Boolean(body.autoswap);
    const autoQa = body.autoQa !== false;
    // An unverified clone must never be published live: autoswap publishes the dev theme to
    // the LIVE theme after convergence, and without auto-QA there is no convergence signal.
    if (autoswap && !autoQa) { response.status(400).json({ error: 'autoswap requires auto-QA — an unverified clone must never be published live. Enable auto-QA or turn autoswap off.' }); return; }
    const storeUrl = `https://${shop}`;
    const duplicate = await db.findActiveFactoryJobByStore(storeUrl);
    if (duplicate) { response.status(409).json({ error: `Another active job ("${duplicate.name}") already targets ${shop}. Two clones writing one store would corrupt it.` }); return; }
    if (body.reactFilesPath) {
      const source = String(body.reactFilesPath);
      if (!(await fileExists(source))) { response.status(422).json({ error: `react_files source not found: ${source}` }); return; }
      if (isZipPath(source)) {
        // Zip intake: extraction (and the package.json check) happens during scaffolding —
        // here we only verify it's actually a file.
        if (!(await stat(source)).isFile()) { response.status(422).json({ error: `react_files source ends in .zip but is not a file: ${source}` }); return; }
      } else if (!(await containsPackageJson(source))) {
        response.status(422).json({ error: 'The react_files folder does not contain a package.json (searched 3 levels deep).' }); return;
      }
    }

    const settings = await getFactorySettings();
    const { slug, workspacePath } = await resolveWorkspacePath(slugify(name));
    const job = await db.createFactoryJob({
      name, slug, workspace_path: workspacePath, react_url: reactUrl.toString().replace(/\/$/, ''), store_url: storeUrl,
      client_id_cipher: encrypt(clientId), client_secret_cipher: encrypt(clientSecret),
      storefront_password_cipher: storefrontPassword ? encrypt(storefrontPassword) : null,
      prefix, dev_theme_name: String(body.devThemeName ?? '').trim() || `${name} Clone (dev)`,
      autoswap, auto_qa: autoQa,
      qa_mode: ['sections', 'interactions', 'both'].includes(String(body.qaMode)) ? String(body.qaMode) : 'both',
      qa_engine: ['playwright', 'headed'].includes(String((body as { qaEngine?: string }).qaEngine)) ? String((body as { qaEngine?: string }).qaEngine) : 'playwright',
      max_iterations: Math.min(10, Math.max(1, Number(body.maxIterations) || settings.defaultMaxIterations)),
      score_threshold: Math.min(1, Math.max(0.5, Number(body.scoreThreshold) || settings.defaultScoreThreshold)),
    // Born 'draft' (not launchable) so a concurrent scheduler tick can't grab it and spawn
    // the CLI in a workspace that doesn't exist yet. Promoted to 'queued' only after scaffold.
    }, 'draft');
    // Register the clone as a first-class project right away (kind='clone', shop_id NULL,
    // linked by factory_job_id) so it appears in the library from the moment it exists.
    // Best-effort: the project mirror must never block job intake.
    await db.syncCloneProjectFromJob(job).catch(() => {});

    try {
      await db.updateFactoryJob(job.id, { status: 'scaffolding', status_detail: 'Preparing workspace' });
      await scaffoldWorkspace({ job, clientId, clientSecret, reactFilesPath: body.reactFilesPath, storefrontPassword: storefrontPassword ?? undefined, extraAllow: settings.extraAllow });
      const queued = await db.updateFactoryJob(job.id, { status: 'queued', status_detail: 'Waiting for a free slot' });
      if (queued) await db.syncCloneProjectFromJob(queued).catch(() => {});
    } catch (error) {
      const failed = await db.updateFactoryJob(job.id, { status: 'failed', status_detail: 'Scaffolding failed', error: error instanceof Error ? error.message : String(error) });
      if (failed) await db.syncCloneProjectFromJob(failed).catch(() => {});
      response.status(500).json({ error: `Workspace scaffolding failed: ${error instanceof Error ? error.message : 'unknown error'}`, job: publicJob((await db.getFactoryJob(job.id))!) });
      return;
    }
    void factoryScheduler.tick();
    response.status(201).json({ job: publicJob((await db.getFactoryJob(job.id))!) });
  }));

  router.get('/jobs', handle(async (_request, response) => {
    response.json({ jobs: (await db.listFactoryJobs()).map(publicJob), scheduler: factoryScheduler.status });
  }));

  router.get('/jobs/:id', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    const reportsDir = path.join(job.workspace_path, 'qa', 'reports');
    const listReports = async (sub = '') => {
      try { return (await readdir(path.join(reportsDir, sub), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => path.posix.join(sub, entry.name)); } catch { return []; }
    };
    response.json({ job: publicJob(job), iterations: await db.listFactoryIterations(job.id), reports: [...await listReports(), ...await listReports('factory')] });
  }));

  // Mint a short-lived shpat_ token for a job's workspace scripts WITHOUT ever writing the
  // Shopify Client Secret to disk. Decrypts the job's stored creds in memory, performs the OAuth
  // client_credentials mint server-side, and returns only the resulting token. Localhost-only +
  // per-job capability key (mintKeyFor) so it cannot be reached off-box or from another job.
  router.post('/jobs/:id/mint-token', handle(async (request, response) => {
    if (config.production) { response.status(404).json({ error: 'Token minting is disabled in production.' }); return; }
    if (!isLoopback(request)) { response.status(403).json({ error: 'Token minting is available on localhost only.' }); return; }
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    const provided = String(request.headers['x-factory-mint-key'] ?? '');
    if (!provided || !secureEqual(provided, mintKeyFor(job.id))) { response.status(401).json({ error: 'Invalid or missing mint key.' }); return; }

    let clientId: string;
    let clientSecret: string;
    try { clientId = decrypt(job.client_id_cipher); clientSecret = decrypt(job.client_secret_cipher); }
    catch { response.status(500).json({ error: 'Could not decrypt the stored credentials for this job.' }); return; }

    const shop = normalizeShop(job.store_url) ?? new URL(job.store_url).host;
    let minted: { access_token: string; scope?: string };
    try {
      const mintResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
      });
      if (!mintResponse.ok) { response.status(502).json({ error: `Token mint failed: HTTP ${mintResponse.status}. Check that the custom app is still installed and its credentials are current.` }); return; }
      minted = await mintResponse.json() as { access_token: string; scope?: string };
    } catch (error) {
      response.status(502).json({ error: `Token mint request failed: ${error instanceof Error ? error.message : 'unknown error'}` });
      return;
    }

    // Resolve the canonical myshopify host (store_url may carry a custom/alias domain form).
    let host = shop;
    try {
      const shopResponse = await fetch(`https://${shop}/admin/api/${config.shopify.apiVersion}/shop.json`, { headers: { 'X-Shopify-Access-Token': minted.access_token } });
      if (shopResponse.ok) host = ((await shopResponse.json()) as { shop: { myshopify_domain: string } }).shop.myshopify_domain;
    } catch { /* fall back to the request host */ }

    response.json({ access_token: minted.access_token, scope: minted.scope ?? '', host, expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
  }));

  router.post('/jobs/:id/retry', handle(async (request, response) => {
    await factoryScheduler.retry(String(request.params.id));
    response.json({ job: publicJob((await db.getFactoryJob(String(request.params.id)))!) });
  }));

  // Queue a job that has never run (draft) — the JobDetail Start button's target.
  router.post('/jobs/:id/start', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    if (job.status !== 'draft' && job.status !== 'paused') { response.status(409).json({ error: 'Only draft or paused jobs can be started — use Retry for blocked/failed jobs.' }); return; }
    await db.updateFactoryJob(job.id, { status: 'queued', status_detail: null });
    void factoryScheduler.tick();
    response.json({ job: publicJob((await db.getFactoryJob(job.id))!) });
  }));

  router.post('/jobs/:id/pause', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    if (!factoryScheduler.isRunning(job.id) && job.status !== 'queued') { response.status(409).json({ error: 'Only queued or running jobs can be paused.' }); return; }
    await factoryScheduler.stop(job.id, 'paused');
    response.json({ job: publicJob((await db.getFactoryJob(job.id))!) });
  }));

  router.post('/jobs/:id/cancel', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    if (TERMINAL_STATUSES.includes(job.status as typeof TERMINAL_STATUSES[number])) { response.status(409).json({ error: 'The job has already finished.' }); return; }
    await factoryScheduler.stop(job.id, 'canceled');
    response.json({ job: publicJob((await db.getFactoryJob(job.id))!) });
  }));

  router.delete('/jobs/:id', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    if (!TERMINAL_STATUSES.includes(job.status as typeof TERMINAL_STATUSES[number]) && job.status !== 'paused') { response.status(409).json({ error: 'Cancel the job before deleting it.' }); return; }
    if (request.query.purgeWorkspace === '1') {
      const boundary = path.resolve(config.factory.workspaceRoot) + path.sep;
      const target = path.resolve(job.workspace_path);
      if (target.startsWith(boundary) && await fileExists(target)) await rm(target, { recursive: true, force: true });
    }
    await db.deleteFactoryJob(job.id);
    response.status(204).end();
  }));

  router.get('/jobs/:id/log', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    const kind = ['clone', 'fix', 'qa'].includes(String(request.query.kind)) ? String(request.query.kind) : 'clone';
    const iter = Math.max(0, Number(request.query.iter) || 0);
    const lines = Math.min(2000, Math.max(10, Number(request.query.tail) || 200));
    const logPath = safeResolve(job.workspace_path, 'factory/logs', `${kind}-${iter}.log`);
    if (!(await fileExists(logPath))) { response.json({ log: '', exists: false }); return; }
    response.json({ log: scrubSecrets(await tailFile(logPath, lines)), exists: true });
  }));

  // Express 5 named wildcard: params.name is an array of path segments.
  const wildcardName = (request: Request) => {
    const raw = request.params.name as unknown;
    return (Array.isArray(raw) ? raw.join('/') : String(raw ?? '')).replace(/\\/g, '/');
  };

  router.get('/jobs/:id/reports/*name', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    const target = safeResolve(job.workspace_path, 'qa/reports', wildcardName(request));
    if (!(await fileExists(target))) { response.status(404).json({ error: 'Report not found.' }); return; }
    response.type('text/markdown').send(scrubSecrets(await readFile(target, 'utf8')));
  }));

  // List available QA screenshots (relative paths) so the UI can render a gallery.
  router.get('/jobs/:id/screenshots', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    const root = path.join(job.workspace_path, 'qa', 'screenshots');
    const found: string[] = [];
    const walk = async (dir: string, prefix: string) => {
      let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
        else if (/\.(png|jpg|jpeg|webp)$/i.test(entry.name)) found.push(relative);
      }
    };
    await walk(root, '');
    found.sort();
    response.json({ screenshots: found });
  }));

  router.get('/jobs/:id/screenshots/*name', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    const target = safeResolve(job.workspace_path, 'qa/screenshots', wildcardName(request));
    if (!(await fileExists(target)) || !/\.(png|jpg|jpeg|webp)$/i.test(target)) { response.status(404).json({ error: 'Screenshot not found.' }); return; }
    response.sendFile(target);
  }));

  // --- Settings ---
  router.get('/settings', handle(async (_request, response) => {
    response.json({ settings: await getFactorySettings(), locked: lockedFields(), scheduler: factoryScheduler.status, paths: { workspaceRoot: config.factory.workspaceRoot, claudePath: config.factory.claudePath, playwrightRoot: config.factory.playwrightRoot } });
  }));

  router.put('/settings', handle(async (request, response) => {
    const settings = await updateFactorySettings(request.body ?? {});
    void factoryScheduler.tick();
    response.json({ settings, locked: lockedFields() });
  }));

  // --- QA browser (Playwright chromium) detection + install ---
  router.get('/browser', handle(async (_request, response) => {
    const pwRoot = config.factory.playwrightRoot;
    const cliCandidates = [path.join(pwRoot, 'playwright', 'cli.js'), path.join(pwRoot, '.bin', 'playwright')];
    const hasPlaywright = (await Promise.all([path.join(pwRoot, 'playwright'), ...cliCandidates].map(fileExists))).some(Boolean);
    // A chromium build under ms-playwright indicates browsers are installed.
    const cacheDir = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'ms-playwright');
    let hasChromium = false;
    try { hasChromium = (await readdir(cacheDir)).some((entry) => entry.startsWith('chromium')); } catch { /* no cache dir */ }
    response.json({ hasPlaywright, hasChromium, ready: hasPlaywright && hasChromium, playwrightRoot: pwRoot, installing: browserInstalling });
  }));

  router.post('/browser/install', handle(async (_request, response) => {
    if (browserInstalling) { response.json({ installing: true }); return; }
    const cli = path.join(config.factory.playwrightRoot, 'playwright', 'cli.js');
    if (!(await fileExists(cli))) { response.status(422).json({ error: `Playwright CLI not found at ${cli}. Set FACTORY_PW_ROOT to a folder containing a playwright install.` }); return; }
    browserInstalling = true;
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { shell: false, windowsHide: true, detached: false, env: buildSpawnEnv() });
    child.on('exit', () => { browserInstalling = false; });
    child.on('error', () => { browserInstalling = false; });
    response.json({ installing: true, detail: 'Downloading Chromium for QA — this can take a minute. Re-check status shortly.' });
  }));

  // --- Real-Chrome credential helper (wizard Step 2) ---
  // Shopify's login runs hCaptcha bot-detection that reliably flags the app's automated
  // browser, so the recommended way to collect app credentials is the user's OWN Chrome:
  // already signed in, fully trusted by Shopify. These endpoints power the wizard's
  // "use your Chrome" card — detection status + a launcher restricted to Shopify pages.
  router.get('/chrome-status', handle(async (_request, response) => {
    const engines = detectEngines();
    const chrome = engines.find((engine) => engine.id === 'chrome');
    const edge = engines.find((engine) => engine.id === 'msedge');
    response.json({
      chrome: { installed: Boolean(chrome?.available) },
      edge: { installed: Boolean(edge?.available) },
      claudeExtension: { installed: resolveExtensions().some((extension) => extension.isClaude) },
    });
  }));

  router.post('/open-in-chrome', handle(async (request, response) => {
    const raw = typeof request.body?.url === 'string' ? request.body.url : '';
    let url: URL;
    try { url = new URL(raw); } catch { response.status(400).json({ error: 'A valid URL is required.' }); return; }
    const host = url.hostname.toLowerCase();
    // Strict allowlist — this must never become a generic "launch anything" endpoint.
    const allowed = url.protocol === 'https:'
      && (host === 'admin.shopify.com' || host === 'accounts.shopify.com' || host === 'dev.shopify.com'
        || host === 'partners.shopify.com' || host.endsWith('.myshopify.com'));
    if (!allowed) { response.status(422).json({ error: 'Only Shopify admin/accounts pages can be opened.' }); return; }
    const engines = detectEngines();
    const target = engines.find((engine) => engine.id === 'chrome' && engine.available)
      ?? engines.find((engine) => engine.id === 'msedge' && engine.available);
    if (!target?.executablePath) { response.status(422).json({ error: 'No system Chrome or Edge installation was found.' }); return; }
    const child = spawn(target.executablePath, [url.toString()], { shell: false, windowsHide: false, detached: true, stdio: 'ignore' });
    child.on('error', () => { /* surfaced via the browser simply not opening; response already sent */ });
    child.unref();
    response.json({ ok: true, opened: url.toString(), browser: target.label });
  }));

  // --- "Lazy mode" key collector -------------------------------------------------
  // Spawns a headless Claude agent that drives the USER'S already-signed-in Chrome via
  // the Claude extension: opens the app's API credentials page, reads the Client ID,
  // reveals + reads the Secret, and POSTs them back to the loopback deliver endpoint
  // below with a one-time token. Keys live ONLY in this in-memory state and are handed
  // to the wizard exactly once (?take=1), then wiped — never written to disk or logs.
  interface CollectState { status: 'idle' | 'working' | 'delivered' | 'partial' | 'failed'; startedAt: number; finishedAt: number; note: string | null; clientId: string | null; clientSecret: string | null }
  let collect: CollectState = { status: 'idle', startedAt: 0, finishedAt: 0, note: null, clientId: null, clientSecret: null };
  let collectTarget: { shop: string; label: string } | null = null;
  let collectToken: string | null = null;
  let collectChild: ChildProcess | null = null;
  let collectTimer: NodeJS.Timeout | null = null;
  // Full autopilot runs (create app → scopes → release → install → harvest) need more room.
  const COLLECT_TIMEOUT_MS = 15 * 60_000;
  // Everything the clone pipeline can use — the user-verified working list (files, locales,
  // metaobjects, pages, products, content, themes, translations, plus the unauthenticated
  // Storefront scopes QA needs) + the navigation pair the wizard's Test connection checks for.
  const AUTOPILOT_SCOPES = 'read_files,write_files,read_locales,write_locales,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects,read_online_store_pages,write_online_store_pages,read_products,write_products,read_content,write_content,write_theme_code,read_themes,write_themes,read_translations,write_translations,read_online_store_navigation,write_online_store_navigation,unauthenticated_write_bulk_operations,unauthenticated_read_bulk_operations,unauthenticated_read_bundles,unauthenticated_write_checkouts,unauthenticated_read_checkouts,unauthenticated_write_customers,unauthenticated_read_customers,unauthenticated_read_customer_tags,unauthenticated_read_metaobjects,unauthenticated_read_product_pickup_locations';

  // Live activity feed for the wizard panel — friendly one-liners derived from the spawned
  // agent's stream-json events, ALWAYS redacted (no key material can ever appear here).
  let collectLog: Array<{ at: number; text: string }> = [];
  const redactKeys = (text: string) => text.replace(/shpss_[A-Za-z0-9_-]+/g, 'shpss_•••').replace(/\b[0-9a-f]{32}\b/gi, '••••••••');
  const pushCollectLog = (text: string) => {
    const clean = redactKeys(text);
    if (collectLog[collectLog.length - 1]?.text === clean) return; // collapse repeats
    collectLog.push({ at: Date.now(), text: clean });
    if (collectLog.length > 40) collectLog = collectLog.slice(-40);
  };
  const collectEventText = (line: string): string | null => {
    let parsed: { type?: string; subtype?: string; is_error?: boolean; message?: { content?: Array<{ type?: string; name?: string; text?: string }> } };
    try { parsed = JSON.parse(line) as typeof parsed; } catch { return null; }
    if (parsed.type === 'system' && parsed.subtype === 'init') return 'Agent booted — connecting to your Chrome…';
    if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
      for (const block of parsed.message.content) {
        if (block.type === 'tool_use') {
          const name = String(block.name ?? '');
          if (name === 'ToolSearch') return 'Loading the Chrome browser tools…';
          if (/tabs_create|navigate/.test(name)) return 'Opening your store admin in Chrome…';
          if (/read_page|get_page_text|find/.test(name)) return 'Reading the page…';
          if (/computer|form_input/.test(name)) return 'Clicking in your Chrome…';
          if (name === 'Bash') return 'Delivering the keys to ThemeBot…';
          return `Using ${name.replace(/^mcp__claude-in-chrome__/, 'chrome: ')}…`;
        }
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) return block.text.trim().slice(0, 140);
      }
    }
    if (parsed.type === 'result') return parsed.is_error ? 'Agent finished with an error.' : 'Agent finished.';
    return null;
  };

  const stopCollector = (status: CollectState['status'], note: string | null) => {
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
    if (collectChild && collectChild.exitCode === null && collectChild.pid != null) {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(collectChild.pid), '/T', '/F'], { shell: false, windowsHide: true });
      else collectChild.kill('SIGKILL');
    }
    collectChild = null;
    collectToken = null;
    if (collect.status === 'working') collect = { ...collect, status, note, finishedAt: Date.now() };
  };

  router.post('/collect-keys/start', handle(async (request, response) => {
    if (collect.status === 'working') { response.status(409).json({ error: 'The key collector is already running.' }); return; }
    const shop = normalizeShop(String(request.body?.storeUrl ?? ''));
    if (!shop) { response.status(422).json({ error: 'A valid *.myshopify.com store is required (fill it in step 1).' }); return; }
    const handleName = shop.replace(/\.myshopify\.com$/i, '');
    // App is named after the PROJECT so users (and the bot) always know which store it belongs to.
    const projectName = String(request.body?.projectName ?? '').trim();
    const appName = `${(slugify(projectName) || handleName).slice(0, 25)}_bot`;
    collectToken = newSecret(24);
    collect = { status: 'working', startedAt: Date.now(), finishedAt: 0, note: null, clientId: null, clientSecret: null };
    collectTarget = { shop, label: projectName || handleName };
    collectLog = [];
    pushCollectLog('Bot process starting — the agent takes ~30s to boot before Chrome moves…');
    const deliverUrl = `http://127.0.0.1:${config.port}/api/factory/collect-keys/deliver`;
    const prompt = [
      `You are ThemeBot's credential autopilot. The user is watching their own Chrome window and has asked you to set up their Shopify custom app end-to-end and fetch its credentials. Work autonomously, never wait for user input.`,
      `Use ONLY the claude-in-chrome browser MCP tools (load them via ToolSearch first if they are deferred). They drive the user's real, already-signed-in Chrome.`,
      `SPEED RULES — the user is watching and waiting, so keep every step tight: (a) prefer read_page / find / get_page_text to learn a page — take a screenshot only when the accessibility tree genuinely is not enough (e.g. verifying a visual state). (b) Never take a screenshot just to confirm a click worked; read the page instead. (c) Navigate directly by URL when you already know the destination instead of clicking through menus. (d) Chain independent actions with browser_batch where available. (e) Do not re-verify steps you already completed this run.`,
      `Mission: make sure a custom app with the right scopes exists in the Shopify Dev Dashboard, is released, and is installed on the store ${shop} — then deliver its Client ID + Client Secret.`,
      `1. Open a new tab at https://dev.shopify.com and get to the Dev Dashboard. If a login or captcha page appears, the user has to complete it themselves — do NOT fail and do NOT touch the login form. Instead: (a) say exactly this in your output so the app can alert the user: WAITING FOR LOGIN — please log in in the Chrome window. (b) switch the banner to paused mode by running this JavaScript in the page: (()=>{var w=document.getElementById('themebot-bot-overlay');if(w&&w.firstChild){w.firstChild.style.background='#b45309';w.firstChild.textContent='⏸ ThemeBot is PAUSED — log in on this page; the bot resumes automatically once you are in.'}})() (c) then WAIT: re-check the page every ~20 seconds for up to 6 minutes until the Dev Dashboard is reachable, then continue. Only if it is still blocked after ~6 minutes, deliver status "failed" with note "not logged in" (step 8) and stop.`,
      `1c. CRITICAL — verify the organization before creating anything: the Dev Dashboard opens on whichever organization was used last, which may be the WRONG one. Check the organization name (top-right switcher). Open the "Stores" section and check whether this organization owns the store whose DOMAIN is ${shop}. Match stores by their .myshopify.com domain, NEVER by display name: owners rename stores freely and renaming never changes the domain, so the store may be listed under any name (possibly "${projectName || handleName}"). Do NOT type "${handleName}" into the store search box and trust an empty result — search boxes match display names, not domains. Instead clear any search filter, browse the FULL store list (check both Active and Inactive), and read each store's domain from the list or its details page. If the domain ${shop} is not in this organization, open the org switcher (top-right) and repeat for the other organizations. If no organization owns it, deliver status "failed" with note "store ${shop} not found in any Dev Dashboard organization" and stop. NEVER create an app in an organization that does not own the target store.`,
      `1b. Show the user you own the tab: immediately after the tab opens, and again after EVERY full page navigation, run this exact JavaScript in the page via the browser javascript tool. It draws a green control tint + banner + status chip, and pings a ripple ring at every click you make so the user can watch where you are working. Everything is pointer-events:none, so it never blocks your clicks, and the tint is light enough to never obscure your screenshots: (()=>{if(document.getElementById('themebot-bot-overlay'))return;var s=document.createElement('style');s.textContent='@keyframes tbring{0%{transform:scale(.4);opacity:.9}100%{transform:scale(2.6);opacity:0}}';document.head.appendChild(s);var w=document.createElement('div');w.id='themebot-bot-overlay';w.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;border:4px solid #00a47c;box-shadow:inset 0 0 0 2000px rgba(0,164,124,.06),inset 0 0 80px rgba(0,164,124,.18)';var b=document.createElement('div');b.style.cssText='position:fixed;top:0;left:50%;transform:translateX(-50%);pointer-events:none;background:#00a47c;color:#fff;font:700 13px system-ui;padding:9px 18px;border-radius:0 0 10px 10px;box-shadow:0 4px 14px rgba(0,0,0,.3);max-width:92vw;text-align:center';b.textContent='🤖 ThemeBot started working in this tab — hands off. If a login appears, log in; the bot continues on its own.';var c=document.createElement('div');c.style.cssText='position:fixed;right:14px;bottom:14px;pointer-events:none;display:flex;align-items:center;gap:8px;background:rgba(10,25,20,.85);color:#7ef0c6;font:600 12px system-ui;padding:8px 14px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.35)';c.innerHTML='<span style="width:8px;height:8px;border-radius:50%;background:#00e69a;animation:tbring 1.4s ease-out infinite"></span>ThemeBot is driving this page…';w.appendChild(b);w.appendChild(c);document.documentElement.appendChild(w);var r=function(e){var d=document.createElement('div');d.style.cssText='position:fixed;left:'+(e.clientX-18)+'px;top:'+(e.clientY-18)+'px;width:36px;height:36px;border:3px solid #00e69a;border-radius:50%;pointer-events:none;animation:tbring .7s ease-out forwards';w.appendChild(d);setTimeout(function(){d.remove()},750)};document.addEventListener('mousedown',r,true)})()`,
      `2. This run is for the project "${projectName || handleName}" targeting the store ${shop}. If an app named "${appName}" already exists in the Apps list, open it and skip to step 5. Do NOT reuse apps with other names — each project gets its own app.`,
      `3. Click "Create app", name it exactly "${appName}", and create it.`,
      `4. Set the access scopes: open the app's version editor (Versions → New version, or the configuration shown after creation). The Access scopes card accepts a comma-separated list typed directly into its field ("Enter scopes as a comma-separated list") — enter: ${AUTOPILOT_SCOPES}. If typing into the field misbehaves, use the "Select scopes" link instead: it opens a checkbox dialog with a search box — search each scope name, tick it, then click Done. If the dashboard rejects specific scopes, drop the rejected ones and keep the rest (absolute minimum: write_themes,read_themes). Then click Release; in the "Release this new version?" dialog leave the name and message BLANK and click Release.`,
      `5. Install it on the store: from the app's Overview click "Install app", pick the store "${handleName}" (${shop}), and on the consent page click Install. If it is already installed there, just continue. IMPORTANT: if "Install app" is disabled or the flow says the store needs a plan/subscription, do NOT go anywhere near billing, checkout, or payment pages — deliver status "partial" with note "store has no active plan — activate the $1 starter plan on the store, then run the bot again" and stop after step 6 if credentials are still readable.`,
      `6. Open the app's Settings tab and locate the Client ID and Client Secret. Click the reveal icon on the secret and read both values.`,
      `7. Typing is allowed ONLY for: the app name in step 3, the scopes list in step 4, and nothing else. Never change unrelated settings, never enter payment or billing details of any kind. Stay on dev.shopify.com / admin.shopify.com / accounts.shopify.com.`,
      `8. Deliver the result: run a Bash curl POST to ${deliverUrl} with header "x-collect-token: ${collectToken}" and JSON body {"clientId":"...","clientSecret":"...","status":"delivered"}. If you could only get part of it, send what you have with status "partial" and a short "note" saying exactly which step failed. If nothing worked, send status "failed" with a "note". Never print the secret in your own output — it goes only into the curl body.`,
    ].join('\n');
    // Headless `claude -p` needs a trusted cwd with a scoped tool allowlist (same pattern as
    // clone workspaces): the collector gets ONLY the chrome MCP tools + curl for the delivery.
    const collectorRoot = path.join(config.factory.workspaceRoot, '_key-collector');
    try {
      await mkdir(path.join(collectorRoot, '.claude'), { recursive: true });
      await writeFile(path.join(collectorRoot, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['ToolSearch', 'Bash(curl:*)', 'mcp__claude-in-chrome'], deny: [] } }, null, 2) + '\n');
      await trustWorkspace(collectorRoot);
    } catch (error) {
      collect = { status: 'failed', startedAt: collect.startedAt, finishedAt: Date.now(), note: error instanceof Error ? error.message : 'Could not prepare the collector workspace.', clientId: null, clientSecret: null };
      collectToken = null;
      response.status(500).json({ error: collect.note }); return;
    }
    try {
      // --chrome: the Claude-in-Chrome extension tools are session-scoped, not an MCP config
      // entry — without this flag a headless spawn has no browser tools at all.
      // stream-json + --verbose: incremental events feed the wizard's live activity panel.
      // Model: settings-driven (Settings → Models). Default opus — tested 2026-07-20:
      // sonnet refuses this mission outright (reads autonomous credential fetching from a
      // signed-in browser as harvesting, even with explicit owner-authorization framing in
      // the prompt); opus completes it reliably. Speed comes from the SPEED RULES in the
      // prompt (fewer screenshots, direct URLs, batched actions), not from the model tier.
      const collectorModel = (await getFactorySettings()).collectorModel;
      pushCollectLog(`Model: ${collectorModel}`);
      collectChild = spawn(config.factory.claudePath, ['-p', prompt, '--model', collectorModel, '--chrome', '--output-format', 'stream-json', '--verbose'], { cwd: collectorRoot, shell: false, windowsHide: true, env: buildSpawnEnv() });
      let streamBuffer = '';
      collectChild.stdout?.on('data', (chunk: Buffer) => {
        streamBuffer += chunk.toString('utf8');
        const lines = streamBuffer.split('\n');
        streamBuffer = lines.pop() ?? '';
        for (const line of lines) { const text = collectEventText(line.trim()); if (text) pushCollectLog(text); }
      });
      collectChild.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) pushCollectLog(text.split('\n')[0].slice(0, 140));
      });
    } catch (error) {
      collect = { status: 'failed', startedAt: collect.startedAt, finishedAt: Date.now(), note: error instanceof Error ? error.message : 'Could not launch the bot.', clientId: null, clientSecret: null };
      collectToken = null;
      response.status(500).json({ error: collect.note }); return;
    }
    collectChild.on('error', (error) => { stopCollector('failed', `Cannot launch ${config.factory.claudePath}: ${error.message}`); });
    collectChild.on('exit', () => { if (collect.status === 'working') stopCollector('failed', 'The bot finished without delivering keys — copy them manually from the Chrome window.'); });
    collectTimer = setTimeout(() => stopCollector('failed', 'The bot timed out after 8 minutes.'), COLLECT_TIMEOUT_MS);
    response.json({ started: true });
  }));

  router.post('/collect-keys/deliver', handle(async (request, response) => {
    const token = String(request.headers['x-collect-token'] ?? '');
    if (!collectToken || !token || !secureEqual(token, collectToken)) { response.status(403).json({ error: 'Invalid collector token.' }); return; }
    const body = request.body as { clientId?: string; clientSecret?: string; status?: string; note?: string };
    const clientId = typeof body.clientId === 'string' && /^[0-9a-f]{32}$/i.test(body.clientId.trim()) ? body.clientId.trim() : null;
    const clientSecret = typeof body.clientSecret === 'string' && body.clientSecret.trim().startsWith('shpss_') ? body.clientSecret.trim() : null;
    const delivered = body.status === 'delivered' && clientId && clientSecret;
    collect = {
      status: delivered ? 'delivered' : body.status === 'failed' ? 'failed' : 'partial',
      startedAt: collect.startedAt,
      finishedAt: Date.now(),
      note: typeof body.note === 'string' ? body.note.slice(0, 300) : null,
      clientId, clientSecret,
    };
    // Durability: persist a full delivery as an encrypted saved store IMMEDIATELY, so a page
    // reload before the user hits Test connection can never lose the secret.
    if (delivered && collectTarget) {
      await db.upsertFactoryStore({
        label: collectTarget.label, shop_domain: collectTarget.shop, client_id: clientId!,
        client_secret_cipher: encrypt(clientSecret!), storefront_password_cipher: null,
      }).catch(() => { /* best-effort — the wizard hand-off still works from memory */ });
    }
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
    collectToken = null;
    response.status(204).end();
  }));

  router.get('/collect-keys/status', handle(async (request, response) => {
    const take = String(request.query.take ?? '') === '1';
    const payload = {
      status: collect.status,
      running: collect.status === 'working',
      elapsedSec: collect.status === 'working' ? Math.round((Date.now() - collect.startedAt) / 1000) : null,
      finishedAgoSec: collect.finishedAt ? Math.round((Date.now() - collect.finishedAt) / 1000) : null,
      note: collect.note,
      log: collectLog.slice(-8),
      clientId: take ? collect.clientId : collect.clientId ? 'ready' : null,
      clientSecret: take ? collect.clientSecret : null,
      hasSecret: Boolean(collect.clientSecret),
    };
    // Hand the keys to the wizard exactly once, then wipe them from memory.
    if (take && collect.status !== 'working') collect = { ...collect, clientId: null, clientSecret: null };
    response.json(payload);
  }));

  router.post('/collect-keys/stop', handle(async (_request, response) => {
    stopCollector('failed', 'Stopped by user.');
    response.json({ stopped: true });
  }));

  // Nuke a store's credentials from every place ThemeBot keeps anything: saved-store records
  // (encrypted secret), job credential ciphers, workspace API.txt files (public id), and the
  // in-memory collector state. Note: secrets were never on disk to begin with — API.txt only
  // ever held the public Client ID.
  router.post('/keys/purge', handle(async (request, response) => {
    const shop = normalizeShop(String(request.body?.storeUrl ?? ''));
    if (!shop) { response.status(422).json({ error: 'A valid *.myshopify.com store is required.' }); return; }
    const removed = { stores: 0, jobs: 0, files: 0 };
    for (const store of await db.listFactoryStores()) {
      if (store.shop_domain === shop && await db.deleteFactoryStore(store.id)) removed.stores += 1;
    }
    for (const job of await db.listFactoryJobs()) {
      if (normalizeShop(job.store_url) !== shop) continue;
      // Empty ciphers: decrypt fails on any later mint attempt, which is exactly the point.
      await db.updateFactoryJob(job.id, { client_id_cipher: '', client_secret_cipher: '', storefront_password_cipher: undefined });
      removed.jobs += 1;
      const apiTxt = path.join(job.workspace_path, 'API.txt');
      if (await fileExists(apiTxt)) {
        await writeFile(apiTxt, `# Credentials purged by the user on ${new Date().toISOString()}.\n# Re-enter keys in the wizard to run further iterations for this job.\n`);
        removed.files += 1;
      }
    }
    stopCollector('failed', null);
    collect = { status: 'idle', startedAt: 0, finishedAt: 0, note: null, clientId: null, clientSecret: null };
    collectLog = [];
    response.json({ ok: true, ...removed });
  }));

  // Sanity-check the QA scoring pipeline (Playwright + segmentation + alignment + scoring)
  // against a known-good pair BEFORE trusting job scores. Localhost-only like mint-token:
  // it spawns a local browser process, which has no business being reachable off-box.
  router.post('/qa-selftest', handle(async (request, response) => {
    if (!isLoopback(request)) { response.status(403).json({ error: 'The QA self-test is available on localhost only.' }); return; }
    if (qaSelftestRunning) { response.status(409).json({ error: 'A QA self-test is already running — wait for it to finish.' }); return; }
    const script = path.join(TEMPLATES_ROOT, 'qa', 'calibrate.mjs');
    if (!(await fileExists(script))) { response.status(500).json({ error: `Calibration script not found: ${script}` }); return; }
    qaSelftestRunning = true;
    try {
      const result = await runCalibration(script);
      response.json(result);
    } finally {
      qaSelftestRunning = false;
    }
  }));

  router.post('/queue/pause', handle(async (_request, response) => { factoryScheduler.setQueuePaused(true, 'Paused by user'); response.json({ scheduler: factoryScheduler.status }); }));
  router.post('/queue/resume', handle(async (_request, response) => { factoryScheduler.setQueuePaused(false); response.json({ scheduler: factoryScheduler.status }); }));

  // --- Validation (wizard as-you-type + settings Check buttons) ---
  router.post('/validate', handle(async (request, response) => {
    const kind = String(request.body?.kind ?? '');
    const value = String(request.body?.value ?? '');
    if (kind === 'reactFiles') {
      if (!(await fileExists(value))) { response.json({ ok: false, detail: 'Folder or .zip not found.' }); return; }
      if (isZipPath(value)) {
        const isFile = (await stat(value)).isFile();
        response.json({ ok: isFile, detail: isFile ? 'Zip archive detected — it will be extracted into react_files/ during scaffolding.' : 'Path ends in .zip but is not a file.' });
        return;
      }
      const hasPackage = await containsPackageJson(value);
      response.json({ ok: hasPackage, detail: hasPackage ? 'React source detected.' : 'No package.json found within 3 levels.' });
      return;
    }
    if (kind === 'claude' || kind === 'playwright' || kind === 'workspace' || kind === 'path') {
      const target = value || (kind === 'claude' ? config.factory.claudePath : kind === 'playwright' ? path.join(config.factory.playwrightRoot, 'playwright') : config.factory.workspaceRoot);
      const ok = await fileExists(target);
      response.json({ ok, detail: ok ? `Found: ${target}` : `Not found: ${target}` });
      return;
    }
    response.status(422).json({ error: 'Unknown validation kind.' });
  }));

  // Opt-in end-to-end proof that theme writes work: PUT a harmless snippet on the store's
  // main theme, then DELETE it (mirrors clone-theme preflight 0.6). Runs ONLY on explicit
  // request — never as a side effect of a plain connection test.
  const canaryWriteTest = async (shop: string, accessToken: string, requiredScopesGranted: boolean): Promise<{ ok: boolean; detail: string }> => {
    if (!requiredScopesGranted) return { ok: false, detail: 'Skipped — write_themes is not granted.' };
    const headers = { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' };
    const apiBase = `https://${shop}/admin/api/${config.shopify.apiVersion}`;
    const themesResponse = await fetch(`${apiBase}/themes.json`, { headers });
    if (!themesResponse.ok) return { ok: false, detail: `Could not list themes: HTTP ${themesResponse.status}.` };
    const themes = ((await themesResponse.json()) as { themes?: Array<{ id: number; name: string; role: string }> }).themes ?? [];
    const main = themes.find((theme) => theme.role === 'main') ?? themes[0];
    if (!main) return { ok: false, detail: 'No themes found on this store.' };
    const key = 'snippets/__themebot_canary.liquid';
    const put = await fetch(`${apiBase}/themes/${main.id}/assets.json`, { method: 'PUT', headers, body: JSON.stringify({ asset: { key, value: '{# themebot push canary — written and immediately deleted #}' } }) });
    if (!put.ok) return { ok: false, detail: `Canary write failed: HTTP ${put.status} on theme "${main.name}".` };
    const cleanup = await fetch(`${apiBase}/themes/${main.id}/assets.json?asset[key]=${encodeURIComponent(key)}`, { method: 'DELETE', headers });
    return cleanup.ok
      ? { ok: true, detail: `Write + delete verified on theme "${main.name}".` }
      : { ok: true, detail: `Write OK on theme "${main.name}", but canary cleanup failed — delete ${key} manually (harmless).` };
  };

  // Shared by /validate-creds and /stores/:id/test: mint a short-lived token, verify the
  // shop identity + granted scopes, and (only when asked) run the canary write test.
  // Nothing is persisted here; the secret is used in memory only.
  const checkStoreCredentials = async (shop: string, clientId: string, clientSecret: string, canary: boolean) => {
    try {
      const mintResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
      });
      if (!mintResponse.ok) return { ok: false, detail: `Token mint failed: HTTP ${mintResponse.status}. Check that the custom app is installed and the credentials match its API credentials page.` };
      const token = await mintResponse.json() as { access_token: string; scope?: string };
      const scopes = (token.scope ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
      const shopResponse = await fetch(`https://${shop}/admin/api/${config.shopify.apiVersion}/shop.json`, { headers: { 'X-Shopify-Access-Token': token.access_token } });
      const shopName = shopResponse.ok ? ((await shopResponse.json()) as { shop: { name: string } }).shop.name : null;
      const ok = REQUIRED_SCOPES.every((scope) => scopes.includes(scope));
      return {
        ok,
        shopName,
        scopes: {
          required: REQUIRED_SCOPES.map((scope) => ({ scope, granted: scopes.includes(scope) })),
          recommended: RECOMMENDED_SCOPES.map((scope) => ({ scope, granted: scopes.includes(scope) })),
        },
        ...(canary ? { push: await canaryWriteTest(shop, token.access_token, ok) } : {}),
      };
    } catch (error) {
      return { ok: false, detail: `Connection failed: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
  };

  router.post('/validate-creds', handle(async (request, response) => {
    const shop = normalizeShop(String(request.body?.storeUrl ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    const clientId = String(request.body?.clientId ?? '').trim();
    const clientSecret = String(request.body?.clientSecret ?? '').trim();
    if (!shop || !clientId || !clientSecret) { response.status(422).json({ error: 'storeUrl, clientId, and clientSecret are required.' }); return; }
    response.json(await checkStoreCredentials(shop, clientId, clientSecret, request.body?.canary === true));
  }));

  // --- Saved stores (lazy onboarding): enter credentials once, reuse on every job ---
  // Secrets are stored encrypted and are NEVER echoed back — the public shape carries
  // only the non-sensitive fields needed to identify and select a store.
  const publicStore = (store: Awaited<ReturnType<typeof db.listFactoryStores>>[number]) => ({
    id: store.id, label: store.label, shop_domain: store.shop_domain, client_id: store.client_id,
    has_storefront_password: Boolean(store.storefront_password_cipher), created_at: store.created_at, updated_at: store.updated_at,
  });

  router.get('/stores', handle(async (_request, response) => {
    response.json({ stores: (await db.listFactoryStores()).map(publicStore) });
  }));

  router.post('/stores', handle(async (request, response) => {
    const shop = normalizeShop(String(request.body?.storeUrl ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    const clientId = String(request.body?.clientId ?? '').trim();
    const clientSecret = String(request.body?.clientSecret ?? '').trim();
    if (!shop) { response.status(422).json({ error: 'The store URL must be a *.myshopify.com domain.' }); return; }
    if (!/^[0-9a-f]{32}$/i.test(clientId)) { response.status(422).json({ error: 'The Client ID must be a 32-character hex string.' }); return; }
    if (!/^shpss_/.test(clientSecret)) { response.status(422).json({ error: 'The Client Secret must start with shpss_.' }); return; }
    const store = await db.upsertFactoryStore({
      label: String(request.body?.label ?? '').trim() || shop,
      shop_domain: shop, client_id: clientId,
      client_secret_cipher: encrypt(clientSecret),
      storefront_password_cipher: request.body?.storefrontPassword ? encrypt(String(request.body.storefrontPassword)) : null,
    });
    response.status(201).json({ store: publicStore(store) });
  }));

  router.delete('/stores/:id', handle(async (request, response) => {
    if (!(await db.deleteFactoryStore(String(request.params.id)))) { response.status(404).json({ error: 'Store not found.' }); return; }
    response.status(204).end();
  }));

  // Test a saved store's stored credentials without re-entering them (the secret never
  // leaves the server). Same response shape as /validate-creds.
  router.post('/stores/:id/test', handle(async (request, response) => {
    const store = await db.getFactoryStore(String(request.params.id));
    if (!store) { response.status(404).json({ error: 'Store not found.' }); return; }
    let clientSecret: string;
    try { clientSecret = decrypt(store.client_secret_cipher); }
    catch { response.status(500).json({ error: 'Could not decrypt the stored credentials for this store.' }); return; }
    response.json(await checkStoreCredentials(store.shop_domain, store.client_id, clientSecret, request.body?.canary === true));
  }));

  return router;
}
