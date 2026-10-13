// Admin security API (Authorization: Bearer ADMIN_TOKEN):
//
//   GET  /v1/admin/security/flags[?hours=24&account=]   anomaly flags, worst accounts first
//   GET  /v1/admin/security/events[?account=&hours=&limit=]   recent security events
//   POST /v1/admin/security/leak  {"text": "…"} or a text/plain body   who received a leaked text
//
// registerSecurityRoutes() mounts this with its own body parser (leaked texts can be large), so
// call it BEFORE the app's global `express.json({ limit: '16kb' })`, next to the webhooks line.
import express, { Router, type Express } from 'express';
import { CloudError, handle, iso, type CloudContext } from '../context';
import { requireAdmin } from '../middleware';
import { limitByIp } from '../rate-limit';
import { analyzeLeak, ensureWatermarkSchema } from '../watermark';
import { ensureSecuritySchema, securityEvents } from './events';
import { computeSecurityFlags } from './flags';

const MAX_LEAK_BYTES = '1mb';

const hoursFrom = (value: unknown, fallback: number) => {
  const hours = Number(value);
  return Number.isFinite(hours) && hours > 0 ? Math.min(24 * 30, hours) : fallback;
};

export function securityRouter(ctx: CloudContext) {
  const router = Router();
  router.use(limitByIp(ctx, 'admin-security', 120, 60_000), requireAdmin(ctx));
  // After the admin check: nobody else gets a large body parsed.
  router.use(express.json({ limit: MAX_LEAK_BYTES }), express.text({ type: 'text/plain', limit: MAX_LEAK_BYTES }));

  router.get('/flags', handle((request, response) => {
    const accountId = typeof request.query.account === 'string' && request.query.account ? request.query.account : undefined;
    response.json(computeSecurityFlags(ctx, { hours: hoursFrom(request.query.hours, 24), accountId }));
  }));

  router.get('/events', handle((request, response) => {
    const accountId = typeof request.query.account === 'string' && request.query.account ? request.query.account : undefined;
    const since = ctx.now() - hoursFrom(request.query.hours, 24 * 7) * 60 * 60_000;
    const rows = securityEvents(ctx.db, { accountId, since, limit: Number(request.query.limit) || 200 });
    response.json({ events: rows.map((row) => ({ id: row.id, at: iso(row.at), account: row.account_id, device: row.device_id, kind: row.kind, network: row.ip_prefix })) });
  }));

  router.post('/leak', handle((request, response) => {
    const body = request.body as unknown;
    const text = typeof body === 'string' ? body : body && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string' ? (body as { text: string }).text : '';
    if (!text.trim()) throw new CloudError(400, 'BAD_REQUEST', 'Send the leaked text as {"text": "…"} or as a text/plain body.');
    const limit = Math.min(50, Math.max(1, Number((body as { limit?: unknown })?.limit) || 10));
    const report = analyzeLeak(text, ctx.db, { limit });
    // Never store the text itself.
    ctx.db.audit(ctx.now(), 'admin', 'security.leak_checked', report.candidates[0]?.accountId ?? null, { chars: text.length, candidates: report.candidates.length, topConfidence: report.candidates[0]?.confidence ?? 0 });
    response.json(report);
  }));

  return router;
}

/** Creates the security + watermark tables and mounts the admin security routes. */
export function registerSecurityRoutes(app: Express, ctx: CloudContext) {
  ensureSecuritySchema(ctx.db);
  ensureWatermarkSchema(ctx.db);
  app.use('/v1/admin/security', securityRouter(ctx));
}
