// Pull theme files from Shopify (cloud = source of truth). ALWAYS pull before editing.
// Env: THEME_ID (default = dev from qa/state/theme.json), ONLY=a,b (substring filter),
//      MODE=backup (default: snapshot into qa/state/cloud-backup/<ts>/) | sync (overwrite local files).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { mint, client, ROOT } from './qa/lib.mjs';

const state = JSON.parse(readFileSync(`${ROOT}/qa/state/theme.json`, 'utf8'));
const THEME_ID = process.env.THEME_ID || state.dev_theme_id;
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const MODE = process.env.MODE || 'backup';

const { token, host } = await mint();
const c = client(token, host);

const listRes = await c.rest(`themes/${THEME_ID}/assets.json`);
if (!listRes.ok) { console.log(`FAIL list assets HTTP ${listRes.status}: ${(await listRes.text()).slice(0, 300)}`); process.exit(1); }
let assets = (await listRes.json()).assets.map((a) => a.key);
// Only text-editable theme code by default (skip binary assets unless explicitly filtered for)
assets = assets.filter((k) => /^(layout|sections|snippets|templates|config)\//.test(k) || /\.(css|js|json|liquid|svg)$/.test(k));
if (ONLY.length) assets = assets.filter((k) => ONLY.some((o) => k.includes(o)));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(ROOT, 'qa', 'state', 'cloud-backup', stamp);
console.log(`pulling ${assets.length} asset(s) from theme ${THEME_ID} on ${host} (mode=${MODE})`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, fail = 0;
for (const key of assets) {
  let r;
  for (let attempt = 0; attempt < 6; attempt++) {
    r = await c.rest(`themes/${THEME_ID}/assets.json?asset[key]=${encodeURIComponent(key)}`);
    if (r.status !== 429) break;
    await sleep(600 * (attempt + 1));
  }
  if (!r.ok) { fail++; console.log(`  FAIL ${key} HTTP ${r.status}`); continue; }
  const asset = (await r.json()).asset;
  const value = asset.value ?? (asset.attachment ? Buffer.from(asset.attachment, 'base64').toString('utf8') : '');
  const target = MODE === 'sync' ? path.join(ROOT, key) : path.join(backupDir, key);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value);
  ok++;
  await sleep(350);
}
console.log(`done: ${ok} pulled, ${fail} failed${MODE === 'backup' ? ` -> ${backupDir}` : ' (local files overwritten with cloud state)'}`);
if (fail) process.exit(1);
