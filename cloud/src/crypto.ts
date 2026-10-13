// Small crypto helpers shared by every Cloud module. Secrets are never stored as-is: login codes,
// refresh tokens and device fingerprints are kept as HMAC-SHA256 digests keyed with the pepper.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Keyed digest of a secret, namespaced by purpose so a code hash can never match a token hash. */
export function hashSecret(pepper: string, purpose: string, value: string): string {
  return createHmac('sha256', pepper).update(`${purpose}:${value}`).digest('hex');
}

/**
 * Constant-time string comparison. Both sides are hashed to 32 bytes first, so neither the
 * content nor the length of the secret (e.g. ADMIN_TOKEN) shows in the timing.
 */
export function secureEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right) && a === b;
}

/** Opaque ids like acc_Xb3k9…, readable in logs and admin output. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

/** Long-lived bearer secret held by one desktop install (only its hash is stored). */
export function newRefreshToken(): string {
  return `tbr_${randomBytes(32).toString('base64url')}`;
}

/**
 * The successor of a rotated refresh token, derived from the token the app presented and the
 * rotation key the app sent with it, keyed with the pepper. Only the app holds both inputs, so the
 * Cloud can hand the same successor out again when an answer was lost without ever storing it (in
 * any form but its hash), and a copy of the database plus the pepper still can't produce it.
 * The 'refresh-successor:' prefix keeps it apart from every hashSecret purpose.
 */
export function successorRefreshToken(pepper: string, presented: string, rotationKey: string): string {
  return `tbr_${createHmac('sha256', pepper).update(`refresh-successor:${presented}:${rotationKey}`).digest('base64url')}`;
}

/** Six digits, uniformly random. */
export function newLoginCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
