import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config';

export interface SessionPayload {
  shop: string;
  exp: number;
}

export function normalizeShop(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let shop = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!shop.includes('.')) shop += '.myshopify.com';
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null;
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function hmac(value: string, secret = config.security.sessionSecret) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function secureEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.security.encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decrypt(value: string) {
  const [version, ivValue, tagValue, dataValue] = value.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !dataValue) throw new Error('Encrypted value is malformed.');
  const decipher = createDecipheriv('aes-256-gcm', config.security.encryptionKey, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataValue, 'base64url')), decipher.final()]).toString('utf8');
}

export function createSessionCookie(shop: string) {
  const payload: SessionPayload = { shop, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${hmac(encoded)}`;
}

export function parseSessionCookie(cookie?: string): SessionPayload | null {
  if (!cookie) return null;
  const [encoded, signature] = cookie.split('.');
  if (!encoded || !signature || !secureEqual(hmac(encoded), signature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    return payload.exp > Date.now() && normalizeShop(payload.shop) ? payload : null;
  } catch { return null; }
}

export function parseCookies(request: Request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const index = entry.indexOf('=');
    return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))];
  }));
}

export function setSession(response: Response, shop: string) {
  response.cookie('vso_session', createSessionCookie(shop), {
    httpOnly: true,
    secure: config.security.cookieSecure,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function currentShop(request: Request) {
  const session = parseSessionCookie(parseCookies(request).vso_session);
  if (session) return session.shop;
  if (!config.production && config.shopify.legacyShop) return normalizeShop(config.shopify.legacyShop);
  return null;
}

export function requireSession(request: Request, response: Response, next: NextFunction) {
  const shop = currentShop(request);
  if (!shop) {
    response.status(401).json({ error: 'Connect a Shopify store to continue.', code: 'AUTH_REQUIRED' });
    return;
  }
  response.locals.shop = shop;
  next();
}

export function verifyShopifyQuery(query: Record<string, unknown>) {
  const received = typeof query.hmac === 'string' ? query.hmac : '';
  if (!received || !config.shopify.clientSecret) return false;
  const message = Object.entries(query)
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${key}=${Array.isArray(item) ? item.join(',') : String(item)}`)
    .join('&');
  return secureEqual(createHmac('sha256', config.shopify.clientSecret).update(message).digest('hex'), received);
}

export function verifyWebhook(body: Buffer, signature?: string) {
  if (!signature || !config.shopify.clientSecret) return false;
  const expected = createHmac('sha256', config.shopify.clientSecret).update(body).digest('base64');
  return secureEqual(expected, signature);
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(limit = 120, windowMs = 60_000) {
  return (request: Request, response: Response, next: NextFunction) => {
    const id = response.locals.apiKeyId || request.ip || 'unknown';
    const now = Date.now();
    const bucket = rateBuckets.get(id);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(id, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    bucket.count += 1;
    response.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    if (bucket.count > limit) {
      response.status(429).json({ error: 'Rate limit exceeded. Try again shortly.', code: 'RATE_LIMITED' });
      return;
    }
    next();
  };
}

export function newSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}
