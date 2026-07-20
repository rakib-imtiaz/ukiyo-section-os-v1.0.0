-- Saved factory store credentials ("lazy" onboarding): enter a store's Dev Dashboard
-- Client ID/Secret once, reuse it on every future clone job for that store.
--
-- Security notes:
--   * client_secret_cipher / storefront_password_cipher are AES-256-GCM via the app's
--     encryption key — this table NEVER holds plaintext secrets.
--   * client_id is stored in plaintext on purpose: it is a public identifier (safe to
--     embed in workspace configs), only the secret is sensitive.
--   * Upserts key on shop_domain so re-saving a store refreshes its credentials in place.

CREATE TABLE IF NOT EXISTS factory_stores (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  shop_domain TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  client_secret_cipher TEXT NOT NULL,
  storefront_password_cipher TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
