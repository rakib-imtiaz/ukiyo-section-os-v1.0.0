# Factory store setup — free, no credit card, ~5 minutes

The Clone Factory pushes themes to a Shopify store through a **custom app** (Client ID + Client Secret).
Everything below is **free** — no paid plan, no credit card — as long as you use a **development store**
from the Dev Dashboard instead of a regular store from shopify.com (regular stores force a paid plan
after a 3-day trial).

> The wizard's Credentials step embeds this same guide as an interactive checklist with copy buttons.
> This document is the reference version.

## The free path (step by step)

1. **Open the Dev Dashboard** — [dev.shopify.com](https://dev.shopify.com). Free account, no card.
2. **Create a dev store** — *Dev stores → Create store*. Free forever, never expires, full Admin API
   access. Skip if you already have a store. Note: dev stores are **always password-protected** —
   copy that storefront password; the wizard asks for it (QA uses it to get past the wall).
3. **Create the app** — *Apps → Create app → Start from Dev Dashboard*. Any name.
4. **Add the access scopes** — open the app → *Access scopes*:

   ```
   write_themes, read_themes, write_online_store_navigation, write_content
   ```

   The first two are **required**; the last two are recommended (without them, menus/pages/blog
   setup writes `BLOCKED.md` mid-run instead of finishing the job).
5. **Release and install** — *Release* the version → app *Home → Distribution → Custom distribution*
   → pick your store → *Install app*.
6. **Copy the credentials** — app *Settings* tab → **Client ID** and **Client Secret** → paste into
   the wizard → **Test connection**.

## Verify before you queue

- **Test connection** — mints a short-lived token and reports the shop name + granted scopes.
- **Test push access** — additionally writes and immediately deletes a harmless snippet
  (`snippets/__themebot_canary.liquid`) on the store's main theme, proving end-to-end push works.

## Enter once, reuse forever

After a successful test, keep **"Remember this store"** on: the credentials are AES-256-GCM encrypted
and saved. Future jobs pick the store from a dropdown — the secret is pulled from encrypted storage
server-side and never round-trips the browser.

Saved stores live in the `factory_stores` table (migration `006`), or in the memory-mode state file
when running without Postgres. Delete one with `DELETE /api/factory/stores/:id`.

## Going live later

A dev store is a free practice loop forever — but it can't be flipped live in place. When it's time
for real customers you have two options:

1. **Re-run the same job against the real store** (recommended — the React site is the source of
   truth, so the factory just regenerates the theme there). Installing the custom app on the real
   store is free; the paid plan is the store's own subscription, never an app-creation fee.
2. **Transfer the dev store** — Partner Dashboard → *Stores → Transfer ownership* → the recipient
   picks a paid plan. Theme/products/settings carry over, but ownership leaves your partner
   organization and some apps don't transfer cleanly.
