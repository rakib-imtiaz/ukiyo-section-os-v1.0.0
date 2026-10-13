// Operator API (Authorization: Bearer ADMIN_TOKEN): accounts and their devices, comp/test
// accounts, revoke/restore, freeing a seat, billing conflicts (another purchase under an account's
// email, held by the webhook), and settings (minimum app version, variant seats).
import { Router } from 'express';
import { accountUsable } from './accounts';
import { CloudError, bodyOf, handle, iso, normalizeEmail, type CloudContext } from './context';
import type { AccountPatch, AccountRow } from './db';
import { deviceActive, minAppVersion, signOutDevice } from './devices';
import { requireAdmin } from './middleware';
import { limitByIp } from './rate-limit';
import { recordSecurityEvent } from './security/events';
import { isVersion } from './version';
import { accountsWithConflicts, conflictView, openConflicts, productAllowlist, resolveConflict } from './webhooks';

function adminAccount(ctx: CloudContext, account: AccountRow) {
  const now = ctx.now();
  return {
    id: account.id, email: account.email, plan: account.plan, seats: account.seats,
    status: account.status, usable: accountUsable(account, now), expiresAt: iso(account.expires_at), source: account.source,
    lemonSqueezy: { customerId: account.ls_customer_id, subscriptionId: account.ls_subscription_id, orderId: account.ls_order_id, variantId: account.ls_variant_id, status: account.ls_status },
    /** Other purchases under this email that still give access but the account doesn't follow. */
    billingConflicts: openConflicts(ctx, account, now).map(conflictView),
    createdAt: iso(account.created_at), updatedAt: iso(account.updated_at),
    devices: ctx.db.devicesForAccount(account.id).map((device) => ({
      id: device.id, name: device.name, platform: device.platform, appVersion: device.app_version,
      active: deviceActive(device, now), signedOut: device.signed_out_at != null,
      lastSeen: iso(device.last_seen_at || null), createdAt: iso(device.created_at), passesIssued: device.passes_issued,
    })),
  };
}

function parseExpiry(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new CloudError(400, 'BAD_REQUEST', 'expiresAt must be an ISO date or null.');
  return parsed;
}

function parseSeats(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const seats = Number(value);
  if (!Number.isInteger(seats) || seats < 1 || seats > 1000) throw new CloudError(400, 'BAD_REQUEST', 'seats must be a whole number from 1 to 1000.');
  return seats;
}

export function adminRouter(ctx: CloudContext) {
  const router = Router();
  router.use(limitByIp(ctx, 'admin', 120, 60_000), requireAdmin(ctx));

  const accountOr404 = (id: string) => {
    const account = ctx.db.accountById(id);
    if (!account) throw new CloudError(404, 'NOT_FOUND', 'No such account.');
    return account;
  };

  /** GET /v1/admin/accounts[?email=] → { accounts: [...] } with each account's devices. */
  router.get('/accounts', handle((request, response) => {
    const email = typeof request.query.email === 'string' ? normalizeEmail(request.query.email) : null;
    const rows = email ? [ctx.db.accountByEmail(email)].filter((row): row is AccountRow => row != null) : ctx.db.listAccounts();
    response.json({ accounts: rows.map((row) => adminAccount(ctx, row)) });
  }));

  /** POST /v1/admin/accounts { email, plan?, seats?, expiresAt? } — creates, or updates by email. */
  router.post('/accounts', handle((request, response) => {
    const body = bodyOf(request);
    const email = normalizeEmail(body.email);
    if (!email) throw new CloudError(400, 'BAD_REQUEST', 'A valid email is required.');
    const plan = body.plan === undefined ? undefined : String(body.plan).trim().slice(0, 60);
    if (plan === '') throw new CloudError(400, 'BAD_REQUEST', 'plan cannot be empty.');
    const patch: AccountPatch = { plan, seats: parseSeats(body.seats), expires_at: parseExpiry(body.expiresAt) };
    const now = ctx.now();
    const existing = ctx.db.accountByEmail(email);
    const account = existing
      ? ctx.db.updateAccount(existing.id, patch, now)
      : ctx.db.createAccount(email, { source: 'admin', status: 'active', ...patch }, now);
    ctx.db.audit(now, 'admin', existing ? 'account.updated' : 'account.created', account.id, { plan: account.plan, seats: account.seats, expiresAt: iso(account.expires_at) });
    response.status(existing ? 200 : 201).json({ account: adminAccount(ctx, account) });
  }));

  /** Revoked accounts are refused at the next heartbeat (devices stay signed in for a restore). */
  router.post('/accounts/:id/revoke', handle((request, response) => {
    const account = accountOr404(String(request.params.id));
    const now = ctx.now();
    const updated = ctx.db.updateAccount(account.id, { status: 'inactive' }, now);
    ctx.db.audit(now, 'admin', 'account.revoked', account.id);
    response.json({ account: adminAccount(ctx, updated) });
  }));

  router.post('/accounts/:id/restore', handle((request, response) => {
    const account = accountOr404(String(request.params.id));
    const now = ctx.now();
    const updated = ctx.db.updateAccount(account.id, { status: 'active' }, now);
    ctx.db.audit(now, 'admin', 'account.restored', account.id);
    response.json({ account: adminAccount(ctx, updated) });
  }));

  /** GET /v1/admin/billing-conflicts → { accounts: [...] } — accounts with a held purchase to decide on. */
  router.get('/billing-conflicts', handle((_request, response) => {
    response.json({ accounts: accountsWithConflicts(ctx).map((row) => adminAccount(ctx, row)) });
  }));

  /**
   * POST /v1/admin/accounts/:id/billing-conflicts { source: "subscription:<id>" | "order:<id>", action: "adopt" | "dismiss" }
   * adopt: the account follows that purchase from now on (its last recorded state). dismiss: keep the
   * account as it is and stop listing that purchase.
   */
  router.post('/accounts/:id/billing-conflicts', handle((request, response) => {
    const account = accountOr404(String(request.params.id));
    const body = bodyOf(request);
    if (typeof body.source !== 'string' || !/^(subscription|order):.+$/.test(body.source)) throw new CloudError(400, 'BAD_REQUEST', 'source must look like "subscription:<id>" or "order:<id>".');
    if (body.action !== 'adopt' && body.action !== 'dismiss') throw new CloudError(400, 'BAD_REQUEST', 'action must be "adopt" or "dismiss".');
    response.json({ account: adminAccount(ctx, resolveConflict(ctx, account, body.source, body.action)) });
  }));

  /** Signs a device out (frees its seat now); that computer must sign in again. */
  router.post('/devices/:id/release', handle((request, response) => {
    const device = ctx.db.deviceById(String(request.params.id));
    if (!device) throw new CloudError(404, 'NOT_FOUND', 'No such device.');
    signOutDevice(ctx, device, 'admin');
    recordSecurityEvent(ctx, { kind: 'admin_release', accountId: device.account_id, deviceId: device.id, ip: request.ip, fingerprintHash: device.fingerprint_hash });
    response.json({ ok: true });
  }));

  const settings = () => {
    let variantSeats: Record<string, number> = {};
    try { variantSeats = JSON.parse(ctx.db.getSetting('variantSeats') ?? '{}') as Record<string, number>; } catch { variantSeats = {}; }
    return {
      minAppVersion: minAppVersion(ctx), variantSeats, defaultSeats: ctx.config.lemonSqueezy.defaultSeats, envVariantSeats: ctx.config.lemonSqueezy.variantSeats,
      // Which purchases grant access (configured: false in production = none do).
      productAllowlist: productAllowlist(ctx), allowTestMode: !ctx.config.production || ctx.config.lemonSqueezy.allowTestMode,
    };
  };

  router.get('/settings', handle((_request, response) => { response.json(settings()); }));

  /** POST /v1/admin/settings { minAppVersion?, variantSeats?: { "<variantId>": seats } } */
  router.post('/settings', handle((request, response) => {
    const body = bodyOf(request);
    const now = ctx.now();
    if (body.minAppVersion !== undefined) {
      if (!isVersion(body.minAppVersion)) throw new CloudError(400, 'BAD_REQUEST', 'minAppVersion must look like 1.2.3.');
      ctx.db.setSetting('minAppVersion', body.minAppVersion, now);
    }
    if (body.variantSeats !== undefined) {
      const raw = body.variantSeats;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CloudError(400, 'BAD_REQUEST', 'variantSeats must be an object like {"12345": 3}.');
      const clean: Record<string, number> = {};
      for (const [variant, seats] of Object.entries(raw)) clean[variant] = parseSeats(seats) as number;
      ctx.db.setSetting('variantSeats', JSON.stringify(clean), now);
    }
    ctx.db.audit(now, 'admin', 'settings.updated', null, { minAppVersion: body.minAppVersion ?? null, variantSeats: body.variantSeats ?? null });
    response.json(settings());
  }));

  /** GET /v1/admin/audit[?account=&limit=] — newest first. */
  router.get('/audit', handle((request, response) => {
    const limit = Math.min(500, Math.max(1, Number(request.query.limit) || 100));
    const accountId = typeof request.query.account === 'string' ? request.query.account : null;
    const rows = (accountId
      ? ctx.db.sql.prepare('SELECT * FROM audit WHERE account_id = ? ORDER BY id DESC LIMIT ?').all(accountId, limit)
      : ctx.db.sql.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit)) as Array<{ id: number; at: number; actor: string; action: string; account_id: string | null; detail: string | null }>;
    response.json({ entries: rows.map((row) => ({ id: row.id, at: iso(row.at), actor: row.actor, action: row.action, account: row.account_id, detail: row.detail ? JSON.parse(row.detail) as unknown : null })) });
  }));

  return router;
}
