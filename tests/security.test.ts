import { describe, expect, it } from 'vitest';
import { apiKeyHash } from '../server/api';
import { createSessionCookie, decrypt, encrypt, normalizeShop, parseSessionCookie, secureEqual } from '../server/security';

describe('production security primitives', () => {
  it('normalizes safe Shopify domains and rejects deceptive hosts', () => {
    expect(normalizeShop('My-Store')).toBe('my-store.myshopify.com');
    expect(normalizeShop('https://my-store.myshopify.com/')).toBe('my-store.myshopify.com');
    expect(normalizeShop('myshopify.com.attacker.test')).toBeNull();
    expect(normalizeShop('../my-store')).toBeNull();
  });

  it('encrypts access tokens with authenticated encryption', () => {
    const token = 'shpat_private_test_token';
    const cipher = encrypt(token);
    expect(cipher).not.toContain(token);
    expect(decrypt(cipher)).toBe(token);
    expect(() => decrypt(cipher.replace(/.$/, cipher.endsWith('a') ? 'b' : 'a'))).toThrow();
  });

  it('signs browser sessions and rejects tampering', () => {
    const cookie = createSessionCookie('my-store.myshopify.com');
    expect(parseSessionCookie(cookie)?.shop).toBe('my-store.myshopify.com');
    expect(parseSessionCookie(`${cookie}tampered`)).toBeNull();
  });

  it('hashes API keys without storing their plaintext value', () => {
    const key = 'vso_live_example_secret';
    expect(apiKeyHash(key)).not.toContain(key);
    expect(apiKeyHash(key)).toBe(apiKeyHash(key));
    expect(secureEqual(apiKeyHash(key), apiKeyHash(key))).toBe(true);
  });
});
