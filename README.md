# Ukiyo Section OS

Ukiyo Section OS 1.0 is a production-oriented Shopify section platform. It converts designs from Claude, Kimi, Bolt, Emergent, and other coding environments into native, modular Online Store 2.0 sections that merchants can edit in Shopify's theme editor.

## Product capabilities

- Visual section builder with luxury responsive preview.
- Platform-neutral JSON design contract.
- Deterministic Liquid, schema, CSS, and JavaScript compiler.
- Native controls for copy, media, backgrounds, overlays, opacity, layout, typography, mobile behavior, motion, and blocks.
- Saved projects and immutable version history.
- Multi-store Shopify OAuth.
- Encrypted, automatically rotating expiring offline tokens.
- Unpublished-theme-only deployment lock.
- Pre-deployment file snapshots and rollback.
- Deployment audit ledger.
- REST and Streamable HTTP MCP integrations.
- One-time-display, hashed, revocable API keys.
- Mandatory Shopify compliance and uninstall webhooks.
- Optional Shopify recurring billing without hard-coded pricing.
- PostgreSQL persistence, Docker deployment, security headers, rate limiting, and production configuration validation.

## Product surfaces

| Surface | Purpose |
| --- | --- |
| Projects | Saved section library and versioned workspaces |
| Visual Builder | Merchant-friendly modular control generation |
| Design Contract | Universal source format for AI coding platforms |
| Generated Files | Liquid, schema, CSS, JavaScript, and installation package |
| Deployments | Safe draft-theme installation, history, and rollback |
| Connections | Shopify account, MCP endpoint, REST endpoint, and API keys |

## Local development

Node.js 20 or newer is required. Node.js 24 is used by the provided Docker image.

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run dev
```

Open `http://localhost:5173`. The API runs at `http://localhost:8787`.

Without `DATABASE_URL`, development automatically uses in-memory storage. Production refuses to start without PostgreSQL and required secrets.

## Verification

```bash
npm run check
```

This runs strict TypeScript validation, the production UI build, compiler tests, security tests, and repository lifecycle tests.

## Shopify setup

1. Create the app in Shopify's Dev Dashboard.
2. Replace placeholders in `shopify.app.toml`.
3. Set the App URL and OAuth callback to the production HTTPS domain.
4. Request `read_themes,write_themes`.
5. Apply for Shopify's protected theme-file exemption as a page-builder/developer-tooling product.
6. Deploy the app configuration using Shopify CLI.
7. Test on a Shopify development store and duplicated theme.

Public apps created in 2026 require expiring offline access tokens. Section OS requests expiring tokens, encrypts access and refresh tokens, refreshes them before Admin API calls, and replaces both tokens after every rotation.

## Safe theme deployment

Every deployment follows this sequence:

1. Validate the complete design contract.
2. Confirm that the selected theme exists.
3. Reject the target when its role is `MAIN`.
4. Read and store the previous contents of every generated theme file.
5. Record an installing deployment.
6. Upsert the generated Liquid, CSS, and JavaScript files.
7. Record success or failure in the deployment ledger.
8. Permit rollback only while the same target theme remains unpublished.

## AI platform integrations

Create an API key in Connections. The secret is shown once.

### MCP

Endpoint:

```text
https://your-domain.com/mcp
```

Header:

```text
Authorization: Bearer vso_live_your_key
```

Tools:

- `validate_shopify_section`
- `compile_shopify_section`
- `list_section_projects`
- `save_section_project`
- `deploy_section_to_unpublished_theme`

The deployment tool requires explicit unpublished-theme confirmation and still verifies the theme role server-side.

### REST/OpenAPI

Import `openapi.yaml` into an OpenAPI-capable platform. Authenticated endpoints use the same bearer key:

- `POST /v1/compile`
- `GET /v1/projects`
- `POST /v1/projects`

The unauthenticated compiler endpoints remain available only in development. Production requires a connected merchant session.

## Billing

Billing is intentionally disabled by default because the commercial plan has not been chosen. Configure it only after deciding the plan name, monthly price, currency, and trial duration. When enabled, subscription approval and recurring charges run through Shopify's Billing API.

## Production deployment

```bash
docker build -t ukiyo-section-os:1.0.0 .
docker run --env-file .env -p 8787:8787 ukiyo-section-os:1.0.0
```

The database migration is idempotent and runs during startup.

See:

- `docs/DEPLOYMENT.md`
- `docs/SHOPIFY_SUBMISSION_CHECKLIST.md`
- `docs/AGENT_INTEGRATION.md`
- `docs/PRIVACY_POLICY_TEMPLATE.md`
- `docs/TERMS_TEMPLATE.md`

## Important launch boundary

The codebase is complete and configurable, but no code can independently create your Shopify Partner app, approve protected theme access, select your price, purchase a domain, provision hosting, or legally approve policy documents. Those external account decisions are captured step-by-step in the deployment and submission documents.
