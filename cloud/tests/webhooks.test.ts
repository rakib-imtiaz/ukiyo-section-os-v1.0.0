import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloudConfig } from '../src/config';
import type { CloudContext } from '../src/context';
import { lemonSqueezyStartupWarnings } from '../src/webhooks';
import { MINUTE, startTestCloud, type TestCloud } from './helpers';

const DAY = 24 * 60 * MINUTE;
// ThemeBot is product 5. Variants: 111 Studio Monthly (5 seats), 222 Solo (1), 333 Agency (10); any
// other variant of product 5 (e.g. 999) counts with the default 3 seats. Product 42 is something else.
const ENV = { LEMONSQUEEZY_VARIANT_SEATS: '111:5,222:1,333:10', LEMONSQUEEZY_PRODUCT_IDS: '5' };
const PRODUCTION = {
  NODE_ENV: 'production',
  CLOUD_SIGNING_KEY: generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  RESEND_API_KEY: 're_test_only',
  MAIL_FROM: 'ThemeBot <login@example.com>',
};
const RENEWS = '2026-11-01T12:00:00.000Z';
const renewalExpiry = (renews: string) => new Date(Date.parse(renews) + 7 * DAY).toISOString();

let t: TestCloud;
beforeEach(async () => { t = await startTestCloud(ENV); });
afterEach(async () => { await t.close(); });

async function withCloud(env: Record<string, string>, run: (cloud: TestCloud) => Promise<void>) {
  const cloud = await startTestCloud(env);
  try { await run(cloud); } finally { await cloud.close(); }
}

function subscription(event: string, attributes: Record<string, unknown>, id = 'sub_1', meta: Record<string, unknown> = {}) {
  return {
    meta: { event_name: event, ...meta },
    data: {
      type: 'subscriptions', id,
      attributes: {
        store_id: 1, customer_id: 77, order_id: 900, product_id: 5, variant_id: 111, product_name: 'ThemeBot Studio', variant_name: 'Monthly',
        user_email: 'Buyer@Example.com', status: 'active', renews_at: RENEWS, ends_at: null,
        updated_at: '2026-10-01T12:00:00.000Z', test_mode: false, ...attributes,
      },
    },
  };
}

function order(id: string, attributes: Record<string, unknown> = {}, item: Record<string, unknown> = {}, event = 'order_created') {
  return {
    meta: { event_name: event },
    data: {
      type: 'orders', id,
      attributes: {
        store_id: 1, customer_id: 5, user_email: 'once@example.com', status: 'paid', refunded: false, test_mode: false, updated_at: '2026-10-01T12:00:00.000Z',
        first_order_item: { product_id: 5, variant_id: 999, product_name: 'ThemeBot', variant_name: 'Default', test_mode: false, ...item },
        ...attributes,
      },
    },
  };
}

const invoice = (event: string, id: string, subscriptionId: string, status: string) => ({
  meta: { event_name: event },
  data: { type: 'subscription-invoices', id, attributes: { store_id: 1, subscription_id: subscriptionId, user_email: 'buyer@example.com', status, test_mode: false } },
});

const accountOf = async (cloud: TestCloud, email: string) => (await cloud.admin('GET', `/accounts?email=${email}`)).body.accounts[0] as Record<string, any> | undefined;
const account = (email = 'buyer@example.com') => accountOf(t, email);
const auditOf = async (cloud: TestCloud, action: string) => ((await cloud.admin('GET', '/audit?limit=200')).body.entries as Array<Record<string, any>>).filter((entry) => entry.action === action);

describe('Lemon Squeezy webhooks', () => {
  it('rejects a missing or wrong signature', async () => {
    const payload = subscription('subscription_created', {});
    expect((await t.webhook(payload, { signature: '' })).status).toBe(401);
    const wrong = await t.webhook(payload, { signature: 'ab'.repeat(32) });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('BAD_SIGNATURE');
    expect(await account()).toBeUndefined();
  });

  it('answers 503 when no webhook secret is configured', async () => {
    await withCloud({ LEMONSQUEEZY_WEBHOOK_SECRET: '' }, async (bare) => { expect((await bare.webhook(subscription('subscription_created', {}))).status).toBe(503); });
  });

  it('creates the account from subscription_created, with seats from the variant mapping', async () => {
    const result = await t.webhook(subscription('subscription_created', {}));
    expect(result.body).toMatchObject({ ok: true, action: 'created' });
    expect(await account()).toMatchObject({
      email: 'buyer@example.com', plan: 'themebot-studio-monthly', seats: 5, status: 'active', usable: true, source: 'lemonsqueezy',
      expiresAt: renewalExpiry(RENEWS),
      lemonSqueezy: { subscriptionId: 'sub_1', orderId: '900', customerId: '77', variantId: '111', status: 'active' },
      billingConflicts: [],
    });
    // The new customer can sign in right away.
    await t.call('POST', '/v1/auth/start', { email: 'buyer@example.com' });
    expect(t.lastCode('buyer@example.com')).toMatch(/^\d{6}$/);
  });

  it('is idempotent and ignores out-of-order updates', async () => {
    const created = subscription('subscription_created', {});
    await t.webhook(created);
    const again = await t.webhook(created);
    expect(again.body).toMatchObject({ ok: true, duplicate: true });

    await t.webhook(subscription('subscription_updated', { status: 'past_due', updated_at: '2026-10-05T12:00:00.000Z' }));
    const stale = await t.webhook(subscription('subscription_updated', { status: 'expired', updated_at: '2026-10-03T12:00:00.000Z' }));
    expect(stale.body).toMatchObject({ action: 'ignored' });
    expect(await account()).toMatchObject({ status: 'active', lemonSqueezy: { status: 'past_due' } });
  });

  it('an unpaid subscription is reactivated by a recovered payment', async () => {
    await t.webhook(subscription('subscription_created', {}));
    await t.webhook(subscription('subscription_updated', { status: 'unpaid', updated_at: '2026-10-10T00:00:00.000Z' }));
    expect((await account())?.status).toBe('inactive');
    expect((await t.webhook(invoice('subscription_payment_failed', 'inv_1', 'sub_1', 'pending'))).body.action).toBe('ignored');
    expect((await t.webhook(invoice('subscription_payment_success', 'inv_2', 'sub_1', 'paid'))).body.action).toBe('updated');
    expect((await account())?.status).toBe('active');
  });

  it('a paid one-time order creates a lifetime account; unpaid orders are ignored', async () => {
    expect((await t.webhook(order('ord_later', { status: 'pending', user_email: 'later@example.com' }))).body.action).toBe('ignored');
    expect(await account('later@example.com')).toBeUndefined();
    expect((await t.webhook(order('ord_once'))).body.action).toBe('created');
    expect(await account('once@example.com')).toMatchObject({ plan: 'themebot', seats: 3, status: 'active', expiresAt: null, lemonSqueezy: { orderId: 'ord_once', subscriptionId: null } });
  });

  it('a fully refunded one-time order ends the access it bought; partial refunds and other orders do not', async () => {
    expect((await t.webhook(order('ord_1'))).body.action).toBe('created');
    expect((await t.webhook(order('ord_1', { status: 'partial_refund', refunded: false, updated_at: '2026-10-02T00:00:00.000Z' }, {}, 'order_refunded'))).body.action).toBe('ignored');
    expect((await account('once@example.com'))?.usable).toBe(true);
    expect((await t.webhook(order('ord_other', { status: 'refunded', refunded: true }, {}, 'order_refunded'))).body.action).toBe('ignored');
    expect((await account('once@example.com'))?.usable).toBe(true);
    const refunded = await t.webhook(order('ord_1', { status: 'refunded', refunded: true, updated_at: '2026-10-03T00:00:00.000Z' }, {}, 'order_refunded'));
    expect(refunded.body.action).toBe('updated');
    expect(await account('once@example.com')).toMatchObject({ status: 'inactive', usable: false, lemonSqueezy: { status: 'refunded' } });
    // The refunded order can't bring it back; buying again does.
    expect((await t.webhook(order('ord_1', { updated_at: '2026-10-04T00:00:00.000Z' }))).body.action).toBe('ignored');
    expect((await account('once@example.com'))?.usable).toBe(false);
    expect((await t.webhook(order('ord_2'))).body.action).toBe('updated');
    expect(await account('once@example.com')).toMatchObject({ usable: true, lemonSqueezy: { orderId: 'ord_2', status: 'paid' } });
  });

  it("a refund of a subscription's order is left to the subscription events", async () => {
    await t.webhook(subscription('subscription_created', {}));
    await t.webhook(order('900', { user_email: 'buyer@example.com' }, { variant_id: 111 }));
    const refund = await t.webhook(order('900', { user_email: 'buyer@example.com', status: 'refunded', refunded: true }, { variant_id: 111 }, 'order_refunded'));
    expect(refund.body).toMatchObject({ action: 'ignored' });
    expect((await account())?.status).toBe('active');
  });

  it("a subscription's own order does not override the subscription dates", async () => {
    await t.webhook(subscription('subscription_created', {}));
    const own = await t.webhook(order('900', { user_email: 'buyer@example.com' }, { variant_id: 111 }));
    expect(own.body).toMatchObject({ action: 'ignored', reason: expect.stringMatching(/first order/) });
    expect(await account()).toMatchObject({ expiresAt: renewalExpiry(RENEWS), lemonSqueezy: { orderId: '900', subscriptionId: 'sub_1' }, billingConflicts: [] });
  });

  it('admin variant seats override the env mapping', async () => {
    await t.admin('POST', '/settings', { variantSeats: { 111: 12 } });
    await t.webhook(subscription('subscription_created', {}));
    expect((await account())?.seats).toBe(12);
  });
});

describe('only ThemeBot products grant access', () => {
  it('an order or subscription for another product is acknowledged (200), ignored and audited', async () => {
    const other = await t.webhook(order('ord_mug', {}, { product_id: 42, variant_id: 4242, product_name: 'Coffee mug' }));
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ ok: true, action: 'ignored', reason: expect.stringMatching(/not a ThemeBot product \(product 42, variant 4242\)/) });
    const otherSubscription = await t.webhook(subscription('subscription_created', { product_id: 42, variant_id: 4242 }, 'sub_other'));
    expect(otherSubscription.body).toMatchObject({ action: 'ignored', reason: expect.stringMatching(/not a ThemeBot product/) });
    expect(await account('once@example.com')).toBeUndefined();
    expect(await account()).toBeUndefined();
    const [audited] = await auditOf(t, 'billing.order_created');
    expect(audited.detail).toMatchObject({ action: 'ignored', reason: expect.stringMatching(/not a ThemeBot product/), object: 'ord_mug' });

    // An existing customer buying something else in the store keeps their account as it is.
    await t.webhook(subscription('subscription_created', {}));
    await t.webhook(subscription('subscription_created', { product_id: 42, variant_id: 4242, status: 'expired', updated_at: '2026-10-02T00:00:00.000Z' }, 'sub_mug'));
    expect(await account()).toMatchObject({ seats: 5, status: 'active', lemonSqueezy: { subscriptionId: 'sub_1' }, billingConflicts: [] });
  });

  it('the variant mapping and the product ids each allow; a new variant of the product gets the default seats', async () => {
    expect((await t.webhook(order('ord_a', { user_email: 'a@example.com' }, { product_id: 77, variant_id: 333 }))).body.action).toBe('created');
    expect((await account('a@example.com'))?.seats).toBe(10);
    expect((await t.webhook(order('ord_b', { user_email: 'b@example.com' }, { product_id: 5, variant_id: 31337 }))).body.action).toBe('created');
    expect((await account('b@example.com'))?.seats).toBe(3);
  });

  it('the admin variantSeats setting extends the allowlist at runtime', async () => {
    expect((await t.webhook(order('ord_x', {}, { product_id: 42, variant_id: 4242 }))).body.action).toBe('ignored');
    await t.admin('POST', '/settings', { variantSeats: { 4242: 2 } });
    // Ignored-by-configuration deliveries aren't marked delivered: resending the same one applies it.
    expect((await t.webhook(order('ord_x', {}, { product_id: 42, variant_id: 4242 }))).body.action).toBe('created');
    expect((await account('once@example.com'))?.seats).toBe(2);
  });

  it('dev with no allowlist at all accepts any product (permissive local testing)', async () => {
    await withCloud({ LEMONSQUEEZY_VARIANT_SEATS: '' }, async (dev) => {
      expect((await dev.webhook(order('ord_any', {}, { product_id: 42, variant_id: 4242 }))).body.action).toBe('created');
      expect((await accountOf(dev, 'once@example.com'))?.seats).toBe(3);
      expect((await dev.admin('GET', '/settings')).body.productAllowlist).toEqual({ configured: false, variants: [], products: [] });
    });
  });

  it('production with no allowlist grants nothing, until one is set', async () => {
    await withCloud({ ...PRODUCTION, LEMONSQUEEZY_VARIANT_SEATS: '' }, async (prod) => {
      const created = subscription('subscription_created', {});
      const result = await prod.webhook(created);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ action: 'ignored', reason: expect.stringMatching(/no ThemeBot product allowlist/) });
      expect((await prod.webhook(order('ord_1'))).body.action).toBe('ignored');
      expect((await prod.webhook(invoice('subscription_payment_success', 'inv_1', 'sub_1', 'paid'))).body.action).toBe('ignored');
      expect((await prod.admin('GET', '/accounts')).body.accounts).toEqual([]);
      expect((await auditOf(prod, 'billing.subscription_created'))[0].detail).toMatchObject({ action: 'ignored', reason: expect.stringMatching(/no ThemeBot product allowlist/) });
      expect((await prod.admin('GET', '/settings')).body.productAllowlist.configured).toBe(false);

      // The admin fills in the mapping; Lemon Squeezy's "resend" of the missed event now applies.
      await prod.admin('POST', '/settings', { variantSeats: { 111: 5 } });
      expect((await prod.webhook(created)).body.action).toBe('created');
      expect(await accountOf(prod, 'buyer@example.com')).toMatchObject({ seats: 5, usable: true });
    });
  });

  it('warns at startup (instead of refusing) when production has no allowlist', () => {
    const ctx = (production: boolean, settings: Partial<CloudConfig['lemonSqueezy']>, stored: string | null = null) => ({
      config: { production, lemonSqueezy: { webhookSecret: 'whsec', storeId: null, variantSeats: {}, productIds: [], defaultSeats: 3, allowTestMode: false, ...settings } },
      db: { getSetting: () => stored },
    }) as unknown as CloudContext;
    expect(lemonSqueezyStartupWarnings(ctx(true, {}))).toEqual([expect.stringMatching(/grant NOTHING/)]);
    expect(lemonSqueezyStartupWarnings(ctx(true, {}, '{"111":5}'))).toEqual([]);
    expect(lemonSqueezyStartupWarnings(ctx(true, { productIds: ['5'] }))).toEqual([]);
    expect(lemonSqueezyStartupWarnings(ctx(true, { webhookSecret: '' }))).toEqual([]);
    expect(lemonSqueezyStartupWarnings(ctx(false, {}))).toEqual([expect.stringMatching(/dev accepts/)]);
    expect(lemonSqueezyStartupWarnings(ctx(true, { variantSeats: { 111: 5 }, allowTestMode: true }))).toEqual([expect.stringMatching(/test-mode purchases/)]);
  });
});

describe('test mode', () => {
  it('production ignores test-mode events (meta or object test_mode) and audits them', async () => {
    await withCloud({ ...PRODUCTION, ...ENV }, async (prod) => {
      for (const payload of [
        subscription('subscription_created', {}, 'sub_t1', { test_mode: true }),
        subscription('subscription_created', { test_mode: true }, 'sub_t2'),
        order('ord_t1', { test_mode: true }),
        order('ord_t2', {}, { test_mode: true }),
      ]) {
        const result = await prod.webhook(payload);
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ action: 'ignored', reason: expect.stringMatching(/^test mode/) });
      }
      expect((await prod.admin('GET', '/accounts')).body.accounts).toEqual([]);
      expect((await auditOf(prod, 'billing.subscription_created'))[0].detail).toMatchObject({ action: 'ignored', testMode: true });
      // Live events are applied.
      expect((await prod.webhook(subscription('subscription_created', {}))).body.action).toBe('created');
    });
  });

  it('production accepts test mode with LEMONSQUEEZY_ALLOW_TEST_MODE=1; dev always does', async () => {
    await withCloud({ ...PRODUCTION, ...ENV, LEMONSQUEEZY_ALLOW_TEST_MODE: '1' }, async (prod) => {
      expect((await prod.webhook(subscription('subscription_created', { test_mode: true }, 'sub_1', { test_mode: true }))).body.action).toBe('created');
    });
    expect((await t.webhook(subscription('subscription_created', { test_mode: true }, 'sub_1', { test_mode: true }))).body.action).toBe('created');
    expect((await t.webhook(order('ord_t', { test_mode: true }, { test_mode: true }))).body.action).toBe('created');
  });
});

describe('a purchase under an existing email never takes access away', () => {
  it('a second, cheaper subscription is held for the admin; the account keeps following its own', async () => {
    await t.webhook(subscription('subscription_created', {}));
    const cheaper = await t.webhook(subscription('subscription_created', { variant_id: 222, variant_name: 'Solo', order_id: 901, renews_at: '2026-10-15T00:00:00.000Z' }, 'sub_2'));
    expect(cheaper.body).toMatchObject({ action: 'conflict', reason: expect.stringMatching(/follows subscription sub_1/) });
    expect(await account()).toMatchObject({
      plan: 'themebot-studio-monthly', seats: 5, expiresAt: renewalExpiry(RENEWS), lemonSqueezy: { subscriptionId: 'sub_1', orderId: '900' },
      billingConflicts: [{ source: 'subscription:sub_2', kind: 'subscription', id: 'sub_2', event: 'subscription_created', seats: 1, status: 'active', variantId: '222' }],
    });
    expect((await auditOf(t, 'billing.conflict'))[0]).toMatchObject({ actor: 'lemonsqueezy', detail: { source: 'subscription:sub_2', event: 'subscription_created' } });
    expect((await t.admin('GET', '/billing-conflicts')).body.accounts.map((row: Record<string, any>) => row.email)).toEqual(['buyer@example.com']);
    // Its order is covered by the held subscription (not listed twice).
    expect((await t.webhook(order('901', { user_email: 'buyer@example.com' }, { variant_id: 222 }))).body.action).toBe('conflict');
    expect((await account())?.billingConflicts).toHaveLength(1);

    // Its payments, cancellation and expiry change nothing here.
    expect((await t.webhook(invoice('subscription_payment_success', 'inv_9', 'sub_2', 'paid'))).body.action).toBe('ignored');
    await t.webhook(subscription('subscription_cancelled', { variant_id: 222, order_id: 901, status: 'cancelled', ends_at: '2026-10-15T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z' }, 'sub_2'));
    await t.webhook(subscription('subscription_expired', { variant_id: 222, order_id: 901, status: 'expired', ends_at: '2026-10-15T00:00:00.000Z', updated_at: '2026-10-15T00:00:01.000Z' }, 'sub_2'));
    expect(await account()).toMatchObject({ seats: 5, status: 'active', usable: true, expiresAt: renewalExpiry(RENEWS), lemonSqueezy: { subscriptionId: 'sub_1' }, billingConflicts: [] });
    expect((await t.admin('GET', '/billing-conflicts')).body.accounts).toEqual([]);

    // The account's own subscription still applies normally.
    await t.webhook(subscription('subscription_updated', { renews_at: '2026-12-01T12:00:00.000Z', updated_at: '2026-11-01T12:00:05.000Z' }));
    expect((await account())?.expiresAt).toBe(renewalExpiry('2026-12-01T12:00:00.000Z'));
  });

  it('even a bigger second subscription does not displace a subscription in good standing', async () => {
    await t.webhook(subscription('subscription_created', {}));
    expect((await t.webhook(subscription('subscription_created', { variant_id: 333, order_id: 902, renews_at: '2027-10-01T00:00:00.000Z' }, 'sub_3'))).body.action).toBe('conflict');
    expect(await account()).toMatchObject({ seats: 5, lemonSqueezy: { subscriptionId: 'sub_1' }, billingConflicts: [{ source: 'subscription:sub_3', seats: 10 }] });
  });

  it("another subscription's payment never reactivates the account (matched by subscription id, not email)", async () => {
    await t.webhook(subscription('subscription_created', {}));
    await t.webhook(subscription('subscription_updated', { status: 'unpaid', updated_at: '2026-10-10T00:00:00.000Z' }));
    expect((await t.webhook(invoice('subscription_payment_success', 'inv_x', 'sub_somebody_else', 'paid'))).body).toMatchObject({ action: 'ignored', reason: 'not the subscription of any account' });
    expect((await account())?.status).toBe('inactive');
  });

  it("when the account's own subscription ends, a held subscription that is still active takes over", async () => {
    await t.webhook(subscription('subscription_created', {}));
    await t.webhook(subscription('subscription_created', { order_id: 903, renews_at: '2026-11-10T00:00:00.000Z', updated_at: '2026-10-01T13:00:00.000Z' }, 'sub_2'));
    await t.webhook(subscription('subscription_cancelled', { status: 'cancelled', ends_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z' }));
    expect(await account()).toMatchObject({ expiresAt: '2026-10-20T00:00:00.000Z', lemonSqueezy: { subscriptionId: 'sub_1' } });

    const expired = await t.webhook(subscription('subscription_expired', { status: 'expired', ends_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-10-20T00:00:01.000Z' }));
    expect(expired.body).toMatchObject({ action: 'updated', reason: expect.stringMatching(/now follows subscription:sub_2/) });
    expect(await account()).toMatchObject({ status: 'active', usable: true, expiresAt: renewalExpiry('2026-11-10T00:00:00.000Z'), lemonSqueezy: { subscriptionId: 'sub_2', orderId: '903' }, billingConflicts: [] });
    expect((await auditOf(t, 'billing.conflict_resolved'))[0].detail).toMatchObject({ source: 'subscription:sub_2', resolution: 'adopted', by: 'failover' });
    // From now on sub_2 is the account's own subscription.
    await t.webhook(subscription('subscription_updated', { order_id: 903, renews_at: '2026-12-10T00:00:00.000Z', updated_at: '2026-11-10T00:00:05.000Z' }, 'sub_2'));
    expect((await account())?.expiresAt).toBe(renewalExpiry('2026-12-10T00:00:00.000Z'));
  });

  it('the admin can adopt or dismiss a held purchase', async () => {
    await t.webhook(subscription('subscription_created', {}));
    await t.webhook(subscription('subscription_created', { variant_id: 222, order_id: 901 }, 'sub_2'));
    await t.webhook(subscription('subscription_created', { variant_id: 333, order_id: 902 }, 'sub_3'));
    const id = (await account())?.id as string;
    expect((await account())?.billingConflicts.map((c: Record<string, any>) => c.source).sort()).toEqual(['subscription:sub_2', 'subscription:sub_3']);

    expect((await t.admin('POST', `/accounts/${id}/billing-conflicts`, { source: 'subscription:nope', action: 'dismiss' })).status).toBe(404);
    expect((await t.admin('POST', `/accounts/${id}/billing-conflicts`, { source: 'sub_2', action: 'dismiss' })).status).toBe(400);
    const dismissed = await t.admin('POST', `/accounts/${id}/billing-conflicts`, { source: 'subscription:sub_2', action: 'dismiss' });
    expect(dismissed.body.account).toMatchObject({ seats: 5, lemonSqueezy: { subscriptionId: 'sub_1' }, billingConflicts: [{ source: 'subscription:sub_3' }] });
    // A dismissed purchase stays unlisted when it renews.
    await t.webhook(subscription('subscription_updated', { variant_id: 222, order_id: 901, renews_at: '2026-12-01T12:00:00.000Z', updated_at: '2026-11-01T13:00:00.000Z' }, 'sub_2'));
    expect((await account())?.billingConflicts.map((c: Record<string, any>) => c.source)).toEqual(['subscription:sub_3']);

    const adopted = await t.admin('POST', `/accounts/${id}/billing-conflicts`, { source: 'subscription:sub_3', action: 'adopt' });
    expect(adopted.body.account).toMatchObject({ seats: 10, lemonSqueezy: { subscriptionId: 'sub_3', orderId: '902', variantId: '333' }, billingConflicts: [] });
    expect((await auditOf(t, 'billing.conflict_resolved')).map((entry) => entry.detail)).toEqual([
      { source: 'subscription:sub_3', resolution: 'adopted', by: 'admin' },
      { source: 'subscription:sub_2', resolution: 'dismissed', by: 'admin' },
    ]);
    // The old subscription is now the one held.
    await t.webhook(subscription('subscription_updated', { renews_at: '2026-12-01T12:00:00.000Z', updated_at: '2026-11-01T12:00:05.000Z' }));
    expect(await account()).toMatchObject({ seats: 10, billingConflicts: [{ source: 'subscription:sub_1' }] });
  });

  it('a lifetime account keeps its lifetime when the same email subscribes', async () => {
    await t.webhook(order('ord_life', { user_email: 'buyer@example.com' }));
    const sub = await t.webhook(subscription('subscription_created', { order_id: 904 }, 'sub_9'));
    expect(sub.body).toMatchObject({ action: 'conflict', reason: expect.stringMatching(/already has access from order ord_life/) });
    // The subscription's own order arrives too: still held, listed once (under the subscription).
    expect((await t.webhook(order('904', { user_email: 'buyer@example.com' }, { variant_id: 111 }))).body.action).toBe('conflict');
    expect(await account()).toMatchObject({ plan: 'themebot', seats: 3, expiresAt: null, usable: true, lemonSqueezy: { orderId: 'ord_life', subscriptionId: null }, billingConflicts: [{ source: 'subscription:sub_9' }] });
  });

  it('a one-time order under the email of an account with access is held; refunding it closes the conflict', async () => {
    await t.webhook(order('ord_big', {}, { variant_id: 333 }));
    const small = await t.webhook(order('ord_small', { updated_at: '2026-10-02T00:00:00.000Z' }, { variant_id: 222 }));
    expect(small.body.action).toBe('conflict');
    expect(await account('once@example.com')).toMatchObject({ seats: 10, lemonSqueezy: { orderId: 'ord_big' }, billingConflicts: [{ source: 'order:ord_small', seats: 1 }] });
    const id = (await account('once@example.com'))?.id as string;
    await t.webhook(order('ord_small', { status: 'refunded', refunded: true, updated_at: '2026-10-03T00:00:00.000Z' }, { variant_id: 222 }, 'order_refunded'));
    expect(await account('once@example.com')).toMatchObject({ seats: 10, usable: true, billingConflicts: [] });
    expect((await t.admin('POST', `/accounts/${id}/billing-conflicts`, { source: 'order:ord_small', action: 'adopt' })).status).toBe(409);
  });

  it('an admin grant gives way to a subscription that gives at least as much, never to one that gives less', async () => {
    await t.createAccount('buyer@example.com', { plan: 'trial', seats: 3, expiresAt: new Date(t.now() + 7 * DAY).toISOString() });
    expect((await t.webhook(subscription('subscription_created', {}))).body.action).toBe('updated');
    expect(await account()).toMatchObject({ plan: 'themebot-studio-monthly', seats: 5, expiresAt: renewalExpiry(RENEWS), lemonSqueezy: { subscriptionId: 'sub_1' } });

    await t.createAccount('comp@example.com', { plan: 'partner', seats: 10, expiresAt: null });
    expect((await t.webhook(subscription('subscription_created', { user_email: 'comp@example.com' }, 'sub_comp'))).body.action).toBe('conflict');
    expect(await account('comp@example.com')).toMatchObject({ plan: 'partner', seats: 10, expiresAt: null, lemonSqueezy: { subscriptionId: null } });
  });

  it("a lapsed customer's new subscription takes the account over", async () => {
    await t.webhook(subscription('subscription_created', {}));
    await t.webhook(subscription('subscription_expired', { status: 'expired', ends_at: '2026-10-05T00:00:00.000Z', updated_at: '2026-10-05T00:00:01.000Z' }));
    expect((await account())?.usable).toBe(false);
    const fresh = await t.webhook(subscription('subscription_created', { order_id: 905, renews_at: '2026-11-06T00:00:00.000Z', updated_at: '2026-10-06T00:00:00.000Z' }, 'sub_new'));
    expect(fresh.body.action).toBe('updated');
    expect(await account()).toMatchObject({ status: 'active', usable: true, lemonSqueezy: { subscriptionId: 'sub_new' } });
  });
});

describe('legit flows still work', () => {
  it('renewal: payment then subscription_updated with the next renewal date', async () => {
    await t.webhook(subscription('subscription_created', {}));
    expect((await t.webhook(invoice('subscription_payment_success', 'inv_r', 'sub_1', 'paid'))).body).toMatchObject({ action: 'ignored', reason: 'recorded only' });
    await t.webhook(subscription('subscription_updated', { renews_at: '2026-12-01T12:00:00.000Z', updated_at: '2026-11-01T12:00:05.000Z' }));
    expect(await account()).toMatchObject({ status: 'active', expiresAt: renewalExpiry('2026-12-01T12:00:00.000Z') });
  });

  it('plan upgrade and downgrade on the same subscription change the seats both ways', async () => {
    await t.webhook(subscription('subscription_created', {}));
    await t.webhook(subscription('subscription_updated', { variant_id: 333, variant_name: 'Agency', updated_at: '2026-10-02T00:00:00.000Z' }));
    expect(await account()).toMatchObject({ seats: 10, plan: 'themebot-studio-agency', billingConflicts: [] });
    await t.webhook(subscription('subscription_updated', { variant_id: 222, variant_name: 'Solo', updated_at: '2026-10-03T00:00:00.000Z' }));
    expect(await account()).toMatchObject({ seats: 1, plan: 'themebot-studio-solo', billingConflicts: [] });
  });

  it('cancelled runs to the end of the period; expired makes the account inactive; resume brings it back', async () => {
    await t.webhook(subscription('subscription_created', {}));
    await t.webhook(subscription('subscription_cancelled', { status: 'cancelled', ends_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z' }));
    expect(await account()).toMatchObject({ status: 'active', usable: true, expiresAt: '2026-10-20T00:00:00.000Z' });
    t.advance(20 * DAY);
    expect((await account())?.usable).toBe(false);

    await t.webhook(subscription('subscription_expired', { status: 'expired', ends_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-10-20T00:00:01.000Z' }));
    expect(await account()).toMatchObject({ status: 'inactive', usable: false });
    await t.webhook(subscription('subscription_resumed', { status: 'active', renews_at: '2026-12-01T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z' }));
    expect(await account()).toMatchObject({ status: 'active', usable: true });
  });

  it('cancel then resume before the period ends', async () => {
    await t.webhook(subscription('subscription_created', {}));
    await t.webhook(subscription('subscription_cancelled', { status: 'cancelled', ends_at: RENEWS, updated_at: '2026-10-02T00:00:00.000Z' }));
    await t.webhook(subscription('subscription_resumed', { status: 'active', updated_at: '2026-10-03T00:00:00.000Z' }));
    expect(await account()).toMatchObject({ status: 'active', usable: true, expiresAt: renewalExpiry(RENEWS), lemonSqueezy: { status: 'active' }, billingConflicts: [] });
  });

  it('order_created first, then its subscription: the subscription takes over with its dates', async () => {
    expect((await t.webhook(order('900', { user_email: 'buyer@example.com' }, { variant_id: 111 }))).body.action).toBe('created');
    expect(await account()).toMatchObject({ expiresAt: null, lemonSqueezy: { orderId: '900' } });
    const sub = await t.webhook(subscription('subscription_created', {}));
    expect(sub.body).toMatchObject({ action: 'updated', reason: expect.stringMatching(/order this account came from/) });
    expect(await account()).toMatchObject({ seats: 5, expiresAt: renewalExpiry(RENEWS), lemonSqueezy: { subscriptionId: 'sub_1', orderId: '900' }, billingConflicts: [] });
  });
});
