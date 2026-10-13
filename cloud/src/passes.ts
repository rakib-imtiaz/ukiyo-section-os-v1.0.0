// Passes: short-lived proof that a signed-in device may use ThemeBot right now.
//
// Format: base64url(JSON payload) + "." + base64url(Ed25519 signature over the first segment's
// ASCII bytes). The Cloud signs with its private key; the desktop's local server (and later Cloud
// modules) verify with the public key. A pass lives 15 minutes; the app heartbeats every 5.
//
// This file has no dependencies beyond node:crypto on purpose: the desktop server imports it to
// verify passes, so both sides always agree on the format.
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

export const PASS_TTL_SEC = 15 * 60;

export interface PassPayload {
  v: 1;
  /** Account id. */
  acc: string;
  /** Device id. */
  dev: string;
  plan: string;
  seats: number;
  /** App version the pass was issued to. */
  ver: string;
  /** Issued at / expires at, Unix seconds. */
  iat: number;
  exp: number;
}

export type PassCheck =
  | { ok: true; payload: PassPayload }
  | { ok: false; code: 'PASS_INVALID' | 'PASS_EXPIRED' };

export function signPass(payload: PassPayload, privateKey: KeyObject): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(body), privateKey).toString('base64url');
  return `${body}.${signature}`;
}

/** The raw 32-byte Ed25519 public key, base64 — what /v1/public-key serves and the app pins. */
export function rawPublicKey(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('Not an Ed25519 key.');
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

/** KeyObject from the base64 raw public key (as baked into the desktop app). */
export function publicKeyFromRaw(raw: string): KeyObject {
  const bytes = Buffer.from(raw.trim(), 'base64');
  if (bytes.length !== 32) throw new Error('An Ed25519 public key is 32 bytes (base64).');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: bytes.toString('base64url') }, format: 'jwk' });
}

function isPayload(value: unknown): value is PassPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return p.v === 1 && typeof p.acc === 'string' && typeof p.dev === 'string' && typeof p.plan === 'string'
    && typeof p.seats === 'number' && typeof p.ver === 'string' && Number.isInteger(p.iat) && Number.isInteger(p.exp);
}

/**
 * Checks signature, shape and expiry. `nowMs` is the verifier's clock; `skewMs` corrects a clock
 * that is known to run behind/ahead of the Cloud's (the desktop measures it when a pass arrives).
 */
/** base64url without padding; an Ed25519 signature (64 bytes) is exactly 86 such characters. */
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_CHARS = 86;

export function verifyPass(token: string, publicKey: KeyObject, nowMs: number, skewMs = 0): PassCheck {
  if (typeof token !== 'string' || token.length > 4096) return { ok: false, code: 'PASS_INVALID' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, code: 'PASS_INVALID' };
  // Strict encoding: Node's base64url decoder skips characters it doesn't know, so without this
  // many different strings would decode to the same signature.
  if (!SEGMENT.test(parts[0]) || !SEGMENT.test(parts[1]) || parts[1].length !== SIGNATURE_CHARS) return { ok: false, code: 'PASS_INVALID' };
  let valid = false;
  try { valid = verify(null, Buffer.from(parts[0]), publicKey, Buffer.from(parts[1], 'base64url')); } catch { valid = false; }
  if (!valid) return { ok: false, code: 'PASS_INVALID' };
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return { ok: false, code: 'PASS_INVALID' }; }
  if (!isPayload(payload) || payload.exp <= payload.iat) return { ok: false, code: 'PASS_INVALID' };
  if ((nowMs + skewMs) / 1000 >= payload.exp) return { ok: false, code: 'PASS_EXPIRED' };
  return { ok: true, payload };
}
