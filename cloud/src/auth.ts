// Sign-in with a 6-digit email code: /v1/auth/start sends it, /v1/auth/verify trades it (plus
// the computer's details) for a refresh token that this one install keeps.
//
// - Codes are stored hashed, expire after 10 minutes, allow 5 tries, and asking again replaces
//   the previous code. Starts are rate limited per email and per IP; verifies per IP and email.
// - /start answers the same whether or not the email has an account (no account enumeration).
//   Only an active account gets a code; an inactive one gets a "your plan isn't active" email.
import { Router } from 'express';
import { accountUsable, publicAccount } from './accounts';
import { CloudError, bodyOf, handle, normalizeEmail, type CloudContext } from './context';
import { hashSecret, newId, newLoginCode, newRefreshToken, secureEqual } from './crypto';
import type { DeviceRow } from './db';
import { deviceActive, fingerprintHash, requireAppVersion, seatConflict, seatsFull, validFingerprint } from './devices';
import { inactiveAccountEmail, loginCodeEmail } from './mailer';
import { limitByIp } from './rate-limit';
import { recordSecurityEvent } from './security/events';
import { isVersion } from './version';

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
/**
 * Wrong codes per email per 24 h, across every code sent. The per-code and per-15-minute limits
 * alone still allow ~1 900 guesses a day at one account (a 1-in-500 chance of getting in, every
 * day, from rotating IPs). Counted from login_codes, so a restart doesn't reset it.
 */
export const CODE_DAILY_FAILURES = 30;
/** Codes emailed per address per 24 h (stops mail-bombing an inbox through /start). */
const CODES_PER_DAY = 15;
const WINDOW_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

interface CodeRow { id: number; code_hash: string; expires_at: number; attempts: number }

const codeHash = (ctx: CloudContext, email: string, code: string) => hashSecret(ctx.config.pepper, 'code', `${email}:${code}`);

function invalidCode(message: string, details: Record<string, unknown> = {}) {
  return new CloudError(400, 'INVALID_CODE', message, details);
}

/** Device details sent with /verify, cleaned up. */
function parseDevice(value: unknown) {
  const device = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (!validFingerprint(device.fingerprint)) throw new CloudError(400, 'BAD_REQUEST', 'device.fingerprint is missing or malformed.');
  if (!isVersion(device.appVersion)) throw new CloudError(400, 'BAD_REQUEST', 'device.appVersion must look like 1.2.3.');
  const clean = (text: unknown, max: number, fallback: string) => (typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '') || fallback;
  return { fingerprint: device.fingerprint, appVersion: device.appVersion, name: clean(device.name, 100, 'Computer'), platform: clean(device.platform, 20, 'unknown') };
}

export function authRouter(ctx: CloudContext) {
  const router = Router();

  /** POST /v1/auth/start { email } → { ok: true, expiresInSec } — always, for any well-formed email. */
  router.post('/start', limitByIp(ctx, 'auth-start', 20, WINDOW_MS), handle((request, response) => {
    const email = normalizeEmail(bodyOf(request).email);
    if (!email) throw new CloudError(400, 'BAD_REQUEST', 'Enter a valid email address.');
    ctx.limiter.enforce(`email:auth-start:${email}`, 5, WINDOW_MS);
    const now = ctx.now();
    const account = ctx.db.accountByEmail(email);
    const sentToday = account ? Number((ctx.db.sql.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at > ?').get(email, now - DAY_MS) as { n: number }).n) : 0;
    if (account && sentToday >= CODES_PER_DAY) {
      // Same answer as always (no account enumeration); just no more mail today.
      ctx.log.warn('daily sign-in code limit reached', { account: account.id });
    } else if (account && accountUsable(account, now)) {
      const code = newLoginCode();
      ctx.db.transaction(() => {
        ctx.db.sql.prepare('UPDATE login_codes SET used_at = ? WHERE email = ? AND used_at IS NULL').run(now, email); // one live code per email
        ctx.db.sql.prepare('INSERT INTO login_codes (email, code_hash, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)').run(email, codeHash(ctx, email, code), now, now + CODE_TTL_MS, request.ip ?? null);
        ctx.db.audit(now, 'user', 'auth.code_sent', account.id, {});
      });
      // Not awaited: a slow mail API must not make "has an account" measurable by response time.
      ctx.mailer.send(loginCodeEmail(email, code)).catch((error: unknown) => ctx.log.error('login code email failed', { account: account.id, error: error instanceof Error ? error.message : String(error) }));
    } else if (account && ctx.limiter.hit(`email:inactive-notice:${email}`, 3, DAY_MS).ok) {
      ctx.mailer.send(inactiveAccountEmail(email)).catch(() => {});
    }
    response.json({ ok: true, expiresInSec: CODE_TTL_MS / 1000 });
  }));

  /**
   * POST /v1/auth/verify { email, code, device: { fingerprint, name, platform, appVersion } }
   * → { refreshToken, account: { email, plan, seats, expiresAt }, device: { id, name } }
   * Refusals: INVALID_CODE, ACCOUNT_INACTIVE, SEATS_FULL (with the other devices), UPDATE_REQUIRED.
   */
  router.post('/verify', limitByIp(ctx, 'auth-verify', 30, WINDOW_MS), handle((request, response) => {
    const body = bodyOf(request);
    const email = normalizeEmail(body.email);
    if (!email) throw new CloudError(400, 'BAD_REQUEST', 'Enter a valid email address.');
    const code = typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : '';
    if (!/^\d{6}$/.test(code)) throw invalidCode('The code is the 6 digits from the email.');
    const device = parseDevice(body.device);
    ctx.limiter.enforce(`email:auth-verify:${email}`, 20, WINDOW_MS);
    // Before spending the code: an outdated app could not use the session anyway.
    requireAppVersion(ctx, device.appVersion);

    const now = ctx.now();
    const failures = Number((ctx.db.sql.prepare('SELECT COALESCE(SUM(attempts), 0) AS n FROM login_codes WHERE email = ? AND created_at > ?').get(email, now - DAY_MS) as { n: number }).n);
    if (failures >= CODE_DAILY_FAILURES) {
      throw new CloudError(429, 'RATE_LIMITED', 'Too many wrong codes for this email today. Try again tomorrow, or contact support.', { retryAfterSec: 60 * 60 });
    }
    const row = ctx.db.sql.prepare('SELECT id, code_hash, expires_at, attempts FROM login_codes WHERE email = ? AND used_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1').get(email) as CodeRow | undefined;
    if (!row || row.expires_at <= now) throw invalidCode('That code has expired. Ask for a new one.', { expired: true });
    if (row.attempts >= CODE_MAX_ATTEMPTS) throw invalidCode('Too many wrong tries. Ask for a new code.', { expired: true });
    if (!secureEqual(codeHash(ctx, email, code), row.code_hash)) {
      ctx.db.sql.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      const attemptsLeft = CODE_MAX_ATTEMPTS - row.attempts - 1;
      throw invalidCode(attemptsLeft > 0 ? "That code isn't right. Check the email and try again." : 'Too many wrong tries. Ask for a new code.', { attemptsLeft, expired: attemptsLeft <= 0 });
    }

    const account = ctx.db.accountByEmail(email);
    if (!account) throw invalidCode('That code has expired. Ask for a new one.', { expired: true });
    if (!accountUsable(account, now)) throw new CloudError(403, 'ACCOUNT_INACTIVE', 'Your ThemeBot plan is not active.');

    const fpHash = fingerprintHash(ctx, device.fingerprint);
    const result = ctx.db.transaction(() => {
      const existing = (ctx.db.sql.prepare('SELECT * FROM devices WHERE account_id = ? AND fingerprint_hash = ?').get(account.id, fpHash) as DeviceRow | undefined) ?? null;
      // The code stays valid on SEATS_FULL, so the user can sign out elsewhere and retry with it.
      const conflict = seatConflict(ctx, account, existing, now);
      if (conflict) return { ok: false as const, others: conflict, deviceId: existing?.id ?? null };
      let deviceId: string;
      if (existing) {
        deviceId = existing.id;
        const activatedAt = deviceActive(existing, now) ? existing.activated_at : now;
        ctx.db.sql.prepare('UPDATE devices SET name = ?, platform = ?, app_version = ?, signed_out_at = NULL, activated_at = ?, last_seen_at = ? WHERE id = ?')
          .run(device.name, device.platform, device.appVersion, activatedAt, now, deviceId);
      } else {
        deviceId = newId('dev');
        ctx.db.sql.prepare('INSERT INTO devices (id, account_id, fingerprint_hash, name, platform, app_version, created_at, activated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(deviceId, account.id, fpHash, device.name, device.platform, device.appVersion, now, now, now);
      }
      // One live refresh token per install: signing in again replaces the old one.
      ctx.db.sql.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(now, deviceId);
      const refreshToken = newRefreshToken();
      ctx.db.sql.prepare('INSERT INTO refresh_tokens (id, token_hash, account_id, device_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(newId('rt'), hashSecret(ctx.config.pepper, 'refresh', refreshToken), account.id, deviceId, now);
      ctx.db.sql.prepare('UPDATE login_codes SET used_at = ? WHERE id = ?').run(now, row.id);
      ctx.db.audit(now, 'user', 'auth.signed_in', account.id, { device: deviceId, name: device.name, platform: device.platform, appVersion: device.appVersion, ip: request.ip ?? null });
      return { ok: true as const, refreshToken, deviceId };
    });
    if (!result.ok) {
      recordSecurityEvent(ctx, { kind: 'seats_full', accountId: account.id, deviceId: result.deviceId, ip: request.ip, fingerprintHash: fpHash });
      throw seatsFull(account, result.others, now);
    }
    recordSecurityEvent(ctx, { kind: 'signin', accountId: account.id, deviceId: result.deviceId, ip: request.ip, fingerprintHash: fpHash });
    response.json({ refreshToken: result.refreshToken, account: publicAccount(account), device: { id: result.deviceId, name: device.name } });
  }));

  return router;
}
