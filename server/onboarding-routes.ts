// Onboarding routes — Claude connection + workspace selection + progress feed.
// LOCAL OPERATOR TOOL: 404 in production, 403 for non-loopback callers (same posture as the
// integrated terminal/browser). Mounted BEFORE the session-gated /api router.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from './config';
import { disconnectClaude, getClaudeStatus, getClaudeStatusQuick, reconnectCli, setApiKey, startLogin } from './claude-connect';
import { browse, getWorkspaceState, recentWorkspaces, refreshWorkspace, selectWorkspace, clearActiveWorkspace } from './workspace';
import { progressSnapshot } from './progress';

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
  router.post('/workspace/select', handle(async (request, response) => {
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
