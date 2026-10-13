<!-- tbr-canary-1b7e4d93a0c2 -->
## This step: preflight (recipe phase 0)

A hard preflight gauntlet runs **before any work begins**. Every check below is blocking — if anything fails or looks suspicious, stop (headless: `qa/reports/BLOCKED.md`, or `qa/reports/ABORTED.md` for an identity mismatch) instead of carrying on. Two prior incidents drove this design:

- **Wrong-project incident:** `TARGET_SITE_INFO.txt` from an old project was reused, and the orchestrator silently re-cloned the wrong site. → Step 0.2 forces an explicit identity check.
- **Revoked-credentials incident:** the token mint succeeded with stale credentials, but every actual API write failed. → Step 0.6 does a real write to prove access end-to-end.

### 0.1 Files-in-place check

Verify the project's folder structure has what the build expects:

| Path | Purpose | If missing |
|---|---|---|
| `TARGET_SITE_INFO.txt` | React URL + Shopify URL | **STOP** — BLOCKED.md: create it with both URLs |
| `API.txt` | The custom app's Client ID (32-char hex). The Client Secret is intentionally NOT on disk — `mint()` gets tokens from the ThemeBot app | **STOP** — BLOCKED.md: reconnect the store in ThemeBot |
| `job.json` | Factory job: name, prefix, dev theme name, token-mint wiring | **STOP** — BLOCKED.md |
| `react_files/src/` (or any folder containing React `pages/*.tsx`) | Source of truth | **STOP** — BLOCKED.md: say where the React source is expected |
| `sections/`, `templates/`, `snippets/`, `assets/`, `layout/`, `config/` | Standard Shopify dirs | Auto-create empty if missing |
| `qa/` | State + reports dir | Auto-create with `state/`, `reports/`, `screenshots/` subfolders |

Put the found/missing table at the top of `qa/reports/preflight.md`. Don't continue until every required item is present.

### 0.2 URL identity check (catches "wrong project" mistakes) — the single most important gate

Both URLs in `TARGET_SITE_INFO.txt` must actually belong to **this** project. Defense in depth:

1. `GET` the React URL. Parse `<title>`, `<meta name="description">`, and the home page's H1.
2. `GET` the Shopify URL's `/policies` page (or `/products.json`) to scrape the shop name.
3. Write the result to `qa/reports/identity.md` in this exact format:

   ```
   PROJECT IDENTITY CHECK

     React app at:  <url>
       <title>:     "<scraped title>"
       H1:          "<scraped H1>"
       Description: "<meta description, truncated>"

     Shopify store at: <url>
       Shop name:      "<scraped name>"
       myshopify_domain (from auth):  <filled in at 0.5>

     job.json: name "{{NAME}}", react_url {{REACT_URL}}, store_url {{STORE_URL}}
     Verdict: <match | mismatch — why>
   ```

4. Headless gate (instead of asking the user to type `y`): compare the scraped identities against `job.json` (`name`, `react_url`, `store_url`). If the scraped shop/React identity **grossly contradicts** `job.json`, **abort**: write `qa/reports/ABORTED.md` with the mismatch and exit — do NOT clone anyway. Otherwise auto-continue.

### 0.3 React reachability + page enumeration

Walk the React `src/pages/` directory (and the router config). For every page file, derive its expected route (e.g. `AboutPage.tsx` → `/about`). `GET` each route on the live React URL. Cache the per-route HTML under `qa/state/react-html/` (one file per route) for the inventory step.

If any expected route returns 404 or a different page than the React source suggests, flag it. Common cause: the deployed build is stale and missing newly-added pages.

Add a per-page reachability table to `qa/reports/preflight.md`. **STOP** (BLOCKED.md, with the table and the likely cause) if any page is unreachable.

### 0.4 Auth token mint + scope check

1. Read `API.txt`. Confirm the Client ID looks well-formed (32-char hex).
2. Run `node preflight.mjs` — it mints a token through `mint()` (the ThemeBot app performs the OAuth `client_credentials` exchange), checks the scopes, verifies the shop identity (0.5), lists the themes and does the canary write (0.6). Read its whole output.
3. Failure modes to catch explicitly:
   - **HTTP 401 `Invalid API key or access token`** (or a mint failure) → the credentials are revoked or belong to a different store. **STOP**: BLOCKED.md asking the user to verify the custom app is still installed and that the credentials match `Settings → Apps → Develop apps → <App> → API credentials`.
   - **HTTP 403 / scope error** → the app exists but lacks `write_themes` + `write_theme_code`. **STOP**: BLOCKED.md asking the user to add the scopes in the Dev Dashboard, `Release` a new version, re-install, and resume.
   - **HTTP 200 but the token is missing required scopes** → same handling as above.
4. `preflight.mjs` saves the token to `qa/state/token.json` with an expiry timestamp (24h from mint).

### 0.5 Store identity match

From `preflight.mjs`'s `shop.json` output, verify:

- `shop.myshopify_domain` matches the host in `TARGET_SITE_INFO.txt`'s Shopify URL.
- `shop.name` is plausibly related to the React project's title.

Fill `myshopify_domain` into `qa/reports/identity.md`. If the domain matches but the shop name looks wildly different from the React project, note it prominently in `identity.md` ("The token works, but the shop name `<X>` doesn't seem related to the React app `<Y>`"); if it grossly contradicts `job.json`, abort as in 0.2. This catches the scenario where `API.txt` was for a different store than `TARGET_SITE_INFO.txt` claims.

### 0.6 Test push (proves write access end-to-end)

Don't trust scope claims — `preflight.mjs` actually writes:

1. `GET themes.json` → confirms at least one theme is returned and saves the live theme ID.
2. `PUT themes/<live id>/assets.json` with a harmless canary asset `snippets/__preflight-canary.liquid`.
3. Confirms 200 / 201.
4. Immediately `DELETE`s the canary so the live theme isn't polluted.
5. If either PUT or DELETE fails, **STOP**: BLOCKED.md with the exact error body. The user must fix scopes / re-install the app before any real work begins.

This catches "credentials revoked between sessions" — the token mint can succeed while the underlying app permissions are revoked. A real write fails fast here.

This canary (written and deleted at once by `preflight.mjs`) is the only write to the live theme the build ever makes; the never-push-to-live rule above covers everything else.

### 0.7 Preflight summary

Once 0.1–0.6 all pass, finish `qa/reports/preflight.md` with:

```
PREFLIGHT PASSED

  Project root:        {{ROOT}}
  React URL:           <url>             (N pages reachable)
  Shopify store:       <myshopify_domain>
  Live theme:          <id>              (canary write+delete OK)
  Dev theme:           (created by the bootstrap step)
  Token expires at:    <timestamp>
  Section prefix:      {{PREFIX}}-
```

Headless: there is no "go" to wait for — auto-continue (finish this step).
