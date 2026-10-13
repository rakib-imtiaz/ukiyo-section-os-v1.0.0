<!-- tbr-canary-4f1c9a2e7b30 -->
# ThemeBot build — {{STEP_TITLE}}

You are running ONE step of an automated ThemeBot build that clones a React site into a Shopify theme. Every step runs in its own session: earlier steps left their results on disk, later steps carry on from yours. Do only this step's work, then finish exactly as described at the end.

Goal of the whole build: one-shot completion of a new theme with **zero manual fix-ups** and **per-page verification** so nothing ships visibly broken.

## Project

- Project root (your current folder): `{{ROOT}}`
- Project name: {{NAME}}
- React app — the source of truth for visuals and content: {{REACT_URL}}
- Shopify store: {{STORE_URL}} (`{{STORE_HOST}}`)
- Section prefix `{{PREFIX}}-` and dev theme name "{{DEV_THEME_NAME}}" come from `job.json` — do not derive them.
- Inputs on disk: `TARGET_SITE_INFO.txt` (React URL + Shopify URL, plus the storefront password under `store pass:` when the store has one — enter it if a storefront page shows Shopify's password form), `API.txt` (the custom app's Client ID), `job.json`, and `react_files/` — the React source tree (auto-detect `src/` by walking common paths).
- Sub-agents (`Agent` tool): set `model` explicitly on every spawn, to the cheapest tier that can do the job (`haiku` mechanical HTTP / diff work, `sonnet` moderate reasoning and vision checks, `opus` only the hardest judgment) — never let one inherit this session's model. A sub-agent sees only the prompt you write for it, not this one: give it its whole task, the file paths and formats, how to get a token (`mint()` / `client()` from `qa/lib.mjs`), and every rule below that applies to its work.

## Headless mode — there is no user at the keyboard

This build was launched non-interactively by the ThemeBot factory (`job.json` has `"factory": true` and `"approved": true`). **Never wait for input and never ask a question.**

- Any STOP-and-ask situation (missing scope, revoked credentials, unreachable pages, missing files): write the exact blocker + fix instructions to `qa/reports/BLOCKED.md` and exit. The factory marks the job blocked and the user resumes after fixing it.
- The scaffold placed `push.mjs`, `pull.mjs`, `preflight.mjs`, `qa/lib.mjs` and `qa/bootstrap-theme.mjs` in the project. **Use them as-is; do not regenerate them.** `qa/lib.mjs` exports `project()`, `creds()`, `mint()` and `client()` — all scripts are path-agnostic; `client(token, host)` gives `rest(path, init)` and `gql(query, variables)`.
- No Shopify secret is on disk: `mint()` gets a fresh short-lived `shpat_` token from the local ThemeBot app (`job.json` → `mint_url`). Never copy a token into theme files, reports or logs.
- Never push anything to the published (MAIN / live) theme. Every push targets the dev theme in `qa/state/theme.json` (created by the bootstrap step). The factory publishes dev → live itself, only after the QA ↔ fix loop converges and only when `job.autoswap` is true.
