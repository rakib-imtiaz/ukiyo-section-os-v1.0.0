// Refresh-token rotation with reuse detection (cloud/src/tokens.ts) through the real HTTP API.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudDb, SUPERSEDED_TOKEN_DAYS } from '../src/db';
import { publicKeyFromRaw, verifyPass } from '../src/passes';
import { FP_A, FP_B, MINUTE, startTestCloud, type TestCloud } from './helpers';

const DAY = 24 * 60 * MINUTE;
const REUSE = "This computer's sign-in was used somewhere else, so it was signed out. Sign in again.";

let t: TestCloud;
beforeEach(async () => { t = await startTestCloud(); });
afterEach(async () => { await t.close(); });

const newKey = () => randomBytes(32).toString('base64url');
/** A heartbeat as a rotating app sends it (with `key`), or as an older app does (without). */
const beat = (refreshToken: string, key?: string, fingerprint = FP_A) =>
  t.call('POST', '/v1/devices/heartbeat', { refreshToken, fingerprint, appVersion: '1.0.0', ...(key ? { rotate: true, rotationKey: key } : {}) });
const session = (pass: string) => t.call('GET', '/v1/session', undefined, { Authorization: `Pass ${pass}` });
const events = async (accountId: string) => ((await t.admin('GET', `/security/events?account=${accountId}`)).body.events as Array<{ kind: string }>).map((event) => event.kind);
const flagsOf = async (accountId: string) => ((await t.admin('GET', `/security/flags?account=${accountId}`)).body.accounts as Array<{ flags: Array<Record<string, any>> }>)[0]?.flags ?? [];

async function signedIn(email = 'owner@example.com', seats = 1) {
  const account = await t.createAccount(email, { seats });
  const signIn = await t.signIn(email, { fingerprint: FP_A, name: 'Desk PC' });
  expect(signIn.status).toBe(200);
  return { accountId: account.id as string, token: signIn.body.refreshToken as string, deviceId: signIn.body.device.id as string };
}

describe('refresh-token rotation', () => {
  it('every heartbeat from a rotating app hands out the next token; the pass is as before', async () => {
    const { accountId, token: t0 } = await signedIn('rotate@example.com');
    const first = await beat(t0, newKey());
    expect(first.status).toBe(200);
    const t1 = first.body.refreshToken as string;
    expect(t1).toMatch(/^tbr_[A-Za-z0-9_-]{43}$/);
    expect(t1).not.toBe(t0);
    const check = verifyPass(first.body.pass, publicKeyFromRaw(t.publicKey), t.now());
    expect(check.ok && check.payload).toMatchObject({ acc: accountId, ver: '1.0.0' });
    expect((await session(first.body.pass)).status).toBe(200);

    t.advance(5 * MINUTE);
    const second = await beat(t1, newKey());
    expect(second.status).toBe(200);
    const t2 = second.body.refreshToken as string;
    expect(new Set([t0, t1, t2]).size).toBe(3);
    t.advance(5 * MINUTE);
    expect((await beat(t2, newKey())).status).toBe(200);
    // The admin views never show a token (the database itself is checked in the migration test).
    const dump = JSON.stringify(await t.admin('GET', '/audit?limit=500')) + JSON.stringify(await t.admin('GET', '/accounts'));
    for (const token of [t0, t1, t2]) expect(dump).not.toContain(token);
  });

  it('a lost answer: the same token and key again get the same successor, never a second branch', async () => {
    const { accountId, token: t0 } = await signedIn('lost@example.com');
    const k0 = newKey();
    const lost = await beat(t0, k0);
    const t1 = lost.body.refreshToken as string;
    // The answer never arrived (or couldn't be saved): the app tries again, twice.
    t.advance(30_000);
    const retry = await beat(t0, k0);
    expect(retry.status).toBe(200);
    expect(retry.body.refreshToken).toBe(t1);
    expect((await session(retry.body.pass)).status).toBe(200);
    t.advance(5 * MINUTE);
    expect((await beat(t0, k0)).body.refreshToken).toBe(t1);
    // The successor works and rotates on; only then does the old token stop.
    const next = await beat(t1, newKey());
    expect(next.status).toBe(200);
    expect(next.body.refreshToken).not.toBe(t1);
    expect(await events(accountId)).not.toContain('token_reuse');
    expect(await flagsOf(accountId)).toEqual([]);
  });

  it('a rotated token used after its successor was used: the device is signed out on both copies, recorded and flagged', async () => {
    const { accountId, token: t0, deviceId } = await signedIn('copied@example.com');
    // Machine A rotates T0 → T1, then uses T1 (→ T2).
    const t1 = (await beat(t0, newKey())).body.refreshToken as string;
    t.advance(5 * MINUTE);
    const a2 = await beat(t1, newKey());
    const t2 = a2.body.refreshToken as string;
    expect((await session(a2.body.pass)).status).toBe(200);
    // Copy B still holds T0.
    t.advance(MINUTE);
    const b = await beat(t0, newKey());
    expect([b.status, b.body.code, b.body.reason, b.body.message]).toEqual([401, 'SIGNED_OUT', 'token_reuse', REUSE]);
    // A is out too — told why — and its unexpired pass stops at once.
    const a3 = await beat(t2, newKey());
    expect([a3.status, a3.body.code, a3.body.reason, a3.body.message]).toEqual([401, 'SIGNED_OUT', 'token_reuse', REUSE]);
    expect((await session(a2.body.pass)).body.code).toBe('SIGNED_OUT');
    expect(await events(accountId)).toContain('token_reuse');
    const flag = (await flagsOf(accountId)).find((entry) => entry.rule === 'token_reuse');
    expect(flag).toMatchObject({ severity: 'high', value: 1, detail: { reused: 1, otherMachine: 0, devices: [deviceId] } });
    expect(flag?.message).toMatch(/used in two places/);
    const audit = (await t.admin('GET', `/audit?account=${accountId}`)).body.entries as Array<{ action: string }>;
    expect(audit.map((entry) => entry.action)).toContain('device.token_reuse');
    const listed = await t.admin('GET', '/accounts?email=copied@example.com');
    expect(listed.body.accounts[0].devices[0]).toMatchObject({ signedOut: true, active: false });
    // The seat is free at once (1-seat plan), and signing in again starts a new family; the old ones stay dead.
    const again = await t.signIn('copied@example.com', { fingerprint: FP_A });
    expect(again.status).toBe(200);
    expect((await beat(again.body.refreshToken, newKey())).status).toBe(200);
    for (const old of [t0, t1, t2]) expect((await beat(old, newKey())).body.code).toBe('SIGNED_OUT');
  });

  it('two copies taking turns are caught at the second heartbeat, even holding the same rotation key', async () => {
    const { accountId, token: t0 } = await signedIn('turns@example.com');
    const k0 = newKey(); // copied along with the token
    const t1 = (await beat(t0, k0)).body.refreshToken as string; // A
    const b1 = await beat(t0, k0); // B, before A used T1: indistinguishable from A retrying
    expect(b1.body.refreshToken).toBe(t1);
    // Each copy now draws its own key for T1.
    t.advance(2 * MINUTE);
    expect((await beat(t1, newKey())).status).toBe(200); // A
    t.advance(2 * MINUTE);
    const caught = await beat(t1, newKey()); // B
    expect([caught.body.code, caught.body.reason]).toEqual(['SIGNED_OUT', 'token_reuse']);
    expect(await events(accountId)).toContain('token_reuse');
  });

  it('a superseded token presented with another key, or without rotating, is reuse — not a retry', async () => {
    for (const [index, presentAgain] of [(token: string) => beat(token, newKey()), (token: string) => beat(token)].entries()) {
      const { token: t0 } = await signedIn(`other-key-${index}@example.com`);
      const t1 = (await beat(t0, newKey())).body.refreshToken as string;
      const again = await presentAgain(t0);
      expect([again.body.code, again.body.reason]).toEqual(['SIGNED_OUT', 'token_reuse']);
      expect((await beat(t1, newKey())).body.code).toBe('SIGNED_OUT');
    }
  });

  it('refuses a malformed rotation key, and a refused heartbeat never rotates', async () => {
    const { accountId, token: t0 } = await signedIn('refused@example.com');
    const bad = await t.call('POST', '/v1/devices/heartbeat', { refreshToken: t0, fingerprint: FP_A, appVersion: '1.0.0', rotate: true, rotationKey: 'short' });
    expect([bad.status, bad.body.code]).toEqual([400, 'BAD_REQUEST']);
    await t.admin('POST', `/accounts/${accountId}/revoke`);
    const inactive = await beat(t0, newKey());
    expect(inactive.body.code).toBe('ACCOUNT_INACTIVE');
    expect(inactive.body.refreshToken).toBeUndefined();
    await t.admin('POST', `/accounts/${accountId}/restore`);
    // Wrong machine: refused without rotating or revoking; the real computer carries on with T0.
    expect((await beat(t0, newKey(), FP_B)).body.code).toBe('SIGNED_OUT');
    const ok = await beat(t0, newKey());
    expect(ok.status).toBe(200);
    expect(ok.body.refreshToken).toMatch(/^tbr_/);
  });
});

describe('release and sign-out with a just-rotated token', () => {
  it('release takes the token a heartbeat replaced while its answer was lost; the retry still works after', async () => {
    const { accountId, token: t0 } = await signedIn('quit@example.com');
    const k0 = newKey();
    const t1 = (await beat(t0, k0)).body.refreshToken as string; // answer lost; the app quits
    expect((await t.call('POST', '/v1/devices/release', { refreshToken: t0 })).body).toEqual({ ok: true });
    // The seat was handed back: another computer can take it on this 1-seat plan…
    const laptop = await t.signIn('quit@example.com', { fingerprint: FP_B });
    expect(laptop.status).toBe(200);
    await t.call('POST', '/v1/devices/release', { refreshToken: laptop.body.refreshToken });
    // …and the desk PC's next start retries with T0 + its key: same successor, no alarm.
    const back = await beat(t0, k0);
    expect([back.status, back.body.refreshToken]).toEqual([200, t1]);
    expect(await events(accountId)).not.toContain('token_reuse');
  });

  it('release with a token whose successor was already used is reuse', async () => {
    const { token: t0 } = await signedIn('late-release@example.com');
    const t1 = (await beat(t0, newKey())).body.refreshToken as string;
    expect((await beat(t1, newKey())).status).toBe(200);
    const late = await t.call('POST', '/v1/devices/release', { refreshToken: t0 });
    expect([late.status, late.body.reason]).toEqual([401, 'token_reuse']);
  });

  it('presenting a token to release counts as using it: a copy holding the one before is caught at once', async () => {
    const { token: t0 } = await signedIn('used-by-release@example.com');
    const k0 = newKey();
    const t1 = (await beat(t0, k0)).body.refreshToken as string;
    expect((await t.call('POST', '/v1/devices/release', { refreshToken: t1 })).status).toBe(200);
    const copy = await beat(t0, k0);
    expect(copy.body.reason).toBe('token_reuse');
  });

  it('sign-out takes the token a heartbeat replaced while its answer was lost, without a reuse alarm', async () => {
    const { accountId, token: t0 } = await signedIn('signout@example.com');
    const k0 = newKey();
    const t1 = (await beat(t0, k0)).body.refreshToken as string;
    expect((await t.call('POST', '/v1/devices/signout', { refreshToken: t0 })).body).toEqual({ ok: true });
    for (const token of [t0, t1]) expect((await beat(token, k0)).body.code).toBe('SIGNED_OUT');
    const kinds = await events(accountId);
    expect(kinds).toContain('signout');
    expect(kinds).not.toContain('token_reuse');
    expect((await t.call('POST', '/v1/devices/signout', { refreshToken: t0 })).body).toEqual({ ok: true }); // idempotent
  });

  it('sign-out with a token whose successor was used signs the device out and records the reuse', async () => {
    const { accountId, token: t0 } = await signedIn('signout-copy@example.com');
    const t1 = (await beat(t0, newKey())).body.refreshToken as string;
    expect((await beat(t1, newKey())).status).toBe(200);
    expect((await t.call('POST', '/v1/devices/signout', { refreshToken: t0 })).body).toEqual({ ok: true });
    expect((await beat(t1, newKey())).body.code).toBe('SIGNED_OUT');
    expect(await events(accountId)).toContain('token_reuse');
  });
});

describe('pass checks with rotation', () => {
  it('passes from rotated heartbeats verify and stop at release, sign-out and reuse', async () => {
    const { token: t0 } = await signedIn('passes@example.com');
    const first = await beat(t0, newKey());
    expect((await session(first.body.pass)).status).toBe(200);
    t.advance(16 * MINUTE);
    expect((await session(first.body.pass)).body.code).toBe('PASS_EXPIRED');
    const second = await beat(first.body.refreshToken, newKey());
    expect((await session(second.body.pass)).status).toBe(200);
    await t.call('POST', '/v1/devices/release', { refreshToken: second.body.refreshToken });
    expect((await session(second.body.pass)).body.code).toBe('PASS_EXPIRED');
    const third = await beat(second.body.refreshToken, newKey());
    expect((await session(third.body.pass)).status).toBe(200);
    const pass = third.body.pass as string;
    expect((await session(`${pass.slice(0, -10)}${pass.at(-10) === 'A' ? 'B' : 'A'}${pass.slice(-9)}`)).body.code).toBe('PASS_INVALID');
  });
});

describe('apps from before rotation', () => {
  it('a heartbeat without `rotate` keeps the one token for good, as before', async () => {
    const { accountId, token } = await signedIn('old-app@example.com');
    for (let index = 0; index < 4; index += 1) {
      const answer = await beat(token);
      expect(answer.status).toBe(200);
      expect(answer.body).not.toHaveProperty('refreshToken');
      expect((await session(answer.body.pass)).status).toBe(200);
      t.advance(5 * MINUTE);
    }
    expect((await t.call('POST', '/v1/devices/release', { refreshToken: token })).status).toBe(200);
    expect((await beat(token)).status).toBe(200);
    expect((await t.call('POST', '/v1/devices/signout', { refreshToken: token })).body).toEqual({ ok: true });
    expect((await beat(token)).body.code).toBe('SIGNED_OUT');
    expect(await events(accountId)).not.toContain('token_reuse');
  });

  it('an existing token starts rotating at its first heartbeat from a new app (downgrading back still works)', async () => {
    const { token: t0 } = await signedIn('upgrade@example.com');
    expect((await beat(t0)).status).toBe(200); // the old build
    const t1 = (await beat(t0, newKey())).body.refreshToken as string; // the update
    expect(t1).toMatch(/^tbr_/);
    expect((await beat(t1)).status).toBe(200); // an older build reading the saved T1
    expect((await beat(t1, newKey())).body.refreshToken).toMatch(/^tbr_/);
  });
});

describe('database', () => {
  it('migration 3 adds the rotation columns to an existing database, keeps its tokens working, and is idempotent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tb-rotation-migrate-'));
    try {
      const before = await startTestCloud({ CLOUD_DATA_DIR: dir });
      await before.createAccount('migrated@example.com');
      const t0 = (await before.signIn('migrated@example.com', { fingerprint: FP_A })).body.refreshToken as string;
      await before.close();
      // Back to the schema before rotation (version 2), as on a Cloud that ran an older build.
      const file = path.join(dir, 'cloud.sqlite');
      const old = new DatabaseSync(file);
      old.exec('DROP INDEX refresh_tokens_superseded; PRAGMA user_version = 2;');
      for (const column of ['successor_id', 'superseded_at', 'rotation_key_hash', 'revoked_reason']) old.exec(`ALTER TABLE refresh_tokens DROP COLUMN ${column}`);
      old.close();

      const after = await startTestCloud({ CLOUD_DATA_DIR: dir });
      const secrets: string[] = [t0];
      try {
        const call = (refreshToken: string, key?: string) => after.call('POST', '/v1/devices/heartbeat', { refreshToken, fingerprint: FP_A, appVersion: '1.0.0', ...(key ? { rotate: true, rotationKey: key } : {}) });
        expect((await call(t0)).status).toBe(200);
        const k0 = newKey();
        const t1 = (await call(t0, k0)).body.refreshToken as string;
        const k1 = newKey();
        const t2 = (await call(t1, k1)).body.refreshToken as string;
        expect(t2).toMatch(/^tbr_/);
        secrets.push(k0, t1, k1, t2);
      } finally { await after.close(); }
      // Only hashes at rest: no token or rotation key appears anywhere in the database.
      const raw = new DatabaseSync(file);
      const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((table) => table.name);
      const everything = tables.map((table) => JSON.stringify(raw.prepare(`SELECT * FROM "${table}"`).all())).join('\n');
      raw.close();
      expect(everything).toContain('"successor_id":"rt_'); // sanity: the rotated rows are there
      for (const secret of secrets) expect(everything).not.toContain(secret);
      // Running migration 3 again over a database that already has the columns changes nothing.
      const again = new DatabaseSync(file);
      again.exec('PRAGMA user_version = 2;');
      again.close();
      const reopened = new CloudDb(file);
      const columns = (reopened.sql.prepare('PRAGMA table_info(refresh_tokens)').all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(['successor_id', 'superseded_at', 'rotation_key_hash', 'revoked_reason']));
      expect(Number((reopened.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBeGreaterThanOrEqual(3);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prunes rotated tokens a week after their successor was used, never one still in its retry window', () => {
    const db = new CloudDb(':memory:');
    try {
      const now = Date.parse('2026-10-01T12:00:00Z');
      const account = db.createAccount('prune@example.com', {}, now - 30 * DAY);
      db.sql.prepare("INSERT INTO devices (id, account_id, fingerprint_hash, name, platform, app_version, created_at, activated_at, last_seen_at) VALUES ('dev_1', ?, 'fp', 'PC', 'win32', '1.0.0', ?, ?, ?)").run(account.id, now - 30 * DAY, now, now);
      const insert = (id: string, at: number, fields: { successor?: string; superseded?: number; used?: number | null; revoked?: number }) => db.sql
        .prepare('INSERT INTO refresh_tokens (id, token_hash, account_id, device_id, created_at, last_used_at, revoked_at, successor_id, superseded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, `hash_${id}`, account.id, 'dev_1', at, fields.used ?? null, fields.revoked ?? null, fields.successor ?? null, fields.superseded ?? null);
      const old = now - (SUPERSEDED_TOKEN_DAYS + 1) * DAY;
      // A chain whose newest token is in use: the old links go.
      insert('rt_a0', old - DAY, { successor: 'rt_a1', superseded: old, used: old });
      insert('rt_a1', old, { successor: 'rt_a2', superseded: old + MINUTE, used: old + MINUTE });
      insert('rt_a2', old + MINUTE, { used: now });
      // A recent rotation stays (reuse detection looks there).
      insert('rt_b0', now - DAY, { successor: 'rt_b1', superseded: now - DAY, used: now - DAY });
      insert('rt_b1', now - DAY, { used: now - MINUTE });
      // An old rotation whose answer never arrived: the computer's way back in — kept.
      insert('rt_c0', old - DAY, { successor: 'rt_c1', superseded: old, used: old });
      insert('rt_c1', old, { used: null });
      db.prune(now);
      const left = (db.sql.prepare('SELECT id FROM refresh_tokens ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id);
      expect(left).toEqual(['rt_a2', 'rt_b0', 'rt_b1', 'rt_c0', 'rt_c1']);
    } finally { db.close(); }
  });
});
