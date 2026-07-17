# Production deployment

## 1. Create the Shopify app

Create a public app in Shopify's Dev Dashboard. Section OS is configured as a standalone app because its workspace runs outside the Shopify Admin iframe.

Set:

- App URL: `https://your-app-domain.com`
- Redirect URL: `https://your-app-domain.com/auth/shopify/callback`
- Scopes: `read_themes,write_themes`
- API version: `2026-07`

Replace the placeholders in `shopify.app.toml`, then deploy the configuration with Shopify CLI.

## 2. Request protected theme access

Apply for Shopify's protected theme-file exemption. Describe Section OS as a page-builder and developer-tooling product that creates complete merchant-editable Online Store 2.0 sections, validates them, previews them, versions them, and deploys only with merchant confirmation.

The app remains fully usable through ZIP export while approval is pending.

## 3. Provision infrastructure

Required production services:

- A container host capable of running Node.js 24.
- PostgreSQL 15 or newer.
- A permanent HTTPS domain.
- Centralized logs and uptime monitoring.
- Daily PostgreSQL backups.

Build and run:

```bash
docker build -t ukiyo-section-os:1.0.0 .
docker run --env-file .env -p 8787:8787 ukiyo-section-os:1.0.0
```

The migration runs automatically at startup and is idempotent.

## 4. Configure secrets

Generate independent values:

```bash
openssl rand -base64 32
openssl rand -hex 48
openssl rand -hex 48
```

Use them for `APP_ENCRYPTION_KEY`, `SESSION_SECRET`, and `API_KEY_PEPPER`. Never reuse or commit these values.

## 5. Configure billing

Billing is off by default because product pricing has not been selected. Once pricing is final, set:

```env
BILLING_ENABLED=true
SHOPIFY_PLAN_NAME=Section OS Pro
SHOPIFY_PLAN_PRICE=YOUR_PRICE
SHOPIFY_PLAN_CURRENCY=USD
SHOPIFY_PLAN_TRIAL_DAYS=14
```

The app will create the recurring subscription through Shopify and use Shopify's merchant approval screen.

## 6. Connect AI platforms

Create a key under Connections. Use:

- Streamable HTTP MCP: `https://your-app-domain.com/mcp`
- REST/OpenAPI: `https://your-app-domain.com/v1`
- Header: `Authorization: Bearer vso_live_...`

Keep one key per platform or external development partner so access can be revoked independently.

## 7. Release checks

Run:

```bash
npm ci
npm run check
docker build -t ukiyo-section-os:release .
```

Test OAuth, token refresh, app uninstall, compliance webhooks, project saves, compilation, deployment to a duplicated theme, and rollback on a Shopify development store before submitting the public app.
