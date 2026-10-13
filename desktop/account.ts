// The ThemeBot account on this computer, signed in to ThemeBot Cloud (cloud/ in this repo).
//
// - Sign-in: email → a 6-digit code the Cloud emails → a refresh token for this install, kept
//   encrypted with the OS keychain (Electron safeStorage) in userData/account.json.
// - This computer is identified by a fingerprint: the OS machine id (Windows MachineGuid, macOS
//   IOPlatformUUID, Linux /etc/machine-id) hashed with a random per-install salt, so the raw id
//   never leaves the computer. The Cloud only accepts the refresh token with that fingerprint.
// - main.ts heartbeats every 5 minutes; each heartbeat returns a pass (valid 15 minutes) that the
//   local server needs to start builds. Seats are enforced by the Cloud (see cloud/src/devices.ts).
// - Every heartbeat also rotates the refresh token (cloud/src/tokens.ts): the answer carries the
//   next token, saved here (atomically, encrypted) before the pass is used. The token it replaces
//   stops working once the new one is used, so a copy of these files on a second computer gets
//   both copies signed out. Each token has its own random rotation key, saved with it: a heartbeat
//   whose answer was lost (or not saved, or the app crashed) is sent again with the same token and
//   key, and the Cloud hands out the same next token — so that is never mistaken for a copy.
// - With no Cloud in the build (dev, the internal edition) no account is needed.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { safeStorage } from 'electron';

const run = promisify(execFile);

export interface CloudConfig { url: string; publicKey: string }
export interface CloudAccount { email: string; plan: string; seats: number; expiresAt: string | null }
export interface OtherDevice { name: string; platform: string; lastSeen: string | null }

export type CloudCode = 'INVALID_CODE' | 'SEATS_FULL' | 'ACCOUNT_INACTIVE' | 'UPDATE_REQUIRED' | 'SIGNED_OUT' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'OFFLINE' | 'SERVER_ERROR';
/** `reason: 'token_reuse'` on SIGNED_OUT: this computer's sign-in was caught in use on a second computer. */
export interface CloudFailure { ok: false; code: CloudCode; message: string; devices?: OtherDevice[]; minAppVersion?: string; expired?: boolean; reason?: string }
export type HeartbeatResult = { ok: true; pass: string; passExpiresAt: string; minAppVersion: string; account: CloudAccount } | CloudFailure;

const KNOWN_CODES: CloudCode[] = ['INVALID_CODE', 'SEATS_FULL', 'ACCOUNT_INACTIVE', 'UPDATE_REQUIRED', 'SIGNED_OUT', 'RATE_LIMITED', 'BAD_REQUEST'];

/** Offline and server trouble are temporary: keep the app open and try again. Everything else is a refusal. */
export const isTransient = (failure: CloudFailure) => failure.code === 'OFFLINE' || failure.code === 'SERVER_ERROR';

/** What to tell the person, for each refusal. */
export function friendlyMessage(failure: Pick<CloudFailure, 'code' | 'message' | 'expired' | 'reason'>): string {
  switch (failure.code) {
    case 'INVALID_CODE': return failure.expired ? 'That code has expired or was tried too many times. Send yourself a new one.' : "That code isn't right. Check the email and try again.";
    case 'SEATS_FULL': return 'ThemeBot is already open on every computer your plan covers. Close ThemeBot or sign out there (Help → Sign out of this PC), or wait 15 minutes, then try again.';
    case 'ACCOUNT_INACTIVE': return "Your ThemeBot plan isn't active. Renew it to keep using ThemeBot, or contact whoever sold you ThemeBot.";
    case 'UPDATE_REQUIRED': return 'This version of ThemeBot is too old to use. Update ThemeBot to carry on.';
    case 'SIGNED_OUT': return failure.reason === 'token_reuse'
      ? "This computer's sign-in was used somewhere else, so it was signed out. Sign in again."
      : 'This computer was signed out of ThemeBot. Sign in again to carry on.';
    case 'RATE_LIMITED': return 'Too many tries. Wait a few minutes, then try again.';
    case 'OFFLINE': return "Can't reach ThemeBot — check your internet connection.";
    case 'BAD_REQUEST': return failure.message || 'Check what you entered and try again.';
    default: return "ThemeBot's servers had a problem. Try again in a minute.";
  }
}

/**
 * account.json. `refreshToken` and `rotationKey` are encrypted with the OS keychain when it's
 * available. `session` is a random id per sign-in that stays the same across token rotations (files
 * from older builds have none: their signedInAt stands in). Older builds read refreshToken alone.
 */
interface Stored { email: string; refreshToken: string; encrypted: boolean; signedInAt: string; account?: CloudAccount; session?: string; rotationKey?: string }
/** The session as the app uses it (decrypted). */
type Session = Omit<Stored, 'encrypted'>;
interface DeviceFile { salt: string; fallbackId: string }

/** A fresh key for rotating the next token: 32 random bytes, used for that one token only. */
const newRotationKey = () => randomBytes(32).toString('base64url');
const validRotationKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(value);
const sessionOf = (session: Session) => session.session ?? session.signedInAt;
const signedOut = (): CloudFailure => ({ ok: false, code: 'SIGNED_OUT', message: friendlyMessage({ code: 'SIGNED_OUT', message: '' }) });

/**
 * Writes a file so it is never half-written: a temp file next to it, flushed to disk, then renamed
 * over it — after a crash or power cut the old file or the new one is there, never a mix. A rename
 * held up for a moment (antivirus, indexer) is tried again briefly. Throws when it couldn't.
 */
export function writeFileAtomic(file: string, data: string) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = openSync(temp, 'w', 0o600);
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    for (let attempt = 1; ; attempt += 1) {
      try { renameSync(temp, file); return; } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 3 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30 * attempt); } catch { /* can't wait here: try at once */ }
      }
    }
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** The OS's stable machine id, or null if it can't be read. */
async function machineId(): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const query = (extra: string[]) => run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', ...extra], { timeout: 5000, windowsHide: true });
      const { stdout } = await query(['/reg:64']).catch(() => query([]));
      return /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{16,})/.exec(stdout)?.[1]?.toLowerCase() ?? null;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 5000 });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1] ?? null;
    }
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      if (existsSync(file)) { const id = readFileSync(file, 'utf8').trim(); if (id) return id; }
    }
  } catch { /* fall back to a random id kept with the install */ }
  return null;
}

export interface AccountOptions {
  /** Reads the OS machine id (tests and drills pass their own). */
  machineId?: () => Promise<string | null>;
}

export class Account {
  private readonly file: string;
  private readonly deviceFile: string;
  private readonly readMachineId: () => Promise<string | null>;
  private fingerprintCache: Promise<string> | null = null;
  /** The session as last read or saved. A save that fails leaves it — and the file — on the old token. */
  private session: Session | null = null;
  /** The heartbeat on its way, per token: a second caller shares its answer instead of sending the token twice. */
  private inflight: { token: string; promise: Promise<HeartbeatResult> } | null = null;

  constructor(private readonly userData: string, private readonly config: CloudConfig | null, private readonly appVersion: string, options: AccountOptions = {}) {
    this.file = path.join(userData, 'account.json');
    this.deviceFile = path.join(userData, 'device.json');
    this.readMachineId = options.machineId ?? machineId;
  }

  /** True when this build requires signing in to ThemeBot. */
  get required() { return this.config != null; }

  /** The current session: from memory, else from account.json. */
  private read(): Session | null {
    if (this.session) return this.session;
    try {
      if (!existsSync(this.file)) return null;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Stored;
      // Encrypted with this user's keychain: a copy on another computer (or user) can't decrypt it.
      const open = (value: string) => (raw.encrypted ? safeStorage.decryptString(Buffer.from(value, 'base64')) : value);
      const refreshToken = open(raw.refreshToken);
      if (!refreshToken.startsWith('tbr_')) return null;
      let rotationKey: string | undefined;
      try { rotationKey = raw.rotationKey ? open(raw.rotationKey) : undefined; } catch { rotationKey = undefined; }
      const { encrypted: _encrypted, ...rest } = raw;
      this.session = { ...rest, refreshToken, rotationKey: validRotationKey(rotationKey) ? rotationKey : undefined };
      return this.session;
    } catch { return null; }
  }

  /** Saves the session to account.json — atomically, secrets encrypted. False (nothing changed) when it couldn't. */
  private save(session: Session): boolean {
    try {
      const encrypted = safeStorage.isEncryptionAvailable();
      const seal = (value: string) => (encrypted ? safeStorage.encryptString(value).toString('base64') : value);
      const { rotationKey, ...rest } = session;
      const stored: Stored = { ...rest, refreshToken: seal(session.refreshToken), ...(rotationKey ? { rotationKey: seal(rotationKey) } : {}), encrypted };
      mkdirSync(this.userData, { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(stored, null, 2));
      this.session = session;
      return true;
    } catch { return false; }
  }

  hasSession() { return this.read() != null; }

  /** The account as of the last successful sign-in or heartbeat (shown while offline). */
  lastKnownAccount(): CloudAccount | null { return this.read()?.account ?? null; }

  /** The signed-in (or last used) email, to prefill the sign-in screen. */
  email(): string | null {
    if (this.session) return this.session.email;
    try { return (JSON.parse(readFileSync(this.file, 'utf8')) as Stored).email ?? null; } catch { return null; }
  }

  /** Forgets this computer's session locally (the Cloud frees the seat after 15 minutes). */
  forget() {
    this.session = null;
    try { rmSync(this.file, { force: true }); } catch { /* the Cloud refuses its token anyway */ }
  }

  /** Salted hash of the machine id — the same on every launch of this install, useless anywhere else. */
  fingerprint(): Promise<string> {
    this.fingerprintCache ??= (async () => {
      let device: DeviceFile | null = null;
      try { device = JSON.parse(readFileSync(this.deviceFile, 'utf8')) as DeviceFile; } catch { device = null; }
      if (!device?.salt || !device.fallbackId) {
        device = { salt: randomBytes(32).toString('hex'), fallbackId: randomBytes(16).toString('hex') };
        mkdirSync(this.userData, { recursive: true });
        writeFileSync(this.deviceFile, JSON.stringify(device, null, 2), { mode: 0o600 });
      }
      const id = await this.readMachineId() ?? `install:${device.fallbackId}`;
      return createHash('sha256').update(`${device.salt}:${id}`).digest('hex');
    })();
    return this.fingerprintCache;
  }

  private async post<T>(route: string, body: unknown, timeoutMs = 15_000): Promise<({ ok: true } & T) | CloudFailure> {
    if (!this.config) return { ok: false, code: 'SERVER_ERROR', message: 'This build has no ThemeBot Cloud address.' };
    let response: Response;
    try {
      response = await fetch(`${this.config.url}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, code: 'OFFLINE', message: friendlyMessage({ code: 'OFFLINE', message: '' }) };
    }
    const data = await response.json().catch(() => null) as (Record<string, unknown> & T) | null;
    if (response.ok && data) return { ok: true, ...data };
    const code = KNOWN_CODES.includes(data?.code as CloudCode) ? data!.code as CloudCode : 'SERVER_ERROR';
    const failure: CloudFailure = { ok: false, code, message: typeof data?.message === 'string' ? data.message : `HTTP ${response.status}` };
    if (Array.isArray(data?.devices)) failure.devices = data.devices as OtherDevice[];
    if (typeof data?.minAppVersion === 'string') failure.minAppVersion = data.minAppVersion;
    if (data?.expired === true) failure.expired = true;
    if (typeof data?.reason === 'string') failure.reason = data.reason;
    return { ...failure, message: friendlyMessage(failure) };
  }

  /** Step 1: email a sign-in code. */
  async start(email: string): Promise<{ ok: true } | CloudFailure> {
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return { ok: false, code: 'BAD_REQUEST', message: 'Enter the email address you bought ThemeBot with.' };
    const result = await this.post<{ expiresInSec: number }>('/v1/auth/start', { email: trimmed });
    return result.ok ? { ok: true } : result;
  }

  /** Step 2: trade the code for this computer's session (uses one seat). */
  async verify(email: string, code: string): Promise<{ ok: true; account: CloudAccount } | CloudFailure> {
    const device = { fingerprint: await this.fingerprint(), name: hostname().slice(0, 100) || 'Computer', platform: process.platform, appVersion: this.appVersion };
    const result = await this.post<{ refreshToken: string; account: CloudAccount }>('/v1/auth/verify', { email: email.trim(), code: code.replace(/\s+/g, ''), device });
    if (!result.ok) return result;
    const saved = this.save({
      email: result.account.email, refreshToken: result.refreshToken, signedInAt: new Date().toISOString(), account: result.account,
      session: randomBytes(16).toString('hex'), rotationKey: newRotationKey(),
    });
    if (!saved) {
      this.forget(); // the Cloud replaced any earlier session of this computer with the one we couldn't keep
      return { ok: false, code: 'BAD_REQUEST', message: "You're signed in, but ThemeBot couldn't save that on this computer. Check there is free disk space, then send yourself a new code." };
    }
    return { ok: true, account: result.account };
  }

  /**
   * Proves this computer is still signed in and holding a seat; returns a fresh pass, and saves the
   * rotated refresh token before returning. Never throws (trouble here counts as being offline).
   */
  heartbeat(): Promise<HeartbeatResult> {
    const session = this.read();
    if (!session) return Promise.resolve(signedOut());
    // The timer and "Try again" can ask at the same moment: one request per token.
    if (this.inflight?.token === session.refreshToken) return this.inflight.promise;
    const promise: Promise<HeartbeatResult> = this.sendHeartbeat(session)
      .catch((): HeartbeatResult => ({ ok: false, code: 'SERVER_ERROR', message: friendlyMessage({ code: 'SERVER_ERROR', message: '' }) }))
      .finally(() => { if (this.inflight?.promise === promise) this.inflight = null; });
    this.inflight = { token: session.refreshToken, promise };
    return promise;
  }

  private async sendHeartbeat(presented: Session): Promise<HeartbeatResult> {
    // The rotation key must be on disk before the Cloud rotates with it: after a crash the app has
    // to present the same key again, or its retry would look like a second copy. Sessions saved by
    // older builds have none yet; when it can't be saved, this heartbeat just doesn't rotate.
    let session = presented;
    if (!session.rotationKey) {
      const withKey = { ...session, rotationKey: newRotationKey() };
      if (this.save(withKey)) session = withKey;
    }
    const { rotationKey } = session;
    const result = await this.post<{ pass: string; passExpiresAt: string; minAppVersion: string; account: CloudAccount; refreshToken?: unknown }>('/v1/devices/heartbeat', {
      refreshToken: session.refreshToken, appVersion: this.appVersion, fingerprint: await this.fingerprint(),
      ...(rotationKey ? { rotate: true, rotationKey } : {}),
    });
    const current = this.read();
    // Signed out (or in again) while this heartbeat was on its way: its answer belongs to a session
    // that is gone — never write it back (that would quietly sign this computer in again).
    if (!current || sessionOf(current) !== sessionOf(session)) return signedOut();
    if (result.ok) {
      const next = rotationKey && typeof result.refreshToken === 'string' && result.refreshToken.startsWith('tbr_') && result.refreshToken !== session.refreshToken ? result.refreshToken : null;
      // Only while the session still holds the token this heartbeat presented: an answer that lands
      // after a newer one must never roll the token back.
      if (current.refreshToken === session.refreshToken) {
        // Saved BEFORE the pass is handed on. If saving fails, the old token stays (here and on
        // disk) and the next heartbeat presents it again with the same key: the Cloud answers that
        // retry with this same new token, which nobody can have used meanwhile.
        this.save(next ? { ...current, account: result.account, refreshToken: next, rotationKey: newRotationKey() } : { ...current, account: result.account });
      }
      return { ok: true, pass: result.pass, passExpiresAt: result.passExpiresAt, minAppVersion: result.minAppVersion, account: result.account };
    }
    if (result.code === 'SIGNED_OUT') this.forget();
    return result;
  }

  /**
   * The app is closing: hand the seat back now (stays signed in). Best effort, never slow. Uses the
   * latest saved token; the Cloud also takes the one it replaced at a heartbeat whose answer this
   * app never saw (or couldn't save).
   */
  async release(): Promise<void> {
    const session = this.read();
    if (session) await this.post('/v1/devices/release', { refreshToken: session.refreshToken }, 3000).catch(() => {});
  }

  /** Signs this computer out: frees the seat at once and forgets the session. */
  async signOut(): Promise<void> {
    const session = this.read();
    if (session) await this.post('/v1/devices/signout', { refreshToken: session.refreshToken }, 5000).catch(() => {});
    this.forget();
  }
}

/** The Cloud address + pass key baked into the app's package.json at build time (scripts/desktop/build.mjs). */
export function cloudConfigFrom(pkg: { themebot?: { cloud?: { url?: unknown; publicKey?: unknown } } }): CloudConfig | null {
  const cloud = pkg.themebot?.cloud;
  if (typeof cloud?.url !== 'string' || typeof cloud.publicKey !== 'string' || !cloud.url || !cloud.publicKey) return null;
  return { url: cloud.url.replace(/\/+$/, ''), publicKey: cloud.publicKey };
}
