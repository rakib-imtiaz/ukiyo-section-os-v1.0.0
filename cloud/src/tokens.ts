// Refresh tokens: lookup, rotation and reuse detection (the OAuth refresh-token-rotation pattern).
//
// An app that asks for it (`rotate: true` + its `rotationKey` on /v1/devices/heartbeat) gets a new
// refresh token with every pass. The token it presented becomes "superseded" and points to its
// successor. Only hashes are stored.
//
//   - Lost answer: the app presents the superseded token again, with the SAME rotation key, before
//     the successor was ever used → it gets the same successor again. The successor is derived, not
//     stored (crypto.ts successorRefreshToken: HMAC of the presented token + the app's rotation key
//     under the pepper), so there is never a second branch and nothing secret at rest.
//   - Reuse: a superseded token presented any other way — after its successor was used, with a
//     different rotation key, or without rotating — means two copies of this computer's sign-in
//     exist. The device is signed out (every token of the family revoked, passes refused at once,
//     the seat freed), a high-severity `token_reuse` security event is recorded, and the answer is
//     SIGNED_OUT with reason `token_reuse`.
//   - /release and /signout also accept a superseded token whose successor was never used (an app
//     quitting right after a heartbeat whose answer it never saw); after that it is reuse there too.
//
// Why a rotation key and not just "was the successor used?": two copies taking turns would never
// trip that rule (A rotates T1→T2, B presents T1 before A has used T2 and gets T2 as well, and so
// on). Each install draws its own random key for every token and saves it with the token, so the
// same request again is a retry and anything else is a second copy — caught at the latest on the
// copy's second heartbeat.
//
// Apps that don't send `rotate` (builds from before rotation) keep one token for good, as before.
import type { Request } from 'express';
import { CloudError, bodyOf, iso, type CloudContext } from './context';
import { hashSecret, newId, secureEqual, successorRefreshToken } from './crypto';
import type { AccountRow, DeviceRow, RefreshTokenRow } from './db';
import { recordSecurityEvent } from './security/events';

/**
 * current: the live token. superseded: rotated, but its successor was never used (the retry
 * window). reused: rotated and its successor already used — a second copy.
 */
export type TokenStatus = 'current' | 'superseded' | 'reused';

export interface FoundToken {
  status: TokenStatus;
  /** The token as presented (needed to derive its successor; never stored). */
  raw: string;
  token: RefreshTokenRow;
  account: AccountRow;
  device: DeviceRow;
}

export const TOKEN_REUSE_MESSAGE = "This computer's sign-in was used somewhere else, so it was signed out. Sign in again.";

const signedOut = () => new CloudError(401, 'SIGNED_OUT', 'This computer is signed out of ThemeBot. Sign in again.');
const tokenHash = (ctx: CloudContext, raw: string) => hashSecret(ctx.config.pepper, 'refresh', raw);
const rotationKeyHash = (ctx: CloudContext, key: string) => hashSecret(ctx.config.pepper, 'rotation-key', key);

/** The refresh token from the JSON body ({ refreshToken }) or "Authorization: Bearer tbr_…". */
export function refreshTokenFrom(request: Request): string {
  const fromBody = bodyOf(request).refreshToken;
  if (typeof fromBody === 'string') return fromBody;
  const header = request.header('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/** Looks a presented refresh token up (stored hashed). Null when unknown or revoked. */
export function findRefreshToken(ctx: CloudContext, raw: string): FoundToken | null {
  if (!raw.startsWith('tbr_') || raw.length > 200) return null;
  const token = ctx.db.sql.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(tokenHash(ctx, raw)) as RefreshTokenRow | undefined;
  if (!token) return null;
  const account = ctx.db.accountById(token.account_id);
  const device = ctx.db.deviceById(token.device_id);
  if (!account || !device) return null;
  let status: TokenStatus = 'current';
  if (token.successor_id != null) {
    const next = ctx.db.sql.prepare('SELECT * FROM refresh_tokens WHERE id = ?').get(token.successor_id) as RefreshTokenRow | undefined;
    if (!next || next.revoked_at != null) return null; // the family is gone
    status = next.last_used_at == null && next.superseded_at == null ? 'superseded' : 'reused';
  }
  return { status, raw, token, account, device };
}

/** A rotation key: 22–128 base64url characters (the app sends 32 random bytes). */
export function validRotationKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(value);
}

/** A superseded token presented again with the key it was rotated with, before its successor was used. */
export function isRotationRetry(ctx: CloudContext, found: FoundToken, rotationKey: unknown): boolean {
  return found.status === 'superseded' && validRotationKey(rotationKey) && found.token.rotation_key_hash != null
    && secureEqual(rotationKeyHash(ctx, rotationKey), found.token.rotation_key_hash);
}

/**
 * Call inside the heartbeat's transaction. The current token: mints its successor and marks it
 * superseded. A retry (isRotationRetry): the same successor again, nothing written.
 */
export function rotateRefreshToken(ctx: CloudContext, found: FoundToken, rotationKey: string, now: number): string {
  const successor = successorRefreshToken(ctx.config.pepper, found.raw, rotationKey);
  if (found.status === 'superseded') {
    const stored = ctx.db.sql.prepare('SELECT token_hash FROM refresh_tokens WHERE id = ? AND revoked_at IS NULL').get(found.token.successor_id) as { token_hash: string } | undefined;
    if (!stored || !secureEqual(stored.token_hash, tokenHash(ctx, successor))) throw signedOut();
    return successor;
  }
  if (found.status !== 'current') throw signedOut();
  const successorId = newId('rt');
  ctx.db.sql.prepare('INSERT INTO refresh_tokens (id, token_hash, account_id, device_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(successorId, tokenHash(ctx, successor), found.account.id, found.device.id, now);
  const changed = ctx.db.sql.prepare('UPDATE refresh_tokens SET successor_id = ?, superseded_at = ?, rotation_key_hash = ? WHERE id = ? AND successor_id IS NULL AND revoked_at IS NULL')
    .run(successorId, now, rotationKeyHash(ctx, rotationKey), found.token.id);
  // Rotated by another request in the meantime: roll back; the app's next try is a plain retry.
  if (Number(changed.changes) !== 1) throw new CloudError(503, 'TRY_AGAIN', 'Try again in a moment.');
  return successor;
}

/** Same digest as devices.ts fingerprintHash (kept here: devices.ts imports middleware, which imports this). */
function presentedFingerprintHash(ctx: CloudContext, request: Request): string | null {
  const fingerprint = bodyOf(request).fingerprint;
  return typeof fingerprint === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(fingerprint) ? hashSecret(ctx.config.pepper, 'device', fingerprint) : null;
}

/**
 * Two copies of this computer's sign-in exist. Signs the device out — every token of the family
 * revoked, its passes refused from now on, its seat freed — records a `token_reuse` security event
 * and returns the SIGNED_OUT refusal to answer with. Both copies get it at their next call.
 */
export function signOutReusedToken(ctx: CloudContext, found: FoundToken, request: Request): CloudError {
  const now = ctx.now();
  const { device } = found;
  ctx.db.transaction(() => {
    ctx.db.sql.prepare('UPDATE devices SET signed_out_at = COALESCE(signed_out_at, ?) WHERE id = ?').run(now, device.id);
    ctx.db.sql.prepare("UPDATE refresh_tokens SET revoked_at = ?, revoked_reason = 'token_reuse' WHERE device_id = ? AND revoked_at IS NULL").run(now, device.id);
    ctx.db.audit(now, 'security', 'device.token_reuse', device.account_id, { device: device.id, name: device.name, token: found.token.id, supersededAt: iso(found.token.superseded_at), ip: request.ip ?? null });
  });
  recordSecurityEvent(ctx, { kind: 'token_reuse', accountId: device.account_id, deviceId: device.id, ip: request.ip, fingerprintHash: presentedFingerprintHash(ctx, request) ?? device.fingerprint_hash });
  ctx.log.warn('refresh token reused: device signed out', { account: device.account_id, device: device.id });
  return tokenReuseRefusal();
}

export const tokenReuseRefusal = () => new CloudError(401, 'SIGNED_OUT', TOKEN_REUSE_MESSAGE, { reason: 'token_reuse' });

/** True when this token was revoked because its sign-in was caught on two computers (so the other copy hears why too). */
export function revokedForReuse(ctx: CloudContext, raw: string): boolean {
  if (!raw.startsWith('tbr_') || raw.length > 200) return false;
  return ctx.db.sql.prepare("SELECT 1 FROM refresh_tokens WHERE token_hash = ? AND revoked_reason = 'token_reuse'").get(tokenHash(ctx, raw)) != null;
}
