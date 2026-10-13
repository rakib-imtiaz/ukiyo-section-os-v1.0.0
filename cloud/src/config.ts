// ThemeBot Cloud — configuration, read once from the environment.
//
// Dev needs nothing set: the signing key, the hashing pepper and the admin token are generated on
// first start and kept in the data folder (cloud/.data, gitignored), and login codes are printed to
// the console instead of emailed. Production refuses to start without a real signing key and mail
// settings, and never prints codes or tokens.
import { createPrivateKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CloudConfig {
  production: boolean;
  host: string;
  port: number;
  dataDir: string;
  /** SQLite file (':memory:' in some tests). */
  dbFile: string;
  /** Ed25519 private key that signs passes. Its public half ships inside the desktop app. */
  signingKey: KeyObject;
  /** Secret mixed into every stored hash (login codes, refresh tokens, device fingerprints). */
  pepper: string;
  mail: { resendApiKey: string; from: string };
  /**
   * variantSeats + productIds (+ the admin variantSeats setting) are the ThemeBot product allowlist:
   * only those purchases grant access. Empty in production = purchases grant nothing (a startup
   * warning, not a refusal: the admin setting can fill it at runtime). allowTestMode: production
   * applies test-mode events only when LEMONSQUEEZY_ALLOW_TEST_MODE=1 (dev always does).
   */
  lemonSqueezy: { webhookSecret: string; storeId: number | null; variantSeats: Record<string, number>; productIds: string[]; defaultSeats: number; allowTestMode: boolean };
  /** Empty = admin API off. */
  adminToken: string;
  /** Fallback when the admin hasn't set one (settings table wins). */
  minAppVersion: string;
  /** Express 'trust proxy' — set when the Cloud runs behind a load balancer, so rate limits see real client IPs. */
  trustProxy: boolean | number | string;
}

const cloudDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function value(env: NodeJS.ProcessEnv, name: string, fallback = '') {
  return env[name]?.trim() || fallback;
}

/** A small secret kept in the data folder, generated on first use. */
function persisted(dataDir: string, file: string, generate: () => string): string {
  const target = path.join(dataDir, file);
  try {
    if (existsSync(target)) {
      const existing = readFileSync(target, 'utf8').trim();
      if (existing) return existing;
    }
  } catch { /* unreadable — regenerate below */ }
  const fresh = generate();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(target, `${fresh}\n`, { mode: 0o600 });
  return fresh;
}

function loadSigningKey(env: NodeJS.ProcessEnv, dataDir: string, production: boolean): KeyObject {
  // Env vars often carry PEMs with literal "\n" — accept both forms.
  const configured = value(env, 'CLOUD_SIGNING_KEY').replace(/\\n/g, '\n');
  const keyFile = path.join(dataDir, 'signing-key.pem');
  let pem = configured;
  if (!pem && existsSync(keyFile)) pem = readFileSync(keyFile, 'utf8');
  if (!pem) {
    if (production) throw new Error('CLOUD_SIGNING_KEY is required in production (Ed25519 private key, PEM).');
    pem = persisted(dataDir, 'signing-key.pem', () => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().trim());
  }
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('CLOUD_SIGNING_KEY must be an Ed25519 private key.');
  return key;
}

/** "12345:3,67890:10" → { '12345': 3, '67890': 10 } */
export function parseVariantSeats(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const [variant, seats] = part.split(':').map((piece) => piece.trim());
    const count = Number(seats);
    if (variant && Number.isInteger(count) && count > 0) out[variant] = count;
  }
  return out;
}

/** "123, 456 789" → ['123', '456', '789'] */
export function parseIdList(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean))];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const production = env.NODE_ENV === 'production';
  const dataDir = path.resolve(value(env, 'CLOUD_DATA_DIR', path.join(cloudDir, '.data')));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const resendApiKey = value(env, 'RESEND_API_KEY');
  const from = value(env, 'MAIL_FROM', 'ThemeBot <login@themebot.local>');
  if (production && (!resendApiKey || !value(env, 'MAIL_FROM'))) throw new Error('RESEND_API_KEY and MAIL_FROM are required in production (login codes are emailed).');

  let adminToken = value(env, 'ADMIN_TOKEN');
  if (production && adminToken && adminToken.length < 24) throw new Error('ADMIN_TOKEN must be at least 24 characters.');
  if (!adminToken && !production) adminToken = persisted(dataDir, 'admin-token', () => `tba_${randomBytes(24).toString('base64url')}`);

  const trustRaw = value(env, 'CLOUD_TRUST_PROXY', 'false');
  const trustProxy = trustRaw === 'true' ? true : trustRaw === 'false' ? false : /^\d+$/.test(trustRaw) ? Number(trustRaw) : trustRaw;

  return {
    production,
    host: value(env, 'CLOUD_HOST', '127.0.0.1'),
    port: Number(value(env, 'CLOUD_PORT', '8800')),
    dataDir,
    dbFile: value(env, 'CLOUD_DB_FILE', path.join(dataDir, 'cloud.sqlite')),
    signingKey: loadSigningKey(env, dataDir, production),
    pepper: value(env, 'CLOUD_PEPPER') || persisted(dataDir, 'pepper', () => randomBytes(32).toString('base64url')),
    mail: { resendApiKey, from },
    lemonSqueezy: {
      webhookSecret: value(env, 'LEMONSQUEEZY_WEBHOOK_SECRET'),
      storeId: Number(value(env, 'LEMONSQUEEZY_STORE_ID')) || null,
      variantSeats: parseVariantSeats(value(env, 'LEMONSQUEEZY_VARIANT_SEATS')),
      productIds: parseIdList(value(env, 'LEMONSQUEEZY_PRODUCT_IDS')),
      defaultSeats: Math.max(1, Number(value(env, 'LEMONSQUEEZY_DEFAULT_SEATS', '3')) || 3),
      allowTestMode: ['1', 'true'].includes(value(env, 'LEMONSQUEEZY_ALLOW_TEST_MODE').toLowerCase()),
    },
    adminToken,
    minAppVersion: value(env, 'MIN_APP_VERSION', '0.0.0'),
    trustProxy,
  };
}
