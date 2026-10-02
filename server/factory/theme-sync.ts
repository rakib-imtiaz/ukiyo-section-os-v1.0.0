// Draft-theme sync: are the theme files on disk the same as the ones on the store's UNPUBLISHED
// draft theme? A check compares your website with the draft theme's preview, so files that were
// written but never uploaded would make the score meaningless. Compares by MD5 (Shopify's asset
// checksum) and uploads only the files that differ.
//
// SAFETY: only ever the draft theme recorded in qa/state/theme.json (dev_theme_id). If Shopify
// reports that theme as the live one (role "main"), nothing is read or written.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import type { FactoryJobRecord } from '../db';
import { decrypt, normalizeShop } from '../security';

const THEME_DIRS = ['layout', 'sections', 'blocks', 'snippets', 'templates', 'config', 'locales', 'assets'];
const TEXT_EXT = /\.(liquid|json|css|js|mjs|svg|txt|md)$/i;

export interface SyncStatus {
  ok: boolean;
  error?: string;
  themeId: number | null;
  themeName?: string;
  missing: string[];   // on disk, not on the draft theme
  changed: string[];   // on both, different content
  total: number;       // theme files on disk
  checkedAt: number;
}

async function token(job: FactoryJobRecord) {
  const shop = normalizeShop(job.store_url);
  if (!shop) throw new Error('This build has no valid store address.');
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: decrypt(job.client_id_cipher), client_secret: decrypt(job.client_secret_cipher), grant_type: 'client_credentials' }),
  });
  if (!response.ok) throw new Error(`Could not connect to the store (HTTP ${response.status}).`);
  return { shop, accessToken: ((await response.json()) as { access_token: string }).access_token };
}

async function draftTheme(job: FactoryJobRecord, shop: string, accessToken: string) {
  const state = JSON.parse(await readFile(path.join(job.workspace_path, 'qa', 'state', 'theme.json'), 'utf8')) as { dev_theme_id?: number };
  const themeId = Number(state.dev_theme_id);
  if (!themeId) throw new Error('This build has no draft theme yet.');
  const response = await fetch(`https://${shop}/admin/api/${config.shopify.apiVersion}/themes/${themeId}.json`, { headers: { 'X-Shopify-Access-Token': accessToken } });
  if (!response.ok) throw new Error(`The draft theme could not be found (HTTP ${response.status}).`);
  const theme = ((await response.json()) as { theme: { id: number; name: string; role: string } }).theme;
  if (theme.role === 'main') throw new Error('Refusing to sync: that theme is the live theme.');
  return theme;
}

async function localFiles(root: string) {
  const files: Array<{ key: string; md5: string; full: string }> = [];
  for (const dir of THEME_DIRS) {
    let names: string[] = [];
    try { names = await readdir(path.join(root, dir)); } catch { continue; }
    for (const name of names) {
      const full = path.join(root, dir, name);
      try { if (!(await stat(full)).isFile()) continue; } catch { continue; }
      files.push({ key: `${dir}/${name}`, md5: createHash('md5').update(await readFile(full)).digest('hex'), full });
    }
  }
  return files;
}

const cache = new Map<string, SyncStatus>();

export async function syncStatus(job: FactoryJobRecord, force = false): Promise<SyncStatus> {
  const cached = cache.get(job.id);
  if (cached && !force && Date.now() - cached.checkedAt < 60_000) return cached;
  const base: SyncStatus = { ok: false, themeId: null, missing: [], changed: [], total: 0, checkedAt: Date.now() };
  try {
    const { shop, accessToken } = await token(job);
    const theme = await draftTheme(job, shop, accessToken);
    const response = await fetch(`https://${shop}/admin/api/${config.shopify.apiVersion}/themes/${theme.id}/assets.json?fields=key,checksum`, { headers: { 'X-Shopify-Access-Token': accessToken } });
    if (!response.ok) throw new Error(`Could not list the draft theme's files (HTTP ${response.status}).`);
    const remote = new Map(((await response.json()) as { assets: Array<{ key: string; checksum: string | null }> }).assets.map((asset) => [asset.key, asset.checksum]));
    const local = await localFiles(job.workspace_path);
    const status: SyncStatus = {
      ok: true, themeId: theme.id, themeName: theme.name, total: local.length, checkedAt: Date.now(),
      missing: local.filter((file) => !remote.has(file.key)).map((file) => file.key),
      changed: local.filter((file) => remote.has(file.key) && remote.get(file.key) && remote.get(file.key) !== file.md5).map((file) => file.key),
    };
    cache.set(job.id, status);
    return status;
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : 'Could not check the draft theme.' };
  }
}

/** Upload the files that are missing or different — to the draft theme only. */
export async function uploadToDraft(job: FactoryJobRecord): Promise<{ uploaded: string[]; failed: Array<{ key: string; error: string }> }> {
  const status = await syncStatus(job, true);
  if (!status.ok || !status.themeId) throw new Error(status.error ?? 'Could not check the draft theme.');
  const { shop, accessToken } = await token(job);
  await draftTheme(job, shop, accessToken);   // re-check it is still not the live theme
  const keys = [...status.missing, ...status.changed];
  const uploaded: string[] = []; const failed: Array<{ key: string; error: string }> = [];
  const logFile = path.join(job.workspace_path, 'factory', 'logs', 'sync.log');
  await mkdir(path.dirname(logFile), { recursive: true }).catch(() => {});
  // Layout and config first (sections and templates depend on them), templates last.
  const order = (key: string) => ['layout', 'config', 'locales', 'snippets', 'blocks', 'assets', 'sections', 'templates'].indexOf(key.split('/')[0]);
  for (const key of keys.sort((a, b) => order(a) - order(b))) {
    const bytes = await readFile(path.join(job.workspace_path, key));
    const asset = TEXT_EXT.test(key) ? { key, value: bytes.toString('utf8') } : { key, attachment: bytes.toString('base64') };
    const response = await fetch(`https://${shop}/admin/api/${config.shopify.apiVersion}/themes/${status.themeId}/assets.json`, {
      method: 'PUT', headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ asset }),
    }).catch((error: unknown) => ({ ok: false, status: 0, text: async () => String(error) }) as unknown as Response);
    if (response.ok) uploaded.push(key);
    else failed.push({ key, error: (await response.text().catch(() => '')).slice(0, 200) || `HTTP ${response.status}` });
    await appendFile(logFile, `${new Date().toISOString()} | ${key} | ${response.ok ? 'uploaded' : `FAILED ${response.status}`} | draft theme ${status.themeId}\n`).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 550));   // stay under the Admin API rate limit
  }
  cache.delete(job.id);
  return { uploaded, failed };
}
