// Push theme files to a Shopify theme via REST Assets API.
// Mints a fresh token, auto-discovers layout/sections/snippets/templates/assets/config,
// PUTs each with 429 backoff. Env: THEME_ID (default = dev from qa/state/theme.json),
// ONLY=a,b (substring filter — push only edited files; never bulk-push blindly).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { mint, client, ROOT } from './qa/lib.mjs';

const state = JSON.parse(readFileSync(`${ROOT}/qa/state/theme.json`, 'utf8'));
const THEME_ID = process.env.THEME_ID || state.dev_theme_id;
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);

const { token, host } = await mint();
const c = client(token, host);

function walk(dir, prefix) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    const full = `${dir}/${f}`;
    if (statSync(full).isDirectory()) continue;
    out.push({ key: `${prefix}/${f}`, path: full });
  }
  return out;
}

let assets = [
  ...walk(`${ROOT}/layout`, 'layout'),
  ...walk(`${ROOT}/sections`, 'sections'),
  ...walk(`${ROOT}/snippets`, 'snippets'),
  ...walk(`${ROOT}/templates`, 'templates'),
  ...walk(`${ROOT}/assets`, 'assets'),
  ...walk(`${ROOT}/config`, 'config'),
];
if (existsSync(`${ROOT}/templates/customers`)) assets.push(...walk(`${ROOT}/templates/customers`, 'templates/customers'));

if (ONLY.length) assets = assets.filter((a) => ONLY.some((o) => a.key.includes(o)));

console.log(`pushing ${assets.length} asset(s) to theme ${THEME_ID} on ${host}`);
let ok = 0, fail = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function putAsset(a) {
  const value = readFileSync(a.path, 'utf8');
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await c.rest(`themes/${THEME_ID}/assets.json`, {
      method: 'PUT', body: JSON.stringify({ asset: { key: a.key, value } }),
    });
    if (r.ok) return { ok: true };
    if (r.status === 429) { await sleep(600 * (attempt + 1)); continue; }
    return { ok: false, msg: `${a.key} -> HTTP ${r.status} ${(await r.text()).slice(0, 200)}` };
  }
  return { ok: false, msg: `${a.key} -> 429 after retries` };
}

// concurrency 2 to respect the 2 req/s Assets API limit, with pacing
const CONC = 2;
for (let i = 0; i < assets.length; i += CONC) {
  const batch = assets.slice(i, i + CONC);
  const res = await Promise.all(batch.map(putAsset));
  for (const rr of res) { if (rr.ok) ok++; else { fail++; failures.push(rr.msg); } }
  await sleep(350);
}
console.log(`done: ${ok} ok, ${fail} failed`);
if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  ' + f)); process.exit(1); }
