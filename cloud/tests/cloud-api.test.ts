import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publicKeyFromRaw, verifyPass } from '../src/passes';
import { ADMIN, FP_A, FP_B, FP_C, MINUTE, startTestCloud, type TestCloud } from './helpers';

let t: TestCloud;
beforeEach(async () => { t = await startTestCloud(); });
afterEach(async () => { await t.close(); });

describe('cloud basics', () => {
  it('serves health, the public key and locked-down headers', async () => {
    const health = await fetch(`${t.base}/v1/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('x-powered-by')).toBeNull();
    const key = await t.call('GET', '/v1/public-key');
    expect(key.body).toEqual({ algorithm: 'Ed25519', publicKey: t.publicKey });
    expect((await t.call('GET', '/v1/nope')).body.code).toBe('NOT_FOUND');
  });

  it('measures the 16 kB body limit after inflating gzip (a small bomb is refused)', async () => {
    const bomb = gzipSync(JSON.stringify({ email: 'a@example.com', pad: ' '.repeat(2 * 1024 * 1024) }));
    expect(bomb.length).toBeLessThan(16 * 1024);
    const response = await fetch(`${t.base}/v1/auth/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: bomb });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe('TOO_LARGE');
    // An unauthenticated caller never gets a QA-sized body read: the pass check comes first.
    const qa = await fetch(`${t.base}/v1/qa/sections`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: gzipSync(JSON.stringify({ pad: ' '.repeat(4 * 1024 * 1024) })) });
    expect(((await qa.json()) as { code: string }).code).toBe('PASS_REQUIRED');
  });

  it('guards the admin API with the admin token', async () => {
    expect((await t.call('GET', '/v1/admin/accounts')).status).toBe(401);
    const wrong = await t.call('GET', '/v1/admin/accounts', undefined, { Authorization: `Bearer ${ADMIN}x` });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('UNAUTHORIZED');
    expect((await t.admin('GET', '/accounts')).status).toBe(200);
  });
});

describe('sign-in', () => {
  it('answers the same for unknown emails and sends nothing', async () => {
    await t.createAccount('known@example.com', { seats: 1 });
    const known = await t.call('POST', '/v1/auth/start', { email: 'Known@Example.com ' });
    const unknown = await t.call('POST', '/v1/auth/start', { email: 'nobody@example.com' });
    expect(known.status).toBe(200);
    expect(unknown).toEqual(known);
    expect(t.sent.map((mail) => mail.to)).toEqual(['known@example.com']);
    expect((await t.call('POST', '/v1/auth/start', { email: 'not-an-email' })).status).toBe(400);
  });

  it('emails an inactive account a notice instead of a code', async () => {
    await t.createAccount('lapsed@example.com', { expiresAt: new Date(t.now() - MINUTE).toISOString() });
    expect((await t.call('POST', '/v1/auth/start', { email: 'lapsed@example.com' })).status).toBe(200);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].subject).toMatch(/not active/);
    expect(() => t.lastCode('lapsed@example.com')).toThrow();
  });

  it('signs in, heartbeats a valid pass, and the pass opens /v1/session until it expires', async () => {
    const account = await t.createAccount('owner@example.com', { seats: 2, plan: 'studio' });
    const signIn = await t.signIn('owner@example.com', { fingerprint: FP_A, name: 'Office PC' });
    expect(signIn.status).toBe(200);
    expect(signIn.body.refreshToken).toMatch(/^tbr_/);
    expect(signIn.body.account).toEqual({ email: 'owner@example.com', plan: 'studio', seats: 2, expiresAt: null });

    const beat = await t.heartbeat(signIn.body.refreshToken, FP_A, '1.2.0');
    expect(beat.status).toBe(200);
    expect(beat.body.minAppVersion).toBe('0.0.0');
    expect(Date.parse(beat.body.passExpiresAt)).toBe(t.now() + 15 * MINUTE);
    const check = verifyPass(beat.body.pass, publicKeyFromRaw(t.publicKey), t.now());
    expect(check.ok && check.payload).toMatchObject({ v: 1, acc: account.id, plan: 'studio', seats: 2, ver: '1.2.0' });

    const session = await t.call('GET', '/v1/session', undefined, { Authorization: `Pass ${beat.body.pass}` });
    expect(session.status).toBe(200);
    expect(session.body.device.name).toBe('Office PC');
    expect((await t.call('GET', '/v1/session')).body.code).toBe('PASS_REQUIRED');
    t.advance(16 * MINUTE);
    expect((await t.call('GET', '/v1/session', undefined, { Authorization: `Pass ${beat.body.pass}` })).body.code).toBe('PASS_EXPIRED');
  });

  it('rejects wrong codes, locks after 5 tries, and expires codes after 10 minutes', async () => {
    await t.createAccount('codes@example.com');
    await t.call('POST', '/v1/auth/start', { email: 'codes@example.com' });
    const code = t.lastCode('codes@example.com');
    const wrongCode = code === '000000' ? '111111' : '000000';
    const device = { fingerprint: FP_A, name: 'PC', platform: 'win32', appVersion: '1.0.0' };
    const first = await t.call('POST', '/v1/auth/verify', { email: 'codes@example.com', code: wrongCode, device });
    expect(first.status).toBe(400);
    expect(first.body).toMatchObject({ code: 'INVALID_CODE', attemptsLeft: 4 });
    for (let attempt = 0; attempt < 4; attempt += 1) await t.call('POST', '/v1/auth/verify', { email: 'codes@example.com', code: wrongCode, device });
    const locked = await t.call('POST', '/v1/auth/verify', { email: 'codes@example.com', code, device });
    expect(locked.body).toMatchObject({ code: 'INVALID_CODE', expired: true });

    await t.call('POST', '/v1/auth/start', { email: 'codes@example.com' });
    const fresh = t.lastCode('codes@example.com');
    t.advance(11 * MINUTE);
    expect((await t.call('POST', '/v1/auth/verify', { email: 'codes@example.com', code: fresh, device })).body).toMatchObject({ code: 'INVALID_CODE', expired: true });
  });

  it('rate limits code requests per email', async () => {
    await t.createAccount('busy@example.com');
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await t.call('POST', '/v1/auth/start', { email: 'busy@example.com' })).status).toBe(200);
    const limited = await t.call('POST', '/v1/auth/start', { email: 'busy@example.com' });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });

  it('caps wrong codes per email per day across fresh codes, so guessing cannot go on all day', async () => {
    const email = 'target@example.com';
    await t.createAccount(email);
    const device = { fingerprint: FP_A, name: 'PC', platform: 'win32', appVersion: '1.0.0' };
    // Six fresh codes, five wrong guesses each = 30 (the per-15-minute limits allow far more per day).
    for (let round = 0; round < 6; round += 1) {
      t.advance(16 * MINUTE);
      await t.call('POST', '/v1/auth/start', { email });
      const code = t.lastCode(email);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let guess = 0; guess < 5; guess += 1) expect((await t.call('POST', '/v1/auth/verify', { email, code: wrong, device })).body.code).toBe('INVALID_CODE');
    }
    t.advance(16 * MINUTE);
    await t.call('POST', '/v1/auth/start', { email });
    const locked = await t.call('POST', '/v1/auth/verify', { email, code: t.lastCode(email), device });
    expect([locked.status, locked.body.code]).toEqual([429, 'RATE_LIMITED']); // even the right code
    // A day after those guesses the account signs in normally again.
    t.advance(24 * 60 * MINUTE);
    expect((await t.signIn(email, { fingerprint: FP_A })).status).toBe(200);
  });

  it('stops emailing codes after 15 a day, with the same answer as always', async () => {
    const email = 'inbox@example.com';
    await t.createAccount(email);
    for (let request = 0; request < 18; request += 1) {
      if (request % 5 === 0) t.advance(16 * MINUTE);
      const answer = await t.call('POST', '/v1/auth/start', { email });
      expect(answer.body).toEqual({ ok: true, expiresInSec: 600 });
    }
    expect(t.sent.filter((mail) => mail.to === email)).toHaveLength(15);
  });
});

describe('seats', () => {
  it('refuses a second computer on a 1-seat plan and says where the seat is used', async () => {
    await t.createAccount('solo@example.com', { seats: 1 });
    const first = await t.signIn('solo@example.com', { fingerprint: FP_A, name: 'Desk PC' });
    expect(first.status).toBe(200);
    const second = await t.signIn('solo@example.com', { fingerprint: FP_B, name: 'Laptop' });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'SEATS_FULL', seats: 1, devices: [{ name: 'Desk PC', platform: 'win32', active: true }] });
    // The same computer signing in again is not a second seat.
    expect((await t.signIn('solo@example.com', { fingerprint: FP_A, name: 'Desk PC' })).status).toBe(200);
  });

  it('frees the seat 15 minutes after the last heartbeat', async () => {
    await t.createAccount('solo@example.com', { seats: 1 });
    const desk = await t.signIn('solo@example.com', { fingerprint: FP_A, name: 'Desk PC' });
    t.advance(14 * MINUTE);
    expect((await t.signIn('solo@example.com', { fingerprint: FP_B })).body.code).toBe('SEATS_FULL');
    t.advance(2 * MINUTE); // 16 minutes since the desk PC was last seen
    const laptop = await t.signIn('solo@example.com', { fingerprint: FP_B, name: 'Laptop' });
    expect(laptop.status).toBe(200);
    // The desk PC comes back: the laptop holds the seat now.
    const back = await t.heartbeat(desk.body.refreshToken, FP_A);
    expect(back.body).toMatchObject({ code: 'SEATS_FULL', devices: [{ name: 'Laptop' }] });
    expect((await t.heartbeat(laptop.body.refreshToken, FP_B)).status).toBe(200);
  });

  it('signing out frees the seat at once and ends that session', async () => {
    await t.createAccount('solo@example.com', { seats: 1 });
    const desk = await t.signIn('solo@example.com', { fingerprint: FP_A });
    // On SEATS_FULL the code stays usable: sign out elsewhere, then retry with the same code.
    await t.call('POST', '/v1/auth/start', { email: 'solo@example.com' });
    const code = t.lastCode('solo@example.com');
    const device = { fingerprint: FP_B, name: 'Laptop', platform: 'darwin', appVersion: '1.0.0' };
    expect((await t.call('POST', '/v1/auth/verify', { email: 'solo@example.com', code, device })).body.code).toBe('SEATS_FULL');
    expect((await t.call('POST', '/v1/devices/signout', { refreshToken: desk.body.refreshToken })).body).toEqual({ ok: true });
    expect((await t.call('POST', '/v1/auth/verify', { email: 'solo@example.com', code, device })).status).toBe(200);
    expect((await t.heartbeat(desk.body.refreshToken, FP_A)).body.code).toBe('SIGNED_OUT');
    expect((await t.call('POST', '/v1/devices/signout', { refreshToken: desk.body.refreshToken })).body).toEqual({ ok: true }); // idempotent
  });

  it('closing the app hands the seat back but stays signed in', async () => {
    await t.createAccount('solo@example.com', { seats: 1 });
    const desk = await t.signIn('solo@example.com', { fingerprint: FP_A });
    expect((await t.call('POST', '/v1/devices/release', { refreshToken: desk.body.refreshToken })).status).toBe(200);
    const laptop = await t.signIn('solo@example.com', { fingerprint: FP_B });
    expect(laptop.status).toBe(200);
    expect((await t.heartbeat(desk.body.refreshToken, FP_A)).body.code).toBe('SEATS_FULL');
    await t.call('POST', '/v1/devices/release', { refreshToken: laptop.body.refreshToken });
    expect((await t.heartbeat(desk.body.refreshToken, FP_A)).status).toBe(200);
  });

  it('a pass stops working once its seat is handed back, so computers cannot take turns on one seat', async () => {
    await t.createAccount('turns@example.com', { seats: 1 });
    const session = (pass: string) => t.call('GET', '/v1/session', undefined, { Authorization: `Pass ${pass}` });
    const desk = await t.signIn('turns@example.com', { fingerprint: FP_A });
    const deskPass = (await t.heartbeat(desk.body.refreshToken, FP_A)).body.pass as string;
    expect((await session(deskPass)).status).toBe(200);
    // Hand the seat back and let a second computer take it, while the first pass is still unexpired.
    await t.call('POST', '/v1/devices/release', { refreshToken: desk.body.refreshToken });
    expect((await session(deskPass)).body.code).toBe('PASS_EXPIRED');
    const laptop = await t.signIn('turns@example.com', { fingerprint: FP_B });
    expect(laptop.status).toBe(200);
    const laptopPass = (await t.heartbeat(laptop.body.refreshToken, FP_B)).body.pass as string;
    expect((await session(laptopPass)).status).toBe(200);
    expect((await session(deskPass)).body.code).toBe('PASS_EXPIRED'); // one seat, one working computer
    expect((await t.heartbeat(desk.body.refreshToken, FP_A)).body.code).toBe('SEATS_FULL');
    // The normal flow is untouched: a computer that keeps heartbeating keeps working.
    t.advance(5 * MINUTE);
    const next = (await t.heartbeat(laptop.body.refreshToken, FP_B)).body.pass as string;
    expect((await session(next)).status).toBe(200);
  });

  it('when seats are cut, the longest-running computers keep theirs', async () => {
    const account = await t.createAccount('team@example.com', { seats: 2 });
    const a = await t.signIn('team@example.com', { fingerprint: FP_A, name: 'A' });
    t.advance(MINUTE);
    const b = await t.signIn('team@example.com', { fingerprint: FP_B, name: 'B' });
    expect((await t.signIn('team@example.com', { fingerprint: FP_C, name: 'C' })).body.code).toBe('SEATS_FULL');
    await t.admin('POST', '/accounts', { email: account.email, seats: 1 });
    expect((await t.heartbeat(a.body.refreshToken, FP_A)).status).toBe(200);
    expect((await t.heartbeat(b.body.refreshToken, FP_B)).body.code).toBe('SEATS_FULL');
    expect((await t.heartbeat(a.body.refreshToken, FP_A)).status).toBe(200);
  });

  it('a refresh token only works from the computer it was issued to', async () => {
    await t.createAccount('owner@example.com');
    const desk = await t.signIn('owner@example.com', { fingerprint: FP_A });
    expect((await t.heartbeat(desk.body.refreshToken, FP_B)).body.code).toBe('SIGNED_OUT');
    expect((await t.heartbeat('tbr_made_up', FP_A)).body.code).toBe('SIGNED_OUT');
    expect((await t.heartbeat(desk.body.refreshToken, FP_A)).status).toBe(200);
  });
});

describe('account and version gates', () => {
  it('UPDATE_REQUIRED below the minimum app version (sign-in and heartbeat)', async () => {
    await t.createAccount('owner@example.com');
    const desk = await t.signIn('owner@example.com', { fingerprint: FP_A, appVersion: '1.0.0' });
    const set = await t.admin('POST', '/settings', { minAppVersion: '1.5.0' });
    expect(set.body.minAppVersion).toBe('1.5.0');
    const old = await t.heartbeat(desk.body.refreshToken, FP_A, '1.0.0');
    expect(old.status).toBe(426);
    expect(old.body).toMatchObject({ code: 'UPDATE_REQUIRED', minAppVersion: '1.5.0' });
    expect((await t.signIn('owner@example.com', { fingerprint: FP_B, appVersion: '1.4.9' })).body.code).toBe('UPDATE_REQUIRED');
    const updated = await t.heartbeat(desk.body.refreshToken, FP_A, '1.5.0');
    expect(updated.status).toBe(200);
    expect(updated.body.minAppVersion).toBe('1.5.0');
    expect((await t.admin('POST', '/settings', { minAppVersion: 'latest' })).status).toBe(400);
  });

  it('revoking an account refuses heartbeats and passes; restoring brings it back', async () => {
    const account = await t.createAccount('owner@example.com');
    const desk = await t.signIn('owner@example.com', { fingerprint: FP_A });
    const pass = (await t.heartbeat(desk.body.refreshToken, FP_A)).body.pass as string;
    await t.admin('POST', `/accounts/${account.id}/revoke`);
    const refused = await t.heartbeat(desk.body.refreshToken, FP_A);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCOUNT_INACTIVE');
    expect((await t.call('GET', '/v1/session', undefined, { Authorization: `Pass ${pass}` })).body.code).toBe('ACCOUNT_INACTIVE');
    await t.admin('POST', `/accounts/${account.id}/restore`);
    expect((await t.heartbeat(desk.body.refreshToken, FP_A)).status).toBe(200);
  });

  it('an admin can sign a device out', async () => {
    await t.createAccount('owner@example.com');
    const desk = await t.signIn('owner@example.com', { fingerprint: FP_A, name: 'Desk' });
    const listed = await t.admin('GET', '/accounts?email=owner@example.com');
    const device = listed.body.accounts[0].devices[0];
    expect(device).toMatchObject({ name: 'Desk', active: true, signedOut: false });
    expect((await t.admin('POST', `/devices/${device.id}/release`)).body).toEqual({ ok: true });
    expect((await t.heartbeat(desk.body.refreshToken, FP_A)).body.code).toBe('SIGNED_OUT');
    const audit = await t.admin('GET', '/audit');
    expect(audit.body.entries.map((entry: { action: string }) => entry.action)).toContain('device.signed_out');
    expect(JSON.stringify(audit.body)).not.toContain(desk.body.refreshToken);
  });
});
