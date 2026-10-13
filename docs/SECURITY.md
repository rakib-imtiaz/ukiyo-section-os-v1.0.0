# ThemeBot desktop — how the product is protected

ThemeBot's value is the build recipe (the step-by-step know-how) and the QA scoring. Anything that
sits on a customer's computer can be copied, patched or decompiled, so the protection rests on one
idea: **the hands are on the PC, the brain is on our server.** The app only does the work it is told
to do, one step at a time, for a signed-in account with a free seat.

Each layer below says what it stops. None of them is DRM on its own; together they make a shared or
cracked copy useless and a leak small, stale and traceable.

## 1. Accounts, seats and passes (Phase 1)

- **Personal sign-in.** Email + 6-digit code. Each computer gets its own sign-in token, tied to that
  machine's fingerprint; the token does nothing on another machine.
- **Rotating sign-in tokens** (`cloud/src/tokens.ts`). Every heartbeat replaces the computer's
  sign-in token with a new one; the Cloud stores only hashes. A replaced token presented again
  after its successor was used means the sign-in exists twice: the Cloud signs that computer out
  (every token of the family revoked, its passes refused at once, its seat freed), records a
  `token_reuse` security event and answers `SIGNED_OUT` — so the original and the copy are both out
  and the owner signs in again with an email code. What is never mistaken for a copy: a heartbeat
  whose answer was lost, not saved, or cut off by a crash or sleep. The app saves a random rotation
  key with each token and simply asks again with the same token and key; until the new token has
  been used, the Cloud answers with that same new token (re-derived from the old token and the key
  under a server secret — no second branch, nothing secret at rest). `/release` and `/signout` take
  a replaced token in that window too. The per-token key is also what catches two copies taking
  turns, which "was the successor used?" alone would miss.
- **Seats.** A plan has N seats. A computer holds a seat while it heartbeats (every 5 minutes); a
  quiet computer frees its seat after 15 minutes, closing the app frees it at once. A computer over
  the limit is refused (`SEATS_FULL`) and shown where the account is in use.
- **Passes.** Every heartbeat returns a pass signed by the Cloud (Ed25519, 15-minute life). The app
  checks it with a public key built into it; the Cloud checks it again on every request, together
  with the account still being active and the computer still signed in.
- **A pass is only as good as its seat.** Handing a seat back (closing the app, `/release`) or
  going quiet makes that computer's unexpired passes stop working at once (`PASS_EXPIRED`, so a
  real app simply heartbeats again). Two computers can't take turns on one seat and keep working.
- **Sign-in limits.** At most 30 wrong codes and 15 codes sent per email per 24 h (counted in the
  database, so a restart doesn't reset them), on top of the per-code and per-IP limits. Rate limits
  key IPv6 clients by their /64, so one connection can't rotate addresses to dodge them.
- **Refunds.** A fully refunded one-time order makes its account inactive (`order_refunded`).
- **Purchases.** Only ThemeBot products (variant/product allowlist; none configured in production = nothing granted) and, in production, only live-mode events grant access; another purchase under an existing email never cuts that account's seats or end date (held for the admin as a `billing.conflict`). Chargebacks arrive as full refunds (Lemon Squeezy has no dispute webhook).
- **Version lock.** The Cloud refuses app versions older than the minimum it sets.
- **Stops:** passing the installer around, sharing one login across a team larger than the plan,
  using the app after a subscription ends, a refund or an account is revoked (the Cloud refuses
  the very next step or QA call), and a computer's sign-in files copied to a second machine —
  even together with its fingerprint (a cloned disk or VM, a patched app): both copies are signed
  out within one heartbeat round, usually at the copy's first heartbeat and within about 10
  minutes at worst (a copy taken mid-cycle passes once as a "retry"), and `token_reuse` flags it.
- **Still only flagged:** app builds from before rotation keep one token for good (raise
  `minAppVersion` once every install rotates), and two machines that deliberately share one live
  token store — a patched client that syncs the token and key between them — behave like one
  computer on one seat (`impossible_concurrency` shows the doubled pass rate).

## 2. The recipe stays on the server (Phase 2)

- The recipe is split into steps held by the Cloud. The app asks for the next step with a valid
  pass and gets only that step's instructions, sent straight to Claude Code over stdin — no recipe
  file, prompt file or raw log is written to the customer's disk, and the job's Claude Code
  transcripts are removed after each step.
- **Stops:** copying the recipe out of the install or a job folder, patching the app to skip the
  sign-in (no pass → no steps → no build), reusing a job folder on another computer.

## 3. QA scoring on the server (Phase 3)

- The app captures evidence (section text, structure, click effects) and uploads it; the Cloud scores
  it and returns the score, issues and summary. The scoring rules and weights never ship.
- **Stops:** lifting the QA engine, and running the recipe "offline" with a faked score.

## 4. Fingerprints, freshness and hardening (Phase 4)

### Watermarks on every step (`cloud/src/watermark.ts`)

Each step prompt is marked for the account, build and step it was sent to (a 48-bit mark derived
from the three ids with a server secret), through two independent channels:

- **Invisible:** the mark (plus a check byte) in zero-width characters, between sentences of prose,
  at up to four spots. Survives copy-paste; lost if someone strips zero-width characters.
- **Wording:** at every eligible spot in prose the Cloud picks one of two equivalent forms —
  "do not"/"don't", "e.g."/"for example", "make sure"/"ensure", "for each"/"for every", `**bold**`/
  `__bold__`, "-"/"*" and "1."/"1)" list markers, a closing period on list items or not, "—"/"--",
  "→"/"->", a comma before and/or/but or not, one or two spaces between sentences. The choice is a
  bit drawn from the mark and the words around the spot, so it survives zero-width stripping,
  re-typing, reflowing and excerpts. The real recipe has about one such spot per 100 characters.

Code blocks, inline code, URLs, paths, identifiers, quoted strings, headings, tables and HTML are
never changed; the line count never changes. Every send is logged (mark, account, build, step, text
hash, a few word 5-grams, and an index of sampled 5-grams).

**Finding the source of a leak:** `POST /v1/admin/security/leak` with the text (JSON `{"text": …}`
or a plain-text body). The Cloud finds which logged steps the text overlaps, reads any zero-width
marks and every wording choice, and ranks the accounts that received it with a confidence. Measured
on the real 37 KB recipe split into 6 steps, 40 accounts: the intact text and the zero-width-stripped
text name the right account every time (confidence ≈ 1.0); a 30% excerpt of a normal-size step
(6–9 KB) names it 149 times out of 150; a whole step re-typed with all whitespace squashed onto one
line still names it every time (a 30% excerpt of such a copy: about 3 in 4). Small excerpts (a few hundred characters) or heavily paraphrased text
may not be attributable — the report then shows low confidence rather than a wrong certainty.

### Anomaly flags (`cloud/src/security/`)

The Cloud records sign-ins, heartbeats (once per hour per computer and network), seat hand-backs,
`SEATS_FULL` refusals, tokens presented by the wrong machine and replaced tokens coming back
(`token_reuse`, section 1) — storing only the network prefix
(/24 or /48) and the hashed machine fingerprint, kept 30 days. `GET /v1/admin/security/flags`
(`?hours=24`) lists accounts to review, worst first:

| Flag | Meaning (limits per 24 h, scaled by seats) |
|---|---|
| `many_networks` | more networks than max(4, 2 × seats) |
| `many_devices` | more computers than max(4, 2 × seats) |
| `many_fingerprints` | sign-ins from more machines than max(3, seats + 2) |
| `seat_churn` | seats taken + handed back more than max(12, 6 × seats) times |
| `seats_full` | people turned away (all seats busy) more than 4 times |
| `token_reuse` | a computer's sign-in token presented by a different machine, or a replaced (rotated) token presented after its successor was used — a copied sign-in, already signed out by the Cloud (high) |
| `impossible_concurrency` | one computer taking passes like two machines (>30 in an hour, or >20 in two separate hours), or flipping between networks minutes apart (a cloned install) |
| `recipe_harvest` | more than 5 build steps a day reported done under 30 s after being handed out, or never handed out — a script walking the step engine to collect prompts, not Claude Code doing the work (a desktop re-creating a lost build can also trip it) |

Flags never block anyone by themselves (the sign-out on a reused token is the token rotation's own
doing, not the flag's); an admin revokes the account (`/v1/admin/accounts/:id/revoke`)
when the evidence holds up. `GET /v1/admin/security/events?account=…` shows the raw events.

### Fresh recipe

Recipe versions live in the Cloud and change often, and `minAppVersion` forces app updates, so a
captured copy goes stale.

### App hardening (Electron fuses, `electron-builder.yml`)

The packaged app has these fuses flipped (`scripts/desktop/pack.mjs` reads them back and fails the
build otherwise):

- `RunAsNode` off — `ThemeBot.exe` can't be used as a plain Node.js through `ELECTRON_RUN_AS_NODE`.
  (The ThemeBot server runs on its own bundled Node runtime, not on the Electron binary.)
- `NODE_OPTIONS` and `--inspect` off — no code injection or debugger in the main process.
- `OnlyLoadAppFromAsar` + embedded ASAR integrity on — the app's code loads only from `app.asar`,
  whose hash is built into the executable; an edited `app.asar` makes the app refuse to start.

These are speed bumps: a determined person can patch the executable itself. Code signing follows
once certificates exist. The server bundle, templates and runtime sit next to `app.asar` and are not
covered by the integrity check — which is why nothing valuable is kept there.

## The limit we accept

In subscription mode the AI runs in the customer's own Claude Code, so a determined, paying
customer can record the instructions of the steps their own builds receive — and one build hands
out every kind of step, so the whole step set can be captured. That cannot be prevented while the
steps run on the customer's computer. What we keep: the recipe never sits on disk for casual
copying; a script walking the step engine to collect prompts shows up as `recipe_harvest`;
frequent recipe updates make any capture stale; server-side QA keeps the scoring out of reach; and
the watermarks make a capture that gets shared traceable to the account that received it (someone
who diffs two of their own builds can find and normalise the marked spots, so treat attribution as
strong evidence, not proof).

## For the Cloud operator

- Wire-up (`cloud/src/app.ts`, in this order): webhooks (raw body) → `registerQaRoutes(app, ctx)`
  (8 MB parser after the pass check) → `registerSecurityRoutes(app, ctx)` (1 MB parser after the
  admin check; creates the security and watermark tables) → the global
  `express.json({ limit: '16kb' })` → auth, devices, session, admin →
  `registerStepRoutes(app, ctx, { decoratePrompt: createPromptDecorator(db, { secret: config.pepper, now, log }) })`
  → JSON 404 and error handlers. No large body is ever read before its route's auth check.
- Security events come from `recordSecurityEvent(ctx, { kind, accountId, deviceId, ip, fingerprintHash })`
  in the routes themselves: `/v1/auth/verify` (`signin`, `seats_full`), `/v1/devices/heartbeat`
  (`heartbeat`, `seats_full`, `fingerprint_mismatch` — the presented fingerprint's hash), `/release`,
  `/signout`, and the admin device release (`admin_release`); `token_reuse` from heartbeat, release
  and sign-out (`cloud/src/tokens.ts`, with a `device.token_reuse` audit entry). It never throws and
  never changes a response.
- Housekeeping (hourly): login codes, pass log, dead refresh tokens, audit; replaced (rotated)
  refresh tokens 7 days after their successor was used — one whose successor was never used is a
  computer's way back after a lost answer and stays like a current token; `qa_rounds` after 90
  days; security events after 30 days. `watermark_sends` / `watermarks` / `watermark_contents` are
  kept (a leak can surface months later) — back up `cloud.sqlite`.
- Drills that prove all of this end to end, against the real app: `tests/integration-e2e.test.ts`
  (no pass → 403 and nothing starts; a cracked app with a forged pass gets no step and no score;
  expired and other-account passes refused; revoke mid-build stops at the next step and Resume
  continues after restore; `UPDATE_REQUIRED`; `SEATS_FULL` and the anomaly flags; copied sign-in
  files, fingerprint included, sign both computers out — also when copied mid-cycle; with
  `INTEGRATION_E2E=1` a full build whose 30 % prompt excerpt is traced to the right account).
