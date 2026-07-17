# Master Orchestrator Prompt — React → Shopify Theme Clone

## Context

You're starting a new React→Shopify clone (third in this series after CA89 + Back to Earth). Both prior projects taught lessons that this orchestrator encodes:

- Tailwind classes don't work in raw Shopify Liquid — sections must use inline `{% stylesheet %}` blocks with raw CSS keyed off a 2-3 char prefix.
- Sections need `class="full-width"` on the outer `<section>` element to span the viewport (the theme uses a CSS grid container that constrains children to a center column by default).
- Reveal animations need a default-visible safety net; per-section IntersectionObservers fail silently and leave content stuck at `opacity: 0`.
- Internal links must use `shopify://pages/<handle>` with handles that match what's actually in the Shopify Admin (e.g., `our-team`, not `team`).
- Shopify CLI's interactive OAuth doesn't work in Claude Code's non-TTY shell — use REST Assets API directly with a token minted via OAuth `client_credentials`.
- **Header + footer must be SECTIONS driven by Shopify navigation menus (`linklists`), never hardcoded snippets.** A hardcoded nav leaves Online Store → Navigation showing the stock "Home, Catalog, Contact" menu, and the merchant can't edit the nav. See "Header & footer" below — this is mandatory.
- **`document.currentScript` is null-ish inside `{% javascript %}`.** Shopify bundles all section JS into one external file, so `document.currentScript.closest('.my-section')` returns `null` and any `if (!s) return;` guard silently kills the section's JS (filters, accordions, quizzes, counters all die with no error). Always write `var s = (document.currentScript && document.currentScript.closest('.x')) || document.querySelector('.x');`
- **`hidden` is an HTMLElement property, not an SVGElement one.** `svg.hidden = true` is a no-op expando. Toggle SVG icon visibility with `setAttribute`/`removeAttribute('hidden')`.
- **Liquid output tags can't do comparisons.** `{{ a == b }}` renders `a`, not a boolean. Use `{% if %}` + `assign`.
- Source React apps often reference **dead external image/video URLs**. Verify every asset returns 200 and swap dead ones; don't ship broken media.

Goal: One-shot completion of a new theme with **zero manual fix-ups** and **per-page verification** so nothing ships visibly broken.

---

## What this file is

A reusable **master prompt** plus orchestrator workflow that the user invokes when starting a new clone project. The prompt itself is project-agnostic: it reads two well-known files at runtime to learn the project specifics, then spawns sub-agents in a defined sequence.

---

## Inputs (read at runtime, NOT hardcoded)

The orchestrator reads these from the project root at start. If anything is missing or fails preflight, it asks the user.

| File | Contents |
|---|---|
| `TARGET_SITE_INFO.txt` | Two URLs on separate lines: the deployed React app (source of truth for visual + content) and the Shopify store (`*.myshopify.com`). |
| `API.txt` | Shopify custom-app `Client ID` + `Client Secret`. The orchestrator mints a 24h `shpat_*` token via the OAuth `client_credentials` flow on every push. |
| `react_files/src/` (or similar) | The React source tree. Auto-detected by walking common paths. |

The 2-3 char section prefix is derived from the project name (e.g., "Wild & Sacred" → `ws-`).

---

## Model assignment policy (cost control) — MANDATORY

The orchestrator layer (this main session) runs on **Opus 4.8** and stays there — it holds all
coordination, gate decisions, and the per-page routing logic. **Sub-agents must NOT inherit Opus
by default.** Every sub-agent is spawned with the `Agent` tool's `model` parameter set explicitly
to the cheapest tier that can do its job. Omitting `model` makes the sub-agent inherit Opus 4.8 and
burns the usage limit — that is the failure this policy prevents.

Available tiers (pass the alias, not the full id):

| Alias | Model | Use for |
|---|---|---|
| `opus` | Opus 4.8 (`claude-opus-4-8`) | Orchestrator + hardest creative/judgment work only |
| `sonnet` | Sonnet 5 (`claude-sonnet-5`) | Moderate reasoning, simple code-gen, vision checks |
| `haiku` | Haiku 4.5 (`claude-haiku-4-5`) | Mechanical/deterministic: HTTP calls, string/schema diff |

**Per-layer assignment — set `model:` on every `Agent` spawn accordingly:**

| Layer / Agent | Phase | `model` | Rationale |
|---|---|---|---|
| **Orchestrator** (this session) | all | `opus` | Coordination, gates, per-page routing |
| Preflight | 0 | `haiku` | Mechanical HTTP / token mint / identity scrape |
| Inventory (Explore) | 1 | `sonnet` | Reads React tree → structured JSON |
| Bootstrap scaffold | 2 | `sonnet` | Mostly reused scripts, light judgment |
| Store setup A / B / C | 3 | `haiku` | Pure REST + GraphQL calls |
| Page Rewrite — **simple** (≤4 sections, no modal/quiz) | 4 | `sonnet` | Straightforward React→Liquid |
| Page Rewrite — **complex** (>4 sections, modals, quizzes, tabs, calendars) | 4 | `opus` | Quality-critical conversion |
| Specialists 1, 2, 2b, 6 (Link, Content, Completeness, Editability) | 5 | `haiku` | Deterministic text/schema diff |
| Specialists 3, 4, 5, 7 (Modal, Animation, Responsiveness, Visual) | 5 | `sonnet` | Need vision / timing judgment |
| Fixer | 5 | `opus` | Rewrites Liquid/CSS/JS from 7 reports |
| Final report + live swap | 6 | `haiku` | Aggregation + mechanical PUTs |

**Phase 4 routing rule (the biggest single spend):** after Phase 1 inventory, the orchestrator
knows each page's section count and interactive features. For each page, decide the tier BEFORE
spawning its Page Rewrite Agent:
- **complex** → `opus` if the page has any of: >4 top-level sections, a modal, a quiz/multi-step
  form, a view toggle/tabs/calendar/carousel, or non-trivial custom animation logic.
- **simple** → `sonnet` otherwise.

Record the chosen tier next to each page in `qa/state/inventory.json` (`"model": "opus"|"sonnet"`)
so the assignment is auditable and reused verbatim by any Fixer re-spawn for that page's specialists.

**How to spawn:** every `Agent` call in the phases below passes `model` from this table, e.g.
a Phase 3 store-setup agent → `Agent(subagent_type: "general-purpose", model: "haiku", …)`;
a complex Phase 4 page → `model: "opus"`; a Phase 5 Link Verifier → `model: "haiku"`.
If a `haiku` specialist returns an ambiguous/low-confidence verdict, the orchestrator may re-run
just that one check at `sonnet` — do not blanket-upgrade the tier.

**Session requirement:** start the clone-theme session on Opus 4.8 (`/model opus` or Fast mode on
Opus) so the orchestrator layer itself is Opus. Sub-agent tiers are then controlled entirely by the
explicit `model:` values above, independent of the session default.

---

## FACTORY / HEADLESS MODE (job.json)

If the project root contains a **`job.json`** with `"factory": true` and `"approved": true`, this run was launched non-interactively by the Theme Factory (`claude -p /clone-theme`). **There is no user at the keyboard — never wait for input.** Wherever this document says to pause, ask, or wait for `y` / "go" / "proceed", apply this table instead:

| Interactive gate | Headless behavior |
|---|---|
| 0.2 URL identity confirm (`y`) | Scrape identities as normal, then compare against `job.json` (`name`, `react_url`, `store_url`). Write the identity check to `qa/reports/identity.md`. If the scraped shop/React identity grossly contradicts `job.json`, **abort**: write `qa/reports/ABORTED.md` with the mismatch and exit — do NOT clone anyway. Otherwise auto-continue. |
| 0.7 preflight summary ("go") | Write the summary to `qa/reports/preflight.md` and auto-continue. |
| Phase 1 inventory approval ("proceed") | Write the inventory to `qa/state/inventory.json` + a human-readable copy in `qa/reports/inventory.md` and auto-continue. |
| Any STOP-and-ask (missing scope, revoked creds, unreachable pages, missing files) | Write the exact blocker + fix instructions to `qa/reports/BLOCKED.md` and exit. The factory marks the job failed and the user resumes after fixing. |
| Phase 6 live swap | **Never swap to live during this clone run.** In factory mode the clone you produce has NOT yet been through the QA↔fix convergence loop, so publishing it now would show customers an un-converged clone. Always leave everything on the dev theme and note the dev preview URL prominently at the top of `final.md`. The factory backend performs the dev→live publish itself, and only after convergence, when `job.autoswap` is true. Do NOT push any file to the live/main theme here. |

Additional headless rules:
- `prefix` and `dev_theme_name` come from `job.json` — do not derive them.
- The scaffold has already placed `push.mjs`, `pull.mjs`, `preflight.mjs`, `qa/lib.mjs`, `qa/bootstrap-theme.mjs`, `seed/CONVENTIONS.md` in the project. **Use them as-is; do not regenerate them.** (`qa/lib.mjs` exports `project()`, `creds()`, `mint()`, `client()` — all scripts are path-agnostic.)
- **Always finish by writing `qa/reports/final.md`** — even on partial failure. Its existence is how the factory knows the run completed; describe any incomplete pages inside it.

If there is no `job.json` (or `approved` is not `true`), this section does not apply — run interactively with all gates as written below.

---

## Phase 0 — Preflight (sequential, ~60s)

A single agent runs a hard preflight gauntlet **before any work begins**. Every check below is blocking — if anything fails or looks suspicious, pause and ask the user to fix or confirm. Two prior incidents drove this design:

- **Wrong-project incident:** `TARGET_SITE_INFO.txt` from an old project was reused, and the orchestrator silently re-cloned the wrong site. → Step 0.2 forces an explicit identity-confirm gate.
- **Revoked-credentials incident:** Token mint succeeded with stale Client ID + Secret, but every actual API write failed. → Step 0.6 does a real write to prove access end-to-end.

### 0.1 Files-in-place check

Verify the project's folder structure has what the orchestrator expects:

| Path | Purpose | If missing |
|---|---|---|
| `TARGET_SITE_INFO.txt` | React URL + Shopify URL | **STOP**, ask user to create with both URLs |
| `API.txt` | Client ID + Secret | **STOP**, ask user to paste credentials |
| `react_files/src/` (or any folder containing React `pages/*.tsx`) | Source of truth | **STOP**, ask user where the React source is |
| `sections/`, `templates/`, `snippets/`, `assets/`, `layout/`, `config/` | Standard Shopify dirs | Auto-create empty if missing |
| `qa/` | State + reports dir | Auto-create with `state/`, `reports/`, `screenshots/` subfolders |

Print a found/missing table to the user. Don't continue until every required item is present.

### 0.2 URL identity check (catches "wrong project" mistakes)

Both URLs in `TARGET_SITE_INFO.txt` must actually belong to **this** project. Defense in depth:

1. `GET` the React URL. Parse `<title>`, `<meta name="description">`, and the home page's H1.
2. `GET` the Shopify URL's `/policies` page (or `/products.json`) to scrape the shop name.
3. Print to the user, in this exact format:

   ```
   PROJECT IDENTITY CHECK — confirm this is the right project before proceeding.

     React app at:  <url>
       <title>:     "<scraped title>"
       H1:          "<scraped H1>"
       Description: "<meta description, truncated>"

     Shopify store at: <url>
       Shop name:      "<scraped name>"
       myshopify_domain (from auth):  <will fill in 0.5>

   Is this the React app you intend to clone INTO that Shopify store? (y/n)
   ```

4. **Wait for user to type `y`.** Anything else → STOP. The user typing `n` triggers a request to fix `TARGET_SITE_INFO.txt` and re-run.

This is the single most important gate.

### 0.3 React reachability + page enumeration

Walk the React `src/pages/` directory. For every page file, derive its expected route (e.g. `AboutPage.tsx` → `/about`). `GET` each route on the live React URL. Cache the per-route HTML for the inventory phase.

If any expected route returns 404 or a different page than the React source suggests, flag it. Common cause: deployed build is stale and missing newly-added pages.

Print a per-page reachability table. STOP if any page is unreachable.

### 0.4 Auth token mint + scope check

1. Read `API.txt`. Confirm Client ID + Client Secret look well-formed (`shpss_*` for the secret, 32-char hex for the ID).
2. `POST https://<shop>/admin/oauth/access_token` with `client_id`, `client_secret`, `grant_type=client_credentials`.
3. Failure modes to catch explicitly:
   - **HTTP 401 `Invalid API key or access token`** → credentials are revoked or belong to a different store. STOP. Ask user to verify the custom app is still installed and that the credentials in `API.txt` match `Settings → Apps → Develop apps → <App> → API credentials`.
   - **HTTP 403 / scope error** → app exists but lacks `write_themes` + `write_theme_code`. STOP. Ask user to add scopes in the Dev Dashboard, `Release` a new version, re-install, and re-run.
   - **HTTP 200 but token missing required scopes** → same handling as above.
4. Save the token to `qa/state/token.json` with an expiry timestamp (24h from mint).

### 0.5 Store identity match

`GET /admin/api/2025-01/shop.json` with the minted token. Verify:

- `shop.myshopify_domain` matches the host in `TARGET_SITE_INFO.txt`'s Shopify URL.
- `shop.name` is plausibly related to the React project's title.

If the domain matches but the shop name looks wildly different from the React project, **pause and ask the user**: "The token works, but the shop name `<X>` doesn't seem related to the React app `<Y>`. Continue anyway?"

This catches the scenario where `API.txt` was for a different store than `TARGET_SITE_INFO.txt` claims.

### 0.6 Test push (proves write access end-to-end)

Don't trust scope claims — actually try writing.

1. `GET /admin/api/2025-01/themes.json` → list themes. Confirm at least one is returned. Save the live theme ID.
2. `PUT /admin/api/2025-01/themes/<id>/assets.json` with a harmless canary asset:
   ```json
   { "asset": { "key": "snippets/__preflight-canary.liquid", "value": "{# preflight canary #}" } }
   ```
3. Confirm 200 / 201.
4. Immediately `DELETE` the canary so the live theme isn't polluted.
5. If either PUT or DELETE fails, **STOP** and report the exact error body. User must fix scopes / re-install the app before any real work begins.

This catches "credentials revoked between sessions" — the token mint can succeed while underlying app permissions are revoked. Real write fails fast here.

### 0.7 Preflight summary

Once 0.1–0.6 all pass, print:

```
✅ PREFLIGHT PASSED

  Project root:        <abs path>
  React URL:           <url>             (N pages reachable)
  Shopify store:       <myshopify_domain>
  Live theme:          <id>              (canary write+delete OK)
  Dev theme:           (will be created in Phase 2)
  Token expires at:    <timestamp>
  Section prefix:      <derived>         (e.g. "ws-")

Press <enter> or type "go" to begin Phase 1 (inventory).
```

Wait for confirmation. **Only proceed when the user signs off on the summary.** This is the second hard gate (after 0.2 URL identity).

---

## Phase 1 — Inventory (1 Explore agent, ~2 min)

A single agent walks the React source and produces a JSON inventory:

```json
{
  "pages":   [{ "route": "/about", "react_file": "src/pages/AboutPage.tsx", "shopify_handle": "about", "template": "page.<prefix>_about.json" }, ...],
  "header":  { "nav_items": [...], "dropdowns": {...} },
  "footer":  { "columns": [...], "social": [...], "policies": [...] },
  "blog":    { "data_file": "src/data/blogArticles.ts", "articles": [...] },
  "images":  [{ "react_path": "/public/hero.jpg", "intended_handle": "hero" }, ...],
  "modals":  [{ "react_component": "Modal", "used_in": ["AboutPage", "HomePage"] }, ...],
  "anim_libs": ["framer-motion", "gsap"]
}
```

**Pause point:** Orchestrator presents inventory to user. User confirms the page list / blog plan / handle mapping looks correct, then types "proceed". Orchestrator continues.

---

## Phase 2 — Bootstrap (sequential, ~1 min)

1. Create a fresh dev theme: `POST /admin/api/2025-01/themes.json` with `role: unpublished`. Save returned theme ID to `qa/state/theme.json`.
2. Generate the local theme skeleton if missing:
   - `layout/theme.liquid` — must render the header/footer via `{% sections 'header-group' %}` … `{% sections 'footer-group' %}`, **not** `{% render %}`.
   - `sections/<prefix>-header.liquid` + `sections/<prefix>-footer.liquid` (see "Header & footer" below)
   - `sections/header-group.json` + `sections/footer-group.json`
   - `snippets/bte-animations.liquid` (the proven reveal + safety-net snippet from Back to Earth)
   - `snippets/bte-modal.liquid` (shared modal shell)
   - `assets/critical.css` (with `.full-width` rule and CSS grid container)
   - `push.mjs` (auto-discovers `sections/<prefix>-*.liquid` + `templates/page.<prefix>_*.json` + `snippets/<prefix>-*.liquid`, mints fresh token, PUTs each, supports `THEME_ID` env override, and an `ONLY=a,b` filter)
   - `seed/lib.mjs` (token mint + `gql()` helper) and `seed/create-menus.mjs` (see below)
3. Push the skeleton to the dev theme.

### Header & footer — MANDATORY pattern (menu-driven sections)

Never hardcode nav/footer links in a snippet. Build both as **sections with a `link_list` setting** that render from `linklists`, wrapped in section groups.

**Header section** (`sections/<prefix>-header.liquid`):
```liquid
{%- liquid
  assign menu_handle = section.settings.menu
  if menu_handle == blank
    assign menu_handle = '<prefix>-main-menu'
  endif
  assign main_menu = linklists[menu_handle]
  assign use_menu = false
  if main_menu.links.size > 0
    assign use_menu = true
  endif
-%}
{%- if use_menu -%}
  {%- for l in main_menu.links -%}
    {%- if l.links.size > 0 -%}   {%- comment -%} parent w/ children -> dropdown {%- endcomment -%}
      <a href="{{ l.url }}">{{ l.title }} · Overview</a>
      {%- for s in l.links -%}<a href="{{ s.url }}"{% if s.active %} aria-current="page"{% endif %}>{{ s.title }}</a>{%- endfor -%}
    {%- else -%}
      <a href="{{ l.url }}"{% if l.active %} aria-current="page"{% endif %}>{{ l.title }}</a>
    {%- endif -%}
  {%- endfor -%}
{%- else -%}
  ... hardcoded fallback links so the nav can NEVER render bare ...
{%- endif -%}
```
**Footer section**: same shape — each top-level menu item becomes a column heading, its children become the column's links.

Rules:
- Always include the **hardcoded fallback** branch (`use_menu == false`). A missing/empty menu must never yield an empty nav.
- Buttons/CTAs are **section settings** (label + `url`), not menu items.
- Shopify menu items carry **no subtitles**. If the React dropdown has subtitle lines, keep them as section settings matched by `s.url contains '<handle>'`.
- **`link_list` schema `default` only accepts `main-menu` or `footer`.** Any other handle 422s the asset upload. Omit `default` and supply the handle via the Liquid fallback + the section-group JSON.
- Section groups: `sections/header-group.json` → `{"type":"header","sections":{"header":{"type":"<prefix>-header","settings":{"menu":"<prefix>-main-menu"}}},"order":["header"]}` (and the footer equivalent with `"type":"footer"`).

**Seed the menus** with `seed/create-menus.mjs` — GraphQL `menuCreate` / `menuUpdate`, idempotent by handle, mirroring the React Navbar + Footer:
```js
const link = (title, url, items = []) => ({ title, type: 'HTTP', url, items });
const Q_MENUS = `{ menus(first:20){ nodes { id handle title } } }`;
// upsert(handle,title,items): menuUpdate if handle exists else menuCreate
```
**Use dedicated handles** (`<prefix>-main-menu`, `<prefix>-footer`) rather than overwriting the store-wide `main-menu` / `footer`, which the currently-published theme also renders. Overwriting those is a destructive change to live navigation — only do it if the user explicitly asks. The `link_list` setting lets them repoint from the theme editor either way.

Requires the `write_online_store_navigation` scope.

---

## Phase 3 — Parallel store setup (3 agents in parallel, ~3 min)

All three run concurrently in background.

**Agent A — Pages:** For each entry in inventory `pages`, `POST /admin/api/2025-01/pages.json` with `handle` + `template_suffix`. Verify each returns 201 and the page resolves at `/pages/<handle>`. Save the `template → handle` map to `qa/state/handles.json` so page agents in Phase 4 can wire `shopify://pages/<handle>` links correctly.

**Agent B — Blog + articles:** `POST /admin/api/2025-01/blogs.json` for the field-notes blog. For each article in the React data file, `POST /admin/api/2025-01/articles.json` with title, body_html, tags, published_at, image.

**Agent C — Files + metafields + policies:** For each entry in inventory `images`, run `stagedUploadsCreate` + `fileCreate` (GraphQL). Build a `react_path → cdn_url` map at `qa/state/images.json`. Define metafield definitions for any custom fields React uses on products/articles. Create boilerplate privacy / ToS / refund policies if footer references them.

**Menu work (Agent A continued):** Run `seed/create-menus.mjs` to upsert the nav menus via the GraphQL `menuCreate` / `menuUpdate` mutations (REST `menus.json` does not exist). Mirror the React Navbar + Footer exactly, including nested children. Use **dedicated handles** (`<prefix>-main-menu`, `<prefix>-footer`) — do NOT overwrite the store-wide `main-menu` / `footer` unless the user explicitly asks, since the published theme renders those. Verify afterwards that the rendered header/footer come from `linklists` (count the links in the DOM), not from the fallback branch.

If the response is `403 / scope missing`, pause and ask the user to add `write_online_store_navigation` to the custom app, `Release` a new version, re-install, and re-run. Do not silently skip: a missing menu means the header falls back to hardcoded links and the merchant cannot edit the nav.

---

## Phase 4 — Parallel page rewrites (N agents in parallel, one per page, ~5 min each)

> **Model (see "Model assignment policy"):** decide each page's tier from its inventory before
> spawning — **complex** page (>4 sections, modal, quiz, tabs/toggle/calendar/carousel, custom
> animation) → `model: "opus"`; **simple** page → `model: "sonnet"`. Record the choice in
> `qa/state/inventory.json`.

For every entry in inventory `pages`, spawn one **Page Rewrite Agent** in the background. They run concurrently.

Each agent receives:
- React file path for its page
- Section prefix (e.g., `ws-`)
- Handle map (`qa/state/handles.json`) so internal links resolve
- Image CDN map (`qa/state/images.json`) so `<img src>` settings have working defaults
- Theme ID

Agent's task per page:
1. Read the React page top-to-bottom. Identify each visual section (hero, features grid, CTA, etc.).
2. For each section, create `sections/<prefix>-<pagename>-<sectionname>.liquid` with:
   - `<section class="full-width <prefix>-<sectionname>">` — `full-width` is **mandatory**.
   - Inline `{% stylesheet %}` block with raw CSS keyed off the section's class prefix. **NO Tailwind classes in markup.**
   - Inline SVGs replacing every Lucide icon. **No imports.**
   - Schema settings for every visible string, image, link, color, toggle, repeated unit. **No hardcoded user-facing content.**
   - Schema rules: name ≤ 25 chars, no `default: ""` on text/textarea, no default on `url` type, range default `(default-min) % step === 0`.
   - `image_picker` + `image_url` text fallback pattern for images.
   - Scroll reveals via `[data-bte-reveal]` from the global snippet (default-visible variant — let the safety-net catch IO failures).
   - Modal pattern: hidden `<div data-modal-source="<name>">` + JS clones into shared `bte-modal` shell on open + handles ESC/backdrop/focus.
   - prefers-reduced-motion guards on all animations.
   - Transitions use `cubic-bezier(.165,.84,.44,1)`.
3. Create `templates/page.<prefix>_<handle>.json` referencing the new sections, seed with the React data, set all `btn_url` / `cta_url` settings to `shopify://pages/<handle>` from the handle map.
4. Push the section files + snippet + template via the same REST API call pattern (using minted token).
5. Hand off to Phase 5 verification.

---

## Phase 5 — Per-page verification loop (max 5 iterations per page)

After each Page Rewrite Agent finishes, the orchestrator spawns 7 specialist agents **in parallel** to check that page. They all read the same dev-theme preview URL: `https://<shop>/pages/<handle>?preview_theme_id=<id>`.

> **Model (see "Model assignment policy"):** specialists 1, 2, 2b, 6 (Link, Content, Completeness,
> Editability) → `model: "haiku"`; specialists 3, 4, 5, 7 (Modal, Animation, Responsiveness, Visual)
> → `model: "sonnet"`. The **Fixer** → `model: "opus"`.

| # | Specialist | Check | Pass criterion |
|---|---|---|---|
| 1 | **Link Verifier** | Scan every `href`, `btn_url`, `cta_url` across the page's section files + template. Validate against handle map. | All links resolve to a real handle, mailto, tel, or external URL. No empty values. No self-loops. |
| 2 | **Content Matcher** | Read React JSX + Shopify rendered output. Compare every visible string: headings, body copy, button labels, list items, captions. | Zero string drift. |
| 2b | **Section Completeness** | Enumerate EVERY top-level `<section>` / visual band in the React page, in order. Confirm each has a corresponding `<prefix>-*` section in the Shopify template. Also confirm interactive sub-views (view toggles, calendars, tabs, carousels, quizzes) exist. | Zero omitted bands. A page agent must never silently drop a band because the brief listed fewer; the React file is the source of truth. |
| 3 | **Modal Coverage** | Identify React modals (open-state variables, JSX). Confirm Shopify section has equivalent hidden source node + JS open/close/ESC/backdrop wiring. | Every React modal has a working Shopify counterpart with identical content. |
| 4 | **Animation Match** | Compare React (framer-motion / Tailwind animate-*) against Shopify CSS keyframes + JS triggers. Check durations, easings, stagger delays, hover transforms. | Animation timings within ±50ms; same direction; same easing curve. |
| 5 | **Responsiveness** | Use Playwright MCP to load the page at 375 / 768 / 1440 px. Compare to React at same breakpoints. | No horizontal overflow, no text overlap, no broken grids at any breakpoint. |
| 6 | **Editability Auditor** | Parse the section's schema. List every user-visible content piece in the rendered HTML. Cross-check that each is bound to a schema setting. | Zero hardcoded user content. Every label/image/color/link is a settings field. |
| 7 | **Visual Comparator** | Playwright screenshots both React and Shopify at desktop 1440px and mobile 375px. Save PNGs to `qa/screenshots/<page>/`. A vision-capable agent reads the four PNGs (React-desktop / Shopify-desktop / React-mobile / Shopify-mobile) and reports visual diffs. | No layout/spacing/color/typography drift visible. |

**Decision logic:**
- If **all 7 PASS** → mark page complete in `qa/state/progress.json`. Stop.
- If **any FAIL** → orchestrator spawns one **Fixer Agent** with all seven reports as input. Fixer edits the section files, re-pushes, then re-spawns the same 7 specialists. Increment iteration counter.
- If iteration counter reaches **5** with at least one specialist still failing → mark page as `needs_manual_review` in progress.json. Stop. Continue with other pages.

Specialists run **in parallel** within each page's verification cycle. Pages run **in parallel** with each other. The orchestrator waits for all pages to terminate (pass or hit max-iter) before proceeding.

---

## Phase 6 — Final report + live swap (sequential, ~1 min)

1. Aggregate `qa/state/progress.json` across all pages.
2. **Live swap — SKIP under the factory (job.json `factory: true`).** In factory mode this clone
   has not yet been through the QA↔fix convergence loop, so it must NOT be published to the live
   theme here. Leave every page on the dev theme; the factory backend performs the dev→live publish
   itself, and only after convergence when `job.autoswap` is true. **Only when running
   interactively (no `job.json`)** do the live swap now: pages that **passed all 7 checks** →
   push their files to the **live theme**:
   - `GET /admin/api/2025-01/themes.json` → find the live theme ID
   - PUT each section file + template from the dev theme to the live theme
3. Pages that **hit max-iter** (or, in factory mode, every page) → leave on dev theme, listed in final report.
4. Generate `qa/reports/final.md` with:
   - Per-page pass/fail table
   - Screenshots side-by-side for any page that hit max-iter
   - Punch list for manual fixes
   - Live theme URL + dev theme preview URL
5. Output the report path and both URLs to the user.

**No pause** for live swap — this is autonomous. Per the user's spec: pause only after inventory and on missing scope.

---

## Critical files to be created or reused

**New per project (created once at Phase 2):**
- `push.mjs` — REST Assets API push script. Mints fresh token each run, auto-discovers `sections/<prefix>-*.liquid` + `snippets/<prefix>-*.liquid` + `templates/page.<prefix>_*.json`. `THEME_ID` env override.
- `qa/state/theme.json` — dev theme ID
- `qa/state/handles.json` — page handle map
- `qa/state/images.json` — image CDN URL map
- `qa/state/progress.json` — per-page verification status

- `sections/<prefix>-header.liquid` + `sections/<prefix>-footer.liquid` — menu-driven, `link_list` setting, hardcoded fallback
- `sections/header-group.json` + `sections/footer-group.json` — section groups referenced by `layout/theme.liquid`
- `seed/lib.mjs` — token mint + `gql()` helper
- `seed/create-menus.mjs` — idempotent `menuCreate`/`menuUpdate` upsert of the nav + footer menus
- `audit.mjs` — Playwright sweep of every page @ desktop+mobile: horizontal-overflow detection (with offending elements), nav wrap/overlap detection, broken `<img>`/`<video>` detection, dead-link detection, full-page screenshots

**Skeleton snippets (copied from prior project):**
- `snippets/bte-animations.liquid` (rename prefix per project) — global `[data-bte-reveal]` IntersectionObserver + 1.2s `bte-revealed` body-class safety-net + count-up utility. **Critical: the safety-net selector list must include the project's reveal class patterns.**
- `snippets/bte-modal.liquid` (rename prefix) — shared modal shell with backdrop, ESC handling, focus trap.

**Reference scripts to reuse:**
- `seed/upload-files.mjs` (CA89) — `stagedUploadsCreate` + `fileCreate` GraphQL pattern for image upload. Adapt for new project's `/public` images.
- `seed/gen-page-templates.mjs` (CA89) — generates page templates from inventory. Re-use the structure.

---

## Patterns the orchestrator enforces (encoded in every agent prompt)

These are baked into the prompts of every Page Rewrite Agent and Fixer Agent:

1. **Every section** has `class="full-width"` on its outer `<section>`.
2. **No Tailwind classes** in markup. Use inline `{% stylesheet %}` with raw CSS, scoped by `<prefix>-<sectionname>` class names.
3. **No Lucide imports.** Inline SVGs.
4. **All internal links** use `shopify://pages/<handle>` with handles from `qa/state/handles.json`.
5. **All scroll reveals** use `[data-bte-reveal]` (which has the working IO + safety-net) — never invent per-section reveal classes that default to `opacity: 0`.
6. **Schema validation rules:**
   - Every block / setting `name` ≤ 25 chars
   - No `default: ""` on text/textarea (omit instead)
   - No `default` on `url` type
   - Range `default - min % step === 0`
   - Every section has a `presets` array
7. **Modal pattern:** hidden source node with `data-modal-source` + shared `bte-modal` snippet rendered once per layout + JS `clones source on open / closes on backdrop, ESC, X button / locks body scroll`.
8. **Inline `{% stylesheet %}` and `{% javascript %}`** per section — nothing project-wide goes into `assets/theme.css` or `assets/theme.js`.
9. **`prefers-reduced-motion`** guard on every keyframe + transition longer than 200ms.
10. **Cubic-bezier `(.165,.84,.44,1)`** on user-facing transitions.
11. **Header/footer are menu-driven sections**, never hardcoded snippets. See "Header & footer" in Phase 2. Layout uses `{% sections 'header-group' %}` / `{% sections 'footer-group' %}`.
12. **Section-scoping JS:** `var s = (document.currentScript && document.currentScript.closest('.x')) || document.querySelector('.x');` — the naive ternary `document.currentScript ? …closest(…) : …` resolves to `null` once Shopify bundles section JS and silently disables the section.
13. **No filters inside `{% if %}`.** `{% if forloop.index0 | modulo: 2 %}` is a Liquid syntax error → 422. `{% assign m = forloop.index0 | modulo: 2 %}{% if m == 1 %}`.
14. **No comparisons in output tags.** `{{ a == b }}` renders `a`. Use `{% if %}` + `assign`.
15. **Toggle SVG visibility via attributes**, not the `hidden` property (`hidden` exists only on HTMLElement).
16. **Nav bars must not wrap or overlap.** Put `white-space: nowrap` on nav links/buttons, never let the nav flex-shrink below its content (`min-width:0` causes links to overlap the CTAs), and pick a desktop breakpoint wide enough to fit every link + CTA. Remember the page container has a `max-width` — widening the viewport past it buys no extra room.

---

## Verification (how the user knows it worked)

Run the orchestrator. When it terminates:

1. Check `qa/reports/final.md`. Every page in the inventory should appear in the "Passed all 7 checks" table.
2. Open the live store URL (`https://<shop>/pages/<handle>` for each page). Spot-check the most complex pages (modals, animations, dropdowns).
3. Open `qa/screenshots/<page>/` and compare React-vs-Shopify side-by-side at desktop + mobile.
4. Run the link sweep agent set one more time on the live theme to confirm nothing regressed during the live swap.
5. Confirm Shopify Admin → Online Store → Themes shows: dev theme `unpublished`, live theme `published`. The live theme contains the latest section files.

If any page is in the "needs manual review" table:
- Open dev theme preview URL for that page
- Read its 7 specialist reports in `qa/reports/<page>/`
- Fix the issue manually, re-push that page, re-run that page's 7 specialists once
- If they pass, run live-swap manually for just that page

---

## How the user invokes this orchestrator

Drop these files in the new theme project's root:

```
TARGET_SITE_INFO.txt   ← React URL + Shopify URL
API.txt                ← Client ID + Secret
react_files/           ← React source
```

Then in Claude Code, paste **the master prompt** (the body of this plan, sections "Phase 0" through "Patterns the orchestrator enforces"). Claude reads it, executes Phase 0 preflight, asks for confirmation after Phase 1 inventory, then runs autonomously through Phase 6.
