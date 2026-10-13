# ThemeBot desktop app

The same ThemeBot UI and engine, packaged as an installable app for Windows, macOS and Linux
(Electron — the same approach as the Claude, ChatGPT and Codex desktop apps).

## How it fits together

```
ThemeBot.exe / ThemeBot.app / themebot   (Electron main: desktop/main.ts)
 ├─ window  → loads http://127.0.0.1:<port>  (the normal React UI, sandboxed; preload: desktop/preload.ts)
 └─ server  → bundled Node.js runtime running resources/server/server.mjs  (desktop/server-host.ts)
               └─ Claude Code, QA scripts, npm … (the customer's own Claude Code + Chrome)
```

- The server is the same code as `npm run dev`, started in **desktop mode** (`THEMEBOT_DESKTOP=1`):
  it serves the built UI, keeps its data in the app's data folder, and saves builds in the folder the
  user picks during setup.
- Node.js + npm ship inside the app (`resources/runtime`), so customers never install Node.
- The main process owns: single instance, the window, native folder picker, the ThemeBot account
  sign-in, starting/restarting/stopping the server, and automatic updates.

| Where | Windows | macOS | Linux |
|---|---|---|---|
| App data (settings, account, logs, state) | `%APPDATA%\ThemeBot` | `~/Library/Application Support/ThemeBot` | `~/.config/ThemeBot` |
| Dev runs | `%APPDATA%\ThemeBot-Dev` | `…/ThemeBot-Dev` | `~/.config/ThemeBot-Dev` |
| Builds | the folder chosen in setup (default `~/ThemeBot Builds`) | same | same |

Logs: Help → Logs folder (`server.log`, `updates.log`).

## Commands

| Command | What it does |
|---|---|
| `npm run desktop:dev` | Builds UI + main, runs the app against the repo's TypeScript server |
| `npm run desktop:build` | Builds everything into `build/` (UI, bundled server, main, Node runtime) |
| `npm run desktop:pack` | `desktop:build` + installers for **this** OS into `release/` |
| `npm run desktop:pack:dir` | Same, but only the unpacked app (`release/<os>-unpacked`) — fastest to test |

An installer can only be built on its own OS. `.github/workflows/desktop.yml` builds Windows, macOS
(Apple Silicon + Intel) and Linux on GitHub and keeps them as workflow artifacts — **it never publishes**.
It runs only when started by hand (GitHub → Actions → Desktop installers → **Run workflow**), so it
doesn't spend the private repo's Actions minutes on every push.

## Build settings (environment variables at build time)

| Variable | Effect |
|---|---|
| `THEMEBOT_EDITION=internal` | Keeps the operator tools (Terminal, Browser, developer mode). Default: `customer` (hidden) |
| `THEMEBOT_CLOUD_URL` | ThemeBot Cloud address (`https://…`; `http://` only for 127.0.0.1/localhost). Set = the app requires signing in to a ThemeBot account. Unset = no account needed (dev, internal builds) |
| `THEMEBOT_CLOUD_PUBKEY` | The Cloud's pass-signing public key (base64 Ed25519, from `GET <cloud>/v1/public-key`). Required with `THEMEBOT_CLOUD_URL`; pinned into the app |
| `THEMEBOT_UPDATE_URL` | Turns on automatic updates from that address (generic feed: `latest.yml` + installers) |
| `THEMEBOT_NODE_VERSION` | Node.js version to bundle (default: the version building it) |

## ThemeBot account (desktop/account.ts, signed in to ThemeBot Cloud)

Builds made with `THEMEBOT_CLOUD_URL` require a ThemeBot account; there is no licence key to copy.

```
signin.html ──email──▶ Cloud /v1/auth/start ──6-digit code by email──▶ signin.html ──▶ /v1/auth/verify
                                                                   └─▶ refresh token (this install only)
main.ts ──every 5 min──▶ /v1/devices/heartbeat ──▶ pass (Ed25519-signed, valid 15 min) + next refresh token
        │                                             (saved to account.json before the pass is used)
        └─ IPC {type:'pass'} ──▶ local server (server/cloud-client.ts) ──▶ builds may start
```

- **Sign-in**: email → 6-digit code → a refresh token stored encrypted with the OS keychain
  (Electron `safeStorage`) in `account.json`. It only works with this computer's fingerprint: the
  OS machine id (MachineGuid / IOPlatformUUID / machine-id) hashed with a per-install salt, so the
  raw id never leaves the computer.
- **Token rotation** (`cloud/src/tokens.ts`): every heartbeat sends `rotate: true` with a random
  rotation key kept (encrypted) next to the token, and gets the next refresh token back. The app
  saves it — temp file, flush, rename, so `account.json` is never half-written — before handing the
  pass on, and always uses the latest saved token for heartbeat, release and sign-out. The token it
  replaced dies once the new one is used, so if `account.json` + `device.json` are copied to a
  second computer (even one faking the machine id), whichever copy presents a replaced token gets
  **both** computers signed out ("This computer's sign-in was used somewhere else…") and the
  account flagged `token_reuse`; their passes stop at that moment. Usually the copy's first
  heartbeat trips it; a copy taken mid-cycle can pass once as a "retry" and is caught one round
  later — within about 10 minutes of the copy starting.
- **Lost answers are safe**: a heartbeat whose answer never arrived, couldn't be saved, or was cut
  off by a crash or sleep is simply sent again with the same token and key; the Cloud hands out the
  same next token (derived, never stored) for as long as nobody has used it. A save that fails
  keeps the old token in memory and on disk. `/release` and `/signout` also take the replaced token
  in that window (an app quitting right after such a heartbeat). One heartbeat runs at a time per
  token; an answer that lands after a sign-out / new sign-in, or after a newer token was saved, is
  never written back (the session id in `account.json` and the epoch in `main.ts`).
- **Older builds** don't send `rotate` and keep one token, exactly as before; a session they saved
  starts rotating at its first heartbeat from an updated app (the key is saved first). Raise
  `minAppVersion` once every install rotates, so a non-rotating build can't share a sign-in.
- **Seats** (AutoCAD-style): a computer holds a seat while it heartbeats. Opening ThemeBot on more
  computers than the plan's seats → "already open on every computer your plan covers", listing
  where. Closing the app hands the seat back at once; a computer that just goes quiet frees it after
  15 minutes; Help → **Sign out of this PC…** frees it and forgets the session.
- **Passes**: the local server refuses to start builds (403 with the reason) unless it holds a
  valid pass — new jobs, Easy-mode runs, check / fix / rebuild / retry / start / resume, and queued
  jobs waiting in the scheduler. Running builds carry on.
- **Offline**: no grace period. The app stays open, the top bar says "Can't reach ThemeBot — check
  your internet", heartbeats retry (30 s → 5 min), and new builds wait until the next pass.
- **Refusals** close the engine (builds pause and resume after the next sign-in) and show the
  sign-in screen with the reason: signed out, plan not active, seats full. **Update required**
  shows an update screen and starts the download when the build has `THEMEBOT_UPDATE_URL`.
- With no Cloud in the build (dev, `THEMEBOT_EDITION=internal` builds without the variable) the app
  runs without an account, as before.

## ThemeBot Cloud (cloud/)

Our server for accounts, devices/seats and passes, the build recipe (served one step at a time) and
the QA scoring. Express + `node:sqlite` (built into Node 24), `node:crypto` for Ed25519/HMAC — no
extra dependencies. How the pieces protect the product: [docs/SECURITY.md](SECURITY.md).

**Run it locally**

```bash
npm run cloud:dev            # http://127.0.0.1:8800 (data in cloud/.data, gitignored)
```

First start generates a signing key, a hashing pepper and an admin token in `cloud/.data` and prints
the public key and the admin token. Without `RESEND_API_KEY`, sign-in codes are printed to the
console instead of emailed. Then build the app against it:

```bash
THEMEBOT_CLOUD_URL=http://127.0.0.1:8800 \
THEMEBOT_CLOUD_PUBKEY=$(curl -s http://127.0.0.1:8800/v1/public-key | node -pe "JSON.parse(require('fs').readFileSync(0)).publicKey") \
node scripts/desktop/build.mjs --skip-runtime && npx electron build/desktop-app
```

**Environment**

| Variable | Default / meaning |
|---|---|
| `CLOUD_PORT`, `CLOUD_HOST` | `8800`, `127.0.0.1` |
| `CLOUD_DATA_DIR` | `cloud/.data` — SQLite database (`cloud.sqlite`) and dev secrets |
| `CLOUD_SIGNING_KEY` | Ed25519 private key (PEM; `\n` escapes allowed). Required in production; dev generates `signing-key.pem` |
| `CLOUD_PEPPER` | Secret for hashing codes, refresh tokens and fingerprints (else generated into the data folder) |
| `RESEND_API_KEY`, `MAIL_FROM` | Login-code emails via Resend. Required in production; unset in dev = codes printed to the console |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | Signing secret of the Lemon Squeezy webhook (unset = webhook answers 503) |
| `LEMONSQUEEZY_VARIANT_SEATS` | `variantId:seats,…` (e.g. `12345:3,67890:10`). Also the allowlist: only these variants (plus `LEMONSQUEEZY_PRODUCT_IDS` and the admin `variantSeats` setting) grant access |
| `LEMONSQUEEZY_PRODUCT_IDS` | Optional `productId,…`: every variant of these products grants access, with `LEMONSQUEEZY_DEFAULT_SEATS` (3) unless mapped above. With no allowlist at all, production grants nothing (startup warning); dev accepts any product |
| `LEMONSQUEEZY_STORE_ID` | Optional: ignore events from any other store |
| `LEMONSQUEEZY_ALLOW_TEST_MODE` | `1` = production applies test-mode events too (default: ignored and audited). Dev always applies them |
| `ADMIN_TOKEN` | Bearer token for `/v1/admin/*` (24+ chars in production; unset in production = admin off) |
| `MIN_APP_VERSION` | Oldest app version allowed (`0.0.0`); the admin setting overrides it |
| `CLOUD_RECIPE_DIR` | Where the step recipe is read from at start (default `cloud/recipe`: `manifest.json` + its files) |
| `CLOUD_TRUST_PROXY` | Express `trust proxy` (`false`); set to `1` behind a load balancer so rate limits see client IPs |
| `NODE_ENV=production` | Enforces the required settings above, HSTS, JSON logs; never prints codes or tokens |

**API** (JSON; errors are `{ code, message, … }` with stable codes)

| Route | Auth | Purpose |
|---|---|---|
| `GET /v1/health`, `GET /v1/public-key` | — | Liveness; the pass public key (base64 Ed25519) |
| `POST /v1/auth/start {email}` | — | Emails a code (same answer for unknown emails) |
| `POST /v1/auth/verify {email, code, device}` | — | → `{refreshToken, account}`; `INVALID_CODE`, `SEATS_FULL` (+ `devices`), `ACCOUNT_INACTIVE`, `UPDATE_REQUIRED` |
| `POST /v1/devices/heartbeat {refreshToken, appVersion, fingerprint, rotate?, rotationKey?}` | refresh token | → `{pass, passExpiresAt, minAppVersion, account, refreshToken?}` (`refreshToken` = the next token, with `rotate: true`); `SIGNED_OUT` (`reason: "token_reuse"` for a copied sign-in), `ACCOUNT_INACTIVE`, `SEATS_FULL`, `UPDATE_REQUIRED` |
| `POST /v1/devices/release {refreshToken}` | refresh token | App closing: free the seat now, stay signed in (also takes a just-replaced token) |
| `POST /v1/devices/signout {refreshToken}` | refresh token | Free the seat and end the session (also takes a just-replaced token) |
| `GET /v1/session` | `Authorization: Pass <pass>` | Who the pass belongs to |
| `/v1/builds/*` | Pass | The recipe step engine — below |
| `/v1/qa/*` | Pass | QA scoring — below |
| `POST /v1/webhooks/lemonsqueezy` | `X-Signature` HMAC | Orders + subscription events → accounts (idempotent) |
| `/v1/admin/*` | `Authorization: Bearer $ADMIN_TOKEN` | Below (security: `/v1/admin/security/*`, see SECURITY.md) |

Body limits: the app-wide JSON parser takes 16 kB; the QA routes (8 MB, after the pass check) and
`/v1/admin/security/*` (1 MB, after the admin check) parse their own bodies and are mounted before
it. Every parser inflates `Content-Encoding: gzip` (the desktop compresses bodies over 16 kB) and
measures the limit on the inflated body. Rate limits: 1200 requests / 5 min per IP overall (IPv6 by
/64); build steps 900 / 5 min per account; 60 new builds / hour per account; QA 900 calls / hour
per account. QA scoring also estimates each request's work before scoring: too much in one request
→ 413 `TOO_LARGE`, too much per account per hour → 429 `RATE_LIMITED`. Sign-in: at most 15 codes
sent and 30 wrong codes per email per 24 h (then 429 `RATE_LIMITED` on `/v1/auth/verify`).

Pass format: `base64url(JSON {v, acc, dev, plan, seats, ver, iat, exp}) + "." + base64url(Ed25519
signature of the first part)` — `cloud/src/passes.ts`, shared with the desktop server.

**Admin calls**

```bash
A="Authorization: Bearer $ADMIN_TOKEN"; C=http://127.0.0.1:8800
curl -H "$A" $C/v1/admin/accounts                                   # accounts + devices (?email=…)
curl -H "$A" -H 'Content-Type: application/json' -d '{"email":"agency@example.com","plan":"studio","seats":3,"expiresAt":null}' $C/v1/admin/accounts
curl -H "$A" -X POST $C/v1/admin/accounts/<accountId>/revoke        # …/restore to undo
curl -H "$A" -X POST $C/v1/admin/devices/<deviceId>/release         # sign one computer out
curl -H "$A" -H 'Content-Type: application/json' -d '{"minAppVersion":"1.2.0","variantSeats":{"12345":3}}' $C/v1/admin/settings
curl -H "$A" "$C/v1/admin/audit?limit=50"
curl -H "$A" $C/v1/admin/billing-conflicts                          # accounts with a held purchase
curl -H "$A" -H 'Content-Type: application/json' -d '{"source":"subscription:123","action":"adopt"}' $C/v1/admin/accounts/<accountId>/billing-conflicts   # or "dismiss"
```

**Lemon Squeezy**: add a webhook to `https://<cloud>/v1/webhooks/lemonsqueezy` with the events
`order_created`, `order_refunded` and `subscription_*` (created, updated, cancelled, expired,
resumed, paused, unpaused, payment_success, payment_failed, payment_recovered). on_trial / active /
past_due / cancelled-until-period-end keep an account active; paused / unpaid / expired make it
inactive. Active subscriptions expire 7 days after their renewal date unless renewed. A paid
one-time order creates an account with no end date; a full refund of that order makes it inactive
(partial refunds change nothing). Lemon Squeezy has no chargeback/dispute webhook: it settles a
chargeback by refunding the order in full, so it arrives as `order_refunded` and is handled the same.

- *Only ThemeBot products count*: an order or subscription whose variant isn't in the seat
  mapping and whose product isn't in `LEMONSQUEEZY_PRODUCT_IDS` is answered 200 and audited as
  ignored (`not a ThemeBot product`). Production with no allowlist ignores every purchase.
- *Test mode*: production ignores events with `test_mode` (on the order/subscription/invoice, or
  `meta.test_mode`) unless `LEMONSQUEEZY_ALLOW_TEST_MODE=1`.
- Events ignored for those reasons (or another store) aren't marked delivered: after fixing the
  settings, resend them from Lemon Squeezy (Settings → Webhooks) and they apply.
- *One account follows one purchase* (its subscription id, or the one-time order id). That
  subscription's events apply normally, plan changes and downgrades included. Another purchase under
  the same email never takes access away: it takes the account over only if the account has no
  access now, if it is the subscription of the order the account came from, or if an account
  without a subscription (an admin grant) gets at least the same seats and end date. Otherwise it
  is *held*: audited as `billing.conflict` and listed in the account's `billingConflicts`. When the
  account's own subscription ends, the best held subscription that is still active takes over. The
  admin can adopt or dismiss a held purchase (below).

Tests: `npx vitest run cloud` (passes, seats, sign-in, webhooks, admin, steps, QA, watermarks,
security), `tests/cloud-client.test.ts`, and `tests/integration-e2e.test.ts` (the real app with
every route wired; piracy drills always, the full build + Chromium QA with `INTEGRATION_E2E=1`).

### The recipe step engine (`cloud/src/steps`, recipe in `cloud/recipe`)

The build recipe lives only in the Cloud (`cloud/recipe`: `manifest.json`, step bodies, knowledge
fragments; every file carries a `tbr-canary-*` marker). It is loaded once at start (from
`CLOUD_RECIPE_DIR` if set) and leaves the Cloud one rendered, watermarked step prompt at a time.

| Route (all need a pass; another account's build answers 404) | Purpose |
|---|---|
| `POST /v1/builds {name, prefix, storeHost, reactUrl, root, devThemeName?, qaEngine?, pages?, rebuiltRoutes?}` | Creates a build → `{buildId, recipeVersion, plan}` |
| `GET /v1/builds/:id` | Status, plan and step history — never prompts |
| `POST /v1/builds/:id/pages {pages, replace?}` | The page list from `qa/state/inventory.json` (sent in chunks under 12 kB) |
| `POST /v1/builds/:id/next {session, running?, finished?, facts?}` | → `{step}` (id, title, prompt, model, signal) / `{wait}` / `{done}` / `{blocked, code}` |
| `POST /v1/builds/:id/result {stepId, outcome, detail?, session?}` | How a step ended (`done`, `failed`, `blocked`, …) |
| `POST /v1/builds/:id/fix {iter, summary: {reportPath, issueCount?, regressed?}}` | A QA fix round's prompt → `{prompt, model, signal}` |

Plan: `preflight → inventory → bootstrap → store-setup → page:<slug> + verify:<slug> per page →
final`. Core steps and `final` run alone; page/check steps run side by side (the app's "Pages built
at once" setting, 1–4, default 2). A core step reported done while the app's `facts.files` says one
of its required outputs is missing counts as a failed attempt (inventory → `qa/state/inventory.json`;
bootstrap → `qa/state/theme.json` + `qa/state/bootstrap.json`; store-setup → `qa/state/handles.json`;
final → `qa/reports/final.md`). Late results are capped at 200 per `/next` call, a repeat of a
step's last result is ignored, and a build keeps at most 5000 step rows. A step that ends without its signal file is handed out again;
after 2 failures in one app session a core step blocks the build and a page is skipped (Resume —
a new session — tries it again). A page or check step that runs out of time (the "Longest first
build" / "Stop if nothing happens for" limits) counts as such a failure, so the other pages carry
on; a core step that runs out of time stops the build. Steps never run on a model above the
user's AI model setting — the activity says so once when that lowers a step's model. A Pause,
cancel or quit that lands while the Cloud is handing out a step stops that step before it starts
(it is reported "killed" with the next run's first request). Limits: at most `60 + 12 × pages` prompts per build (a heavy
40-page build with retries and three Resumes needs ~150 of its 540), 120 fix rounds per build; a
Rebuild starts a new build. Every prompt goes through `createPromptDecorator`
(`cloud/src/watermark.ts`); what was sent is logged in `watermark_sends` (marks and hashes, not the
prompt). The app keeps its step requests under 8 kB of lists (late results, rebuilt routes) so the
16 kB parser never refuses them.

**Cloud mode vs local mode on the desktop.** `server/cloud-client.ts` `cloudRequired` is true when
the server was started with `THEMEBOT_CLOUD_URL` (customer desktop builds). Then the build runs on
Cloud steps (`runCloudBuild` in `server/factory/convergence.ts`), fix prompts come from `/fix`, QA is
captured locally and scored by the Cloud (`checkAgainstSite` → `runQaViaCloud`), the QA self-test
is scored by the Cloud, and the scaffolder writes no recipe into the workspace (no
`.claude/commands/clone-theme.md`, no `seed/CONVENTIONS.md`, no `qa/factory/*.mjs`;
`factory/steps/` holds only ids, titles and states). `scripts/desktop/build.mjs` leaves the recipe
and scoring templates out of such builds and fails if any shipped. Without `THEMEBOT_CLOUD_URL`
(dev `npm run dev`, internal builds) everything runs from the local templates exactly as before
(`/clone-theme`, `fix-session.md`, the `qa/factory` scripts, `calibrate.mjs`).

**Transcripts and logs.** Each step's prompt goes to `claude -p` on stdin (never argv, never a
file), with `--no-session-persistence`; after every step the runner deletes Claude Code's
transcripts for that workspace (`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<workspace slug>` —
only that folder; a slug over 200 characters is matched by Claude Code's own hash of the full
path, never by its prefix alone). `factory/logs/clone-0.log` and `*.events.jsonl` hold readable events (tool use,
what the AI wrote), never the raw stream, which could echo the prompt.

### Cloud QA (`cloud/src/qa`, capture in `templates/factory/qa-capture`)

The desktop only captures evidence (`capture.mjs`: layout dumps, click inventories, click effects,
page health, screenshots — Chromium via Playwright); the Cloud turns it into scores, issues and the
fixer's summary. Same report files as the local scripts (`qa/reports/factory/sections-N.*`,
`interactions-N.*`, `qa-summary-N.md`); the raw evidence stays in `qa/capture/factory/<iter>/` for
this round and the previous one.

| Route (pass; bodies up to 8 MB, gzip accepted) | Purpose |
|---|---|
| `POST /v1/qa/sections {iter, reactBase, shopifyBase, routes}` | Section presence + text → `{report, markdown}` |
| `POST /v1/qa/interactions/plan {iter, handles, routes}` | The click plan (HMAC-signed for this account) |
| `POST /v1/qa/interactions/score {plan, effects, …}` | Scores the clicks it planned → `{report, markdown}` |
| `POST /v1/qa/summary {buildRef, iter, …}` | Composite score, issues, fixed since last round → `{score, subscores, summaryMarkdown, captureFailed, …}` |
| `POST /v1/qa/calibrate {reference, candidate?}` | The self-test fixture's score |

`buildRef` is the Cloud build id from `factory/steps/build.json` (else the job id): the Cloud keeps
one `qa_rounds` row per (account, build, iteration) — score and issue keys, no page content, 90
days — as the fallback for "fixed since last round". **capture_failed:** when nothing could be
captured (site down, password page, blank React app) the summary says `captureFailed`; the reports
are still written — the summary as `qa-summary-N.capture-failed.md`, so the round doesn't count as
scored (Resume runs round N again; a Fix run never fixes from it) — the round is never scored 0%,
and the job stops as blocked with "QA failed: QA capture failed — …" (the build panel then says
the website or store could not be loaded).

## Releasing an update (only when told to deploy)

1. Bump `version` in `package.json`.
2. `THEMEBOT_UPDATE_URL=<feed url> npm run desktop:pack` on each OS (or run the CI workflow).
3. Upload the new installers **and** `latest*.yml` + `.blockmap` files to the feed address.
   Installed apps download it in the background and install on the next restart.

Publishing a release is deploying: it happens only on an explicit go-ahead.

## Still to do before selling widely

- Code signing: Windows (Azure Artifact Signing), macOS (Apple Developer ID + notarization).
  Unsigned builds show an "unknown publisher" / "unidentified developer" warning.
- Test the macOS and Linux builds on real machines (Finder launch, Keychain sign-in, Chrome profile,
  AppImage/deb).
- Host ThemeBot Cloud (HTTPS, persistent volume for `CLOUD_DATA_DIR`, backups of `cloud.sqlite`),
  then build installers with its `THEMEBOT_CLOUD_URL` / `THEMEBOT_CLOUD_PUBKEY`.
- A real-build quality-parity run on a test store (Cloud steps vs the local `/clone-theme` session).
- Production secrets for the hosted Cloud (Resend, the Lemon Squeezy webhook secret,
  `CLOUD_SIGNING_KEY`, `ADMIN_TOKEN`); back up `cloud.sqlite` — it holds the watermark log.
