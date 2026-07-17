# ThemeBot

ThemeBot is an autonomous Shopify theme builder. It combines two spines in one local-first app:

1. **Section OS** — a visual section platform. A platform-neutral JSON design contract is compiled deterministically into native Online Store 2.0 files (Liquid, schema, CSS, JS) and deployed to **unpublished themes only**, with pre-deploy snapshots, rollback, and an audit ledger.
2. **Clone Factory** — an autonomous clone pipeline. Give it a React site URL, a Shopify store, and custom-app credentials; it scaffolds an isolated workspace, runs a headless `claude -p /clone-theme` build, then drives a Playwright QA convergence loop (section-presence, text-match, and interaction subscores) that spawns targeted fix sessions until the score threshold is met — with an optional post-convergence swap of the dev theme to live.

Around both spines sit an integrated **Terminal** (real PTY in the browser) and a managed **Browser** (live-streamed Playwright session that Claude can drive through a local MCP endpoint).

## Surfaces

| # | Surface | Purpose |
| --- | --- | --- |
| 00 | Home | Launchpad and workspace overview |
| 01 | Projects | Section library + clone projects, versioned |
| 02 | Visual builder | Merchant-style section editing with live preview |
| 03 | Design contract | The universal JSON source format |
| 04 | Generated files | Compiled Liquid / schema / CSS / JS output |
| 05 | Deployments | Draft-theme installs, history, rollback |
| 06 | Connections | Shopify OAuth, MCP + REST endpoints, API keys |
| 07 | Factory | Clone jobs, convergence status, scores, logs |
| 08 | Terminal | Integrated PTY shell (localhost-only) |
| 09 | Browser | Managed Playwright browser, Claude-drivable via local MCP |

## Quickstart

Node.js 20+ required.

```bash
npm install
npm run dev
```

Open `http://localhost:5173` (UI). The API listens at `http://127.0.0.1:8787`. On first launch an onboarding gate walks you through connecting the Claude CLI and choosing a factory workspace root; the onboarding endpoints are localhost-only.

Without `DATABASE_URL`, development uses in-memory storage automatically (factory state is still mirrored to a JSON file in the workspace root so long-running clone jobs survive restarts). Production refuses to boot without PostgreSQL and the required secrets.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8787` | API port |
| `HOST` | `127.0.0.1` | Bind address. Loopback by default so the API — including factory, terminal, and browser operator routes — is not reachable from the LAN. Set `HOST=0.0.0.0` only if you deliberately want network exposure (e.g. behind a reverse proxy). |
| `APP_URL` | `http://localhost:8787` | Public URL; must be HTTPS in production |
| `APP_ENCRYPTION_KEY` | dev: per-install random | **Required in production.** Base64-encoded 32-byte key; encrypts stored tokens/credentials (AES-256-GCM) |
| `SESSION_SECRET`, `API_KEY_PEPPER` | dev: per-install random | Required in production |
| `DATABASE_URL` | *(empty)* | Optional in dev (in-memory fallback); required in production |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` / `SHOPIFY_SCOPES` | — | OAuth app credentials for Section OS deployments |
| `FACTORY_ENABLED` | dev `true`, prod `false` | Clone Factory is a local operator tool |
| `FACTORY_WORKSPACE_ROOT` | — | Root folder where per-job clone workspaces are scaffolded |
| `FACTORY_CLAUDE_PATH` | `~/.local/bin/claude(.exe)` | Path to the Claude CLI used for headless runs |
| `FACTORY_PW_ROOT` | `./node_modules` | `node_modules` root the QA scripts resolve Playwright from |
| `FACTORY_CONCURRENCY` | `2` | Parallel clone jobs; see also `FACTORY_LAUNCH_STAGGER_SEC` and the `FACTORY_*_TIMEOUT_MIN` knobs |
| `TERMINAL_ENABLED` / `TERMINAL_CWD` / `TERMINAL_SHELL` | dev on, prod off | Integrated PTY terminal |
| `BROWSER_ENABLED` / `BROWSER_ENGINE` / `BROWSER_HEADLESS` / `BROWSER_START_URL` / `BROWSER_PROFILE_DIR` / `BROWSER_EXTENSIONS` | dev on, prod off | Integrated browser; persistent profile lives outside the repo |

## Clone Factory pipeline

1. **Create a job** — React URL + Shopify store URL + custom-app Client ID/Secret (+ optional storefront password).
2. **Scaffold** — an isolated workspace with the reference inputs, the bundled `/clone-theme` command, QA scripts, and a scoped `.claude/settings.json` permission allowlist.
3. **Clone** — headless `claude -p /clone-theme` builds and pushes the theme to an unpublished dev theme.
4. **Converge** — Playwright QA scores presence / text / interaction against the reference site; below-threshold runs get targeted fix sessions with fresh QA each iteration, up to `max_iterations`. The best-scoring iteration is tracked on the job.
5. **Autoswap (optional)** — after convergence, the dev theme can be published to live; this is opt-in per job and never happens implicitly.

## Security posture

- **Loopback by default** — the server binds `127.0.0.1`; operator tools (terminal, browser, local MCP, onboarding) additionally enforce localhost-only checks per request and are disabled in production builds.
- **Secrets at rest** — Shopify tokens and factory credentials are AES-256-GCM encrypted with `APP_ENCRYPTION_KEY`; API keys are stored hashed and shown once.
- **No secrets in workspaces** — the Shopify Client Secret is never written to clone-workspace files; workspace scripts mint short-lived tokens instead. Factory child processes get a minimal allowlisted environment, never the app's full `process.env`.
- **Published-theme guard** — every deploy path (UI, REST, MCP, factory) re-validates the target theme role server-side and refuses to write to `MAIN`.
- **Scoped CLI allowlists** — each headless Claude run is sandboxed by a per-job `.claude/settings.json` permission allowlist, and its output logs are secret-scrubbed.
- Standard hardening: strict CSP and security headers, HMAC-verified webhooks, production config validation (HTTPS `APP_URL`, required secrets).

## AI integrations

Create an API key under Connections (shown once). Then:

- **MCP** — `POST /mcp` with `Authorization: Bearer vso_live_...`; tools cover validate/compile/list/save/deploy for sections. Deploys require explicit unpublished-theme confirmation.
- **REST** — `POST /v1/compile`, `GET/POST /v1/projects` with the same bearer key (`openapi.yaml`).
- **Local MCP** — `POST /mcp-local` (localhost-only, no key) exposes the integrated browser tools so a local Claude session can drive the managed browser.

## Development

```bash
npm run dev     # vite UI (5173) + API with watch (8787)
npm run test    # vitest suite
npm run check   # strict tsc + production build + tests
```

Database migrations in `migrations/` are additive and idempotent; they run automatically at startup when `DATABASE_URL` is set.
