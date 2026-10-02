// Onboarding routes — Claude connection + workspace selection + progress feed.
// LOCAL OPERATOR TOOL: 404 in production, 403 for non-loopback callers (same posture as the
// integrated terminal/browser). Mounted BEFORE the session-gated /api router.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from './config';
import { disconnectClaude, getClaudeStatus, getClaudeStatusQuick, reconnectCli, setApiKey, startLogin } from './claude-connect';
import { browse, getWorkspaceState, recentWorkspaces, refreshWorkspace, selectWorkspace, clearActiveWorkspace } from './workspace';
import { progressSnapshot } from './progress';
import { retakeThumb, savedThumb, thumbKey, thumbStatuses, type ThumbSource } from './project-thumbs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { db } from './db';

function requireLocalDev(request: Request, response: Response, next: NextFunction) {
  if (config.production) { response.status(404).json({ error: 'Not available in production.' }); return; }
  const hostname = (value: string | undefined) => { if (!value) return null; try { return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase(); } catch { return null; } };
  const loop = (name: string | null) => name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]';
  const ok = loop(hostname(request.headers.host)) && (request.headers.origin == null || loop(hostname(request.headers.origin as string)));
  if (!ok) { response.status(403).json({ error: 'Available on localhost only.' }); return; }
  next();
}

const handle = (fn: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction) => { fn(request, response).catch(next); };

export function createOnboardingRouter() {
  const router = Router();
  // Scope the gate to OUR paths only — this router is mounted at /api and other /api/*
  // requests must fall through to the main router untouched (esp. in production).
  router.use(['/claude', '/workspace', '/onboarding'], requireLocalDev);

  // ---- Claude connection ----
  router.get('/claude/status', handle(async (request, response) => {
    response.json(await getClaudeStatus(request.query.force === '1'));
  }));
  // Minimal probe-free summary for the main app's Connections UI (same localhost/dev gate
  // as the rest of this router — scoped by the '/claude' prefix above). No paths/secrets.
  router.get('/claude/summary', handle(async (_request, response) => {
    const status = await getClaudeStatusQuick().catch(() => null);
    response.json({ connected: Boolean(status?.connected), method: status?.method ?? null });
  }));
  router.post('/claude/login', handle(async (_request, response) => {
    response.json(await startLogin());
  }));
  router.post('/claude/use-cli', handle(async (_request, response) => {
    response.json(await reconnectCli());
  }));
  router.post('/claude/api-key', handle(async (request, response) => {
    const key = typeof request.body?.key === 'string' ? request.body.key : '';
    const result = await setApiKey(key);
    response.status(result.connected ? 200 : 400).json(result);
  }));
  router.post('/claude/disconnect', handle(async (_request, response) => {
    await disconnectClaude();
    response.json({ disconnected: true });
  }));

  // ---- Workspace ----
  router.get('/workspace/browse', handle(async (request, response) => {
    try { response.json(await browse(typeof request.query.path === 'string' ? request.query.path : undefined)); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Browse failed.' }); }
  }));
  router.get('/workspace/state', handle(async (_request, response) => {
    response.json({ ...(await getWorkspaceState()), recents: await recentWorkspaces() });
  }));
  // ---- Homepage pictures (taken by the server in the background; pages only read them) ----
  // Every project in the workspace plus every ThemeBot build folder, with the URL to picture:
  // the website first, else the store. Bare domains get https://; notes like "(stale domain)" are skipped.
  const asUrl = (value: string) => { const text = (value ?? '').trim(); if (!text || /\s/.test(text)) return ''; const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`; try { return new URL(withScheme).href; } catch { return ''; } };
  const thumbSources = async (): Promise<{ workspace: string | null; sources: ThumbSource[] }> => {
    const state = await getWorkspaceState();
    if (!state.path) return { workspace: null, sources: [] };
    const byKey = new Map<string, ThumbSource>();
    for (const project of state.projects) byKey.set(thumbKey(project.path), { path: project.path, url: asUrl(project.reactUrl) || asUrl(project.storeUrl) });
    for (const job of await db.listFactoryJobs().catch(() => [])) {
      if (job.workspace_path && !byKey.has(thumbKey(job.workspace_path))) byKey.set(thumbKey(job.workspace_path), { path: job.workspace_path, url: asUrl(job.react_url) || asUrl(job.store_url) });
    }
    return { workspace: state.path, sources: [...byKey.values()] };
  };
  const warmThumbs = async () => { const { workspace, sources } = await thumbSources(); if (workspace) await thumbStatuses(workspace, sources); };
  // At startup, then every 6 hours: take missing pictures and refresh week-old ones.
  setTimeout(() => { void warmThumbs().catch(() => {}); }, 8_000).unref?.();
  setInterval(() => { void warmThumbs().catch(() => {}); }, 6 * 60 * 60 * 1000).unref?.();

  router.get('/workspace/thumbs', handle(async (_request, response) => {
    const { workspace, sources } = await thumbSources();
    response.json({ thumbs: workspace ? await thumbStatuses(workspace, sources) : {} });
  }));
  router.get('/workspace/thumb', handle(async (request, response) => {
    const state = await getWorkspaceState();
    const wanted = String(request.query.path ?? '');
    const file = state.path && wanted ? await savedThumb(state.path, wanted) : null;
    if (!file) { response.status(404).end(); return; }
    // The URL carries the picture's version (?v=), so the browser may keep it for a week.
    response.setHeader('Cache-Control', request.query.v ? 'private, max-age=604800, immutable' : 'no-cache');
    response.sendFile(file, { dotfiles: 'allow' });
  }));
  router.post('/workspace/thumb/retake', handle(async (request, response) => {
    const { workspace, sources } = await thumbSources();
    const source = sources.find((entry) => thumbKey(entry.path) === thumbKey(String(request.body?.path ?? '')));
    if (!workspace || !source) { response.status(404).json({ error: 'Project not found.' }); return; }
    if (!retakeThumb(workspace, source)) { response.status(422).json({ error: 'This project has no website address to picture.' }); return; }
    response.json({ ok: true });
  }));
  // Open a project's folder in the file explorer (only folders of the active workspace).
  router.post('/workspace/open-folder', handle(async (request, response) => {
    const state = await getWorkspaceState();
    const wanted = String(request.body?.path ?? '');
    const same = (a: string) => path.resolve(a).toLowerCase() === path.resolve(wanted).toLowerCase();
    // A workspace project, or the folder of one of ThemeBot's own builds (those can sit outside the list).
    const project = state.projects.find((entry) => same(entry.path))
      ?? (wanted ? (await db.listFactoryJobs()).map((job) => ({ path: job.workspace_path })).find((entry) => same(entry.path)) : undefined);
    if (!project) { response.status(404).json({ error: 'Project not found.' }); return; }
    const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(opener, [project.path], { detached: true, stdio: 'ignore', shell: false });
    child.on('error', () => { /* nothing to open with */ });
    child.unref();
    response.json({ ok: true });
  }));
  router.post('/workspace/select',handle(async (request, response) => {
    const target = typeof request.body?.path === 'string' ? request.body.path : '';
    try {
      const { state, returning } = await selectWorkspace(target, { create: request.body?.create === true });
      response.json({ workspace: state, returning });
    } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Could not select that folder.' }); }
  }));
  router.post('/workspace/rescan', handle(async (request, response) => {
    void refreshWorkspace(request.body?.force !== false).catch(() => {});
    response.json({ started: true });
  }));
  router.post('/workspace/close', handle(async (_request, response) => {
    await clearActiveWorkspace();
    response.json({ closed: true });
  }));

  // ---- Progress feed ----
  router.get('/onboarding/progress', handle(async (request, response) => {
    response.json(progressSnapshot(Number(request.query.since ?? 0) || 0));
  }));

  return router;
}
