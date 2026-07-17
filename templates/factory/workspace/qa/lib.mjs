// Shared helpers for every workspace script: project identity, credentials,
// token mint (OAuth client_credentials), REST + GraphQL clients.
// Path-agnostic: ROOT is derived from this file's location (qa/lib.mjs -> project root).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const API_VER = '2025-01';

/** Project identity: URLs from TARGET_SITE_INFO.txt merged with job.json (prefix, names, flags). */
export function project() {
  const info = readFileSync(path.join(ROOT, 'TARGET_SITE_INFO.txt'), 'utf8');
  const urls = info.match(/https?:\/\/[^\s"']+/gi) || [];
  const reactUrl = urls.find((u) => !/myshopify\.com/i.test(u)) || null;
  const storeUrl = urls.find((u) => /myshopify\.com/i.test(u)) || null;
  let job = {};
  const jobPath = path.join(ROOT, 'job.json');
  if (existsSync(jobPath)) job = JSON.parse(readFileSync(jobPath, 'utf8'));
  return { root: ROOT, reactUrl, storeUrl, ...job };
}

/** Client ID + Secret from API.txt, login host from TARGET_SITE_INFO.txt. */
export function creds() {
  const lines = readFileSync(path.join(ROOT, 'API.txt'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const id = lines.map((l) => l.replace(/^client\s*id\s*:?\s*/i, '')).find((l) => /^[0-9a-f]{32}$/i.test(l));
  const secret = lines.map((l) => l.replace(/^client\s*secret\s*:?\s*/i, '')).find((l) => /^shpss_/.test(l));
  if (!id) throw new Error('API.txt: no 32-char hex Client ID found');
  if (!secret) throw new Error('API.txt: no shpss_* Client Secret found');
  const { storeUrl } = project();
  const match = (storeUrl || '').match(/([a-z0-9-]+\.myshopify\.com)/i);
  if (!match) throw new Error('TARGET_SITE_INFO.txt: no *.myshopify.com URL found');
  return { id, secret, loginHost: match[1] };
}

/** Mint a fresh 24h shpat_ token via client_credentials; resolve the canonical shop host. */
export async function mint() {
  const { id, secret, loginHost } = creds();
  const r = await fetch(`https://${loginHost}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
  });
  if (!r.ok) throw new Error(`token mint HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const tok = JSON.parse(await r.text());
  const sr = await fetch(`https://${loginHost}/admin/api/${API_VER}/shop.json`, {
    headers: { 'X-Shopify-Access-Token': tok.access_token },
  });
  const host = sr.ok ? (await sr.json()).shop.myshopify_domain : loginHost;
  return { token: tok.access_token, scope: tok.scope, host };
}

/** REST + GraphQL clients bound to a minted token. */
export function client(token, host) {
  const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  return {
    rest: (p, init = {}) => fetch(`https://${host}/admin/api/${API_VER}/${p}`, { ...init, headers: H }),
    gql: (query, variables = {}) => fetch(`https://${host}/admin/api/${API_VER}/graphql.json`, {
      method: 'POST', headers: H, body: JSON.stringify({ query, variables }),
    }),
    host,
  };
}
