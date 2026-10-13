// Lemon Squeezy webhooks → accounts. Purchases and subscription changes create or update the
// account for the customer's email; the desktop app learns the result on its next heartbeat.
//
// - Authenticity: X-Signature is the hex HMAC-SHA256 of the raw body with the webhook secret.
// - Idempotent: a redelivered event (same body) is acknowledged without being applied again, and
//   subscription events older than the last one applied are ignored (deliveries can arrive out of order).
//   Events ignored because of configuration (another store, test mode, not a ThemeBot product, no
//   allowlist) are not marked delivered, so resending them after fixing the settings applies them.
// - Only ThemeBot purchases grant access. The allowlist is the variant → seats mapping
//   (LEMONSQUEEZY_VARIANT_SEATS + the admin `variantSeats` setting) plus LEMONSQUEEZY_PRODUCT_IDS.
//   Anything else sold in the store is acknowledged (200, so Lemon Squeezy doesn't retry) and audited
//   as ignored. With no allowlist at all, production grants nothing (index.ts warns at start); dev
//   accepts every product so local testing needs no setup.
// - Test mode: production ignores test-mode events (`test_mode` on the order / subscription / invoice
//   object, or `meta.test_mode`) unless LEMONSQUEEZY_ALLOW_TEST_MODE=1. Dev accepts them.
// - One account follows one purchase: its subscription (ls_subscription_id) or, for a one-time order,
//   that order (ls_order_id). That subscription's events apply normally (renewal, plan change, cancel,
//   resume, pause, expiry). Another purchase under the same email never takes access away:
//     · it takes the account over when the account has no access to lose (new, lapsed, refunded), when
//       it is the same purchase (the subscription's order_id is the order the account came from), or
//       when an account without a subscription (an admin grant) gets at least the same seats and end;
//     · otherwise it is held: audited as `billing.conflict` and listed on the account in the admin API
//       (`billingConflicts`) for the admin to adopt or dismiss. When the account's own subscription
//       ends, the best held subscription that is still active takes over (failover).
//   Lemon Squeezy keeps one customer per email in a store, so customer_id can't tell two buyers apart;
//   subscription_id (subscriptions, invoices) and order_id (orders, subscription.order_id) can.
// - Status mapping: on_trial / active / past_due (payment being retried) / cancelled (runs to the
//   end of the paid period) keep the account active; paused / unpaid / expired make it inactive.
//   Active subscriptions get expiresAt = next renewal + 7 days, so a missed webhook can't keep an
//   ended subscription alive forever, and a late renewal webhook doesn't lock anyone out.
// - A fully refunded one-time order (order_refunded) makes its account inactive — subscribe the
//   webhook to order_refunded too. Lemon Squeezy has no chargeback/dispute webhook: it settles a
//   chargeback by refunding the order in full, which arrives here as order_refunded.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { accountUsable } from './accounts';
import { CloudError, handle, iso, normalizeEmail, type CloudContext } from './context';
import type { AccountPatch, AccountRow, AccountStatus } from './db';
import { limitByIp } from './rate-limit';

const RENEWAL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ['on_trial', 'active', 'past_due', 'cancelled'];
const SUBSCRIPTION_EVENTS = ['subscription_created', 'subscription_updated', 'subscription_cancelled', 'subscription_expired', 'subscription_resumed', 'subscription_paused', 'subscription_unpaused'];
const PAYMENT_EVENTS = ['subscription_payment_success', 'subscription_payment_failed', 'subscription_payment_recovered'];
/** Events that can give access — the ones the product allowlist gates. */
const GRANTING_EVENTS = [...SUBSCRIPTION_EVENTS, ...PAYMENT_EVENTS, 'order_created'];
const NO_ALLOWLIST = 'no ThemeBot product allowlist configured (LEMONSQUEEZY_VARIANT_SEATS, LEMONSQUEEZY_PRODUCT_IDS or the admin variantSeats setting)';

type Attributes = Record<string, unknown>;
interface LsEvent { meta?: { event_name?: string; test_mode?: boolean }; data?: { id?: string | number; type?: string; attributes?: Attributes } }

/** What a purchase gives an account (status, seats, end) and the Lemon Squeezy ids it carries. */
type Grant = AccountPatch & { seats: number; status: AccountStatus; expires_at: number | null };
type PurchaseKind = 'subscription' | 'order';
interface Purchase { kind: PurchaseKind; id: string; orderId: string | null; updatedAt: number; grant: Grant }

/** A purchase under an account's email that the account does not follow (audit `billing.conflict`). */
export interface HeldPurchase { source: string; kind: PurchaseKind; id: string; orderId: string | null; updatedAt: number; reason: string; candidate: AccountPatch }
export interface WebhookOutcome {
  action: 'created' | 'updated' | 'ignored' | 'conflict';
  account?: string;
  reason?: string;
  /** Recorded as a `billing.conflict` audit entry (the latest state of a purchase the account doesn't follow). */
  held?: HeldPurchase;
  /** Ignored because of configuration: not marked delivered, so a resend after fixing it is applied. */
  replayable?: boolean;
}

export function validSignature(raw: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(raw).digest();
  const given = /^[0-9a-f]+$/i.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const text = (value: unknown) => (value == null || value === '' ? null : String(value));
const time = (value: unknown) => { const parsed = Date.parse(String(value ?? '')); return Number.isFinite(parsed) ? parsed : null; };
const objectOf = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Attributes;

/** "ThemeBot Studio" + "Yearly" → "themebot-studio-yearly" ("Default" variants add nothing). */
function planName(productName: unknown, variantName: unknown): string {
  const parts = [productName, variantName].map((part) => (typeof part === 'string' ? part.trim() : '')).filter((part) => part && part.toLowerCase() !== 'default');
  return parts.join(' ').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'standard';
}

function storedVariantSeats(ctx: CloudContext): Record<string, number> {
  try {
    const stored = JSON.parse(ctx.db.getSetting('variantSeats') ?? '{}') as unknown;
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, number> : {};
  } catch { return {}; }
}

/** Seats per variant: admin setting (JSON {"variantId": seats}) over LEMONSQUEEZY_VARIANT_SEATS, else the default. */
export function seatsForVariant(ctx: CloudContext, variantId: string | null): number {
  const seats = variantId ? storedVariantSeats(ctx)[variantId] ?? ctx.config.lemonSqueezy.variantSeats[variantId] : undefined;
  return Number.isInteger(seats) && (seats as number) > 0 ? seats as number : ctx.config.lemonSqueezy.defaultSeats;
}

export interface ProductAllowlist { configured: boolean; variants: string[]; products: string[] }

/** The ThemeBot variants (env + admin seat mapping) and products (LEMONSQUEEZY_PRODUCT_IDS). */
export function productAllowlist(ctx: CloudContext): ProductAllowlist {
  const variants = [...new Set([...Object.keys(ctx.config.lemonSqueezy.variantSeats), ...Object.keys(storedVariantSeats(ctx))])];
  const products = ctx.config.lemonSqueezy.productIds;
  return { configured: variants.length > 0 || products.length > 0, variants, products };
}

/** Why a purchase of this product/variant grants nothing, or null for a ThemeBot product. */
function notThemeBot(ctx: CloudContext, productId: string | null, variantId: string | null): string | null {
  const list = productAllowlist(ctx);
  if (!list.configured) return ctx.config.production ? NO_ALLOWLIST : null; // dev: every product counts
  if ((variantId && list.variants.includes(variantId)) || (productId && list.products.includes(productId))) return null;
  return `not a ThemeBot product (product ${productId ?? 'none'}, variant ${variantId ?? 'none'})`;
}

/** Printed by index.ts at start. Production with no allowlist keeps running (fail closed: grants nothing). */
export function lemonSqueezyStartupWarnings(ctx: CloudContext): string[] {
  const settings = ctx.config.lemonSqueezy;
  if (!settings.webhookSecret) return [];
  const warnings: string[] = [];
  if (!productAllowlist(ctx).configured) {
    warnings.push(ctx.config.production
      ? `Lemon Squeezy purchases grant NOTHING: ${NO_ALLOWLIST}. Events are acknowledged and audited as ignored; set your ThemeBot variant or product ids, then resend the missed events from Lemon Squeezy.`
      : 'No ThemeBot product allowlist (LEMONSQUEEZY_VARIANT_SEATS / LEMONSQUEEZY_PRODUCT_IDS): dev accepts a purchase of any product in the store; production would grant nothing.');
  }
  if (ctx.config.production && settings.allowTestMode) warnings.push('LEMONSQUEEZY_ALLOW_TEST_MODE=1: test-mode purchases create real accounts in production.');
  return warnings;
}

/** Documented on the order / subscription / invoice object (and the order's first item); deliveries also carry meta.test_mode. */
function isTestMode(event: LsEvent, attributes: Attributes): boolean {
  return event.meta?.test_mode === true || attributes.test_mode === true || objectOf(attributes.first_order_item).test_mode === true;
}

function subscriptionPurchase(ctx: CloudContext, id: string, a: Attributes, now: number): Purchase {
  const status = String(a.status ?? '');
  const active = ACTIVE_STATUSES.includes(status);
  let expiresAt: number | null;
  if (status === 'cancelled') expiresAt = time(a.ends_at);
  else if (!active) expiresAt = time(a.ends_at) ?? now;
  else { const renews = time(a.renews_at); expiresAt = renews == null ? null : renews + RENEWAL_GRACE_MS; }
  const variantId = text(a.variant_id);
  const orderId = text(a.order_id);
  const updatedAt = time(a.updated_at) ?? now;
  return {
    kind: 'subscription', id, orderId, updatedAt,
    grant: {
      plan: planName(a.product_name, a.variant_name),
      seats: seatsForVariant(ctx, variantId),
      status: active ? 'active' : 'inactive',
      expires_at: expiresAt,
      ls_customer_id: text(a.customer_id),
      ls_subscription_id: id,
      ls_order_id: orderId ?? undefined,
      ls_variant_id: variantId,
      ls_status: status,
      ls_updated_at: updatedAt,
    },
  };
}

/** A one-time purchase: no end date (a later subscription_created sets one if it was a subscription). */
function orderPurchase(ctx: CloudContext, id: string, a: Attributes, now: number): Purchase {
  const item = objectOf(a.first_order_item);
  const variantId = text(item.variant_id);
  return {
    kind: 'order', id, orderId: id, updatedAt: time(a.updated_at) ?? now,
    grant: {
      plan: planName(item.product_name, item.variant_name),
      seats: seatsForVariant(ctx, variantId),
      status: 'active',
      expires_at: null,
      ls_customer_id: text(a.customer_id),
      ls_subscription_id: null,
      ls_order_id: id,
      ls_variant_id: variantId,
      ls_status: 'paid',
      ls_updated_at: null,
    },
  };
}

const sourceOf = (kind: PurchaseKind, id: string) => `${kind}:${id}`;
const endOf = (expiresAt: number | null | undefined) => expiresAt ?? Number.POSITIVE_INFINITY;
const grantsAccess = (candidate: AccountPatch, now: number) => candidate.status === 'active' && endOf(candidate.expires_at) > now;

function create(ctx: CloudContext, email: string | null, purchase: Purchase, now: number): WebhookOutcome {
  if (!email) return { action: 'ignored', reason: 'no customer email' };
  return { action: 'created', account: ctx.db.createAccount(email, { source: 'lemonsqueezy', ...purchase.grant }, now).id };
}

function hold(account: AccountRow, purchase: Purchase, reason: string): WebhookOutcome {
  return {
    action: purchase.grant.status === 'active' ? 'conflict' : 'ignored',
    account: account.id,
    reason,
    held: { source: sourceOf(purchase.kind, purchase.id), kind: purchase.kind, id: purchase.id, orderId: purchase.orderId, updatedAt: purchase.updatedAt, reason, candidate: purchase.grant },
  };
}

/** A purchase under the account's email that the account does not follow. Never takes access away. */
function applyOtherPurchase(ctx: CloudContext, account: AccountRow, purchase: Purchase, now: number): WebhookOutcome {
  const source = sourceOf(purchase.kind, purchase.id);
  const adopt = (reason: string): WebhookOutcome => ({ action: 'updated', account: ctx.db.updateAccount(account.id, purchase.grant, now).id, reason });
  // order_created arrived first and made the account; this is that order's subscription.
  if (purchase.kind === 'subscription' && !account.ls_subscription_id && purchase.orderId != null && account.ls_order_id === purchase.orderId) {
    return adopt('the subscription of the order this account came from');
  }
  if (!accountUsable(account, now)) {
    return purchase.grant.status === 'active' ? adopt(`the account had no access; it now follows ${source}`) : hold(account, purchase, `another ${purchase.kind}, not active`);
  }
  // An admin grant (no subscription) gives way to a subscription that gives at least as much. A
  // one-time order never takes over an account with access: it can't be told apart from the first
  // order of a subscription, which would end the access the account has.
  if (purchase.kind === 'subscription' && !account.ls_subscription_id && purchase.grant.status === 'active'
    && purchase.grant.seats >= account.seats && endOf(purchase.grant.expires_at) >= endOf(account.expires_at)) {
    return adopt(`${source} gives at least the current seats and end date`);
  }
  if (purchase.grant.status !== 'active') return hold(account, purchase, `another ${purchase.kind}, not active`);
  return hold(account, purchase, account.ls_subscription_id
    ? `the account follows subscription ${account.ls_subscription_id}; held for the admin`
    : `the account already has access${account.ls_order_id ? ` from order ${account.ls_order_id}` : ''}; held for the admin`);
}

// ---- held purchases (billing conflicts) -----------------------------------------------------------

interface HeldEntry extends HeldPurchase { auditId: number; at: number; event: string }

/** The latest recorded state of every purchase held for this account, and the ones the admin dismissed. */
function heldEntries(ctx: CloudContext, accountId: string) {
  const rows = ctx.db.sql.prepare("SELECT id, at, action, detail FROM audit WHERE account_id = ? AND action IN ('billing.conflict', 'billing.conflict_resolved') ORDER BY id")
    .all(accountId) as Array<{ id: number; at: number; action: string; detail: string | null }>;
  const latest = new Map<string, HeldEntry>();
  const dismissed = new Set<string>();
  const subscriptionOrders = new Set<string>();
  for (const row of rows) {
    let detail: Record<string, any>;
    try { detail = JSON.parse(row.detail ?? '{}') as Record<string, any>; } catch { continue; }
    if (typeof detail.source !== 'string') continue;
    if (row.action === 'billing.conflict_resolved') { if (detail.resolution === 'dismissed') dismissed.add(detail.source); continue; }
    const entry = { ...detail, auditId: row.id, at: row.at } as HeldEntry;
    if (entry.kind === 'subscription' && entry.orderId) subscriptionOrders.add(entry.orderId);
    const previous = latest.get(entry.source);
    if (!previous || entry.updatedAt >= previous.updatedAt) latest.set(entry.source, entry);
  }
  return { latest, dismissed, subscriptionOrders };
}

/**
 * Purchases under the account's email that it doesn't follow and that still give access: what the
 * admin view lists. An order that is a held subscription's first order is covered by that subscription.
 */
export function openConflicts(ctx: CloudContext, account: AccountRow, now: number): HeldEntry[] {
  const { latest, dismissed, subscriptionOrders } = heldEntries(ctx, account.id);
  return [...latest.values()].filter((entry) => !dismissed.has(entry.source)
    && (entry.kind === 'subscription' ? account.ls_subscription_id !== entry.id : account.ls_order_id !== entry.id && !subscriptionOrders.has(entry.id))
    && grantsAccess(entry.candidate, now));
}

/** The admin view of an open conflict. */
export function conflictView(entry: HeldEntry) {
  const c = entry.candidate;
  return {
    source: entry.source, kind: entry.kind, id: entry.id, event: entry.event, reason: entry.reason, recordedAt: iso(entry.at),
    plan: c.plan ?? null, seats: c.seats ?? null, status: c.status ?? null, expiresAt: iso(c.expires_at), variantId: c.ls_variant_id ?? null, lemonSqueezyStatus: c.ls_status ?? null,
  };
}

/** Accounts with at least one open conflict. */
export function accountsWithConflicts(ctx: CloudContext): AccountRow[] {
  const ids = ctx.db.sql.prepare("SELECT DISTINCT account_id FROM audit WHERE action = 'billing.conflict' AND account_id IS NOT NULL").all() as Array<{ account_id: string }>;
  const now = ctx.now();
  return ids.map((row) => ctx.db.accountById(row.account_id)).filter((account): account is AccountRow => account != null && openConflicts(ctx, account, now).length > 0);
}

/**
 * Admin decision on a held purchase: `adopt` makes the account follow it (its last recorded state,
 * which must still give access), `dismiss` closes it for good (later events of it stay held, unlisted).
 */
export function resolveConflict(ctx: CloudContext, account: AccountRow, source: string, resolution: 'adopt' | 'dismiss'): AccountRow {
  const now = ctx.now();
  const entry = heldEntries(ctx, account.id).latest.get(source);
  if (!entry) throw new CloudError(404, 'NOT_FOUND', 'No held purchase with that source on this account.');
  let updated = account;
  if (resolution === 'adopt') {
    if (!grantsAccess(entry.candidate, now)) throw new CloudError(409, 'NOT_ACTIVE', 'That purchase no longer gives access; nothing to adopt.');
    updated = ctx.db.updateAccount(account.id, entry.candidate, now);
  }
  ctx.db.audit(now, 'admin', 'billing.conflict_resolved', account.id, { source, resolution: resolution === 'adopt' ? 'adopted' : 'dismissed', by: 'admin' });
  return updated;
}

/** The account's own purchase has ended: the best held subscription that still gives access takes over. */
function failover(ctx: CloudContext, account: AccountRow, now: number): AccountRow | null {
  if (accountUsable(account, now)) return null;
  const best = openConflicts(ctx, account, now)
    .filter((entry) => entry.kind === 'subscription')
    .sort((a, b) => endOf(b.candidate.expires_at) - endOf(a.candidate.expires_at) || (b.candidate.seats ?? 0) - (a.candidate.seats ?? 0))[0];
  if (!best) return null;
  const updated = ctx.db.updateAccount(account.id, best.candidate, now);
  ctx.db.audit(now, 'lemonsqueezy', 'billing.conflict_resolved', account.id, { source: best.source, resolution: 'adopted', by: 'failover' });
  return updated;
}

// ---- events ---------------------------------------------------------------------------------------

function applySubscription(ctx: CloudContext, subscriptionId: string, a: Attributes, now: number): WebhookOutcome {
  const blocked = notThemeBot(ctx, text(a.product_id), text(a.variant_id));
  if (blocked) return { action: 'ignored', reason: blocked, replayable: true };
  const purchase = subscriptionPurchase(ctx, subscriptionId, a, now);
  const own = ctx.db.accountBySubscription(subscriptionId);
  if (own) {
    if (own.ls_updated_at != null && purchase.updatedAt < own.ls_updated_at) return { action: 'ignored', account: own.id, reason: 'older than the last update applied' };
    const updated = ctx.db.updateAccount(own.id, purchase.grant, now);
    const switched = failover(ctx, updated, now);
    return { action: 'updated', account: own.id, reason: switched ? `subscription ended; now follows ${switched.ls_subscription_id ? sourceOf('subscription', switched.ls_subscription_id) : 'a held purchase'}` : undefined };
  }
  const email = normalizeEmail(a.user_email);
  const account = email ? ctx.db.accountByEmail(email) : null;
  return account ? applyOtherPurchase(ctx, account, purchase, now) : create(ctx, email, purchase, now);
}

function applyOrder(ctx: CloudContext, orderId: string, a: Attributes, now: number): WebhookOutcome {
  if (a.status !== 'paid') return { action: 'ignored', reason: `order ${String(a.status)}` };
  const item = objectOf(a.first_order_item);
  const blocked = notThemeBot(ctx, text(item.product_id), text(item.variant_id));
  if (blocked) return { action: 'ignored', reason: blocked, replayable: true };
  const email = normalizeEmail(a.user_email);
  const account = email ? ctx.db.accountByEmail(email) : null;
  const purchase = orderPurchase(ctx, orderId, a, now);
  if (!account) return create(ctx, email, purchase, now);
  // The order the account already follows: a subscription's first order (its events own the dates),
  // or a one-time order already applied (a refunded one stays refunded).
  if (account.ls_order_id === orderId) return { action: 'ignored', account: account.id, reason: account.ls_subscription_id ? "the subscription's first order (subscription events decide)" : 'order already applied' };
  return applyOtherPurchase(ctx, account, purchase, now);
}

function applyPayment(ctx: CloudContext, event: string, a: Attributes, now: number): WebhookOutcome {
  // Invoices carry no product, so only the subscription an account follows counts (never the email).
  const subscriptionId = text(a.subscription_id);
  const account = subscriptionId ? ctx.db.accountBySubscription(subscriptionId) : null;
  if (!account) return { action: 'ignored', reason: 'not the subscription of any account' };
  // A recovered payment reactivates an account that went unpaid; the matching subscription_updated
  // carries the new renewal date. A failed payment changes nothing by itself (past_due follows).
  if (event !== 'subscription_payment_failed' && account.status === 'inactive' && account.ls_status === 'unpaid') {
    return { action: 'updated', account: ctx.db.updateAccount(account.id, { status: 'active', ls_status: 'active' }, now).id };
  }
  return { action: 'ignored', account: account.id, reason: 'recorded only' };
}

/**
 * order_refunded: a fully refunded one-time purchase ends the access it bought (it never expires
 * on its own, so without this "buy, refund, keep using" would work forever). Partial refunds
 * change nothing, and subscription accounts are left to their subscription events (a refunded
 * subscription is cancelled/expired in Lemon Squeezy, which arrives as subscription_* events).
 * Chargebacks arrive here too: Lemon Squeezy has no dispute webhook and refunds the order in full.
 * Not gated by the product allowlist: it only takes away access, and only that order's.
 */
function applyRefund(ctx: CloudContext, orderId: string, a: Attributes, now: number): WebhookOutcome {
  if (a.refunded !== true && a.status !== 'refunded') return { action: 'ignored', reason: 'partial refund' };
  const email = normalizeEmail(a.user_email);
  const account = email ? ctx.db.accountByEmail(email) : null;
  if (!account) return { action: 'ignored', reason: 'no account for this email' };
  if (account.ls_order_id !== orderId) {
    const reason = 'not the order this account follows';
    // A held one-time order that is refunded must not stay adoptable in the admin view.
    const source = sourceOf('order', orderId);
    if (!heldEntries(ctx, account.id).latest.has(source)) return { action: 'ignored', account: account.id, reason };
    return { action: 'ignored', account: account.id, reason, held: { source, kind: 'order', id: orderId, orderId, updatedAt: time(a.refunded_at) ?? time(a.updated_at) ?? now, reason: 'refunded', candidate: { status: 'inactive', ls_status: 'refunded' } } };
  }
  if (account.ls_subscription_id) return { action: 'ignored', account: account.id, reason: 'subscription account (subscription events decide)' };
  const updated = ctx.db.updateAccount(account.id, { status: 'inactive', ls_status: 'refunded' }, now);
  const switched = failover(ctx, updated, now);
  return { action: 'updated', account: account.id, reason: switched ? 'refunded; a held subscription took over' : undefined };
}

export function applyLemonSqueezyEvent(ctx: CloudContext, name: string, event: LsEvent, now: number): WebhookOutcome {
  const data = event.data ?? {};
  const attributes = (data.attributes ?? {}) as Attributes;
  const settings = ctx.config.lemonSqueezy;
  if (settings.storeId != null && Number(attributes.store_id) !== settings.storeId) return { action: 'ignored', reason: 'another store', replayable: true };
  if (ctx.config.production && !settings.allowTestMode && isTestMode(event, attributes)) {
    return { action: 'ignored', reason: 'test mode (production accepts it only with LEMONSQUEEZY_ALLOW_TEST_MODE=1)', replayable: true };
  }
  if (data.id == null) return { action: 'ignored', reason: 'no object id' };
  if (ctx.config.production && GRANTING_EVENTS.includes(name) && !productAllowlist(ctx).configured) {
    ctx.log.warn(`Lemon Squeezy ${name} ignored: ${NO_ALLOWLIST}`, { object: String(data.id) });
    return { action: 'ignored', reason: NO_ALLOWLIST, replayable: true };
  }
  if (SUBSCRIPTION_EVENTS.includes(name)) return applySubscription(ctx, String(data.id), attributes, now);
  if (name === 'order_created') return applyOrder(ctx, String(data.id), attributes, now);
  if (name === 'order_refunded') return applyRefund(ctx, String(data.id), attributes, now);
  if (PAYMENT_EVENTS.includes(name)) return applyPayment(ctx, name, attributes, now);
  return { action: 'ignored', reason: `event ${name || 'unnamed'} not handled` };
}

export function webhooksRouter(ctx: CloudContext) {
  const router = Router();
  /** POST /v1/webhooks/lemonsqueezy — raw body (the signature covers the exact bytes). */
  router.post('/lemonsqueezy', limitByIp(ctx, 'webhooks', 300, 60_000), express.raw({ type: () => true, limit: '1mb' }), handle((request, response) => {
    const secret = ctx.config.lemonSqueezy.webhookSecret;
    if (!secret) throw new CloudError(503, 'NOT_CONFIGURED', 'Webhooks are not configured on this server.');
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    if (!validSignature(raw, request.header('x-signature') ?? '', secret)) throw new CloudError(401, 'BAD_SIGNATURE', 'Invalid webhook signature.');
    let event: LsEvent;
    try { event = JSON.parse(raw.toString('utf8')) as LsEvent; } catch { throw new CloudError(400, 'BAD_REQUEST', 'The webhook body is not valid JSON.'); }
    const name = String(event.meta?.event_name ?? request.header('x-event-name') ?? '');
    const deliveryId = createHash('sha256').update(raw).digest('hex');
    const now = ctx.now();
    const outcome = ctx.db.transaction((): WebhookOutcome & { duplicate?: boolean } => {
      if (ctx.db.sql.prepare('SELECT 1 FROM webhook_events WHERE id = ?').get(deliveryId)) return { action: 'ignored', duplicate: true, reason: 'already applied' };
      const result = applyLemonSqueezyEvent(ctx, name, event, now);
      if (!result.replayable) ctx.db.sql.prepare('INSERT INTO webhook_events (id, source, event, received_at) VALUES (?, ?, ?, ?)').run(deliveryId, 'lemonsqueezy', name, now);
      const object = text(event.data?.id);
      ctx.db.audit(now, 'lemonsqueezy', `billing.${name || 'unknown'}`, result.account ?? null, { action: result.action, reason: result.reason ?? null, object, testMode: isTestMode(event, (event.data?.attributes ?? {}) as Attributes) });
      if (result.held) ctx.db.audit(now, 'lemonsqueezy', 'billing.conflict', result.account ?? null, { ...result.held, event: name });
      return result;
    });
    response.json({ ok: true, action: outcome.action, account: outcome.account, reason: outcome.reason, duplicate: outcome.duplicate });
  }));
  return router;
}
