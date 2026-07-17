// Preflight: mint token, verify shop identity, list themes, canary write+delete.
// Proves end-to-end write access before any real work. Never prints secrets or tokens.
import { writeFileSync, mkdirSync } from 'node:fs';
import { loginHost, mint, client, ROOT, API_VER } from './qa/lib.mjs';

// No secret is read from disk: factory mode mints via the app's localhost-only endpoint.
const shopHost = loginHost();
console.log(`shop host: ${shopHost}`);

// --- 0.4 token mint ---
let minted;
try {
  minted = await mint();
} catch (error) {
  console.log(`\nFAIL token mint: ${error.message}`);
  process.exit(1);
}
const { token, scope, host } = minted;
console.log(`\nOK token mint: token shpat_...${token.slice(-4)}`);
console.log(`   scopes: ${scope || '(none reported)'}`);
const REQUIRED = ['write_themes', 'read_themes'];
const missing = REQUIRED.filter((s) => !(scope || '').includes(s));
if (missing.length) { console.log(`FAIL missing scopes: ${missing.join(', ')}`); process.exit(1); }

const c = client(token, host);

// --- 0.5 store identity ---
const shopRes = await c.rest('shop.json');
if (!shopRes.ok) { console.log(`FAIL shop.json: HTTP ${shopRes.status}`); process.exit(1); }
const shop = (await shopRes.json()).shop;
console.log(`\nOK shop.json:`);
console.log(`   name:             ${shop.name}`);
console.log(`   myshopify_domain: ${shop.myshopify_domain}`);
console.log(`   domain-match:     ${shop.myshopify_domain === shopHost ? 'YES' : 'NO <-- MISMATCH'}`);
console.log(`   plan:             ${shop.plan_name}`);

// --- 0.6 themes + canary (real write proves access; deleted immediately) ---
const thRes = await c.rest('themes.json');
if (!thRes.ok) { console.log(`\nFAIL themes.json: HTTP ${thRes.status}\n${(await thRes.text()).slice(0, 400)}`); process.exit(1); }
const themes = (await thRes.json()).themes;
console.log(`\nOK themes.json: ${themes.length} theme(s)`);
for (const t of themes) console.log(`   [${t.id}] ${t.role.padEnd(11)} ${t.name}`);
const live = themes.find((t) => t.role === 'main');
if (!live) { console.log('FAIL: no live (main) theme'); process.exit(1); }

const KEY = 'snippets/__preflight-canary.liquid';
const put = await c.rest(`themes/${live.id}/assets.json`, {
  method: 'PUT',
  body: JSON.stringify({ asset: { key: KEY, value: '{% comment %} preflight canary {% endcomment %}' } }),
});
console.log(`\ncanary PUT on live theme ${live.id}: HTTP ${put.status}`);
if (!put.ok) { console.log((await put.text()).slice(0, 600)); process.exit(1); }

const del = await c.rest(`themes/${live.id}/assets.json?asset[key]=${encodeURIComponent(KEY)}`, { method: 'DELETE' });
console.log(`canary DELETE:                     HTTP ${del.status}`);
if (!del.ok) { console.log((await del.text()).slice(0, 600)); process.exit(1); }

// --- persist state (token file lives in the workspace only) ---
mkdirSync(`${ROOT}/qa/state`, { recursive: true });
mkdirSync(`${ROOT}/qa/reports`, { recursive: true });
mkdirSync(`${ROOT}/qa/screenshots`, { recursive: true });
const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
writeFileSync(`${ROOT}/qa/state/token.json`,
  JSON.stringify({ shop: host, access_token: token, scope, expires_at: expires, live_theme_id: live.id }, null, 2));
console.log(`\nOK wrote qa/state/token.json (expires ${expires})`);
console.log(`\nAPI version: ${API_VER}`);
console.log('\nPREFLIGHT 0.4-0.6 PASSED');
