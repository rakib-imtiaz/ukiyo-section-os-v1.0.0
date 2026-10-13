import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PASS_TTL_SEC, rawPublicKey, signPass } from '../cloud/src/passes';

const keys = generateKeyPairSync('ed25519');
const MINUTE = 60_000;
const passAt = (iatMs: number, key = keys.privateKey) => {
  const iat = Math.floor(iatMs / 1000);
  return signPass({ v: 1, acc: 'acc_1', dev: 'dev_1', plan: 'studio', seats: 3, ver: '1.0.0', iat, exp: iat + PASS_TTL_SEC }, key);
};
const account = { email: 'owner@example.com', plan: 'studio', seats: 3, expiresAt: null };

/** cloud-client reads its env once, at import — load a fresh copy per scenario. */
async function freshClient(cloud: boolean) {
  vi.resetModules();
  if (cloud) {
    process.env.THEMEBOT_CLOUD_URL = 'http://127.0.0.1:8800';
    process.env.THEMEBOT_CLOUD_PUBKEY = rawPublicKey(keys.privateKey);
  } else {
    delete process.env.THEMEBOT_CLOUD_URL;
    delete process.env.THEMEBOT_CLOUD_PUBKEY;
  }
  return import('../server/cloud-client');
}

afterEach(() => {
  delete process.env.THEMEBOT_CLOUD_URL;
  delete process.env.THEMEBOT_CLOUD_PUBKEY;
  vi.useRealTimers();
});

describe('ThemeBot Cloud pass on the local server', () => {
  it('changes nothing when the build has no Cloud configured', async () => {
    const client = await freshClient(false);
    expect(client.buildsBlockedReason()).toBeNull();
    expect(client.cloudStatus()).toMatchObject({ required: false, signedIn: false, offline: false });
  });

  it('holds passes from the desktop host, refuses forged ones, and expires after 15 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-10-01T12:00:00Z');
    vi.setSystemTime(start);
    const client = await freshClient(true);
    expect(client.buildsBlockedReason()).toMatch(/Sign in to ThemeBot/);

    expect(client.handleHostMessage({ type: 'pass', token: passAt(start), account })).toBe(true);
    expect(client.buildsBlockedReason()).toBeNull();
    expect(client.cloudStatus()).toMatchObject({ required: true, signedIn: true, email: 'owner@example.com', offline: false, passExpiresAt: new Date(start + 15 * MINUTE).toISOString() });

    const forger = generateKeyPairSync('ed25519');
    expect(client.acceptPass(passAt(start + MINUTE, forger.privateKey))).toBe(false);
    expect(client.currentPass()?.payload.iat).toBe(start / 1000); // the real pass is kept

    vi.setSystemTime(start + 16 * MINUTE);
    expect(client.currentPass()).toBeNull();
    expect(client.buildsBlockedReason()).toMatch(/can't reach its servers/);
    expect(client.cloudStatus()).toMatchObject({ signedIn: false, offline: true, email: 'owner@example.com' });
    expect(() => client.requireValidPass()).toThrow(client.CloudPassError);
    // The code lets a build that was already running say "paused — press Resume" in the right words.
    expect((() => { try { client.requireValidPass(); } catch (error) { return (error as InstanceType<typeof client.CloudPassError>).code; } })()).toBe('OFFLINE');

    client.handleHostMessage({ type: 'signed-out' });
    expect(client.buildsBlockedReason()).toMatch(/Sign in to ThemeBot/);
    expect((() => { try { client.requireValidPass(); } catch (error) { return (error as InstanceType<typeof client.CloudPassError>).code; } })()).toBe('SIGNED_OUT');
    expect(client.cloudStatus().email).toBeNull();
  });

  it('started offline: says so, still shows who is signed in, and a later pass clears it', async () => {
    const client = await freshClient(true);
    client.handleHostMessage({ type: 'cloud-offline', account });
    expect(client.cloudStatus()).toMatchObject({ signedIn: false, offline: true, email: 'owner@example.com' });
    expect(client.buildsBlockedReason()).toMatch(/can't reach its servers/);
    const ticks: number[] = [];
    client.onCloudChange(() => ticks.push(1));
    client.handleHostMessage({ type: 'pass', token: passAt(Date.now()) });
    expect(client.cloudStatus()).toMatchObject({ signedIn: true, offline: false, email: 'owner@example.com' });
    expect(ticks).toHaveLength(1); // the server ticks the build queue on this
    expect(client.acceptPass(client.currentPass()!.token)).toBe(false); // a resend is not news
  });

  it('a computer clock that is off still gets the full 15 minutes, and no more', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const local = Date.parse('2026-10-01T12:00:00Z');
    vi.setSystemTime(local);
    const client = await freshClient(true);
    // The Cloud's clock is 10 minutes ahead of this PC's.
    expect(client.acceptPass(passAt(local + 10 * MINUTE), account)).toBe(true);
    vi.setSystemTime(local + 14 * MINUTE);
    expect(client.currentPass()).not.toBeNull();
    vi.setSystemTime(local + 15 * MINUTE + 1000);
    expect(client.currentPass()).toBeNull();
  });

  it('build-starting factory routes answer 403 without a valid pass', async () => {
    const client = await freshClient(true);
    const { createFactoryRouter } = await import('../server/factory/routes');
    const app = express();
    app.use(express.json());
    app.use('/api/factory', createFactoryRouter());
    const server = await new Promise<Server>((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/factory`;
    const post = (route: string, body: unknown = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      for (const route of ['/jobs', '/easy/start', '/easy/resume', '/jobs/nope/check', '/jobs/nope/fix', '/jobs/nope/rebuild', '/jobs/nope/retry', '/jobs/nope/start']) {
        const response = await post(route);
        expect(response.status, route).toBe(403);
        expect((await response.json() as { error: string }).error).toMatch(/Sign in to ThemeBot/);
      }
      client.acceptPass(passAt(Date.now()), account);
      const allowed = await post('/jobs/nope/start');
      expect(allowed.status).toBe(404); // past the guard: the job just doesn't exist
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('cloudFetch answers', () => {
  it('a 200 whose body is not JSON (cut off, a proxy page) is a failed call, never an empty success', async () => {
    const app = express();
    app.post('/v1/builds/bld_x/next', (_request, response) => { response.status(200).type('text/html').send('<html>captive portal</html>'); });
    app.post('/v1/ok', (_request, response) => { response.json({ ok: true }); });
    const server = await new Promise<Server>((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    try {
      vi.resetModules();
      process.env.THEMEBOT_CLOUD_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      process.env.THEMEBOT_CLOUD_PUBKEY = rawPublicKey(keys.privateKey);
      const client = await import('../server/cloud-client');
      expect(client.acceptPass(passAt(Date.now()), account)).toBe(true);
      const refused = await client.cloudFetch('/v1/builds/bld_x/next', { session: 'abcdefgh' }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(client.CloudRequestError);
      expect(refused).toMatchObject({ status: 0, code: 'OFFLINE' }); // transient: QA retries it, a build pauses with "check your connection"
      expect(await client.cloudFetch('/v1/ok', {})).toEqual({ ok: true });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('cloudFetch against the real Cloud app', () => {
  it('gzips bodies over 16 kB, which the QA parser inflates; small bodies go plain; limits apply after inflating', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { startQaCloud } = await import('../cloud/tests/qa-harness');
    const t = await startQaCloud();
    try {
      const pass = await t.pass('gzip@example.com');
      vi.resetModules();
      process.env.THEMEBOT_CLOUD_URL = t.base;
      process.env.THEMEBOT_CLOUD_PUBKEY = t.publicKey;
      const client = await import('../server/cloud-client');
      expect(client.acceptPass(pass, account)).toBe(true);

      const capture = JSON.parse(readFileSync(path.resolve('tests/fixtures/qa/canned/capture-sections.json'), 'utf8'));
      const small = { buildRef: 'job-1', iter: 1, reactBase: capture.reactBase, shopifyBase: capture.shopifyBase, routes: capture.routes };
      const big = { ...small, routes: Array.from({ length: 40 }, (_, index) => ({ ...capture.routes[0], route: `/r${index}` })) };

      const plain = await client.encodeBody(small);
      expect(plain.headers['Content-Encoding']).toBeUndefined();
      expect(typeof plain.payload).toBe('string');
      const zipped = await client.encodeBody(big);
      expect(zipped.bytes).toBeGreaterThan(100 * 1024);
      expect(zipped.headers['Content-Encoding']).toBe('gzip');
      expect((zipped.payload as Uint8Array).byteLength).toBeLessThan(zipped.bytes / 4);

      const scoredSmall = await client.cloudFetch<{ report: { pages: unknown[] } }>('/v1/qa/sections', small);
      expect(scoredSmall.report.pages.length).toBeGreaterThan(0);
      const scoredBig = await client.cloudFetch<{ report: { pages: unknown[] } }>('/v1/qa/sections', big);
      expect(scoredBig.report.pages).toHaveLength(40);

      // The step routes sit behind the app-wide 16 kB parser: a gzipped body is measured inflated
      // (no zip-bomb way around it), which is why the app keeps step bodies small.
      const tooBig = { name: 'x', prefix: 'ab', storeHost: 'a.myshopify.com', reactUrl: 'https://a.example.com', root: 'C:\b', rebuiltRoutes: Array.from({ length: 200 }, (_, index) => `/${'p'.repeat(150)}${index}`) };
      expect((await client.encodeBody(tooBig)).headers['Content-Encoding']).toBe('gzip');
      const refused = await client.cloudFetch('/v1/builds', tooBig).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(client.CloudRequestError);
      expect(refused).toMatchObject({ status: 413, code: 'TOO_LARGE' });

      // A corrupt gzip body or an encoding the Cloud doesn't take is the client's fault: a 4xx
      // (not retried as a server hiccup), never a 500.
      const raw = (encoding: string) => fetch(`${t.base}/v1/qa/sections`, { method: 'POST', headers: { Authorization: `Pass ${pass}`, 'Content-Type': 'application/json', 'Content-Encoding': encoding }, body: Buffer.from('definitely not gzip') });
      const corrupt = await raw('gzip');
      expect([corrupt.status, ((await corrupt.json()) as { code: string }).code]).toEqual([400, 'BAD_REQUEST']);
      const unsupported = await raw('compress');
      expect([unsupported.status, ((await unsupported.json()) as { code: string }).code]).toEqual([415, 'UNSUPPORTED_ENCODING']);
      const tiny = await fetch(`${t.base}/v1/auth/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: Buffer.from('garbage') });
      expect(tiny.status).toBe(400);
    } finally {
      await t.close();
    }
  });
});
