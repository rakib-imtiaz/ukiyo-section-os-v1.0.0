// Devices and seats (AutoCAD-style).
//
// A device holds a seat while it heartbeats: it counts as active if it was seen in the last 15
// minutes and isn't signed out. Signing in or heartbeating fails with SEATS_FULL when the account's
// other active devices already fill its seats. A device that goes quiet frees its seat after 15
// minutes; signing out (or the app handing the seat back as it closes) frees it at once.
//
// When seats run short for devices that already hold one (an admin lowered the seat count), the
// longest-running holds keep their seats and the newest ones get SEATS_FULL — never both.
//
// Refresh tokens rotate at heartbeats from apps that ask for it, and a replaced token coming back
// signs the device out (tokens.ts).
import { Router } from 'express';
import { accountUsable, publicAccount } from './accounts';
import { CloudError, bodyOf, handle, iso, type CloudContext } from './context';
import { hashSecret } from './crypto';
import type { AccountRow, DeviceRow } from './db';
import { requireDevice, type DeviceLocals } from './middleware';
import { PASS_TTL_SEC, signPass } from './passes';
import { limitByIp } from './rate-limit';
import { recordSecurityEvent } from './security/events';
import { findRefreshToken, isRotationRetry, refreshTokenFrom, rotateRefreshToken, signOutReusedToken, validRotationKey } from './tokens';
import { compareVersions, isVersion } from './version';

export const ACTIVE_WINDOW_MS = 15 * 60_000;

export function deviceActive(device: DeviceRow, now: number): boolean {
  return device.signed_out_at == null && device.last_seen_at > now - ACTIVE_WINDOW_MS;
}

/** Where else the account is signed in, as shown on the SEATS_FULL screen. */
export function publicDevice(device: DeviceRow, now: number) {
  return { name: device.name, platform: device.platform, lastSeen: iso(device.last_seen_at || null), active: deviceActive(device, now) };
}

/**
 * Null when `device` may hold a seat now, else the other active devices that fill the seats.
 * `device` is null for a computer signing in for the first time on this account.
 */
export function seatConflict(ctx: CloudContext, account: AccountRow, device: DeviceRow | null, now: number): DeviceRow[] | null {
  const others = ctx.db.devicesForAccount(account.id).filter((other) => other.id !== device?.id && deviceActive(other, now));
  const holdsSeat = device != null && deviceActive(device, now);
  const ahead = holdsSeat
    ? others.filter((other) => other.activated_at < device.activated_at || (other.activated_at === device.activated_at && other.id < device.id))
    : others;
  return ahead.length >= account.seats ? others : null;
}

export function seatsFull(account: AccountRow, others: DeviceRow[], now: number) {
  return new CloudError(409, 'SEATS_FULL', `ThemeBot is already in use on ${others.length} computer${others.length === 1 ? '' : 's'} — all ${account.seats} seat${account.seats === 1 ? '' : 's'} on this plan.`, {
    seats: account.seats,
    devices: others.map((other) => publicDevice(other, now)),
  });
}

/** The admin setting wins over the MIN_APP_VERSION env default. */
export function minAppVersion(ctx: CloudContext): string {
  const stored = ctx.db.getSetting('minAppVersion');
  return stored && isVersion(stored) ? stored : ctx.config.minAppVersion;
}

export function requireAppVersion(ctx: CloudContext, appVersion: string) {
  const minimum = minAppVersion(ctx);
  if (compareVersions(appVersion, minimum) < 0) {
    throw new CloudError(426, 'UPDATE_REQUIRED', `This version of ThemeBot (${appVersion}) is too old. Update to ${minimum} or newer.`, { minAppVersion: minimum });
  }
}

export function fingerprintHash(ctx: CloudContext, fingerprint: string) {
  return hashSecret(ctx.config.pepper, 'device', fingerprint);
}

/** Install fingerprints are already salted hashes on the client: 32–128 hex/base64url characters. */
export function validFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

/** Signs a device out: frees its seat now and revokes its refresh tokens. */
export function signOutDevice(ctx: CloudContext, device: DeviceRow, actor: string) {
  const now = ctx.now();
  ctx.db.transaction(() => {
    ctx.db.sql.prepare('UPDATE devices SET signed_out_at = ? WHERE id = ?').run(now, device.id);
    ctx.db.sql.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(now, device.id);
    ctx.db.audit(now, actor, 'device.signed_out', device.account_id, { device: device.id, name: device.name });
  });
}

function issuePass(ctx: CloudContext, account: AccountRow, device: DeviceRow, appVersion: string) {
  const iat = Math.floor(ctx.now() / 1000);
  const exp = iat + PASS_TTL_SEC;
  const pass = signPass({ v: 1, acc: account.id, dev: device.id, plan: account.plan, seats: account.seats, ver: appVersion, iat, exp }, ctx.config.signingKey);
  ctx.db.sql.prepare('INSERT INTO pass_log (account_id, device_id, app_version, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(account.id, device.id, appVersion, iat * 1000, exp * 1000);
  return { pass, passExpiresAt: new Date(exp * 1000).toISOString() };
}

export function devicesRouter(ctx: CloudContext) {
  const router = Router();
  // A desktop heartbeats every 5 minutes; this leaves plenty of room for offices behind one IP.
  router.use(limitByIp(ctx, 'devices', 600, 5 * 60_000));

  /**
   * POST /v1/devices/heartbeat { refreshToken, appVersion, fingerprint, rotate?: true, rotationKey? }
   * → { pass, passExpiresAt, minAppVersion, account, refreshToken? }
   * Refusals: SIGNED_OUT (reason 'token_reuse' when a copied sign-in was caught), ACCOUNT_INACTIVE,
   * UPDATE_REQUIRED, SEATS_FULL.
   *
   * Rotation is opt-in per request (tokens.ts): with `rotate: true` and the install's rotation key
   * the answer carries the next refresh token, which the app must save before using the pass. Apps
   * from before rotation send neither and keep their one token, exactly as before.
   */
  router.post('/heartbeat', requireDevice(ctx), handle((request, response) => {
    const { account, device, tokenId, found } = response.locals as DeviceLocals;
    const body = bodyOf(request);
    const rotate = body.rotate === true;
    if (rotate && !validRotationKey(body.rotationKey)) throw new CloudError(400, 'BAD_REQUEST', 'rotationKey must be 22-128 base64url characters.');
    // A rotated token comes back only as a retry of its rotation (same key, successor unused);
    // anything else means a second copy of this computer's sign-in.
    if (found.status === 'superseded' && !(rotate && isRotationRetry(ctx, found, body.rotationKey))) throw signOutReusedToken(ctx, found, request);
    if (!isVersion(body.appVersion)) throw new CloudError(400, 'BAD_REQUEST', 'appVersion must look like 1.2.3.');
    // The token only works from the computer it was issued to.
    if (!validFingerprint(body.fingerprint) || fingerprintHash(ctx, body.fingerprint) !== device.fingerprint_hash) {
      recordSecurityEvent(ctx, { kind: 'fingerprint_mismatch', accountId: account.id, deviceId: device.id, ip: request.ip, fingerprintHash: validFingerprint(body.fingerprint) ? fingerprintHash(ctx, body.fingerprint) : null });
      throw new CloudError(401, 'SIGNED_OUT', 'This computer is signed out of ThemeBot. Sign in again.');
    }
    const now = ctx.now();
    if (!accountUsable(account, now)) throw new CloudError(403, 'ACCOUNT_INACTIVE', 'Your ThemeBot plan is not active.');
    requireAppVersion(ctx, body.appVersion);
    const result = ctx.db.transaction(() => {
      const conflict = seatConflict(ctx, account, device, now);
      if (conflict) return { ok: false as const, others: conflict };
      const activatedAt = deviceActive(device, now) ? device.activated_at : now;
      ctx.db.sql.prepare('UPDATE devices SET last_seen_at = ?, activated_at = ?, app_version = ?, passes_issued = passes_issued + 1 WHERE id = ?').run(now, activatedAt, body.appVersion as string, device.id);
      ctx.db.sql.prepare('UPDATE refresh_tokens SET last_used_at = ? WHERE id = ?').run(now, tokenId);
      // The next refresh token (the same one again for a retry). Rolled back with everything else
      // if anything here fails, so a refused heartbeat never rotates.
      const refreshToken = rotate ? rotateRefreshToken(ctx, found, body.rotationKey as string, now) : null;
      return { ok: true as const, issued: issuePass(ctx, account, device, body.appVersion as string), refreshToken };
    });
    if (!result.ok) {
      recordSecurityEvent(ctx, { kind: 'seats_full', accountId: account.id, deviceId: device.id, ip: request.ip, fingerprintHash: device.fingerprint_hash });
      throw seatsFull(account, result.others, now);
    }
    recordSecurityEvent(ctx, { kind: 'heartbeat', accountId: account.id, deviceId: device.id, ip: request.ip, fingerprintHash: device.fingerprint_hash });
    response.json({ ...result.issued, minAppVersion: minAppVersion(ctx), account: publicAccount(account), ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}) });
  }));

  /**
   * POST /v1/devices/signout { refreshToken } — frees the seat; the app must sign in again. Idempotent.
   * Takes the current token or a rotated one whose successor was never used (an app signing out right
   * after a heartbeat whose answer it never saw). A rotated token whose successor was used is a
   * copied sign-in: the device is signed out all the same, and the reuse recorded.
   */
  router.post('/signout', handle((request, response) => {
    const raw = refreshTokenFrom(request);
    const found = raw ? findRefreshToken(ctx, raw) : null;
    const device = found?.device ?? null;
    if (found && device && device.signed_out_at == null) {
      if (found.status === 'reused') signOutReusedToken(ctx, found, request);
      else {
        signOutDevice(ctx, device, 'user');
        recordSecurityEvent(ctx, { kind: 'signout', accountId: device.account_id, deviceId: device.id, ip: request.ip, fingerprintHash: device.fingerprint_hash });
      }
    }
    response.json({ ok: true });
  }));

  /**
   * POST /v1/devices/release { refreshToken } — the app is closing: hand the seat back now instead
   * of holding it for 15 minutes, but stay signed in (the next heartbeat claims a seat again).
   * Takes a rotated token still in its retry window too (requireDevice): an app quitting right after
   * a heartbeat whose answer it never saw.
   */
  router.post('/release', requireDevice(ctx), handle((request, response) => {
    const { device, tokenId } = response.locals as DeviceLocals;
    ctx.db.sql.prepare('UPDATE devices SET last_seen_at = 0 WHERE id = ?').run(device.id);
    // Presenting a token is using it: a copy still holding the token this one replaced is then
    // caught at once, not one rotation later.
    ctx.db.sql.prepare('UPDATE refresh_tokens SET last_used_at = ? WHERE id = ?').run(ctx.now(), tokenId);
    recordSecurityEvent(ctx, { kind: 'release', accountId: device.account_id, deviceId: device.id, ip: request.ip, fingerprintHash: device.fingerprint_hash });
    response.json({ ok: true });
  }));

  return router;
}
