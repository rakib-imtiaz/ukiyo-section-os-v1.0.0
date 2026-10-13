// desktop/account.ts against a real ThemeBot Cloud (cloud/tests/helpers) on 127.0.0.1: saving and
// rotating the refresh token. Electron's safeStorage is mocked with a reversible "seal".
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestCloud, type TestCloud } from '../cloud/tests/helpers';
import { Account, friendlyMessage, writeFileAtomic } from '../desktop/account';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`sealed:${text}`, 'utf8'),
    decryptString: (sealed: Buffer) => {
      const text = sealed.toString('utf8');
      if (!text.startsWith('sealed:')) throw new Error('not sealed by this keychain');
      return text.slice('sealed:'.length);
    },
  },
}));

const EMAIL = 'desk@example.com';
let t: TestCloud;
let dir: string;

beforeEach(async () => {
  t = await startTestCloud();
  dir = mkdtempSync(path.join(tmpdir(), 'tb-account-test-'));
  await t.createAccount(EMAIL, { seats: 1 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

const machineId = async () => 'machine-guid-desk-pc';
const newAccount = (userData = dir) => new Account(userData, { url: t.base, publicKey: t.publicKey }, '1.2.0', { machineId });
const accountFile = (userData = dir) => path.join(userData, 'account.json');
const unseal = (value: string) => Buffer.from(value, 'base64').toString('utf8').replace(/^sealed:/, '');
interface SavedSession { email: string; refreshToken: string; rotationKey?: string; session?: string; signedInAt: string; encrypted: boolean; account?: Record<string, unknown> }
/** account.json, decrypted. */
function stored(userData = dir): SavedSession {
  const raw = JSON.parse(readFileSync(accountFile(userData), 'utf8')) as SavedSession;
  return { ...raw, refreshToken: unseal(raw.refreshToken), rotationKey: raw.rotationKey ? unseal(raw.rotationKey) : undefined };
}
async function signIn(account: InstanceType<typeof Account>) {
  expect((await account.start(EMAIL)).ok).toBe(true);
  const result = await account.verify(EMAIL, t.lastCode(EMAIL));
  expect(result.ok).toBe(true);
}
/** A failing disk for account.json: the file replaced by a folder (a rename onto it fails). */
function breakSaving(userData = dir) { rmSync(accountFile(userData), { force: true }); mkdirSync(accountFile(userData)); }
function fixSaving(userData = dir) { rmSync(accountFile(userData), { recursive: true, force: true }); }
const heartbeatsSent = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([url]) => String(url).endsWith('/v1/devices/heartbeat')).length;
/** The bodies of the heartbeats sent so far. */
const presented = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls
  .filter(([url]) => String(url).endsWith('/v1/devices/heartbeat'))
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { refreshToken: string; rotationKey?: string; rotate?: boolean });

describe('desktop account: saving and rotating the sign-in', () => {
  it('saves the sign-in encrypted, with a session id and a rotation key, atomically', async () => {
    const account = newAccount();
    await signIn(account);
    const raw = readFileSync(accountFile(), 'utf8');
    const saved = stored();
    expect(saved.refreshToken).toMatch(/^tbr_/);
    expect(saved.rotationKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(saved.session).toMatch(/^[0-9a-f]{32}$/);
    expect(saved.encrypted).toBe(true);
    expect(raw).not.toContain(saved.refreshToken);
    expect(raw).not.toContain(saved.rotationKey);
    expect(readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('every heartbeat saves the next token (and a new key) before the pass is handed back', async () => {
    const account = newAccount();
    await signIn(account);
    const first = stored();
    const beat = await account.heartbeat();
    expect(beat.ok).toBe(true);
    const second = stored();
    expect(second.refreshToken).toMatch(/^tbr_/);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.rotationKey).not.toBe(first.rotationKey);
    expect(second.session).toBe(first.session);
    expect((await account.heartbeat()).ok).toBe(true);
    expect(stored().refreshToken).not.toBe(second.refreshToken);
    // The replaced tokens are dead to anyone else now (a copy presenting one is signed out).
    const copy = await t.heartbeat(first.refreshToken, 'x'.repeat(64));
    expect(copy.body.code).toBe('SIGNED_OUT');
  });

  it('when saving fails it keeps the old token, and the Cloud hands the same next token out again', async () => {
    const account = newAccount();
    await signIn(account);
    const before = stored();
    const spy = vi.spyOn(globalThis, 'fetch');
    breakSaving();
    const offlineSave = await account.heartbeat();
    expect(offlineSave.ok).toBe(true); // the pass is good; only the new token could not be kept
    const again = await account.heartbeat(); // presents the old token + key: a retry, not a copy
    expect(again.ok).toBe(true);
    expect(readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toEqual([]);
    fixSaving();
    expect((await account.heartbeat()).ok).toBe(true); // the retry once more — now saved
    const after = stored();
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.session).toBe(before.session);
    expect((await account.heartbeat()).ok).toBe(true); // and it rotates on from there
    expect(stored().refreshToken).not.toBe(after.refreshToken);
    // What went out: the old token and key three times (the Cloud answered each with the same new
    // token), then the new token with its own key.
    const sent = presented(spy);
    expect(sent.map((body) => body.refreshToken)).toEqual([before.refreshToken, before.refreshToken, before.refreshToken, after.refreshToken]);
    expect(sent.map((body) => body.rotationKey)).toEqual([before.rotationKey, before.rotationKey, before.rotationKey, after.rotationKey]);
  });

  it('a crash after the Cloud rotated but before saving: the restarted app retries with the saved token and key', async () => {
    await signIn(newAccount());
    const saved = stored();
    // The heartbeat that "crashed": the Cloud rotated, the answer never reached the disk.
    const lost = await t.call('POST', '/v1/devices/heartbeat', { refreshToken: saved.refreshToken, rotationKey: saved.rotationKey, rotate: true, appVersion: '1.2.0', fingerprint: await newAccount().fingerprint() });
    expect(lost.body.refreshToken).toMatch(/^tbr_/);
    const restarted = newAccount();
    const beat = await restarted.heartbeat();
    expect(beat.ok).toBe(true);
    expect(stored().refreshToken).toBe(lost.body.refreshToken);
    expect((await restarted.heartbeat()).ok).toBe(true);
  });

  it('an app quitting with its answer still out: release takes the replaced token, the next start carries on', async () => {
    const account = newAccount();
    await signIn(account);
    const saved = stored();
    await t.call('POST', '/v1/devices/heartbeat', { refreshToken: saved.refreshToken, rotationKey: saved.rotationKey, rotate: true, appVersion: '1.2.0', fingerprint: await account.fingerprint() });
    await account.release(); // still the saved (replaced) token
    const next = newAccount();
    expect((await next.heartbeat()).ok).toBe(true);
    expect(stored().refreshToken).not.toBe(saved.refreshToken);
  });

  it('two callers at once share one heartbeat: one request, one rotation', async () => {
    const account = newAccount();
    await signIn(account);
    const spy = vi.spyOn(globalThis, 'fetch');
    const [left, right] = await Promise.all([account.heartbeat(), account.heartbeat()]);
    expect(left).toEqual(right);
    expect(heartbeatsSent(spy)).toBe(1);
    expect((await account.heartbeat()).ok).toBe(true);
    expect(heartbeatsSent(spy)).toBe(2);
  });

  it('an answer that lands after signing out or in again is never saved (no roll-back, no quiet sign-in)', async () => {
    const realFetch = globalThis.fetch;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let answered: () => void = () => {};
    const arrived = new Promise<void>((resolve) => { answered = resolve; });
    const account = newAccount();
    await signIn(account);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      if (String(input).endsWith('/v1/devices/heartbeat')) { answered(); await gate; }
      return response;
    });
    const pending = account.heartbeat();
    await arrived; // the Cloud has rotated; the answer is held back
    await signIn(account); // a new session meanwhile
    const fresh = stored();
    release();
    const late = await pending;
    expect(late).toMatchObject({ ok: false, code: 'SIGNED_OUT' });
    expect(stored()).toEqual(fresh); // the new session's token, untouched
    vi.restoreAllMocks();
    expect((await account.heartbeat()).ok).toBe(true);
  });

  it('a session saved by an older build (no key yet) gets a key on disk first, then rotates', async () => {
    const legacy = newAccount();
    await signIn(legacy);
    const { refreshToken, email, signedInAt, account: cloudAccount } = stored();
    writeFileSync(accountFile(), JSON.stringify({ email, refreshToken: Buffer.from(`sealed:${refreshToken}`).toString('base64'), encrypted: true, signedInAt, account: cloudAccount }));
    // When the heartbeat goes out, the key it carries must already be on disk.
    const realFetch = globalThis.fetch;
    const onDiskWhenSent: Array<string | undefined> = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/v1/devices/heartbeat')) onDiskWhenSent.push(stored().rotationKey);
      return realFetch(input, init);
    });
    const updated = newAccount();
    expect((await updated.heartbeat()).ok).toBe(true);
    const [body] = presented(spy);
    expect(body).toMatchObject({ refreshToken, rotate: true });
    expect(onDiskWhenSent).toEqual([body.rotationKey]);
    const saved = stored();
    expect(saved.refreshToken).not.toBe(refreshToken);
    expect(saved.rotationKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(saved.rotationKey).not.toBe(body.rotationKey);
    expect(saved.signedInAt).toBe(signedInAt);
  });

  it("when the key can't be saved first, the heartbeat simply doesn't rotate", async () => {
    await signIn(newAccount());
    const { refreshToken, email, signedInAt } = stored();
    writeFileSync(accountFile(), JSON.stringify({ email, refreshToken: Buffer.from(`sealed:${refreshToken}`).toString('base64'), encrypted: true, signedInAt }));
    const updated = newAccount();
    expect(updated.hasSession()).toBe(true);
    breakSaving();
    expect((await updated.heartbeat()).ok).toBe(true);
    // Not rotated: the old token is still the current one (an older build's heartbeat works with it).
    expect((await t.heartbeat(refreshToken, await updated.fingerprint(), '1.2.0')).status).toBe(200);
  });

  it('a copied sign-in is signed out with its own message, and the session forgotten', async () => {
    const account = newAccount();
    await signIn(account);
    const copyDir = mkdtempSync(path.join(tmpdir(), 'tb-account-copy-'));
    try {
      for (const file of ['account.json', 'device.json']) writeFileSync(path.join(copyDir, file), readFileSync(path.join(dir, file)));
      expect((await account.heartbeat()).ok).toBe(true);
      expect((await account.heartbeat()).ok).toBe(true);
      const copy = newAccount(copyDir);
      const caught = await copy.heartbeat();
      expect(caught).toMatchObject({ ok: false, code: 'SIGNED_OUT', reason: 'token_reuse', message: "This computer's sign-in was used somewhere else, so it was signed out. Sign in again." });
      expect(existsSync(accountFile(copyDir))).toBe(false);
      expect(await account.heartbeat()).toMatchObject({ ok: false, code: 'SIGNED_OUT', reason: 'token_reuse' });
      expect(account.hasSession()).toBe(false);
    } finally { rmSync(copyDir, { recursive: true, force: true }); }
    expect(friendlyMessage({ code: 'SIGNED_OUT', message: '' })).toBe('This computer was signed out of ThemeBot. Sign in again to carry on.');
  });

  it('writeFileAtomic replaces the file whole and leaves nothing behind when it fails', () => {
    const file = path.join(dir, 'state.json');
    writeFileAtomic(file, '{"v":1}');
    writeFileAtomic(file, '{"v":2}');
    expect(readFileSync(file, 'utf8')).toBe('{"v":2}');
    mkdirSync(path.join(dir, 'folder.json'));
    expect(() => writeFileAtomic(path.join(dir, 'folder.json'), '{}')).toThrow();
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
