import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { db } from '../server/db';
import { decrypt, encrypt } from '../server/security';
import { createFactoryRouter } from '../server/factory/routes';

const CLIENT_ID = 'a'.repeat(32);
const CLIENT_SECRET = 'shpss_test_secret';

describe('factory store repository (006)', () => {
  it('upserts by shop_domain, refreshes secrets, and never erases a stored password with null', async () => {
    const suffix = Math.random().toString(36).slice(2, 9);
    const domain = `store-${suffix}.myshopify.com`;

    const created = await db.upsertFactoryStore({ label: 'Test Store', shop_domain: domain, client_id: CLIENT_ID, client_secret_cipher: encrypt(CLIENT_SECRET), storefront_password_cipher: encrypt('pw123') });
    expect(created.id).toBeTruthy();
    expect(decrypt(created.client_secret_cipher)).toBe(CLIENT_SECRET);

    // Re-save same domain with a new secret but NO password → updates in place, password kept.
    const updated = await db.upsertFactoryStore({ label: 'Renamed', shop_domain: domain, client_id: CLIENT_ID, client_secret_cipher: encrypt('shpss_rotated'), storefront_password_cipher: null });
    expect(updated.id).toBe(created.id);
    expect(updated.label).toBe('Renamed');
    expect(decrypt(updated.client_secret_cipher)).toBe('shpss_rotated');
    expect(decrypt(updated.storefront_password_cipher!)).toBe('pw123');

    expect((await db.listFactoryStores()).filter((store) => store.shop_domain === domain)).toHaveLength(1);
    expect((await db.getFactoryStore(created.id))?.shop_domain).toBe(domain);
    expect(await db.deleteFactoryStore(created.id)).toBe(true);
    expect(await db.getFactoryStore(created.id)).toBeNull();
  });
});

describe('factory stores routes + canary write-test', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/factory', createFactoryRouter());
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('saves a store without echoing secrets, then validates + canary-tests it server-side', async () => {
    const suffix = Math.random().toString(36).slice(2, 9);
    const domain = `route-${suffix}.myshopify.com`;

    // Save credentials (no network calls on this path).
    const saveResponse = await fetch(`${base}/api/factory/stores`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Route Store', storeUrl: domain, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, storefrontPassword: 'pw123' }),
    });
    expect(saveResponse.status).toBe(201);
    const { store } = await saveResponse.json() as { store: { id: string; shop_domain: string; has_storefront_password: boolean; client_secret_cipher?: string; storefront_password_cipher?: string } };
    expect(store.shop_domain).toBe(domain);
    expect(store.has_storefront_password).toBe(true);
    // Public shape must never carry ciphers or secrets.
    expect(store.client_secret_cipher).toBeUndefined();
    expect(store.storefront_password_cipher).toBeUndefined();
    expect(JSON.stringify(store)).not.toContain(CLIENT_SECRET);

    // Stub outbound Shopify calls only; loopback calls keep working.
    const shopifyCalls: string[] = [];
    const realFetch = globalThis.fetch;
    const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('myshopify.com')) return realFetch(input, init);
      shopifyCalls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/admin/oauth/access_token')) return jsonResponse({ access_token: 'shpat_mock', scope: 'write_themes,read_themes' });
      if (url.includes('/shop.json')) return jsonResponse({ shop: { name: 'Route Store' } });
      if (url.includes('/themes.json')) return jsonResponse({ themes: [{ id: 42, name: 'Dawn', role: 'main' }] });
      if (url.includes('/themes/42/assets.json')) return jsonResponse({ asset: { key: 'snippets/__themebot_canary.liquid' } });
      return jsonResponse({}, 404);
    });
    try {
      const testResponse = await fetch(`${base}/api/factory/stores/${store.id}/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canary: true }),
      });
      expect(testResponse.status).toBe(200);
      const result = await testResponse.json() as { ok: boolean; shopName: string | null; push?: { ok: boolean; detail: string } };
      expect(result.ok).toBe(true);
      expect(result.shopName).toBe('Route Store');
      expect(result.push?.ok).toBe(true);
      expect(result.push?.detail).toContain('Dawn');
      // Canary wrote AND deleted the snippet on the main theme.
      expect(shopifyCalls.some((call) => call.startsWith('PUT ') && call.includes('/themes/42/assets.json'))).toBe(true);
      expect(shopifyCalls.some((call) => call.startsWith('DELETE ') && call.includes(encodeURIComponent('snippets/__themebot_canary.liquid')))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }

    // Cleanup.
    const deleteResponse = await fetch(`${base}/api/factory/stores/${store.id}`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(204);
  });
});
