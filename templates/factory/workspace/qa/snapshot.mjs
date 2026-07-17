// Theme snapshot / restore for the QA convergence loop: capture the dev theme's installable
// files at a known-good iteration, and roll back to exactly that state if a later fix
// iteration regresses the score.
//
// Usage (called by the factory from convergence — keep this CLI contract stable):
//   node qa/snapshot.mjs save <iter>     GET every installable theme file of the dev theme into
//                                        qa/state/theme-snapshots/iter-<iter>/ + manifest.json
//                                        (file list + sha256 hashes + byte sizes).
//   node qa/snapshot.mjs restore <iter>  PUT exactly the manifest's files back to the dev theme
//                                        (429 backoff, concurrency 2 — same pacing as push.mjs).
//
// Scope: text-installable assets (layout/sections/snippets/templates/config + .css/.js/.json/
// .liquid/.svg) — the same set pull.mjs edits. Binary CDN assets are content-addressed and are
// not snapshotted. Exit code: 0 iff every file saved/restored.
//
// SAFETY: refuses to touch the published (MAIN) theme, ever — same convention as the other
// workspace scripts (dev theme only; the factory backend owns any dev->live publish).
// Env: THEME_ID (default = dev_theme_id from qa/state/theme.json).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mint, client, ROOT } from './lib.mjs';

const [action, iterArg] = process.argv.slice(2);
const ITER = String(iterArg ?? '').trim();
if (!['save', 'restore'].includes(action) || !/^\d+$/.test(ITER)) {
  console.error('usage: node qa/snapshot.mjs <save|restore> <iter>');
  process.exit(1);
}

const state = JSON.parse(readFileSync(path.join(ROOT, 'qa', 'state', 'theme.json'), 'utf8'));
const THEME_ID = String(process.env.THEME_ID || state.dev_theme_id || '');
if (!THEME_ID) { console.error('FAIL: no THEME_ID (env) and no dev_theme_id in qa/state/theme.json'); process.exit(1); }
const snapDir = path.join(ROOT, 'qa', 'state', 'theme-snapshots', `iter-${ITER}`);
const manifestPath = path.join(snapDir, 'manifest.json');

const { token, host } = await mint();
const c = client(token, host);

// ---- guard: never touch the published (MAIN) theme ----
const themesRes = await c.rest('themes.json');
if (!themesRes.ok) { console.error(`FAIL list themes HTTP ${themesRes.status}: ${(await themesRes.text()).slice(0, 300)}`); process.exit(1); }
const themes = (await themesRes.json()).themes;
const target = themes.find((t) => String(t.id) === THEME_ID);
if (!target) { console.error(`FAIL: theme ${THEME_ID} not found on ${host}`); process.exit(1); }
if (target.role === 'main' || (state.live_theme_id != null && String(state.live_theme_id) === THEME_ID)) {
  console.error(`REFUSED: theme ${THEME_ID} ("${target.name}", role=${target.role}) is the published/MAIN theme — snapshot.mjs only operates on the dev theme.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const INSTALLABLE = (key) => /^(layout|sections|snippets|templates|config)\//.test(key) || /\.(css|js|json|liquid|svg)$/.test(key);

async function restWithBackoff(pathAndQuery, init) {
  let response;
  for (let attempt = 0; attempt < 6; attempt++) {
    response = await c.rest(pathAndQuery, init);
    if (response.status !== 429) return response;
    await sleep(600 * (attempt + 1));
  }
  return response;
}

if (action === 'save') {
  const listRes = await restWithBackoff(`themes/${THEME_ID}/assets.json`);
  if (!listRes.ok) { console.error(`FAIL list assets HTTP ${listRes.status}: ${(await listRes.text()).slice(0, 300)}`); process.exit(1); }
  const keys = (await listRes.json()).assets.map((asset) => asset.key).filter(INSTALLABLE);
  console.log(`snapshot save iter-${ITER}: ${keys.length} installable file(s) from theme ${THEME_ID} ("${target.name}") on ${host}`);

  const files = [];
  let failed = 0;
  for (const key of keys) {
    const res = await restWithBackoff(`themes/${THEME_ID}/assets.json?asset[key]=${encodeURIComponent(key)}`);
    if (!res.ok) { failed++; console.error(`  FAIL ${key} HTTP ${res.status}`); continue; }
    const asset = (await res.json()).asset;
    const value = asset.value ?? (asset.attachment ? Buffer.from(asset.attachment, 'base64').toString('utf8') : '');
    const filePath = path.join(snapDir, key);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, value);
    files.push({ key, sha256: sha256(value), bytes: Buffer.byteLength(value) });
    await sleep(350);
  }
  mkdirSync(snapDir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ theme_id: Number(THEME_ID), theme_name: target.name, host, iter: Number(ITER), saved_at: new Date().toISOString(), files }, null, 2));
  console.log(`snapshot save done: ${files.length} saved, ${failed} failed -> ${path.relative(ROOT, snapDir)}${path.sep}manifest.json`);
  if (failed) process.exit(1);
} else {
  if (!existsSync(manifestPath)) { console.error(`FAIL: no snapshot manifest at ${manifestPath} — was 'save ${ITER}' run?`); process.exit(1); }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (String(manifest.theme_id) !== THEME_ID) {
    console.error(`REFUSED: snapshot iter-${ITER} was taken from theme ${manifest.theme_id}, but the restore target is theme ${THEME_ID}. Set THEME_ID to match or re-save.`);
    process.exit(1);
  }
  console.log(`snapshot restore iter-${ITER}: pushing ${manifest.files.length} file(s) (saved ${manifest.saved_at}) back to theme ${THEME_ID} ("${target.name}") on ${host}`);

  async function putAsset(file) {
    const filePath = path.join(snapDir, file.key);
    if (!existsSync(filePath)) return { ok: false, msg: `${file.key} -> snapshot file missing on disk` };
    const value = readFileSync(filePath, 'utf8');
    const res = await restWithBackoff(`themes/${THEME_ID}/assets.json`, { method: 'PUT', body: JSON.stringify({ asset: { key: file.key, value } }) });
    if (res.ok) return { ok: true };
    if (res.status === 429) return { ok: false, msg: `${file.key} -> 429 after retries` };
    return { ok: false, msg: `${file.key} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}` };
  }

  // concurrency 2 to respect the 2 req/s Assets API limit, with pacing (same as push.mjs)
  const CONC = 2;
  let ok = 0;
  const failures = [];
  for (let i = 0; i < manifest.files.length; i += CONC) {
    const results = await Promise.all(manifest.files.slice(i, i + CONC).map(putAsset));
    for (const result of results) { if (result.ok) ok++; else failures.push(result.msg); }
    await sleep(350);
  }
  console.log(`snapshot restore done: ${ok} restored, ${failures.length} failed`);
  if (failures.length) { console.error('\nFAILURES:'); failures.forEach((msg) => console.error('  ' + msg)); process.exit(1); }
}
