import { config } from './config';
import { db } from './db';
import { decrypt, encrypt, normalizeShop } from './security';

export interface TokenResponse { access_token: string; scope: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; }

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

export function shopifyStatus() {
  return { configured: Boolean(config.shopify.clientId && config.shopify.clientSecret) || Boolean(config.shopify.legacyShop && config.shopify.legacyToken), apiVersion: config.shopify.apiVersion };
}
