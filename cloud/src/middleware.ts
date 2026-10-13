// Express middleware shared by every Cloud module:
//   securityHeaders  — locked-down response headers (no helmet dependency)
//   requireDevice    — a signed-in desktop install, from its refresh token (rotation: tokens.ts)
//   requirePass      — a valid, unexpired pass (what later phases' build/recipe routes require)
//   requireAdmin     — the operator's ADMIN_TOKEN
//   errorHandler     — CloudError → { code, message, ...details }; anything else → generic 500
import { createPublicKey, type KeyObject } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { accountUsable } from './accounts';
import { CloudError, type CloudContext } from './context';
import { secureEqual } from './crypto';
import type { AccountRow, DeviceRow } from './db';
import { verifyPass, type PassPayload } from './passes';
import { clientKey } from './rate-limit';
import { findRefreshToken, refreshTokenFrom, revokedForReuse, signOutReusedToken, tokenReuseRefusal, type FoundToken } from './tokens';

export function securityHeaders(production: boolean) {
  return (_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Cache-Control', 'no-store');
    if (production) response.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    next();
  };
}

/** What requireDevice puts on response.locals. `found.status` is 'current' or 'superseded' (tokens.ts). */
export interface DeviceLocals { account: AccountRow; device: DeviceRow; tokenId: string; found: FoundToken }

const SIGNED_OUT = () => new CloudError(401, 'SIGNED_OUT', 'This computer is signed out of ThemeBot. Sign in again.');

/** Same rule as devices.ts deviceActive (kept here to avoid an import cycle: devices imports this file). */
const SEAT_HOLD_MS = 15 * 60_000;
function holdsSeat(device: DeviceRow, now: number): boolean {
  return device.signed_out_at == null && device.last_seen_at > now - SEAT_HOLD_MS;
}

/**
 * The refresh token comes in the JSON body ({ refreshToken }) or as "Authorization: Bearer tbr_…".
 * Fails with SIGNED_OUT when the token is unknown/revoked or the device was signed out. A rotated
 * token presented after its successor was used signs the device out (tokens.ts signOutReusedToken).
 * A rotated token still in its retry window passes with found.status 'superseded' and the route
 * decides: the heartbeat takes it only as a retry with the same rotation key, /release takes it.
 */
export function requireDevice(ctx: CloudContext) {
  return (request: Request, response: Response, next: NextFunction) => {
    const raw = refreshTokenFrom(request);
    const found = raw ? findRefreshToken(ctx, raw) : null;
    if (found?.status === 'reused' && found.device.signed_out_at == null) { next(signOutReusedToken(ctx, found, request)); return; }
    // The other copy of a sign-in caught on two computers hears why, too.
    if (!found && raw && revokedForReuse(ctx, raw)) { next(tokenReuseRefusal()); return; }
    if (!found || found.status === 'reused' || found.device.signed_out_at != null) { next(SIGNED_OUT()); return; }
    Object.assign(response.locals, { account: found.account, device: found.device, tokenId: found.token.id, found } satisfies DeviceLocals);
    next();
  };
}

/** What requirePass puts on response.locals. */
export interface PassLocals { pass: PassPayload; account: AccountRow; device: DeviceRow }

/**
 * A pass in "Authorization: Pass <token>" (or X-ThemeBot-Pass). Beyond the signature and expiry,
 * the account must still be usable, the device still signed in AND still holding its seat — so
 * revoking an account, signing a device out or handing its seat back (/v1/devices/release) takes
 * effect at once, not when the pass runs out. Without the seat check, computers could take turns
 * on one seat (heartbeat → release → the next computer heartbeats) and all keep working on their
 * unexpired passes.
 */
export function requirePass(ctx: CloudContext) {
  const publicKey: KeyObject = createPublicKey(ctx.config.signingKey);
  return (request: Request, response: Response, next: NextFunction) => {
    const header = request.header('authorization') ?? '';
    const token = header.startsWith('Pass ') ? header.slice(5).trim() : (request.header('x-themebot-pass') ?? '').trim();
    if (!token) { next(new CloudError(401, 'PASS_REQUIRED', 'Sign in to ThemeBot to do this.')); return; }
    const now = ctx.now();
    const check = verifyPass(token, publicKey, now);
    if (!check.ok) { next(new CloudError(401, check.code, check.code === 'PASS_EXPIRED' ? 'Your ThemeBot session needs refreshing. Check your internet connection.' : 'Invalid pass.')); return; }
    const account = ctx.db.accountById(check.payload.acc);
    const device = ctx.db.deviceById(check.payload.dev);
    if (!account || !device || device.account_id !== account.id || device.signed_out_at != null) { next(SIGNED_OUT()); return; }
    if (!accountUsable(account, now)) { next(new CloudError(403, 'ACCOUNT_INACTIVE', 'Your ThemeBot plan is not active.')); return; }
    // The seat was handed back (or went quiet) after this pass was issued: the next heartbeat must
    // claim a seat again before this computer can use the Cloud. Same code as an expired pass, so
    // the app simply heartbeats and retries.
    if (!holdsSeat(device, now)) { next(new CloudError(401, 'PASS_EXPIRED', 'Your ThemeBot session needs refreshing. Check your internet connection.')); return; }
    Object.assign(response.locals, { pass: check.payload, account, device } satisfies PassLocals);
    next();
  };
}

export function requireAdmin(ctx: CloudContext) {
  return (request: Request, _response: Response, next: NextFunction) => {
    if (!ctx.config.adminToken) { next(new CloudError(404, 'NOT_FOUND', 'Not found.')); return; }
    const header = request.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !secureEqual(token, ctx.config.adminToken)) {
      // Guessing the admin token is rate limited like everything else.
      try { ctx.limiter.enforce(`ip:admin-fail:${clientKey(request.ip)}`, 20, 15 * 60_000); } catch (error) { next(error); return; }
      next(new CloudError(401, 'UNAUTHORIZED', 'Admin token missing or wrong.'));
      return;
    }
    next();
  };
}

export function notFound(_request: Request, _response: Response, next: NextFunction) {
  next(new CloudError(404, 'NOT_FOUND', 'Not found.'));
}

export function errorHandler(ctx: CloudContext) {
  return (error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof CloudError) {
      if (error.status === 429 && typeof error.details.retryAfterSec === 'number') response.setHeader('Retry-After', String(error.details.retryAfterSec));
      response.status(error.status).json({ code: error.code, message: error.message, ...error.details });
      return;
    }
    // body-parser errors carry an HTTP status and a type.
    const parserError = error as { status?: number; type?: string; expose?: boolean };
    if (parserError?.type === 'entity.parse.failed') { response.status(400).json({ code: 'BAD_REQUEST', message: 'The request body is not valid JSON.' }); return; }
    if (parserError?.status === 413) { response.status(413).json({ code: 'TOO_LARGE', message: 'The request body is too large.' }); return; }
    // Other body-parser refusals (a corrupt gzip body, an unsupported Content-Encoding or charset,
    // a body cut short): the client's fault, so a 4xx it won't retry — never a 500.
    if (typeof parserError?.status === 'number' && parserError.status >= 400 && parserError.status < 500 && (typeof parserError.type === 'string' || parserError.expose === true)) {
      const unsupported = parserError.status === 415;
      response.status(parserError.status).json({ code: unsupported ? 'UNSUPPORTED_ENCODING' : 'BAD_REQUEST', message: unsupported ? 'The request body uses an encoding the server does not accept.' : 'The request body could not be read.' });
      return;
    }
    ctx.log.error('unhandled error', { path: request.path, error: error instanceof Error ? error.message : String(error) });
    response.status(500).json({ code: 'INTERNAL', message: 'Something went wrong on our side. Try again in a moment.' });
  };
}
