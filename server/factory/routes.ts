import { spawn } from 'node:child_process';
import { access, readdir, readFile, rm, stat, open } from 'node:fs/promises';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { config } from '../config';
import { db, type FactoryJobRecord } from '../db';
import { decrypt, encrypt, normalizeShop, rateLimit, secureEqual } from '../security';
import { TEMPLATES_ROOT, containsPackageJson, derivePrefix, isZipPath, mintKeyFor, resolveWorkspacePath, scaffoldWorkspace, slugify } from './scaffolder';
import { factoryScheduler } from './scheduler';
import { getFactorySettings, lockedFields, updateFactorySettings } from './settings';
import { scrubSecrets } from './runner';
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

/** Loopback-only guard for the token-mint endpoint (it hands out live Shopify tokens). */
function isLoopback(request: Request) {
  const address = request.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
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
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
  else child.kill('SIGKILL');
}

/** Run calibrate.mjs (bounded) and parse its trailing `CALIBRATE_RESULT <json>` line. */
function runCalibration(script: string): Promise<CalibrationOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      shell: false, windowsHide: true, cwd: path.dirname(script),
      env: { ...process.env, PW_ROOT: config.factory.playwrightRoot },
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
  router.use(requireFactoryEnabled, rateLimit(300));

  // --- Jobs ---
  router.post('/jobs', handle(async (request, response) => {
    const body = request.body as JobIntake;
    const name = String(body.name ?? '').trim();
    if (!name) { response.status(422).json({ error: 'A project name is required.' }); return; }
    let reactUrl: URL;
    try { reactUrl = new URL(String(body.reactUrl ?? '')); if (!/^https?:$/.test(reactUrl.protocol)) throw new Error(); } catch { response.status(422).json({ error: 'The React URL must be a valid http(s) URL.' }); return; }
    const shop = normalizeShop(String(body.storeUrl ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    if (!shop) { response.status(422).json({ error: 'The store URL must be a *.myshopify.com domain.' }); return; }
    const clientId = String(body.clientId ?? '').trim();
    const clientSecret = String(body.clientSecret ?? '').trim();
    if (!/^[0-9a-f]{32}$/i.test(clientId)) { response.status(422).json({ error: 'The Client ID must be a 32-character hex string.' }); return; }
    if (!/^shpss_/.test(clientSecret)) { response.status(422).json({ error: 'The Client Secret must start with shpss_.' }); return; }
    const prefix = String(body.prefix ?? '').trim().toLowerCase() || derivePrefix(name);
    if (!/^[a-z][a-z0-9]{1,2}$/.test(prefix)) { response.status(422).json({ error: 'The prefix must be 2-3 characters (letters/digits, starting with a letter).' }); return; }
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
      storefront_password_cipher: body.storefrontPassword ? encrypt(String(body.storefrontPassword)) : null,
      prefix, dev_theme_name: String(body.devThemeName ?? '').trim() || `${name} Clone (dev)`,
      autoswap: Boolean(body.autoswap), auto_qa: body.autoQa !== false,
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
      await scaffoldWorkspace({ job, clientId, clientSecret, reactFilesPath: body.reactFilesPath, storefrontPassword: body.storefrontPassword, extraAllow: settings.extraAllow });
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
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { shell: false, windowsHide: true, detached: false });
    child.on('exit', () => { browserInstalling = false; });
    child.on('error', () => { browserInstalling = false; });
    response.json({ installing: true, detail: 'Downloading Chromium for QA — this can take a minute. Re-check status shortly.' });
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

  router.post('/validate-creds', handle(async (request, response) => {
    const shop = normalizeShop(String(request.body?.storeUrl ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    const clientId = String(request.body?.clientId ?? '').trim();
    const clientSecret = String(request.body?.clientSecret ?? '').trim();
    if (!shop || !clientId || !clientSecret) { response.status(422).json({ error: 'storeUrl, clientId, and clientSecret are required.' }); return; }
    try {
      const mintResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
      });
      if (!mintResponse.ok) { response.json({ ok: false, detail: `Token mint failed: HTTP ${mintResponse.status}. Check that the custom app is installed and the credentials match its API credentials page.` }); return; }
      const token = await mintResponse.json() as { access_token: string; scope?: string };
      const scopes = (token.scope ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
      const shopResponse = await fetch(`https://${shop}/admin/api/${config.shopify.apiVersion}/shop.json`, { headers: { 'X-Shopify-Access-Token': token.access_token } });
      const shopName = shopResponse.ok ? ((await shopResponse.json()) as { shop: { name: string } }).shop.name : null;
      response.json({
        ok: REQUIRED_SCOPES.every((scope) => scopes.includes(scope)),
        shopName,
        scopes: {
          required: REQUIRED_SCOPES.map((scope) => ({ scope, granted: scopes.includes(scope) })),
          recommended: RECOMMENDED_SCOPES.map((scope) => ({ scope, granted: scopes.includes(scope) })),
        },
      });
    } catch (error) {
      response.json({ ok: false, detail: `Connection failed: ${error instanceof Error ? error.message : 'unknown error'}` });
    }
  }));

  return router;
}
