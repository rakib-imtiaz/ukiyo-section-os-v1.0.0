// ThemeBot Cloud, as the local server sees it (desktop builds that require sign-in).
//
// The desktop app's main process signs in to ThemeBot Cloud and heartbeats every 5 minutes. Each
// heartbeat brings a fresh pass (valid 15 minutes) that main hands to this server over the IPC
// channel: { type: 'pass', token, account }. The pass is checked against the Cloud's public key,
// which the app was built with (THEMEBOT_CLOUD_PUBKEY). New builds may only start while the held
// pass is valid — there is no offline grace: offline for 15+ minutes means builds wait.
//
// With no Cloud configured (THEMEBOT_CLOUD_URL unset: the web build, dev, the internal edition)
// nothing here applies and builds start as before.
import type { KeyObject } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { publicKeyFromRaw, verifyPass, type PassPayload } from '../cloud/src/passes';

const gzipAsync = promisify(gzip);

const cloudUrl = (process.env.THEMEBOT_CLOUD_URL ?? '').trim().replace(/\/+$/, '');
const publicKey: KeyObject | null = (() => {
  const raw = (process.env.THEMEBOT_CLOUD_PUBKEY ?? '').trim();
  if (!raw) return null;
  try { return publicKeyFromRaw(raw); } catch { return null; }
})();

/** True when this server was started by a desktop build that requires a ThemeBot account. */
export const cloudRequired = Boolean(cloudUrl);

export interface CloudAccount { email: string; plan: string; seats: number; expiresAt: string | null }
interface HeldPass { token: string; payload: PassPayload; skewMs: number }

let held: HeldPass | null = null;
/** Who is signed in, as last reported by the desktop host (kept while offline). */
let knownAccount: CloudAccount | null = null;
let offline = false;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* a listener's problem */ } } };

const MAX_SKEW_MS = 24 * 60 * 60 * 1000;

function parseAccount(value: unknown): CloudAccount | null {
  if (!value || typeof value !== 'object') return null;
  const account = value as Record<string, unknown>;
  if (typeof account.email !== 'string') return null;
  return { email: account.email, plan: String(account.plan ?? ''), seats: Number(account.seats) || 0, expiresAt: typeof account.expiresAt === 'string' ? account.expiresAt : null };
}

/**
 * Takes a pass from the desktop host. The difference between the pass's issue time and this
 * computer's clock is remembered, so a PC whose clock is a few minutes off still gets the full
 * 15 minutes (and no more). Returns false (and keeps the old pass) when it doesn't verify.
 */
export function acceptPass(token: string, account?: unknown): boolean {
  if (!publicKey) return false;
  const now = Date.now();
  const unchecked = verifyPass(token, publicKey, 0); // signature + shape only (time 0 never expires)
  if (!unchecked.ok) return false;
  const skew = unchecked.payload.iat * 1000 - now;
  const skewMs = Math.abs(skew) <= MAX_SKEW_MS ? skew : 0;
  const check = verifyPass(token, publicKey, now, skewMs);
  if (!check.ok) return false;
  if (held && check.payload.iat <= held.payload.iat) return false; // only newer passes (a resend is not news)
  held = { token, payload: check.payload, skewMs };
  knownAccount = parseAccount(account) ?? knownAccount;
  offline = false;
  notify();
  return true;
}

/** The desktop host couldn't reach the Cloud on its last heartbeat (the held pass runs out on its own). */
export function markOffline(account?: unknown) { offline = true; knownAccount = parseAccount(account) ?? knownAccount; notify(); }

/** Signed out: forget the pass and the account. */
export function clearPass() { held = null; knownAccount = null; offline = false; notify(); }

/** The held pass while it is valid, else null. */
export function currentPass(): { token: string; payload: PassPayload } | null {
  if (!held || !publicKey) return null;
  const check = verifyPass(held.token, publicKey, Date.now(), held.skewMs);
  return check.ok ? { token: held.token, payload: check.payload } : null;
}

/** Why there is no usable pass: the install lacks the key, the pass ran out (offline), or nobody is signed in. */
export type PassProblem = 'DAMAGED' | 'OFFLINE' | 'SIGNED_OUT';

function passProblem(): { code: PassProblem; reason: string } | null {
  if (!cloudRequired || currentPass()) return null;
  if (!publicKey) return { code: 'DAMAGED', reason: 'This copy of ThemeBot is damaged (its sign-in key is missing). Reinstall ThemeBot.' };
  if (offline || held) return { code: 'OFFLINE', reason: "ThemeBot can't reach its servers, so new builds can't start right now. Check your internet connection — builds can start again as soon as ThemeBot is back online." };
  return { code: 'SIGNED_OUT', reason: 'Sign in to ThemeBot to start builds.' };
}

/** Null when builds may start; otherwise why not, in words for the person at the keyboard. */
export function buildsBlockedReason(): string | null {
  return passProblem()?.reason ?? null;
}

export class CloudPassError extends Error {
  readonly status = 403;
  /** Lets a build that was already running say what to do (it stops; Resume carries on). */
  constructor(message: string, readonly code: PassProblem = 'SIGNED_OUT') { super(message); }
}

/** Throws CloudPassError (403) unless builds may start; returns the pass when one is required. */
export function requireValidPass(): { token: string; payload: PassPayload } | null {
  const problem = passProblem();
  if (problem) throw new CloudPassError(problem.reason, problem.code);
  return currentPass();
}

/** For /api/session and /api/health: what the UI shows about the ThemeBot account. */
export function cloudStatus() {
  const pass = currentPass();
  return {
    required: cloudRequired,
    signedIn: Boolean(pass),
    email: knownAccount?.email ?? null,
    plan: knownAccount?.plan ?? null,
    passExpiresAt: pass ? new Date(pass.payload.exp * 1000).toISOString() : null,
    offline: cloudRequired && !pass && (offline || Boolean(held)),
  };
}

export class CloudRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** JSON bodies larger than this go gzip-compressed (Content-Encoding: gzip). The Cloud's parsers
 *  inflate them; their size limits apply to the inflated body, so this saves upload time (QA
 *  captures shrink ~10×), never a limit. */
export const GZIP_BODY_OVER_BYTES = 16 * 1024;

/** A JSON body as sent: compressed when large. */
export async function encodeBody(body: unknown): Promise<{ payload: string | Uint8Array<ArrayBuffer>; bytes: number; headers: Record<string, string> }> {
  const json = JSON.stringify(body);
  const bytes = Buffer.byteLength(json);
  if (bytes <= GZIP_BODY_OVER_BYTES) return { payload: json, bytes, headers: { 'Content-Type': 'application/json' } };
  return { payload: new Uint8Array(await gzipAsync(json)), bytes, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } };
}

/**
 * Calls a pass-protected ThemeBot Cloud route (the build recipe steps, QA scoring).
 * POST with a JSON body, or GET when body is undefined.
 */
export async function cloudFetch<T = unknown>(route: string, body?: unknown): Promise<T> {
  if (!cloudRequired) throw new CloudRequestError(0, 'NOT_CONFIGURED', 'ThemeBot Cloud is not configured for this build.');
  const pass = requireValidPass();
  if (!pass) throw new CloudPassError('Sign in to ThemeBot first.', 'SIGNED_OUT');
  const encoded = body === undefined ? null : await encodeBody(body);
  // Big uploads (QA evidence, up to a few MB) get extra time on a slow line: 1 s per 64 kB sent.
  const sent = encoded ? (typeof encoded.payload === 'string' ? Buffer.byteLength(encoded.payload) : encoded.payload.byteLength) : 0;
  let response: Response;
  try {
    response = await fetch(`${cloudUrl}${route.startsWith('/') ? route : `/${route}`}`, {
      method: encoded ? 'POST' : 'GET',
      headers: { Authorization: `Pass ${pass.token}`, ...(encoded?.headers ?? {}) },
      body: encoded?.payload,
      signal: AbortSignal.timeout(30_000 + Math.ceil(sent / 65_536) * 1000),
    });
  } catch {
    throw new CloudRequestError(0, 'OFFLINE', "ThemeBot can't reach its servers. Check your internet connection.");
  }
  // The timeout covers reading the answer too: a body cut off half way (or not JSON) is a failed
  // call, never an empty success ({} would read as "no step to run" or an empty QA report).
  const data = await response.json().then((value: unknown) => value, () => undefined) as { code?: string; message?: string } | undefined;
  if (!response.ok) throw new CloudRequestError(response.status, data?.code ?? 'ERROR', data?.message ?? `ThemeBot Cloud answered ${response.status}.`);
  if (!data || typeof data !== 'object') throw new CloudRequestError(0, 'OFFLINE', "ThemeBot Cloud's answer didn't arrive in full. Check your internet connection.");
  return data as T;
}

/** Runs `listener` whenever the pass or the online state changes (e.g. to start queued builds). */
export function onCloudChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Messages from the desktop host over IPC. Returns true when the message was about the Cloud. */
export function handleHostMessage(message: unknown): boolean {
  const data = message as { type?: unknown; token?: unknown; account?: unknown } | null;
  if (data?.type === 'pass' && typeof data.token === 'string') { acceptPass(data.token, data.account); return true; }
  if (data?.type === 'cloud-offline') { markOffline(data.account); return true; }
  if (data?.type === 'signed-out') { clearPass(); return true; }
  return false;
}
