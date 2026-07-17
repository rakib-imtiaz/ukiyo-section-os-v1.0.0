import { config } from './config';
import { db } from './db';
import { decrypt, encrypt, normalizeShop } from './security';
import type { GeneratedFile } from '../src/shared/types';

export interface ShopifyTheme { id: string; name: string; role: string; }
export interface TokenResponse { access_token: string; scope: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; }
export interface ThemeSnapshot { filename: string; existed: boolean; bodyType: 'TEXT'|'BASE64'; value?: string; }

const refreshes = new Map<string, Promise<string>>();

function tokenDates(tokens: TokenResponse) {
  return {
    token_expires_at: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
    refresh_token_expires_at: tokens.refresh_token_expires_in ? new Date(Date.now() + tokens.refresh_token_expires_in * 1000).toISOString() : null,
  };
}

async function tokenRequest(shop: string, body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
  });
  const payload = await response.json() as TokenResponse & { error?: string; error_description?: string };
  if (!response.ok || payload.error) throw new Error(payload.error_description || payload.error || `Shopify token request failed with HTTP ${response.status}.`);
  return payload;
}

export async function exchangeAuthorizationCode(shop: string, code: string) {
  return tokenRequest(shop, new URLSearchParams({
    client_id: config.shopify.clientId, client_secret: config.shopify.clientSecret, code, expiring: '1',
  }));
}

async function refreshAccessToken(shop: string) {
  const active = refreshes.get(shop);
  if (active) return active;
  const refresh = (async () => {
    const record = await db.getShop(shop);
    if (!record?.refresh_token_cipher) throw new Error('The Shopify session must be reconnected.');
    const tokens = await tokenRequest(shop, new URLSearchParams({
      client_id: config.shopify.clientId, client_secret: config.shopify.clientSecret,
      grant_type: 'refresh_token', refresh_token: decrypt(record.refresh_token_cipher),
    }));
    const dates = tokenDates(tokens);
    await db.updateShopTokens(record.id, {
      access_token_cipher: encrypt(tokens.access_token),
      refresh_token_cipher: tokens.refresh_token ? encrypt(tokens.refresh_token) : record.refresh_token_cipher,
      token_expires_at: dates.token_expires_at,
      refresh_token_expires_at: dates.refresh_token_expires_at,
      scopes: tokens.scope,
    });
    return tokens.access_token;
  })().finally(() => refreshes.delete(shop));
  refreshes.set(shop, refresh);
  return refresh;
}

export async function storeTokens(shop: string, tokens: TokenResponse) {
  const dates = tokenDates(tokens);
  return db.upsertShop({
    shop_domain: shop,
    access_token_cipher: encrypt(tokens.access_token),
    refresh_token_cipher: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
    token_expires_at: dates.token_expires_at,
    refresh_token_expires_at: dates.refresh_token_expires_at,
    scopes: tokens.scope,
  });
}

export async function getAccessToken(shopInput: string) {
  const shop = normalizeShop(shopInput);
  if (!shop) throw new Error('Invalid Shopify store domain.');
  if (config.shopify.legacyShop === shop && config.shopify.legacyToken) return config.shopify.legacyToken;
  const record = await db.getShop(shop);
  if (!record || record.status !== 'active') throw new Error('This Shopify store is not connected.');
  const expiresAt = record.token_expires_at ? new Date(record.token_expires_at).getTime() : Infinity;
  if (expiresAt - Date.now() < 5 * 60_000) return refreshAccessToken(shop);
  return decrypt(record.access_token_cipher);
}

export async function shopifyGraphql<T>(shop: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const makeRequest = async (token: string) => fetch(`https://${shop}/admin/api/${config.shopify.apiVersion}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }),
  });
  let response = await makeRequest(await getAccessToken(shop));
  if (response.status === 401) response = await makeRequest(await refreshAccessToken(shop));
  const payload = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (!response.ok || payload.errors?.length) throw new Error(payload.errors?.map((error) => error.message).join('; ') || `Shopify returned HTTP ${response.status}.`);
  if (!payload.data) throw new Error('Shopify returned no data.');
  return payload.data;
}

export async function listThemes(shop: string): Promise<ShopifyTheme[]> {
  const data = await shopifyGraphql<{ themes: { nodes: ShopifyTheme[] } }>(shop, `#graphql
    query SectionOsThemes { themes(first: 50) { nodes { id name role } } }
  `);
  return data.themes.nodes;
}

/** Fetch a single theme's live status by id (role + async-processing flag). */
async function fetchTheme(shop: string, themeId: string): Promise<(ShopifyTheme & { processing: boolean }) | null> {
  const data = await shopifyGraphql<{ theme: (ShopifyTheme & { processing: boolean }) | null }>(shop, `#graphql
    query SectionOsThemeStatus($id: ID!) { theme(id: $id) { id name role processing } }
  `, { id: themeId });
  return data.theme;
}

/** Poll until a freshly-created/duplicated theme has finished asynchronous processing. */
async function waitForThemeReady(shop: string, themeId: string, timeoutMs = 180_000): Promise<ShopifyTheme> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const theme = await fetchTheme(shop, themeId);
    if (!theme) throw new Error('The duplicated theme could not be found.');
    if (!theme.processing) return { id: theme.id, name: theme.name, role: theme.role };
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the duplicated theme to finish processing.');
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

/**
 * Duplicate an existing theme into a fresh, UNPUBLISHED target and wait until it is ready.
 * Callers get a safe, writable copy so deploys never touch the live/published theme.
 */
export async function themeDuplicate(shop: string, sourceThemeId: string, name?: string): Promise<ShopifyTheme> {
  const data = await shopifyGraphql<{ themeDuplicate: { theme: ShopifyTheme | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(shop, `#graphql
    mutation SectionOsThemeDuplicate($id: ID!, $name: String) {
      themeDuplicate(id: $id, name: $name) {
        theme { id name role }
        userErrors { field message }
      }
    }
  `, { id: sourceThemeId, name });
  if (data.themeDuplicate.userErrors.length) throw new Error(data.themeDuplicate.userErrors.map((error) => error.message).join('; '));
  const theme = data.themeDuplicate.theme;
  if (!theme) throw new Error('Theme duplication did not return a theme.');
  return waitForThemeReady(shop, theme.id);
}

/**
 * Re-validate the write target's role IMMEDIATELY before mutating it. `listThemes` at the
 * top of a deploy is a check-then-write race: a merchant can publish the target between the
 * check and the upsert. Re-fetching here closes that TOCTOU so we never write to a MAIN theme.
 */
async function assertWritableTarget(shop: string, themeId: string) {
  const theme = await fetchTheme(shop, themeId);
  if (!theme) throw new Error('The selected theme could not be found.');
  if (theme.role === 'MAIN') throw new Error('Section OS will not write directly to the published theme. Select an unpublished duplicate.');
}

export async function readThemeFiles(shop: string, themeId: string, filenames: string[]): Promise<ThemeSnapshot[]> {
  if (!filenames.length) return [];
  const data = await shopifyGraphql<{ theme: null | { files: { nodes: Array<{ filename: string; body: { content?: string; contentBase64?: string; url?: string } }>; userErrors: Array<{ code: string; filename: string }> } } }>(shop, `#graphql
    query SectionOsThemeFiles($themeId: ID!, $filenames: [String!]!) {
      theme(id: $themeId) {
        files(filenames: $filenames, first: 50) {
          nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } ... on OnlineStoreThemeFileBodyBase64 { contentBase64 } ... on OnlineStoreThemeFileBodyUrl { url } } }
          userErrors { code filename }
        }
      }
    }
  `, { themeId, filenames });
  if (!data.theme) throw new Error('Theme not found.');
  const found = new Map(data.theme.files.nodes.map((file) => [file.filename, file]));
  return filenames.map((filename) => {
    const file = found.get(filename);
    if (!file) return { filename, existed: false, bodyType: 'TEXT' as const };
    if (typeof file.body.contentBase64 === 'string') return { filename, existed: true, bodyType: 'BASE64' as const, value: file.body.contentBase64 };
    return { filename, existed: true, bodyType: 'TEXT' as const, value: file.body.content ?? '' };
  });
}

// Shopify caps each themeFilesUpsert at 50 files. Batch instead of throwing so full-theme
// deploys (which routinely exceed 50 files) work by splitting into sequential ≤50 chunks.
const UPSERT_CHUNK_SIZE = 50;

async function upsertFiles(shop: string, themeId: string, files: Array<{ filename: string; body: { type: 'TEXT'|'BASE64'; value: string } }>) {
  if (!files.length) return [];
  // Close the check-then-write race: re-validate role !== MAIN right before the first write.
  await assertWritableTarget(shop, themeId);
  const upserted: string[] = [];
  for (let index = 0; index < files.length; index += UPSERT_CHUNK_SIZE) {
    const chunk = files.slice(index, index + UPSERT_CHUNK_SIZE);
    const data = await shopifyGraphql<{ themeFilesUpsert: { upsertedThemeFiles: Array<{ filename: string }>; userErrors: Array<{ message: string }> } }>(shop, `#graphql
      mutation SectionOsInstall($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
        themeFilesUpsert(themeId: $themeId, files: $files) { upsertedThemeFiles { filename } userErrors { message } }
      }
    `, { themeId, files: chunk });
    if (data.themeFilesUpsert.userErrors.length) throw new Error(data.themeFilesUpsert.userErrors.map((error) => error.message).join('; '));
    for (const file of data.themeFilesUpsert.upsertedThemeFiles) upserted.push(file.filename);
  }
  return upserted;
}

async function deleteFiles(shop:string,themeId:string,files:string[]){
  if(!files.length)return [];
  await assertWritableTarget(shop, themeId);
  const data=await shopifyGraphql<{themeFilesDelete:{deletedThemeFiles:Array<{filename:string}>;userErrors:Array<{message:string}>}}>(shop,`#graphql
    mutation SectionOsDelete($themeId: ID!, $files: [String!]!) { themeFilesDelete(themeId:$themeId,files:$files){ deletedThemeFiles{filename} userErrors{message} } }
  `,{themeId,files});
  if(data.themeFilesDelete.userErrors.length)throw new Error(data.themeFilesDelete.userErrors.map((error)=>error.message).join('; '));
  return data.themeFilesDelete.deletedThemeFiles.map((file)=>file.filename);
}

export async function installFiles(shop: string, themeId: string, files: GeneratedFile[]) {
  const prepared = await prepareInstallation(shop, themeId, files);
  const installed = await applyInstallation(shop, themeId, prepared.themeFiles);
  return { theme: prepared.theme, files: installed, snapshot: prepared.snapshot };
}

export async function prepareInstallation(shop: string, themeId: string, files: GeneratedFile[]) {
  const themes = await listThemes(shop);
  const target = themes.find((theme) => theme.id === themeId);
  if (!target) throw new Error('The selected theme could not be found.');
  if (target.role === 'MAIN') throw new Error('Section OS will not write directly to the published theme. Select an unpublished duplicate.');
  const themeFiles = files.filter((file) => file.path.startsWith('sections/') || file.path.startsWith('assets/'));
  const snapshot = await readThemeFiles(shop, themeId, themeFiles.map((file) => file.path));
  return { theme: target, themeFiles, snapshot };
}

export async function applyInstallation(shop:string,themeId:string,themeFiles:GeneratedFile[]){
  return upsertFiles(shop,themeId,themeFiles.map((file)=>({filename:file.path,body:{type:'TEXT',value:file.content}})));
}

export async function rollbackFiles(shop:string,themeId:string,snapshot:ThemeSnapshot[]){
  const restore=snapshot.filter((file)=>file.existed&&typeof file.value==='string').map((file)=>({filename:file.filename,body:{type:file.bodyType,value:file.value!}}));
  const remove=snapshot.filter((file)=>!file.existed).map((file)=>file.filename);
  const [restored,deleted]=await Promise.all([upsertFiles(shop,themeId,restore),deleteFiles(shop,themeId,remove)]);
  return { restored, deleted };
}

export function shopifyStatus() {
  return { configured: Boolean(config.shopify.clientId && config.shopify.clientSecret) || Boolean(config.shopify.legacyShop && config.shopify.legacyToken), apiVersion: config.shopify.apiVersion };
}
