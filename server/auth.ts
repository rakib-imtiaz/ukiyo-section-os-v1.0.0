import type { Request, Response } from 'express';
import { config } from './config';
import { db } from './db';
import { exchangeAuthorizationCode, storeTokens } from './shopify';
import { hmac, newSecret, normalizeShop, parseCookies, secureEqual, setSession, sha256, verifyShopifyQuery } from './security';

export async function beginShopifyAuth(request: Request, response: Response) {
  if (!config.shopify.clientId || !config.shopify.clientSecret) {
    response.status(503).send('Shopify OAuth is not configured.'); return;
  }
  const shop = normalizeShop(request.query.shop);
  if (!shop) { response.status(400).send('Enter a valid myshopify.com store domain.'); return; }
  const state = newSecret(24);
  await db.createOAuthState(sha256(state), shop);
  response.cookie('vso_oauth_state', `${state}.${hmac(state)}`, {
    httpOnly: true, secure: config.security.cookieSecure, sameSite: 'lax', maxAge: 10 * 60_000, path: '/auth/shopify/callback',
  });
  const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
  authorize.searchParams.set('client_id', config.shopify.clientId);
  authorize.searchParams.set('scope', config.shopify.scopes);
  authorize.searchParams.set('redirect_uri', `${config.appUrl}/auth/shopify/callback`);
  authorize.searchParams.set('state', state);
  response.redirect(authorize.toString());
}

export async function completeShopifyAuth(request: Request, response: Response) {
  const shop = normalizeShop(request.query.shop);
  const code = typeof request.query.code === 'string' ? request.query.code : '';
  const state = typeof request.query.state === 'string' ? request.query.state : '';
  if (!shop || !code || !state || !verifyShopifyQuery(request.query)) { response.status(400).send('Shopify OAuth verification failed.'); return; }
  const [cookieState, signature] = (parseCookies(request).vso_oauth_state ?? '').split('.');
  if (!cookieState || !signature || cookieState !== state || !secureEqual(hmac(cookieState), signature) || !(await db.consumeOAuthState(sha256(state), shop))) {
    response.status(400).send('The OAuth state expired or did not match. Start the connection again.'); return;
  }
  const tokens = await exchangeAuthorizationCode(shop, code);
  const granted = new Set(tokens.scope.split(',').map((scope) => scope.trim()));
  const required = config.shopify.scopes.split(',').map((scope) => scope.trim()).filter((scope) => !scope.startsWith('read_') || !granted.has(scope.replace('read_', 'write_')));
  if (required.some((scope) => !granted.has(scope))) { response.status(403).send('The store did not grant all required scopes.'); return; }
  const record = await storeTokens(shop, tokens);
  await db.audit(record.id, 'shop.connected', 'merchant', { scopes: tokens.scope });
  setSession(response, shop);
  response.clearCookie('vso_oauth_state', { path: '/auth/shopify/callback' });
  response.redirect(`/?shop=${encodeURIComponent(shop)}&connected=1`);
}
