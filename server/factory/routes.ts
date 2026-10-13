import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, readdir, readFile, rename, rm, stat, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { Router, raw as rawBody } from 'express';
import { config } from '../config';
import { detectEngines, resolveExtensions } from '../browser';
import { centeredWindowArgs, chromeProfileInUse, prepareFreshWindow } from '../window-placement';
import { db, type FactoryJobRecord } from '../db';
import { decrypt, encrypt, newSecret, normalizeShop, rateLimit, secureEqual } from '../security';
import { TEMPLATES_ROOT, containsPackageJson, derivePrefix, isZipPath, mintKeyFor, resolveWorkspacePath, scaffoldWorkspace, slugify, trustWorkspace } from './scaffolder';
import { factoryScheduler } from './scheduler';
import { getFactorySettings, lockedFields, updateFactorySettings } from './settings';
import { buildSpawnEnv, scrubSecrets } from './runner';
import { claudeEnv } from '../claude-connect';
import { TERMINAL_STATUSES, type CollectionMethod, type JobIntake } from './types';
import { checkStoreAccess, runScriptedCollector, listChromeProfiles, type ScriptedHandle, type StoreAccess } from './scripted-collector';
import { fetchAppSecretViaPartnerApi } from './partner-api';
import { pageProgress, stepProgressSummary, writeAlreadyBuilt } from './progress';
import { syncStatus, uploadToDraft } from './theme-sync';
import { KEY_SPECS, accountStatuses, activeEngine, clearLimit, keyStatuses, linkAccount, listEngines, readUsage, recordUsage, removeProviderKey, setActiveEngine, setProviderKey, usageSummary, type AccountProvider, type EngineId, type KeyProvider } from './engines';
import { awaitPreview, checkShopifyLogin, forgetLoginStatus, getPreview, ingestUpload, inspectProject, openShopifySignIn, publicPreview, startPreview, stopPreview } from './intake';
import { killTree, ownProcessGroup } from '../platform/proc';
import { buildsBlockedReason, cloudRequired } from '../cloud-client';
import { runSelftestViaCloud } from './qa-cloud';

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
  killTree(child);
}

/** Run calibrate.mjs (bounded) and parse its trailing `CALIBRATE_RESULT <json>` line. */
function runCalibration(script: string): Promise<CalibrationOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      shell: false, windowsHide: true, detached: ownProcessGroup, cwd: path.dirname(script),
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
  /** Validate + create + scaffold a clone job. Shared by the wizard's POST /jobs and the
   *  easy-mode orchestrator (which feeds it the credentials the autopilot just collected). */
  const intakeJob = async (body: JobIntake): Promise<{ status: number; payload: Record<string, unknown> }> => {
    const name = String(body.name ?? '').trim();
    if (!name) return { status: 422, payload: { error: 'A project name is required.' } };
    let reactUrl: URL;
    try { reactUrl = new URL(String(body.reactUrl ?? '')); if (!/^https?:$/.test(reactUrl.protocol)) throw new Error(); } catch { return { status: 422, payload: { error: 'The React URL must be a valid http(s) URL.' } }; }
    const shop = normalizeShop(String(body.storeUrl ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    if (!shop) return { status: 422, payload: { error: 'The store URL must be a *.myshopify.com domain.' } };
    // Credentials come either from the form, or from a saved store (savedStoreId) — in the
    // latter case the secret is decrypted server-side and never round-trips the browser.
    let clientId = String(body.clientId ?? '').trim();
    let clientSecret = String(body.clientSecret ?? '').trim();
    let storefrontPassword = body.storefrontPassword ? String(body.storefrontPassword) : null;
    if (body.savedStoreId) {
      const saved = await db.getFactoryStore(String(body.savedStoreId));
      if (!saved) return { status: 422, payload: { error: 'The selected saved store no longer exists — pick another or enter credentials manually.' } };
      if (saved.shop_domain !== shop) return { status: 422, payload: { error: `The saved store "${saved.label}" is for ${saved.shop_domain}, not ${shop}.` } };
      clientId = saved.client_id;
      try { clientSecret = decrypt(saved.client_secret_cipher); }
      catch { return { status: 500, payload: { error: 'Could not decrypt the stored credentials for this store.' } }; }
      if (!storefrontPassword && saved.storefront_password_cipher) {
        try { storefrontPassword = decrypt(saved.storefront_password_cipher); } catch { storefrontPassword = null; }
      }
    }
    if (!/^[0-9a-f]{32}$/i.test(clientId)) return { status: 422, payload: { error: 'The Client ID must be a 32-character hex string.' } };
    if (!/^shpss_/.test(clientSecret)) return { status: 422, payload: { error: 'The Client Secret must start with shpss_.' } };
    const prefix = String(body.prefix ?? '').trim().toLowerCase() || derivePrefix(name);
    if (!/^[a-z][a-z0-9]{1,2}$/.test(prefix)) return { status: 422, payload: { error: 'The prefix must be 2-3 characters (letters/digits, starting with a letter).' } };
    const autoswap = Boolean(body.autoswap);
    const autoQa = body.autoQa !== false;
    // An unverified clone must never be published live: autoswap publishes the dev theme to
    // the LIVE theme after convergence, and without auto-QA there is no convergence signal.
    if (autoswap && !autoQa) return { status: 400, payload: { error: 'autoswap requires auto-QA — an unverified clone must never be published live. Enable auto-QA or turn autoswap off.' } };
    const storeUrl = `https://${shop}`;
    const duplicate = await db.findActiveFactoryJobByStore(storeUrl);
    if (duplicate) return { status: 409, payload: { error: `Another active job ("${duplicate.name}") already targets ${shop}. Two clones writing one store would corrupt it.` } };
    if (body.reactFilesPath) {
      const source = String(body.reactFilesPath);
      if (!(await fileExists(source))) return { status: 422, payload: { error: `react_files source not found: ${source}` } };
      if (isZipPath(source)) {
        // Zip intake: extraction (and the package.json check) happens during scaffolding —
        // here we only verify it's actually a file.
        if (!(await stat(source)).isFile()) return { status: 422, payload: { error: `react_files source ends in .zip but is not a file: ${source}` } };
      } else if (!(await containsPackageJson(source))) {
        return { status: 422, payload: { error: 'The react_files folder does not contain a package.json (searched 3 levels deep).' } };
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
      // 'playwright' = quiet headless check; 'headed' = same, in a visible window; 'chrome' =
      // Claude also verifies in the user's own Chrome (needs the one-time extension setup).
      qa_engine: ['playwright', 'headed', 'chrome'].includes(String((body as { qaEngine?: string }).qaEngine)) ? String((body as { qaEngine?: string }).qaEngine) : 'playwright',
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
      return { status: 500, payload: { error: `Workspace scaffolding failed: ${error instanceof Error ? error.message : 'unknown error'}`, job: publicJob((await db.getFactoryJob(job.id))!) } };
    }
    void factoryScheduler.tick();
    return { status: 201, payload: { job: publicJob((await db.getFactoryJob(job.id))!) } };
  };

  // Customer builds need the "I own this site / have permission" confirmation, kept as a record.
  const rightsMissing = (body: { rightsConfirmed?: unknown } | undefined) => config.edition === 'customer' && body?.rightsConfirmed !== true;
  const recordRights = (site: string, store: string) => db.audit(null, 'build.rights_confirmed', 'user', { site, store, at: new Date().toISOString() }).catch(() => {});
  // Desktop builds that require a ThemeBot account start builds only with a valid pass (see
  // cloud-client.ts): signed out, or offline for 15+ minutes, is refused with the reason.
  const passMissing = (response: Response) => {
    const reason = buildsBlockedReason();
    if (reason) response.status(403).json({ error: reason, code: 'THEMEBOT_SIGNIN_REQUIRED' });
    return reason != null;
  };

  router.post('/jobs', handle(async (request, response) => {
    if (passMissing(response)) return;
    if (rightsMissing(request.body)) { response.status(422).json({ error: "Confirm that you own this website or have the owner's permission before building." }); return; }
    void recordRights(String(request.body?.reactUrl ?? request.body?.reactFilesPath ?? ''), String(request.body?.storeUrl ?? ''));
    const result = await intakeJob(request.body as JobIntake);
    response.status(result.status).json(result.payload);
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

  router.post('/jobs/:id/rebuild', handle(async (request, response) => {
    if (passMissing(response)) return;
    const target = await db.getFactoryJob(String(request.params.id));
    // Pages already built in an earlier run are listed for the AI so it doesn't pay to write them again.
    const skipped = target ? await writeAlreadyBuilt(target) : { done: 0, total: 0 };
    try { await factoryScheduler.rebuild(String(request.params.id)); }
    catch (error) { response.status(409).json({ error: error instanceof Error ? error.message : 'Could not rebuild.' }); return; }
    response.json({ job: publicJob((await db.getFactoryJob(String(request.params.id)))!), alreadyBuilt: skipped });
  }));

  // Hand-started runs from the build panel: one check (free — scripted comparison, no AI), or
  // fix rounds (AI), each followed by a check.
  router.post('/jobs/:id/check', handle(async (request, response) => {
    if (passMissing(response)) return;
    try { await factoryScheduler.runMode(String(request.params.id), { kind: 'check' }); }
    catch (error) { response.status(409).json({ error: error instanceof Error ? error.message : 'Could not start the check.' }); return; }
    response.json({ job: publicJob((await db.getFactoryJob(String(request.params.id)))!) });
  }));
  router.post('/jobs/:id/fix', handle(async (request, response) => {
    if (passMissing(response)) return;
    const rounds = Math.min(10, Math.max(1, Math.round(Number(request.body?.rounds ?? 1)) || 1));
    try { await factoryScheduler.runMode(String(request.params.id), { kind: 'fix', rounds }); }
    catch (error) { response.status(409).json({ error: error instanceof Error ? error.message : 'Could not start fixing.' }); return; }
    response.json({ job: publicJob((await db.getFactoryJob(String(request.params.id)))!) });
  }));
  // Draft-theme sync: which theme files on disk are missing from / different on the store's
  // unpublished draft theme, and upload just those (never the live theme).
  router.get('/jobs/:id/sync', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    response.json(await syncStatus(job, request.query.force === '1'));
  }));
  router.post('/jobs/:id/sync', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    if (factoryScheduler.isRunning(job.id)) { response.status(409).json({ error: 'The build is running — its own uploads are in progress.' }); return; }
    try { response.json(await uploadToDraft(job)); }
    catch (error) { response.status(409).json({ error: error instanceof Error ? error.message : 'Could not upload.' }); }
  }));

  router.post('/jobs/:id/retry', handle(async (request, response) => {
    if (passMissing(response)) return;
    await factoryScheduler.retry(String(request.params.id));
    response.json({ job: publicJob((await db.getFactoryJob(String(request.params.id)))!) });
  }));

  // Queue a job that has never run (draft) — the JobDetail Start button's target.
  router.post('/jobs/:id/start', handle(async (request, response) => {
    if (passMissing(response)) return;
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    if (job.status !== 'draft' && job.status !== 'paused') { response.status(409).json({ error: 'Only draft or paused jobs can be started — use Retry for blocked/failed jobs.' }); return; }
    await db.updateFactoryJob(job.id, { status: 'queued', status_detail: null });
    void factoryScheduler.tick();
    response.json({ job: publicJob((await db.getFactoryJob(job.id))!) });
  }));

  // Store a job's storefront password (job, saved store, and the project's TARGET_SITE_INFO.txt).
  router.post('/jobs/:id/storefront-password', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    const password = String(request.body?.password ?? '').trim();
    if (!password || password.length > 100) { response.status(422).json({ error: 'A storefront password is required.' }); return; }
    await db.updateFactoryJob(job.id, { storefront_password_cipher: encrypt(password) });
    const shop = normalizeShop(job.store_url);
    const saved = shop ? (await db.listFactoryStores()).find((store) => store.shop_domain === shop) : null;
    if (saved) await db.upsertFactoryStore({ label: saved.label, shop_domain: saved.shop_domain, client_id: saved.client_id, client_secret_cipher: saved.client_secret_cipher, storefront_password_cipher: encrypt(password) });
    const infoPath = path.join(job.workspace_path, 'TARGET_SITE_INFO.txt');
    try {
      const info = await readFile(infoPath, 'utf8');
      await writeFile(infoPath, /store pass:\s*\n\s*\n?[^\n]*/i.test(info) ? info.replace(/store pass:\s*\n\s*\n?[^\n]*/i, `store pass:\n\n${password}`) : `${info.trimEnd()}\n\nstore pass:\n\n${password}\n`);
    } catch { /* no info file */ }
    response.json({ ok: true });
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

  /** Build progress for the panel: the plan (qa/state/inventory.json — every page and how many
   *  sections it needs) against what exists on disk (each page's template and the section files it
   *  uses), the current step, and a time estimate from the pace so far. ThemeBot Cloud builds report
   *  their real steps (factory/steps/progress.json, written as the Cloud hands them out); builds on
   *  the local /clone-theme command name the newest "Phase N" their log mentions. */
  const STEP_LABELS: Record<string, string> = { '0': 'Getting ready', '1': 'Planning the pages', '2': 'Setting up the theme', '3': 'Setting up the store', '4': 'Building the pages', '5': 'Checking each page', '6': 'Wrapping up' };
  router.get('/jobs/:id/progress', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    const startedAt = new Date(job.started_at ?? job.created_at).getTime();
    const { planned, pages, files, sectionTimes } = await pageProgress(job.workspace_path);
    const sectionsPlanned = pages.reduce((total, page) => total + page.planned, 0);
    const sectionsBuilt = pages.reduce((total, page) => total + page.built, 0);
    const changedThisRun = [...sectionTimes.values()].filter((at) => at >= startedAt).length;
    const elapsedMs = Math.max(0, (job.finished_at ? new Date(job.finished_at).getTime() : Date.now()) - startedAt);
    const remaining = Math.max(0, sectionsPlanned - sectionsBuilt);
    // Pace = sections written this run per ms; only trusted once a few have landed.
    const etaMs = remaining > 0 && changedThisRun >= 3 && elapsedMs > 0 ? Math.round(remaining / (changedThisRun / elapsedMs)) : remaining === 0 && sectionsPlanned > 0 ? 0 : null;

    // Current step: a Cloud build's own step list, else the newest "Phase N" the build's log mentions.
    let step: { n: string; label: string } | null = null;
    const cloudSteps = await stepProgressSummary(job.workspace_path);
    if (cloudSteps) {
      step = job.status === 'cloning' ? cloudSteps.step : null;
    } else {
      try {
        const events = await tailFile(path.join(job.workspace_path, 'factory', 'logs', 'clone-0.events.jsonl'), 600);
        const matches = [...events.matchAll(/Phase (\d)(?:\.\d+)?/g)];
        const n = matches.length ? matches[matches.length - 1][1] : null;
        if (n) step = { n, label: STEP_LABELS[n] ?? `Phase ${n}` };
      } catch { /* no log yet */ }
    }
    if (['qa_running', 'fixing'].includes(job.status)) step = { n: cloudSteps ? 'qa' : '5', label: job.status === 'fixing' ? 'Fixing differences' : 'Checking against your website' };

    response.json({
      step, planned, pages: pages.map(({ sections: _sections, template: _template, ...page }) => page),
      // A build that isn't building right now (paused, blocked, crashed mid-step) runs no step, whatever
      // the last saved list says.
      ...(cloudSteps ? { steps: job.status === 'cloning' ? cloudSteps.steps : cloudSteps.steps.map((entry) => (entry.status === 'running' ? { ...entry, status: 'pending' as const } : entry)), stepTotals: { done: cloudSteps.done, total: cloudSteps.total } } : {}),
      totals: { pagesPlanned: pages.length, pagesStarted: pages.filter((page) => page.hasTemplate).length, pagesDone: pages.filter((page) => page.built >= page.planned).length, sectionsPlanned, sectionsBuilt, changedThisRun },
      files, startedAt, elapsedMs, etaMs,
    });
  }));

  /** Live code for the build panel: the theme files the build changed, newest last. The AI writes
   *  most files through scripts rather than one "write file" action, so the project folder itself
   *  is the source of truth. `since` (ms) returns only files changed after it, with content. */
  const THEME_DIRS = ['layout', 'sections', 'snippets', 'blocks', 'templates', 'config', 'locales', 'assets'];
  const CODE_EXT = /\.(liquid|json|css|js|mjs|svg|md|txt)$/i;
  router.get('/jobs/:id/code', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    const since = Math.max(Number(request.query.since ?? 0) || 0, new Date(job.created_at).getTime() - 60_000);
    const found: Array<{ path: string; mtime: number; size: number }> = [];
    const walk = async (relative: string, depth: number) => {
      let entries: import('node:fs').Dirent[] = [];
      try { entries = await readdir(path.join(job.workspace_path, relative), { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const rel = `${relative}/${entry.name}`;
        if (entry.isDirectory()) { if (depth > 0) await walk(rel, depth - 1); continue; }
        if (!CODE_EXT.test(entry.name)) continue;
        try { const info = await stat(path.join(job.workspace_path, rel)); found.push({ path: rel, mtime: info.mtimeMs, size: info.size }); } catch { /* vanished */ }
      }
    };
    for (const dir of THEME_DIRS) await walk(dir, 2);
    found.sort((a, b) => a.mtime - b.mtime);
    // ?file= — one file the user clicked in the list (must be one of the theme files found above).
    const wanted = typeof request.query.file === 'string' ? found.find((file) => file.path === request.query.file) : null;
    if (typeof request.query.file === 'string') {
      if (!wanted) { response.status(404).json({ error: 'File not found.' }); return; }
      const content = wanted.size <= 400_000 ? await readFile(path.join(job.workspace_path, wanted.path), 'utf8').catch(() => '') : '';
      response.json({ files: [{ ...wanted, content: scrubSecrets(content.slice(0, 40_000)), truncated: content.length > 40_000 }], recent: [], total: found.length, now: Date.now() });
      return;
    }
    const recent = found.slice(-400);
    const changed = found.filter((file) => file.mtime > since).slice(-12);
    const files = await Promise.all(changed.map(async (file) => {
      let content = '';
      if (file.size <= 400_000) { try { content = await readFile(path.join(job.workspace_path, file.path), 'utf8'); } catch { /* locked mid-write */ } }
      const truncated = content.length > 40_000;
      return { ...file, content: scrubSecrets(truncated ? content.slice(0, 40_000) : content), truncated };
    }));
    response.json({ files, recent, total: found.length, now: Date.now() });
  }));

  /** Live activity for the build panel: streamed session events (newer builds) merged with the
   *  files the build wrote in the project folder (works for every build, old or new). */
  router.get('/jobs/:id/activity', handle(async (request, response) => {
    const job = await db.getFactoryJob(String(request.params.id));
    if (!job) { response.status(404).json({ error: 'Job not found.' }); return; }
    const since = new Date(job.started_at ?? job.created_at).getTime() - 5000;
    const events: Array<{ at: number; kind: string; text: string }> = [];
    const logsDir = path.join(job.workspace_path, 'factory', 'logs');
    let streaming = false;
    try {
      for (const name of (await readdir(logsDir)).filter((entry) => entry.endsWith('.events.jsonl'))) {
        streaming = true;
        for (const line of (await tailFile(path.join(logsDir, name), 400)).split('\n')) {
          try { const parsed = JSON.parse(line) as { at: number; kind: string; text: string }; if (parsed.at >= since) events.push(parsed); } catch { /* skip */ }
        }
      }
    } catch { /* no logs yet */ }
    const walk = async (relative: string, depth: number) => {
      let entries: import('node:fs').Dirent[] = [];
      try { entries = await readdir(path.join(job.workspace_path, relative), { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const rel = `${relative}/${entry.name}`;
        if (entry.isDirectory()) { if (depth > 0) await walk(rel, depth - 1); continue; }
        try {
          const info = await stat(path.join(job.workspace_path, rel));
          if (info.mtimeMs < since) continue;
          const created = info.birthtimeMs >= since;
          const what = /^qa\//.test(rel) ? (/\.png$/i.test(rel) ? 'Picture taken' : 'Check report written') : created ? 'Created' : 'Updated';
          events.push({ at: Math.round(info.mtimeMs), kind: /^qa\//.test(rel) ? 'net' : 'ok', text: `${what}: ${rel}` });
        } catch { /* racing the build */ }
      }
    };
    for (const folder of ['sections', 'snippets', 'templates', 'layout', 'config', 'locales', 'assets', 'blocks']) await walk(folder, 1);
    await walk('qa', 2);
    events.sort((a, b) => a.at - b.at);
    response.json({ events: events.slice(-300).map((entry) => ({ ...entry, text: scrubSecrets(entry.text) })), streaming });
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
    // Playwright knows where its Chromium lives on every OS (and honours PLAYWRIGHT_BROWSERS_PATH).
    const hasChromium = Boolean(detectEngines().find((engine) => engine.id === 'chromium')?.available);
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

  // Chrome profiles for the scripted collector's profile picker (which one is signed into the
  // right Shopify account). Read from Chrome's own Local State; empty if Chrome isn't installed.
  router.get('/chrome-profiles', handle(async (_request, response) => {
    response.json({ profiles: listChromeProfiles() });
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

  /** One-time Shopify sign-in for the script's own Chrome profile: a PLAIN Chrome window (no
   *  automation attached) on that profile, so Google/Shopify sign-in works normally. The session
   *  is saved in the profile and the script reuses it; the user closes the window when done. */
  // Pages the ThemeBot browser window may open on (fixed list — never an arbitrary URL).
  const SIGNIN_PAGES: Record<string, string> = {
    shopify: 'https://admin.shopify.com/',
    'shopify-accounts': 'https://accounts.shopify.com/select',
    'google-add': 'https://accounts.google.com/AddSession',
    'google-manage': 'https://accounts.google.com/SignOutOptions',
  };
  // Read-only: which Shopify login the ThemeBot window uses and whether it can open this store.
  // Cached for 5 minutes per store; ?force=1 re-checks.
  const storeChecks = new Map<string, StoreAccess>();
  // The store an earlier attempt made for this name (what Start would reuse), if any.
  router.get('/easy/remembered-store', handle(async (request, response) => {
    response.json({ shop: await findCreatedStore(String(request.query.name ?? '')) });
  }));
  router.post('/easy/store-check', handle(async (request, response) => {
    const shop = normalizeShop(String(request.body?.shop ?? ''));
    if (!shop) { response.status(422).json({ error: 'A *.myshopify.com store is required.' }); return; }
    if (collect.status === 'working') { response.json({ shop, access: 'unknown', account: null, storeName: null, reason: 'busy', checkedAt: Date.now() }); return; }
    const cached = storeChecks.get(shop);
    if (cached && !request.body?.force && Date.now() - cached.checkedAt < 5 * 60_000) { response.json(cached); return; }
    const result = await checkStoreAccess(SCRIPT_PROFILE_DIR(), shop);
    if (result.access !== 'unknown') storeChecks.set(shop, result);
    response.json(result);
  }));

  router.post('/easy/signin-window', handle(async (request, response) => {
    if (collect.status === 'working' && collect.method === 'scripted') { response.status(409).json({ error: 'The setup script is using the ThemeBot window right now — stop it first.' }); return; }
    const page = typeof request.body?.page === 'string' && SIGNIN_PAGES[request.body.page] ? request.body.page as string : 'shopify';
    const engines = detectEngines();
    const target = engines.find((engine) => engine.id === 'chrome' && engine.available) ?? engines.find((engine) => engine.id === 'msedge' && engine.available);
    if (!target?.executablePath) { response.status(422).json({ error: 'No system Chrome or Edge installation was found.' }); return; }
    await mkdir(SCRIPT_PROFILE_DIR(), { recursive: true });
    // Optional: open one store's admin instead (the "is this the right store?" check).
    const storeShop = request.body?.shop ? normalizeShop(String(request.body.shop)) : null;
    const adminPath = typeof request.body?.adminPath === 'string' && /^(\/[a-z0-9_-]+)*$/i.test(request.body.adminPath) ? request.body.adminPath : '';
    const url = storeShop ? `https://admin.shopify.com/store/${storeShop.replace(/\.myshopify\.com$/i, '')}${adminPath}` : SIGNIN_PAGES[page];
    storeChecks.clear();   // they may switch account in that window
    prepareFreshWindow(SCRIPT_PROFILE_DIR());
    const child = spawn(target.executablePath, [`--user-data-dir=${SCRIPT_PROFILE_DIR()}`, '--no-first-run', '--no-default-browser-check', ...centeredWindowArgs(), '--new-window', url], { shell: false, windowsHide: false, detached: true, stdio: 'ignore' });
    child.on('error', () => { /* the window simply does not open; response already sent */ });
    child.unref();
    response.json({ ok: true, browser: target.label });
  }));

  // ---- AI engines: accounts, which one builds, and ThemeBot's own usage ----
  router.get('/engines', handle(async (_request, response) => {
    response.json({ active: await activeEngine(), engines: await listEngines(), accounts: await accountStatuses(), keys: await keyStatuses(), usage: await usageSummary() });
  }));
  // Raw usage feed for dashboards: every session / check / finished build since ?since= (ms).
  router.get('/engines/usage', handle(async (request, response) => {
    const since = Number(request.query.since ?? 0) || 0;
    response.json({ entries: (await readUsage()).filter((entry) => entry.at >= since) });
  }));
  // Same feed as CSV (one row per AI session) for spreadsheets.
  router.get('/engines/usage.csv', handle(async (_request, response) => {
    const rows = (await readUsage()).filter((entry) => entry.type === 'session');
    const header = 'when,build,kind,models,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reported_usd,estimated_usd,duration_s,api_s,turns,error';
    const esc = (value: unknown) => { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
    const lines = rows.map((e) => e.type === 'session' ? [new Date(e.at).toISOString(), e.jobName, e.kind, Object.keys(e.models).join(' ') || e.modelSetting, e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheWriteTokens, e.costUsd ?? '', e.estUsd?.toFixed(4) ?? '', e.durationMs ? Math.round(e.durationMs / 1000) : '', e.apiMs ? Math.round(e.apiMs / 1000) : '', e.turns ?? '', e.isError ? 'yes' : ''].map(esc).join(',') : '');
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="themebot-usage.csv"');
    response.send([header, ...lines].join('\n'));
  }));
  // API keys (any provider): checked with the provider, stored encrypted, never sent back.
  router.post('/engines/keys/:provider', handle(async (request, response) => {
    const provider = String(request.params.provider) as KeyProvider;
    if (!KEY_SPECS[provider]) { response.status(404).json({ error: 'Unknown provider.' }); return; }
    try { await setProviderKey(provider, String(request.body?.key ?? '')); response.json({ ok: true }); }
    catch (error) { response.status(422).json({ error: error instanceof Error ? error.message : 'Could not save the key.' }); }
  }));
  router.delete('/engines/keys/:provider', handle(async (request, response) => {
    const provider = String(request.params.provider) as KeyProvider;
    if (!KEY_SPECS[provider]) { response.status(404).json({ error: 'Unknown provider.' }); return; }
    await removeProviderKey(provider); response.json({ ok: true });
  }));
  // Existing sign-ins on this computer: link / unlink with one click.
  router.post('/engines/accounts/:provider/link', handle(async (request, response) => {
    try { await linkAccount(String(request.params.provider) as AccountProvider, request.body?.on !== false); response.json({ ok: true }); }
    catch (error) { response.status(422).json({ error: error instanceof Error ? error.message : 'Could not link.' }); }
  }));
  // Dismiss a "limit reached" notice (e.g. a false alarm).
  router.post('/engines/limit/clear', handle(async (_request, response) => { await clearLimit(); response.json({ ok: true }); }));
  router.post('/engines/active', handle(async (request, response) => {
    try { await setActiveEngine(String(request.body?.id ?? '') as EngineId); response.json({ ok: true, active: await activeEngine() }); }
    catch (error) { response.status(422).json({ error: error instanceof Error ? error.message : 'Could not switch.' }); }
  }));

  router.get('/easy/profile', handle(async (_request, response) => {
    const info = await stat(SCRIPT_PROFILE_DIR()).catch(() => null);
    response.json({ exists: Boolean(info), path: SCRIPT_PROFILE_DIR(), inUse: collect.status === 'working' && collect.method === 'scripted' });
  }));

  // "Sign out of everything": the profile folder is moved aside (kept as a backup, not deleted),
  // so the next window starts signed out of every Google and Shopify account.
  router.post('/easy/profile-reset', handle(async (_request, response) => {
    if (collect.status === 'working' && collect.method === 'scripted') { response.status(409).json({ error: 'The setup script is using the ThemeBot browser right now — stop it first.' }); return; }
    const dir = SCRIPT_PROFILE_DIR();
    if (!(await stat(dir).catch(() => null))) { response.json({ ok: true, backup: null }); return; }
    // On macOS/Linux a folder in use can still be renamed, so check for a running Chrome first.
    if (chromeProfileInUse(dir)) { response.status(409).json({ error: 'Close the ThemeBot browser window first, then try again.' }); return; }
    const backup = `${dir}.signed-out-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { await rename(dir, backup); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') { response.status(409).json({ error: 'Close the ThemeBot browser window first, then try again.' }); return; }
      throw error;
    }
    response.json({ ok: true, backup });
  }));

  // --- "Lazy mode" key collector -------------------------------------------------
  // Spawns a headless Claude agent that drives the USER'S already-signed-in Chrome via
  // the Claude extension: opens the app's API credentials page, reads the Client ID,
  // reveals + reads the Secret, and POSTs them back to the loopback deliver endpoint
  // below with a one-time token. Keys live ONLY in this in-memory state and are handed
  // to the wizard exactly once (?take=1), then wiped — never written to disk or logs.
  interface CollectState { status: 'idle' | 'working' | 'delivered' | 'partial' | 'failed'; method: CollectionMethod | null; startedAt: number; finishedAt: number; note: string | null; clientId: string | null; clientSecret: string | null }
  let collect: CollectState = { status: 'idle', method: null, startedAt: 0, finishedAt: 0, note: null, clientId: null, clientSecret: null };
  let collectTarget: { shop: string; label: string } | null = null;
  // Easy mode: the bot also reads the new dev store's storefront password (QA needs it to get
  // past the password wall). Memory only, wiped with the rest of the collector state.
  let collectStorefrontPassword: string | null = null;
  let collectToken: string | null = null;
  let collectChild: ChildProcess | null = null;
  let collectScripted: ScriptedHandle | null = null;
  let collectTimer: NodeJS.Timeout | null = null;
  // Full autopilot runs (create app → scopes → release → install → harvest) need more room.
  /** The setup script's own Chrome profile (separate from the user's everyday Chrome). */
  const SCRIPT_PROFILE_DIR = () => path.join(config.factory.workspaceRoot, '_collector-profile');
  /** Stores the setup script created, by store name — so a retry (even after a server restart)
   *  reuses the store instead of creating a duplicate. */
  const CREATED_STORES_FILE = () => path.join(config.factory.workspaceRoot, '_easy-created-stores.json');
  type CreatedStore = { name: string; shop: string; at: number };
  const readCreatedStores = async (): Promise<CreatedStore[]> => { try { return JSON.parse(await readFile(CREATED_STORES_FILE(), 'utf8')) as CreatedStore[]; } catch { return []; } };
  const rememberCreatedStore = async (name: string, shop: string) => {
    const list = (await readCreatedStores()).filter((entry) => entry.shop !== shop);
    list.push({ name: name.trim().toLowerCase(), shop, at: Date.now() });
    await writeFile(CREATED_STORES_FILE(), JSON.stringify(list.slice(-50), null, 2)).catch(() => {});
  };
  const forgetCreatedStore = async (shop: string) => {
    const list = await readCreatedStores();
    const kept = list.filter((entry) => entry.shop !== shop);
    if (kept.length !== list.length) await writeFile(CREATED_STORES_FILE(), JSON.stringify(kept, null, 2)).catch(() => {});
  };
  const findCreatedStore = async (name: string) => {
    const wanted = name.trim().toLowerCase();
    const recent = (await readCreatedStores()).filter((entry) => entry.name === wanted && Date.now() - entry.at < 7 * 24 * 3600_000);
    return recent.length ? recent[recent.length - 1].shop : null;
  };
  const COLLECT_TIMEOUT_MS = 15 * 60_000;
  // Store creation + provisioning wait + app setup: give the full easy-mode autopilot more room.
  const COLLECT_TIMEOUT_CREATE_MS = 40 * 60_000;
  // Everything the clone pipeline can use — the user-verified working list (files, locales,
  // metaobjects, pages, products, content, themes, translations, plus the unauthenticated
  // Storefront scopes QA needs) + the navigation pair the wizard's Test connection checks for.
  const AUTOPILOT_SCOPES = 'read_files,write_files,read_locales,write_locales,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects,read_online_store_pages,write_online_store_pages,read_products,write_products,read_content,write_content,write_theme_code,read_themes,write_themes,read_translations,write_translations,read_online_store_navigation,write_online_store_navigation,unauthenticated_write_bulk_operations,unauthenticated_read_bulk_operations,unauthenticated_read_bundles,unauthenticated_write_checkouts,unauthenticated_read_checkouts,unauthenticated_write_customers,unauthenticated_read_customers,unauthenticated_read_customer_tags,unauthenticated_read_metaobjects,unauthenticated_read_product_pickup_locations';

  // Live activity feed for the wizard panel — friendly one-liners derived from the spawned
  // agent's stream-json events, ALWAYS redacted (no key material can ever appear here).
  // 'thought' = the agent's own narration/reasoning; 'action' = a Chrome tool it fired;
  // 'system' = our own status lines. The wizard's live-cognition viewport styles each differently.
  type LogKind = 'thought' | 'action' | 'system';
  let collectLog: Array<{ at: number; text: string; kind: LogKind }> = [];
  const redactKeys = (text: string) => text.replace(/shpss_[A-Za-z0-9_-]+/g, 'shpss_•••').replace(/\b[0-9a-f]{32}\b/gi, '••••••••');
  const pushCollectLog = (text: string, kind: LogKind = 'system') => {
    const clean = redactKeys(text);
    if (collectLog[collectLog.length - 1]?.text === clean) return; // collapse repeats
    collectLog.push({ at: Date.now(), text: clean, kind });
    if (collectLog.length > 60) collectLog = collectLog.slice(-60);
  };
  const collectEventText = (line: string): { text: string; kind: LogKind } | null => {
    let parsed: { type?: string; subtype?: string; is_error?: boolean; message?: { content?: Array<{ type?: string; name?: string; text?: string; thinking?: string }> } };
    try { parsed = JSON.parse(line) as typeof parsed; } catch { return null; }
    if (parsed.type === 'system' && parsed.subtype === 'init') return { text: 'Agent booted — connecting to your Chrome…', kind: 'system' };
    if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
      for (const block of parsed.message.content) {
        if (block.type === 'tool_use') {
          const name = String(block.name ?? '');
          if (name === 'ToolSearch') return { text: 'Loading the Chrome browser tools…', kind: 'action' };
          if (/tabs_create|navigate/.test(name)) return { text: 'Opening your store admin in Chrome…', kind: 'action' };
          if (/read_page|get_page_text|find/.test(name)) return { text: 'Reading the page…', kind: 'action' };
          if (/computer|form_input/.test(name)) return { text: 'Clicking in your Chrome…', kind: 'action' };
          if (name === 'Bash') return { text: 'Delivering the keys to ThemeBot…', kind: 'action' };
          return { text: `Using ${name.replace(/^mcp__claude-in-chrome__/, 'chrome: ')}…`, kind: 'action' };
        }
        // Extended-thinking blocks (when present) and plain narration both read as "thoughts".
        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) return { text: block.thinking.trim().slice(0, 240), kind: 'thought' };
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) return { text: block.text.trim().slice(0, 240), kind: 'thought' };
      }
    }
    if (parsed.type === 'result') return parsed.is_error ? { text: 'Agent finished with an error.', kind: 'system' } : { text: 'Agent finished.', kind: 'system' };
    return null;
  };

  const stopCollector = (status: CollectState['status'], note: string | null) => {
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
    killTree(collectChild);
    collectChild = null;
    // Scripted (in-process Playwright) runs: abort the step-machine and close the browser.
    if (collectScripted) { collectScripted.abort.abort(); void collectScripted.close().catch(() => {}); collectScripted = null; }
    collectToken = null;
    if (collect.status === 'working') collect = { ...collect, status, note, finishedAt: Date.now() };
  };

  /** Validate a delivered clientId+secret, encrypt+persist an encrypted saved store, and set the
   *  collector's terminal state. Shared by the LLM deliver endpoint, the scripted + Partner-API
   *  collectors (in-process), and the manual /keys/save route. Returns whether it was a full delivery. */
  const persistDelivered = async (rawClientId: unknown, rawClientSecret: unknown, status: string | undefined, note: string | null): Promise<boolean> => {
    const clientId = typeof rawClientId === 'string' && /^[0-9a-f]{32}$/i.test(rawClientId.trim()) ? rawClientId.trim() : null;
    const clientSecret = typeof rawClientSecret === 'string' && rawClientSecret.trim().startsWith('shpss_') ? rawClientSecret.trim() : null;
    const delivered = status === 'delivered' && Boolean(clientId) && Boolean(clientSecret);
    collect = {
      ...collect,
      status: delivered ? 'delivered' : status === 'failed' ? 'failed' : 'partial',
      note: typeof note === 'string' ? note.slice(0, 300) : null,
      finishedAt: Date.now(),
      clientId, clientSecret,
    };
    // Durability: persist a full delivery as an encrypted saved store IMMEDIATELY, so a reload
    // before the user hits Test connection can never lose the secret.
    if (delivered && collectTarget && collectTarget.shop) {
      await db.upsertFactoryStore({
        label: collectTarget.label, shop_domain: collectTarget.shop, client_id: clientId!,
        client_secret_cipher: encrypt(clientSecret!), storefront_password_cipher: collectStorefrontPassword ? encrypt(collectStorefrontPassword) : null,
      }).catch(() => { /* best-effort — the wizard hand-off still works from memory */ });
    }
    return delivered;
  };

  /** Hook the easy-mode orchestrator installs to learn when a collector run ends (any method). */
  let onCollectFinished: ((state: CollectState) => void) | null = null;
  const notifyCollectFinished = () => { if (collect.status !== 'working' && onCollectFinished) { const hook = onCollectFinished; onCollectFinished = null; hook(collect); } };

  /** Start a collector run. Called by the wizard route and by the easy-mode orchestrator.
   *  Easy mode ('managed' + createStore) may start without a known shop domain: the bot creates
   *  the store first and delivers the real *.myshopify.com domain together with the keys. */
  const startCollector = async (input: { storeUrl?: string; projectName?: string; method?: string; storeName?: string; createStore?: boolean; createIfUnreachable?: boolean; partnerToken?: string; orgId?: string; clientId?: string; chromeProfile?: string }): Promise<{ status: number; payload: Record<string, unknown> }> => {
    if (collect.status === 'working') return { status: 409, payload: { error: 'The key collector is already running.' } };
    const requested = String(input.method ?? 'llm');
    const method: CollectionMethod = (['llm', 'managed', 'scripted', 'partnerapi'] as const).includes(requested as never) ? requested as CollectionMethod : 'llm';
    const createStore = (method === 'managed' || method === 'llm' || method === 'scripted') && Boolean(input.createStore);
    const shop = normalizeShop(String(input.storeUrl ?? ''));
    if (!shop && !createStore) return { status: 422, payload: { error: 'A valid *.myshopify.com store is required (fill it in step 1).' } };
    const storeName = String(input.storeName ?? '').trim();
    if (createStore && !storeName) return { status: 422, payload: { error: 'A store name is required to create the store.' } };
    const handleName = shop ? shop.replace(/\.myshopify\.com$/i, '') : storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    // App is named after the PROJECT so users (and the bot) always know which store it belongs to.
    const projectName = String(input.projectName ?? '').trim();
    // slugify() THROWS on an empty/symbol-only name rather than returning '', so guard the fallback.
    let appName: string;
    try { appName = `${(slugify(projectName) || handleName).slice(0, 25)}_bot`; }
    catch { appName = `${handleName.slice(0, 25)}_bot`; }
    collectTarget = { shop: shop ?? '', label: projectName || storeName || handleName };
    collectStorefrontPassword = null;
    collectLog = [];
    collect = { status: 'working', method, startedAt: Date.now(), finishedAt: 0, note: null, clientId: null, clientSecret: null };
    const request = { body: input } as unknown as Request;
    const shopOrPending = shop ?? `(${handleName} — created by the bot)`;

    // --- Method: Partner API (headless GraphQL — no browser) --------------------------------
    if (method === 'partnerapi') {
      const partnerToken = String(request.body?.partnerToken ?? '').trim();
      const orgId = String(request.body?.orgId ?? '').trim();
      const clientIdHint = String(request.body?.clientId ?? '').trim();
      if (!partnerToken) { stopCollector('failed', 'A Partner API access token is required for this method.'); return { status: 422, payload: { error: collect.note } }; }
      pushCollectLog('Querying the Shopify Partner API…');
      collectTimer = setTimeout(() => stopCollector('failed', 'Partner API request timed out.'), 60_000);
      void (async () => {
        try {
          const result = await fetchAppSecretViaPartnerApi({ partnerToken, orgId, shop: shop!, appName, clientIdHint, log: pushCollectLog });
          if (collect.status === 'working') await persistDelivered(result.clientId, result.clientSecret, result.status, result.note);
        } catch (error) {
          if (collect.status === 'working') stopCollector('failed', error instanceof Error ? error.message : 'Partner API request failed.');
        } finally { if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; } notifyCollectFinished(); }
      })();
      return { status: 200, payload: { started: true } };
    }

    // --- Method: Scripted Playwright bot (deterministic, no LLM) -----------------------------
    if (method === 'scripted') {
      pushCollectLog('Launching the ThemeBot browser window…');
      collectTimer = setTimeout(() => stopCollector('failed', 'The scripted bot timed out.'), createStore || input.createIfUnreachable ? COLLECT_TIMEOUT_CREATE_MS : COLLECT_TIMEOUT_MS);
      try {
        collectScripted = runScriptedCollector({
          shop: shop ?? '', handleName, appName, projectLabel: projectName || handleName, scopes: AUTOPILOT_SCOPES,
          createStore, storeName: storeName || (input.createIfUnreachable ? projectName : ''),
          createIfUnreachable: input.createIfUnreachable,
          onShopUnreachable: (lost) => { void forgetCreatedStore(lost); },
          onShop: (createdShop, password) => {
            if (!password) void rememberCreatedStore(storeName || projectName, createdShop);
            collectTarget = { shop: createdShop, label: collectTarget?.label ?? (projectName || storeName) };
            if (password) collectStorefrontPassword = password;
          },
          // Default: ThemeBot's OWN Chrome profile (a separate window next to the user's everyday
          // Chrome — the user signs in to Shopify there once, it persists). The user's real profile
          // is opt-in only, because it requires closing every Chrome window (and ThemeBot's UI
          // itself runs in Chrome).
          useRealProfile: request.body?.useRealProfile === true,
          chromeProfile: String(request.body?.chromeProfile ?? '').trim() || undefined,
          profileDir: SCRIPT_PROFILE_DIR(),
          shotsDir: path.join(config.factory.workspaceRoot, '.factory', 'setup-shots'),
          log: pushCollectLog,
          onDone: async (result) => {
            if (collect.status === 'working') await persistDelivered(result.clientId, result.clientSecret, result.status, result.note);
            if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
            collectScripted = null;
            notifyCollectFinished();
          },
          onError: (message) => { if (collect.status === 'working') stopCollector('failed', message); notifyCollectFinished(); },
        });
      } catch (error) {
        stopCollector('failed', error instanceof Error ? error.message : 'Could not launch the scripted bot.');
        return { status: 500, payload: { error: collect.note } };
      }
      return { status: 200, payload: { started: true } };
    }

    // --- Method: LLM bot (default; spawns a Claude agent) --------------------------------------
    // 'llm'     → drives the USER'S Chrome through the Claude-in-Chrome extension (--chrome).
    // 'managed' → drives ThemeBot's OWN built-in browser through the local MCP endpoint, so the
    //             whole run is visible in the app's Browser view and the sign-in the user did
    //             there is what the bot rides on. Easy mode uses this and may create the store.
    const managed = method === 'managed';
    collectToken = newSecret(24);
    pushCollectLog(managed ? 'Bot process starting — the agent takes ~30s to boot before the built-in browser moves…' : 'Bot process starting — the agent takes ~30s to boot before Chrome moves…');
    const deliverUrl = `http://127.0.0.1:${config.port}/api/factory/collect-keys/deliver`;
    const overlayJs = `(()=>{if(document.getElementById('themebot-bot-overlay'))return;var s=document.createElement('style');s.textContent='@keyframes tbring{0%{transform:scale(.4);opacity:.9}100%{transform:scale(2.6);opacity:0}}';document.head.appendChild(s);var w=document.createElement('div');w.id='themebot-bot-overlay';w.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;border:4px solid #00a47c;box-shadow:inset 0 0 0 2000px rgba(0,164,124,.06),inset 0 0 80px rgba(0,164,124,.18)';var b=document.createElement('div');b.style.cssText='position:fixed;top:0;left:50%;transform:translateX(-50%);pointer-events:none;background:#00a47c;color:#fff;font:700 13px system-ui;padding:9px 18px;border-radius:0 0 10px 10px;box-shadow:0 4px 14px rgba(0,0,0,.3);max-width:92vw;text-align:center';b.textContent='🤖 ThemeBot started working in this tab — hands off. If a login appears, log in; the bot continues on its own.';var c=document.createElement('div');c.style.cssText='position:fixed;right:14px;bottom:14px;pointer-events:none;display:flex;align-items:center;gap:8px;background:rgba(10,25,20,.85);color:#7ef0c6;font:600 12px system-ui;padding:8px 14px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.35)';c.innerHTML='<span style="width:8px;height:8px;border-radius:50%;background:#00e69a;animation:tbring 1.4s ease-out infinite"></span>ThemeBot is driving this page…';w.appendChild(b);w.appendChild(c);document.documentElement.appendChild(w);var r=function(e){var d=document.createElement('div');d.style.cssText='position:fixed;left:'+(e.clientX-18)+'px;top:'+(e.clientY-18)+'px;width:36px;height:36px;border:3px solid #00e69a;border-radius:50%;pointer-events:none;animation:tbring .7s ease-out forwards';w.appendChild(d);setTimeout(function(){d.remove()},750)};document.addEventListener('mousedown',r,true)})()`;
    const pausedJs = `(()=>{var w=document.getElementById('themebot-bot-overlay');if(w&&w.firstChild){w.firstChild.style.background='#b45309';w.firstChild.textContent='⏸ ThemeBot is PAUSED — log in on this page; the bot resumes automatically once you are in.'}})()`;
    const toolRules = managed
      ? `Use ONLY the themebot-browser MCP tools (browser_navigate, browser_read_page, browser_click, browser_type, browser_screenshot, browser_evaluate, browser_back, browser_reload). They drive ThemeBot's built-in browser, which the user is watching live in the app. There is exactly one active tab — do not try to open new tabs; browser_navigate replaces the current page. "Run this JavaScript in the page" means browser_evaluate.`
      : `Use ONLY the claude-in-chrome browser MCP tools (load them via ToolSearch first if they are deferred). They drive the user's real, already-signed-in Chrome. "Run this JavaScript in the page" means the browser javascript tool.`;
    const speedRules = managed
      ? `SPEED RULES — the user is watching and waiting, so keep every step tight: (a) prefer browser_read_page to learn a page — take a screenshot only when the text is genuinely not enough (e.g. verifying a visual state or finding click coordinates). (b) Never take a screenshot just to confirm a click worked; read the page instead. (c) Navigate directly by URL when you already know the destination instead of clicking through menus. (d) Do not re-verify steps you already completed this run.`
      : `SPEED RULES — the user is watching and waiting, so keep every step tight: (a) prefer read_page / find / get_page_text to learn a page — take a screenshot only when the accessibility tree genuinely is not enough (e.g. verifying a visual state). (b) Never take a screenshot just to confirm a click worked; read the page instead. (c) Navigate directly by URL when you already know the destination instead of clicking through menus. (d) Chain independent actions with browser_batch where available. (e) Do not re-verify steps you already completed this run.`;
    const loginRule = `If a login or captcha page appears at ANY point, the user has to complete it themselves — do NOT fail and do NOT touch the login form. Instead: (a) say exactly this in your output so the app can alert the user: WAITING FOR LOGIN — please log in in the ${managed ? 'built-in browser (Browser tab in ThemeBot)' : 'Chrome window'}. (b) switch the banner to paused mode by running this JavaScript in the page: ${pausedJs} (c) then WAIT: re-check the page every ~20 seconds for up to 6 minutes until you are past the login, then continue. Only if it is still blocked after ~6 minutes, deliver status "failed" with note "not logged in" (final step) and stop.`;
    const storeSteps = createStore ? [
      `0. CREATE THE STORE FIRST (the user has no store yet). Wanted store name: "${storeName}". Open https://admin.shopify.com/ — this is the store picker for the signed-in account. ${loginRule}`,
      `0a. Look for a "Create store" / "Create another store" / "Add store" / "Start free trial" control and click it. Shopify then asks a few onboarding questions ("What do you want to sell?", "Where would you like to sell?", "Which of these best describes you?" and so on): pick the "Skip" / "Skip all" / "I'm just starting" option on every one of them. When it asks for the store name, type exactly "${storeName}". If it offers to pick a plan, a free trial with a card, or asks for ANY payment method, card, or billing details: click "Skip", "Skip for now", "Decide later", "Continue without a plan" or close the dialog — you must NEVER enter payment details. If a payment step has no way to skip at all, deliver status "failed" with note "Shopify required a payment method to create the store" and stop.`,
      `0a2. Shopify may never ask for a store name and may give the store a random name and a random <handle>.myshopify.com domain. That is fine: do NOT spend time renaming the store — the domain is what identifies it and the name is cosmetic. Go straight to step 0b.`,
      `0b. Wait for the store to finish being set up: the new store's admin home (a URL like https://admin.shopify.com/store/<handle>/...) must load without a "we're setting things up" screen. This can take 1–2 minutes — reload every ~15 seconds, up to 5 minutes.`,
      `0c. Read the store's real domain: the admin URL is https://admin.shopify.com/store/<handle>/... and the store domain is <handle>.myshopify.com (Shopify generates the handle — it is usually NOT the store name). Remember it as SHOP; every later step that mentions the store means this domain, and you MUST include it in the final delivery as "shop". If the store already existed (the picker shows a store named "${storeName}"), open it and read its handle the same way instead of creating a duplicate.`,
    ] : [];
    const shopLabel = createStore ? 'SHOP (the domain you read in step 0c)' : shop!;
    const prompt = [
      `You are ThemeBot's setup autopilot. The user is watching ${managed ? "ThemeBot's built-in browser" : 'their own Chrome window'} and has asked you to set up their Shopify ${createStore ? 'store and ' : ''}custom app end-to-end and fetch its credentials. Work autonomously, never wait for user input except for a login page (see the login rule).`,
      toolRules,
      speedRules,
      `Mission: ${createStore ? `create the Shopify store "${storeName}" (if it does not exist yet), then ` : ''}make sure a custom app with the right scopes exists in the Shopify Dev Dashboard, is released, and is installed on the store ${shopLabel} — then deliver its Client ID + Client Secret${createStore ? ' together with the store domain' : ''}.`,
      ...storeSteps,
      `1. ${managed ? 'Navigate' : 'Open a new tab'} to https://dev.shopify.com and get to the Dev Dashboard. ${loginRule}`,
      `1c. CRITICAL — verify the organization before creating anything: the Dev Dashboard opens on whichever organization was used last, which may be the WRONG one. Check the organization name (top-right switcher). Open the "Stores" section and check whether this organization owns the store whose DOMAIN is ${shopLabel}. Match stores by their .myshopify.com domain, NEVER by display name: owners rename stores freely and renaming never changes the domain, so the store may be listed under any name (possibly "${projectName || storeName || handleName}"). Do NOT type the handle into the store search box and trust an empty result — search boxes match display names, not domains. Instead clear any search filter, browse the FULL store list (check both Active and Inactive), and read each store's domain from the list or its details page. If the domain is not in this organization, open the org switcher (top-right) and repeat for the other organizations. ${createStore ? 'A store created minutes ago can take a little while to show up — if it is missing everywhere, wait 30 seconds and reload the Stores list, up to 5 times. ' : ''}If no organization owns it, deliver status "failed" with note "store ${shopLabel} not found in any Dev Dashboard organization" and stop. NEVER create an app in an organization that does not own the target store.`,
      `1b. Show the user you own the page: immediately after the first page loads, and again after EVERY full page navigation, run this exact JavaScript in the page. It draws a green control tint + banner + status chip, and pings a ripple ring at every click you make so the user can watch where you are working. Everything is pointer-events:none, so it never blocks your clicks, and the tint is light enough to never obscure your screenshots: ${overlayJs}`,
      `2. This run is for the project "${projectName || storeName || handleName}" targeting the store ${shopLabel}. If an app named "${appName}" already exists in the Apps list, open it and skip to step 5. Do NOT reuse apps with other names — each project gets its own app.`,
      `3. Click "Create app", name it exactly "${appName}", and create it.`,
      `4. Set the access scopes: open the app's version editor (Versions → New version, or the configuration shown after creation). The Access scopes card accepts a comma-separated list typed directly into its field ("Enter scopes as a comma-separated list") — enter: ${AUTOPILOT_SCOPES}. If typing into the field misbehaves, use the "Select scopes" link instead: it opens a checkbox dialog with a search box — search each scope name, tick it, then click Done. If the dashboard rejects specific scopes, drop the rejected ones and keep the rest (absolute minimum: write_themes,read_themes). Then click Release; in the "Release this new version?" dialog leave the name and message BLANK and click Release.`,
      `5. Install it on the store: from the app's Overview click "Install app", pick the store whose domain is ${shopLabel}, and on the consent page click Install. If it is already installed there, just continue. IMPORTANT: if "Install app" is disabled or the flow says the store needs a plan/subscription, do NOT go anywhere near billing, checkout, or payment pages — deliver status "partial" with note "store has no active plan — activate the $1 starter plan on the store, then run the bot again" and stop after step 6 if credentials are still readable.`,
      `6. Open the app's Settings tab and locate the Client ID and Client Secret. Click the reveal icon on the secret and read both values.`,
      ...(createStore ? [`6b. Read the storefront password: open https://admin.shopify.com/store/<handle>/online_store/preferences (use the handle from step 0c), find the "Password protection" / "Restrict access to visitors with the password" section and read the password shown there. Include it in the delivery as "storefrontPassword". If there is no password protection, omit it.`] : []),
      ...(createStore ? [`6c. Give the store its proper name (time-box: 2 minutes, at most two attempts). Open https://admin.shopify.com/store/<handle>/settings/general (handle from step 0c), find the store name field under "Store details" (it may sit behind an Edit / pencil control), set it to exactly "${storeName}", and save. If it does not work within two attempts, skip it — the name is cosmetic and must never delay the delivery.`] : []),
      `7. Typing is allowed ONLY for: ${createStore ? 'the store name and onboarding answers in steps 0 and 6c, ' : ''}the app name in step 3, the scopes list in step 4, and nothing else. Never change unrelated settings, never enter payment or billing details of any kind. Stay on dev.shopify.com / admin.shopify.com / accounts.shopify.com.`,
      `8. Deliver the result: run a Bash curl POST to ${deliverUrl} with header "x-collect-token: ${collectToken}" and JSON body {"clientId":"...","clientSecret":"...","status":"delivered"${createStore ? ',"shop":"<handle>.myshopify.com","storefrontPassword":"..."' : ''}}. If you could only get part of it, send what you have with status "partial" and a short "note" saying exactly which step failed${createStore ? ' (always include "shop" if the store exists)' : ''}. If nothing worked, send status "failed" with a "note". Never print the secret in your own output — it goes only into the curl body.`,
    ].join('\n');
    // Headless `claude -p` needs a trusted cwd with a scoped tool allowlist (same pattern as
    // clone workspaces): the collector gets ONLY the browser tools + curl for the delivery.
    const collectorRoot = path.join(config.factory.workspaceRoot, managed ? '_easy-autopilot' : '_key-collector');
    const mcpConfigPath = path.join(collectorRoot, 'mcp.json');
    try {
      await mkdir(path.join(collectorRoot, '.claude'), { recursive: true });
      await writeFile(path.join(collectorRoot, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['ToolSearch', 'Bash(curl:*)', managed ? 'mcp__themebot-browser' : 'mcp__claude-in-chrome'], deny: [] } }, null, 2) + '\n');
      if (managed) await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { 'themebot-browser': { type: 'http', url: `http://127.0.0.1:${config.port}/mcp-local` } } }, null, 2) + '\n');
      await trustWorkspace(collectorRoot);
    } catch (error) {
      collect = { ...collect, status: 'failed', finishedAt: Date.now(), note: error instanceof Error ? error.message : 'Could not prepare the collector workspace.', clientId: null, clientSecret: null };
      collectToken = null;
      return { status: 500, payload: { error: collect.note } };
    }
    try {
      // --chrome: the Claude-in-Chrome extension tools are session-scoped, not an MCP config
      // entry — without this flag a headless spawn has no browser tools at all. The managed
      // variant instead gets an --mcp-config pointing at the app's own /mcp-local endpoint.
      // stream-json + --verbose: incremental events feed the wizard's live activity panel.
      // Model: settings-driven (Settings → Models). Default opus — tested 2026-07-20:
      // sonnet refuses this mission outright (reads autonomous credential fetching from a
      // signed-in browser as harvesting, even with explicit owner-authorization framing in
      // the prompt); opus completes it reliably. Speed comes from the SPEED RULES in the
      // prompt (fewer screenshots, direct URLs, batched actions), not from the model tier.
      const collectorModel = (await getFactorySettings()).collectorModel;
      pushCollectLog(`Model: ${collectorModel}`);
      const browserArgs = managed ? ['--mcp-config', mcpConfigPath] : ['--chrome'];
      collectChild = spawn(config.factory.claudePath, ['-p', prompt, '--model', collectorModel, ...browserArgs, '--output-format', 'stream-json', '--verbose'], { cwd: collectorRoot, shell: false, windowsHide: true, detached: ownProcessGroup, env: buildSpawnEnv(await claudeEnv()) });
      let streamBuffer = '';
      collectChild.stdout?.on('data', (chunk: Buffer) => {
        streamBuffer += chunk.toString('utf8');
        const lines = streamBuffer.split('\n');
        streamBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const ev = collectEventText(line.trim()); if (ev) pushCollectLog(ev.text, ev.kind);
          if (line.includes('"type":"result"')) { try { void recordUsage(JSON.parse(line) as Record<string, unknown>, { kind: 'store setup', jobName: collectTarget?.label ?? 'Store setup', model: collectorModel }); } catch { /* partial line */ } }
        }
      });
      collectChild.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) pushCollectLog(text.split('\n')[0].slice(0, 140));
      });
    } catch (error) {
      collect = { ...collect, status: 'failed', finishedAt: Date.now(), note: error instanceof Error ? error.message : 'Could not launch the bot.', clientId: null, clientSecret: null };
      collectToken = null;
      return { status: 500, payload: { error: collect.note } };
    }
    collectChild.on('error', (error) => { stopCollector('failed', `Cannot launch ${config.factory.claudePath}: ${error.message}`); notifyCollectFinished(); });
    collectChild.on('exit', () => { if (collect.status === 'working') stopCollector('failed', managed ? 'The bot finished without delivering keys.' : 'The bot finished without delivering keys — copy them manually from the Chrome window.'); notifyCollectFinished(); });
    const budgetMs = createStore ? COLLECT_TIMEOUT_CREATE_MS : COLLECT_TIMEOUT_MS;
    collectTimer = setTimeout(() => { stopCollector('failed', `The bot timed out after ${budgetMs / 60_000} minutes.`); notifyCollectFinished(); }, budgetMs);
    void shopOrPending;
    return { status: 200, payload: { started: true } };
  };

  router.post('/collect-keys/start', handle(async (request, response) => {
    const body = request.body ?? {};
    // The wizard never creates stores — that is the easy-mode orchestrator's job (see /easy/start).
    const result = await startCollector({ ...body, createStore: false });
    response.status(result.status).json(result.payload);
  }));

  router.post('/collect-keys/deliver', handle(async (request, response) => {
    const token = String(request.headers['x-collect-token'] ?? '');
    if (!collectToken || !token || !secureEqual(token, collectToken)) { response.status(403).json({ error: 'Invalid collector token.' }); return; }
    const body = request.body as { clientId?: string; clientSecret?: string; status?: string; note?: string; shop?: string; storefrontPassword?: string };
    // Easy mode: the bot created the store and tells us its real domain (+ storefront password) here.
    const deliveredShop = normalizeShop(String(body.shop ?? ''));
    collectStorefrontPassword = typeof body.storefrontPassword === 'string' && body.storefrontPassword.trim() ? body.storefrontPassword.trim().slice(0, 120) : null;
    if (deliveredShop && collectTarget) collectTarget = { ...collectTarget, shop: deliveredShop };
    if (collectTarget && !collectTarget.shop) { pushCollectLog('The bot did not report which store it set up.'); }
    await persistDelivered(body.clientId, body.clientSecret, body.status, typeof body.note === 'string' ? body.note : null);
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
    collectToken = null;
    response.status(204).end();
    notifyCollectFinished();
  }));

  // Manual + bookmarklet durability: validate a client-supplied Client ID + Secret, persist an
  // encrypted saved store, and set delivered state. Loopback-only (no external caller should be
  // able to inject credentials). Distinct from /deliver, which is token-gated for the LLM bot.
  router.post('/keys/save', handle(async (request, response) => {
    if (!isLoopback(request)) { response.status(403).json({ error: 'Available on localhost only.' }); return; }
    const shop = normalizeShop(String(request.body?.storeUrl ?? ''));
    if (!shop) { response.status(422).json({ error: 'A valid *.myshopify.com store is required.' }); return; }
    const projectName = String(request.body?.projectName ?? '').trim();
    const handleName = shop.replace(/\.myshopify\.com$/i, '');
    // Reset any stale run state so the wizard's take-once handoff sees a fresh delivery.
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
    collectTarget = { shop, label: projectName || handleName };
    collect = { status: 'working', method: 'manual', startedAt: Date.now(), finishedAt: 0, note: null, clientId: null, clientSecret: null };
    const delivered = await persistDelivered(request.body?.clientId, request.body?.clientSecret, 'delivered', null);
    if (!delivered) { collect = { ...collect, status: 'failed', finishedAt: Date.now(), note: 'The Client ID or Secret was not in the expected format.' }; response.status(422).json({ error: collect.note }); return; }
    response.json({ ok: true });
  }));

  router.get('/collect-keys/status', handle(async (request, response) => {
    const take = String(request.query.take ?? '') === '1';
    const payload = {
      status: collect.status,
      method: collect.method,
      running: collect.status === 'working',
      elapsedSec: collect.status === 'working' ? Math.round((Date.now() - collect.startedAt) / 1000) : null,
      finishedAgoSec: collect.finishedAt ? Math.round((Date.now() - collect.finishedAt) / 1000) : null,
      note: collect.note,
      log: collectLog.slice(-14),
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
    notifyCollectFinished();
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
    collect = { status: 'idle', method: null, startedAt: 0, finishedAt: 0, note: null, clientId: null, clientSecret: null };
    collectLog = [];
    response.json({ ok: true, ...removed });
  }));

  // Sanity-check the QA scoring pipeline (Playwright + segmentation + alignment + scoring)
  // against a known-good pair BEFORE trusting job scores. Localhost-only like mint-token:
  // it spawns a local browser process, which has no business being reachable off-box.
  // With ThemeBot Cloud the scoring lives there: capture the fixture pair locally, the Cloud scores
  // it (needs a valid pass, like any Cloud call). Without it: the local calibrate.mjs.
  router.post('/qa-selftest', handle(async (request, response) => {
    if (!isLoopback(request)) { response.status(403).json({ error: 'The QA self-test is available on localhost only.' }); return; }
    if (qaSelftestRunning) { response.status(409).json({ error: 'A QA self-test is already running — wait for it to finish.' }); return; }
    if (cloudRequired) {
      const reason = buildsBlockedReason();
      if (reason) { response.status(403).json({ error: reason, code: 'THEMEBOT_SIGNIN_REQUIRED' }); return; }
      qaSelftestRunning = true;
      try { response.json(await runSelftestViaCloud()); } finally { qaSelftestRunning = false; }
      return;
    }
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
      // Shopify's token scope list omits read_x when write_x is granted (write implies read).
      const has = (scope: string) => scopes.includes(scope) || (scope.startsWith('read_') && scopes.includes(`write_${scope.slice(5)}`));
      const ok = REQUIRED_SCOPES.every(has);
      return {
        ok,
        shopName,
        ...(ok ? {} : { detail: `The app is installed but is missing permission: ${REQUIRED_SCOPES.filter((scope) => !has(scope)).join(', ')}.` }),
        scopes: {
          required: REQUIRED_SCOPES.map((scope) => ({ scope, granted: has(scope) })),
          recommended: RECOMMENDED_SCOPES.map((scope) => ({ scope, granted: has(scope) })),
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

  // =========================================================================================
  // Easy mode ("do it for me"): sign-in gate → create store + app (managed autopilot) → test
  // the keys → make sure there is a site to compare against → queue the clone. One run at a
  // time, in memory; the wizard polls /easy/status and renders the plain-English step list.
  // =========================================================================================
  type EasyStepId = 'signin' | 'store' | 'app' | 'keys' | 'test' | 'site' | 'clone';
  type EasyStepState = 'pending' | 'active' | 'done' | 'failed' | 'skipped';
  interface EasyStep { id: EasyStepId; label: string; state: EasyStepState; detail: string | null }
  interface EasyRun {
    id: string; phase: 'running' | 'needs_login' | 'done' | 'failed' | 'canceled';
    storeName: string; siteUrl: string | null; reactFilesPath: string | null; intakeId: string | null; qaEngine: string;
    shop: string | null; jobId: string | null; error: string | null; liveSiteId: string | null;
    steps: EasyStep[]; startedAt: number; updatedAt: number; canceled: boolean;
    /** 'scripted' (default): deterministic Playwright script in ThemeBot's own Chrome window.
     *  'llm': the Claude-in-Chrome AI bot — kept as an opt-in fallback. */
    method: 'scripted' | 'llm';
  }
  const EASY_STEPS: Array<{ id: EasyStepId; label: string }> = [
    { id: 'signin', label: 'Get the ThemeBot browser window ready' },
    { id: 'store', label: 'Create your Shopify store (no card needed)' },
    { id: 'app', label: 'Set up the connection between ThemeBot and your store' },
    { id: 'keys', label: 'Save the connection keys to your project' },
    { id: 'test', label: 'Test that ThemeBot can edit the store' },
    { id: 'site', label: 'Get your website ready to compare against' },
    { id: 'clone', label: 'Start building your Shopify theme' },
  ];
  let easy: EasyRun | null = null;
  const easyStep = (id: EasyStepId) => easy!.steps.find((step) => step.id === id)!;
  const setEasyStep = (id: EasyStepId, state: EasyStepState, detail: string | null = null) => {
    if (!easy) return;
    const step = easyStep(id); step.state = state; step.detail = detail; easy.updatedAt = Date.now();
  };
  const failEasy = (id: EasyStepId, message: string) => {
    if (!easy) return;
    setEasyStep(id, 'failed', message);
    easy.phase = 'failed'; easy.error = message; easy.updatedAt = Date.now();
  };
  const waitForCollector = () => new Promise<CollectState>((resolve) => { onCollectFinished = resolve; });

  /** While the autopilot runs, infer which visible step it is on from its redacted log. */
  const syncEasyFromCollector = () => {
    if (!easy || easy.phase !== 'running' || collect.status !== 'working') return;
    const text = collectLog.map((entry) => entry.text).join('\n');
    const onDevDashboard = /dev\.shopify|Dev Dashboard|Create app|scopes|Release|Install app/i.test(text);
    if (onDevDashboard && easyStep('store').state === 'active') { setEasyStep('store', 'done', 'Store is ready.'); setEasyStep('app', 'active', 'Creating the app and installing it on your store…'); }
    if (/WAITING FOR LOGIN/i.test(text)) { const active = easy.steps.find((step) => step.state === 'active'); if (active) active.detail = easy.method === 'scripted' ? 'Paused — please sign in to Shopify in the ThemeBot window (first time only). It continues by itself once you are in.' : 'Paused — please sign in to Shopify in the Chrome window the bot opened. The bot continues by itself once you are in.'; }
  };

  const runEasy = async (run: EasyRun) => {
    const alive = () => easy?.id === run.id && !run.canceled;
    try {
      // 1. Readiness gate — the autopilot drives the USER'S real Chrome through the Claude
      // extension (trusted by Shopify, already signed in), so what we can verify is: Chrome
      // present, extension present, and the one-time setup confirmed by the user.
      const engines = detectEngines();
      const chromeOk = engines.some((engine) => (engine.id === 'chrome' || engine.id === 'msedge') && engine.available);
      if (run.method === 'scripted') {
        // The script drives ThemeBot's OWN Chrome profile (a separate window) — no extension, no
        // AI, and the user's everyday Chrome stays open. First run: sign in to Shopify there once.
        setEasyStep('signin', 'done', chromeOk ? 'ThemeBot opens its own Chrome window. First time only: sign in to Shopify there when it asks.' : 'ThemeBot opens its own browser window. First time only: sign in to Shopify there when it asks.');
      }
      if (run.method === 'llm') setEasyStep('signin', 'active', 'Checking Chrome and the Claude extension…');
      const extensionOk = run.method === 'scripted' || resolveExtensions().some((extension) => extension.isClaude);
      const setupDone = run.method === 'scripted' || (await getFactorySettings()).browserQaSetup.done;
      if (!alive()) return;
      if (!chromeOk && run.method === 'llm' || !extensionOk || !setupDone) {
        const missing = !chromeOk ? 'Google Chrome is not installed on this computer.' : !extensionOk ? 'The Claude for Chrome extension is not installed.' : 'The one-time Chrome setup has not been confirmed yet.';
        setEasyStep('signin', 'failed', `${missing} Finish the Chrome setup on the previous screen, then press Continue.`);
        run.phase = 'needs_login'; run.updatedAt = Date.now();
        return;
      }
      if (run.method === 'llm') setEasyStep('signin', 'done', 'Chrome and the Claude extension are ready.');

      // 2. Store + app + keys — one autopilot run in the user's own Chrome.
      // A previous attempt may already have created the store (its domain was seen in the bot's
      // log): skip straight to the app setup against that domain instead of creating a duplicate.
      let started;
      const alreadySaved = run.shop ? (await db.listFactoryStores()).find((store) => store.shop_domain === run.shop) : null;
      let reused: { clientId: string; clientSecret: string; storefrontPassword: string | null } | null = null;
      if (alreadySaved) {
        try { reused = { clientId: alreadySaved.client_id, clientSecret: decrypt(alreadySaved.client_secret_cipher), storefrontPassword: alreadySaved.storefront_password_cipher ? decrypt(alreadySaved.storefront_password_cipher) : null }; } catch { reused = null; }
      }
      if (reused) {
        setEasyStep('store', 'done', `Store already exists: ${run.shop}`);
        setEasyStep('app', 'done', 'Connection app already installed.');
        setEasyStep('keys', 'done', 'Keys already saved from an earlier run.');
        started = { status: 200, payload: {} } as { status: number; payload: Record<string, unknown> };
      } else if (run.shop) {
        setEasyStep('store', 'done', `Store already exists: ${run.shop}`);
        setEasyStep('app', 'active', 'Creating the app and installing it on your store…');
        started = await startCollector({ method: run.method, storeUrl: run.shop, projectName: run.storeName, createIfUnreachable: true });
      } else {
        setEasyStep('store', 'active', run.method === 'scripted'
          ? `Creating "${run.storeName}" on Shopify in the ThemeBot window… (pressing Skip on every payment step)`
          : `Creating "${run.storeName}" on Shopify in your Chrome… (skipping every payment step)`);
        started = await startCollector({ method: run.method, createStore: true, storeName: run.storeName, projectName: run.storeName });
      }
      if (started.status !== 200) { failEasy('store', String(started.payload.error ?? 'Could not start the setup bot.')); return; }
      const outcome = reused
        ? ({ status: 'delivered', clientId: reused.clientId, clientSecret: reused.clientSecret, note: null } as unknown as CollectState)
        : await waitForCollector();
      if (!alive()) return;
      const shop = reused ? run.shop : (collectTarget?.shop || null);
      if (outcome.status !== 'delivered' || !outcome.clientId || !outcome.clientSecret || !shop) {
        const note = outcome.note ?? 'The setup bot could not finish.';
        if (/not logged in/i.test(note)) { setEasyStep(easy!.steps.find((step) => step.state === 'active')?.id ?? 'store', 'failed', run.method === 'scripted' ? 'First time only: ThemeBot needs your Shopify sign-in. Press "Open the sign-in window", sign in there (Google works), close the window, then press Continue.' : 'Shopify asked for a sign-in and nobody signed in. Sign in to Shopify in your Chrome window, then press Continue.'); run.phase = 'needs_login'; run.updatedAt = Date.now(); return; }
        // Remember a store the bot managed to create before it stopped, so Continue can pick up
        // from the app setup instead of creating a second store.
        if (!run.shop && collectTarget?.shop) { run.shop = collectTarget.shop; setEasyStep('store', 'done', `Store created: ${run.shop}`); }
        if (!run.shop) {
          const seen = collectLog.map((entry) => entry.text).join('\n').match(/\b([a-z0-9]+(?:-[a-z0-9]+)*\.myshopify\.com)\b/i);
          if (seen) { run.shop = seen[1].toLowerCase(); setEasyStep('store', 'done', `Store created: ${run.shop}`); }
        }
        failEasy(easyStep('store').state === 'done' ? 'app' : 'store', run.shop ? `${note} The store ${run.shop} exists — press Continue to pick up from the app setup.` : note);
        return;
      }
      run.shop = shop;
      setEasyStep('store', 'done', `Store: ${shop}`);
      setEasyStep('app', 'done', 'Connection app created and installed.');
      setEasyStep('keys', 'done', 'Keys saved (encrypted) — they are written to your project when the clone starts.');
      const clientId = outcome.clientId; const clientSecret = outcome.clientSecret; const storefrontPassword = reused ? reused.storefrontPassword : collectStorefrontPassword;
      // Keys were handed to us in-process; wipe the collector's copy like ?take=1 does.
      collect = { ...collect, clientId: null, clientSecret: null };

      // 3. Prove the keys work (token mint + scope check + harmless write/delete on the main theme).
      setEasyStep('test', 'active', 'Doing a tiny test edit on the store…');
      const check = await checkStoreCredentials(shop, clientId, clientSecret, true);
      if (!alive()) return;
      if (!check.ok) { failEasy('test', check.detail ?? 'The store connection test failed.'); return; }
      const push = 'push' in check ? check.push : undefined;
      setEasyStep('test', 'done', push?.ok ? 'Connected and edit test passed.' : `Connected. ${push?.detail ?? ''}`.trim());

      // 4. A site to compare against: the link the user gave, or their project served locally.
      let reactUrl = run.siteUrl;
      if (reactUrl) {
        setEasyStep('site', 'done', `Comparing against ${reactUrl}`);
      } else if (run.reactFilesPath) {
        setEasyStep('site', 'active', 'Starting your project on this computer so ThemeBot can compare against it…');
        const preview = startPreview({ path: run.reactFilesPath }, true);
        run.liveSiteId = preview.id;
        const finished = await awaitPreview(preview.id);
        if (!alive()) return;
        if (finished.phase !== 'done' || !finished.url) { failEasy('site', finished.error ?? 'Your project could not be started.'); return; }
        reactUrl = finished.url;
        setEasyStep('site', 'done', `Your project is running at ${reactUrl} (kept running for the clone).`);
      } else {
        failEasy('site', 'Nothing to clone from — add a website link or upload your project.'); return;
      }

      // 5. Queue the clone job through the exact same path the expert wizard uses.
      setEasyStep('clone', 'active', 'Preparing the workspace…');
      const result = await intakeJob({ name: run.storeName, reactUrl, storeUrl: shop, clientId, clientSecret, storefrontPassword: storefrontPassword ?? undefined, reactFilesPath: run.reactFilesPath ?? undefined, qaEngine: run.qaEngine } as JobIntake);
      if (!alive()) return;
      if (result.status !== 201) { failEasy('clone', String(result.payload.error ?? 'The clone could not be started.')); return; }
      const job = result.payload.job as { id: string };
      run.jobId = job.id;
      setEasyStep('clone', 'done', 'Your theme is being built — follow it on the Dashboard.');
      run.phase = 'done'; run.updatedAt = Date.now();
    } catch (error) {
      if (!alive()) return;
      const active = run.steps.find((step) => step.state === 'active')?.id ?? 'clone';
      failEasy(active, error instanceof Error ? error.message : String(error));
    }
  };

  const publicEasy = (run: EasyRun | null) => {
    if (!run) return { run: null, collector: { running: false, log: [] as typeof collectLog } };
    syncEasyFromCollector();
    return { run: { ...run }, collector: { running: collect.status === 'working', log: collectLog.slice(-10) } };
  };

  // --- Sign-in gate ---
  router.get('/shopify-login', handle(async (request, response) => {
    response.json(await checkShopifyLogin(String(request.query.fresh ?? '') === '1'));
  }));
  router.post('/shopify-login/open', handle(async (_request, response) => {
    try { response.json({ ok: true, browser: await openShopifySignIn() }); }
    catch (error) { response.status(500).json({ error: `Could not open the built-in browser: ${error instanceof Error ? error.message : 'unknown error'}` }); }
  }));

  // --- Project intake (zip upload / folder inspect / preview) ---
  router.post('/intake/upload', rawBody({ type: () => true, limit: '800mb' }), handle(async (request, response) => {
    const buffer = request.body as Buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) { response.status(422).json({ error: 'No file received.' }); return; }
    const name = String(request.query.name ?? 'upload.zip');
    if (!/\.zip$/i.test(name)) { response.status(422).json({ error: 'Please upload a .zip file of your project.' }); return; }
    try {
      const result = await ingestUpload(buffer, name);
      response.status(201).json({ intakeId: result.intakeId, reactFilesPath: result.reactFilesPath, info: result.info });
    } catch (error) {
      response.status(422).json({ error: error instanceof Error ? error.message : 'The zip could not be read.' });
    }
  }));
  router.post('/intake/inspect', handle(async (request, response) => {
    const target = String(request.body?.path ?? '').trim();
    if (!target || !(await fileExists(target))) { response.status(422).json({ error: 'Folder not found.' }); return; }
    try { response.json({ reactFilesPath: target, info: await inspectProject(target) }); }
    catch (error) { response.status(422).json({ error: error instanceof Error ? error.message : 'Could not read the project.' }); }
  }));
  router.post('/intake/preview', handle(async (request, response) => {
    const sourcePath = request.body?.path ? String(request.body.path) : undefined;
    const url = request.body?.url ? String(request.body.url) : undefined;
    if (sourcePath && !(await fileExists(sourcePath))) { response.status(422).json({ error: 'Project folder not found.' }); return; }
    if (url) { try { const parsed = new URL(url); if (!/^https?:$/.test(parsed.protocol)) throw new Error(); } catch { response.status(422).json({ error: 'The website link must start with http:// or https://' }); return; } }
    if (!sourcePath && !url) { response.status(422).json({ error: 'Give a website link or upload a project first.' }); return; }
    response.status(202).json({ preview: publicPreview(startPreview({ path: sourcePath, url })) });
  }));
  router.get('/intake/preview/:id', handle(async (request, response) => {
    const run = getPreview(String(request.params.id));
    if (!run) { response.status(404).json({ error: 'Preview not found.' }); return; }
    response.json({ preview: publicPreview(run) });
  }));
  router.get('/intake/preview/:id/screenshot', handle(async (request, response) => {
    const run = getPreview(String(request.params.id));
    if (!run?.screenshotPath) { response.status(404).json({ error: 'No screenshot yet.' }); return; }
    response.setHeader('Cache-Control', 'no-store');
    response.type('png').send(await readFile(run.screenshotPath));
  }));
  router.post('/intake/preview/:id/stop', handle(async (request, response) => {
    response.json({ stopped: stopPreview(String(request.params.id)) });
  }));

  // --- Easy-mode run ---
  router.post('/easy/start', handle(async (request, response) => {
    if (passMissing(response)) return;
    if (easy && easy.phase === 'running') { response.status(409).json({ error: 'A setup is already running — wait for it to finish or cancel it first.' }); return; }
    if (collect.status === 'working') { response.status(409).json({ error: 'The key collector is busy — stop it in the wizard first.' }); return; }
    const storeName = String(request.body?.storeName ?? '').trim();
    if (storeName.length < 2) { response.status(422).json({ error: 'Give your store a name (at least 2 characters).' }); return; }
    if (rightsMissing(request.body)) { response.status(422).json({ error: "Confirm that you own this website or have the owner's permission before building." }); return; }
    void recordRights(String(request.body?.siteUrl ?? request.body?.reactFilesPath ?? ''), String(request.body?.shop ?? storeName));
    let siteUrl: string | null = null;
    if (request.body?.siteUrl) {
      try { const parsed = new URL(String(request.body.siteUrl)); if (!/^https?:$/.test(parsed.protocol)) throw new Error(); siteUrl = parsed.toString().replace(/\/$/, ''); }
      catch { response.status(422).json({ error: 'The website link must start with http:// or https://' }); return; }
    }
    const reactFilesPath = request.body?.reactFilesPath ? String(request.body.reactFilesPath) : null;
    if (reactFilesPath && !(await fileExists(reactFilesPath))) { response.status(422).json({ error: 'The uploaded project could not be found — upload it again.' }); return; }
    if (!siteUrl && !reactFilesPath) { response.status(422).json({ error: 'Add a website link or upload your project (or both).' }); return; }
    forgetLoginStatus();
    const qaEngine = ['playwright', 'headed', 'chrome'].includes(String(request.body?.qaEngine)) ? String(request.body.qaEngine) : 'playwright';
    // Optional: a store the user (or an earlier attempt) already created — skip store creation.
    const newStore = request.body?.newStore === true;
    if (newStore) { const old = await findCreatedStore(storeName); if (old) await forgetCreatedStore(old); }
    const knownShop = newStore ? null : (request.body?.shop ? normalizeShop(String(request.body.shop)) : null) ?? await findCreatedStore(storeName);
    easy = {
      id: newSecret(8), phase: 'running', storeName, siteUrl, reactFilesPath, intakeId: request.body?.intakeId ? String(request.body.intakeId) : null, qaEngine,
      shop: knownShop, jobId: null, error: null, liveSiteId: null, canceled: false,
      method: request.body?.method === 'llm' ? 'llm' : 'scripted',
      steps: EASY_STEPS.map((step) => ({ ...step, state: 'pending', detail: null })), startedAt: Date.now(), updatedAt: Date.now(),
    };
    void runEasy(easy);
    response.status(202).json(publicEasy(easy));
  }));
  router.get('/easy/status', handle(async (_request, response) => { response.json(publicEasy(easy)); }));
  /** After the user signs in: re-run the same inputs from the top (finished steps are cheap to redo). */
  router.post('/easy/resume', handle(async (request, response) => {
    if (passMissing(response)) return;
    if (!easy || (easy.phase !== 'needs_login' && easy.phase !== 'failed' && easy.phase !== 'canceled')) { response.status(409).json({ error: 'Nothing is waiting to be continued.' }); return; }
    if (collect.status === 'working') { response.status(409).json({ error: 'The setup bot is still running.' }); return; }
    forgetLoginStatus();
    const method = request.body?.method === 'llm' ? 'llm' : request.body?.method === 'scripted' ? 'scripted' : easy.method;
    easy = { ...easy, method, id: newSecret(8), phase: 'running', error: null, canceled: false, steps: EASY_STEPS.map((step) => ({ ...step, state: 'pending', detail: null })), updatedAt: Date.now() };
    void runEasy(easy);
    response.status(202).json(publicEasy(easy));
  }));
  router.post('/easy/cancel', handle(async (_request, response) => {
    if (!easy) { response.json({ canceled: false }); return; }
    easy.canceled = true;
    if (easy.phase === 'running' || easy.phase === 'needs_login') { easy.phase = 'canceled'; easy.updatedAt = Date.now(); }
    if (collect.status === 'working') { stopCollector('failed', 'Stopped by user.'); notifyCollectFinished(); }
    if (easy.liveSiteId && !easy.jobId) stopPreview(easy.liveSiteId);
    response.json({ canceled: true, ...publicEasy(easy) });
  }));
  router.post('/easy/dismiss', handle(async (_request, response) => {
    if (easy && easy.phase !== 'running') easy = null;
    response.json({ ok: true });
  }));

  return router;
}
