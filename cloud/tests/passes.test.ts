import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PASS_TTL_SEC, publicKeyFromRaw, rawPublicKey, signPass, verifyPass, type PassPayload } from '../src/passes';
import { compareVersions, isVersion } from '../src/version';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const iat = 1_790_000_000;
const payload: PassPayload = { v: 1, acc: 'acc_1', dev: 'dev_1', plan: 'studio', seats: 3, ver: '1.0.0', iat, exp: iat + PASS_TTL_SEC };
const at = (seconds: number) => seconds * 1000;

describe('passes', () => {
  it('signs and verifies, through the raw public key the app pins', () => {
    const token = signPass(payload, privateKey);
    expect(token.split('.')).toHaveLength(2);
    const pinned = publicKeyFromRaw(rawPublicKey(privateKey));
    expect(rawPublicKey(publicKey)).toBe(rawPublicKey(privateKey));
    expect(verifyPass(token, pinned, at(iat + 60))).toEqual({ ok: true, payload });
  });

  it('expires after 15 minutes, with clock-skew correction', () => {
    const token = signPass(payload, privateKey);
    expect(verifyPass(token, publicKey, at(iat + PASS_TTL_SEC - 1)).ok).toBe(true);
    expect(verifyPass(token, publicKey, at(iat + PASS_TTL_SEC))).toEqual({ ok: false, code: 'PASS_EXPIRED' });
    // A verifier whose clock runs 10 minutes behind the Cloud's still sees the pass expire on time.
    expect(verifyPass(token, publicKey, at(iat + PASS_TTL_SEC - 600), 600_000)).toEqual({ ok: false, code: 'PASS_EXPIRED' });
  });

  it('rejects tampering, foreign keys and junk', () => {
    const token = signPass(payload, privateKey);
    const [body, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, seats: 99 })).toString('base64url');
    expect(verifyPass(`${forged}.${signature}`, publicKey, at(iat))).toEqual({ ok: false, code: 'PASS_INVALID' });
    const flipped = signature.slice(0, -2) + (signature.endsWith('AA') ? 'BB' : 'AA');
    expect(verifyPass(`${body}.${flipped}`, publicKey, at(iat)).ok).toBe(false);
    const other = generateKeyPairSync('ed25519');
    expect(verifyPass(signPass(payload, other.privateKey), publicKey, at(iat))).toEqual({ ok: false, code: 'PASS_INVALID' });
    for (const junk of ['', 'abc', 'a.b.c', `${body}.`, '.sig']) expect(verifyPass(junk, publicKey, at(iat)).ok).toBe(false);
    // Validly signed but the wrong shape.
    const wrongShape = signPass({ ...payload, v: 2 } as unknown as PassPayload, privateKey);
    expect(verifyPass(wrongShape, publicKey, at(iat))).toEqual({ ok: false, code: 'PASS_INVALID' });
  });

  it('accepts exactly one encoding of a pass (no padding, stray characters or base64 variants)', () => {
    const token = signPass(payload, privateKey);
    const [body, signature] = token.split('.');
    expect(verifyPass(token, publicKey, at(iat)).ok).toBe(true);
    // Node's base64url decoder ignores these, so each would otherwise decode to the same signature.
    for (const variant of [`${body}.${signature}==`, `${body}.${signature}!`, `${body}.${signature.slice(0, 40)} ${signature.slice(40)}`, `${body}=.${signature}`, `${body}.${signature.replace(/-/g, '+').replace(/_/g, '/')}`]) {
      if (variant === token) continue;
      expect(verifyPass(variant, publicKey, at(iat)), variant).toEqual({ ok: false, code: 'PASS_INVALID' });
    }
    // Validly signed, but expiring before it was issued.
    expect(verifyPass(signPass({ ...payload, exp: iat }, privateKey), publicKey, at(iat - 60))).toEqual({ ok: false, code: 'PASS_INVALID' });
  });

  it('refuses a public key that is not 32 bytes', () => {
    expect(() => publicKeyFromRaw(Buffer.alloc(16).toString('base64'))).toThrow();
  });
});

describe('app versions', () => {
  it('compares numerically, with pre-releases before releases', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.3.0-beta.1', '1.3.0')).toBeLessThan(0);
    expect(compareVersions('1.3.0-beta.10', '1.3.0-beta.2')).toBeGreaterThan(0);
    expect(isVersion('1.2.3')).toBe(true);
    expect(isVersion('1.2')).toBe(false);
    expect(isVersion('1.2.3; drop table')).toBe(false);
  });
});
