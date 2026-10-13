<!-- tbr-canary-e5094bd27a61 -->
## This step: bootstrap the theme (recipe phase 2)

Read `qa/state/inventory.json` first (header, footer, modals, anim_libs, images).

Page handles: `qa/state/handles.json` does not exist yet — the store setup step writes it after you. For every internal link you write now (the header/footer fallback links and the menu items in `seed/create-menus.mjs`), use `/pages/<shopify_handle>` from each page's inventory entry (`/` for the home page, the product/collection path for catalog routes); store setup creates exactly those handles.

1. Create a fresh dev theme: run `node qa/bootstrap-theme.mjs`. It creates an unpublished theme named after `job.json` `dev_theme_name` (or reuses it) and saves its ID to `qa/state/theme.json` (`dev_theme_id`, `live_theme_id`, `preview_base`).
2. Generate the local theme skeleton if missing:
   - `layout/theme.liquid` — must render the header/footer via `{% sections 'header-group' %}` … `{% sections 'footer-group' %}`, **not** `{% render %}`. It also renders the shared modal snippet once and the reveal snippet once, and loads `assets/critical.css`.
   - `sections/{{PREFIX}}-header.liquid` + `sections/{{PREFIX}}-footer.liquid` (see "Header & footer" below)
   - `sections/header-group.json` + `sections/footer-group.json`
   - `snippets/{{PREFIX}}-animations.liquid` — the proven reveal + safety-net snippet from Back to Earth (`bte-animations`, prefix renamed for this project): a global `[data-{{PREFIX}}-reveal]` IntersectionObserver + a 1.2s `{{PREFIX}}-revealed` body-class safety-net + a count-up utility. **Critical: the safety-net selector list must include the project's reveal class patterns.** Content is visible by default; the observer only adds the motion.
   - `snippets/{{PREFIX}}-modal.liquid` — the shared modal shell: backdrop, ESC handling, focus trap.
   - `assets/critical.css` (with the `.full-width` rule and the CSS grid container)
   - `seed/create-menus.mjs` (see below) — import `mint` / `client` from `../qa/lib.mjs` for the token and the `gql()` helper. The store setup step runs it.
   - `audit.mjs` — a Playwright sweep of every page @ desktop + mobile: horizontal-overflow detection (with the offending elements), nav wrap/overlap detection, broken `<img>` / `<video>` detection, dead-link detection, full-page screenshots. The per-page checks use it.
   - `push.mjs` is already in place (auto-discovers layout/sections/snippets/templates/assets/config, mints a fresh token, PUTs each with 429 backoff, `THEME_ID` env override, `ONLY=a,b` filter) — use it, do not regenerate it.
3. Push the skeleton to the dev theme: `node push.mjs`.
4. Record the shared names in `qa/state/bootstrap.json`, so every page step (each runs in its own session) uses exactly the same ones:

   ```json
   { "reveal_attribute": "data-{{PREFIX}}-reveal", "reveal_snippet": "snippets/{{PREFIX}}-animations.liquid",
     "reveal_usage": "<one line: the values/options the reveal attribute takes (direction, stagger delay) and how to use the count-up utility>",
     "modal_snippet": "snippets/{{PREFIX}}-modal.liquid", "modal_source_attribute": "data-modal-source",
     "modal_usage": "<one line: how a section's JS opens the shell with a source node's content, and how it closes>",
     "header_section": "sections/{{PREFIX}}-header.liquid", "footer_section": "sections/{{PREFIX}}-footer.liquid",
     "menus": { "main": "{{PREFIX}}-main-menu", "footer": "{{PREFIX}}-footer" } }
   ```

### Header & footer — MANDATORY pattern (menu-driven sections)

Never hardcode nav/footer links in a snippet. Build both as **sections with a `link_list` setting** that render from `linklists`, wrapped in section groups.

**Header section** (`sections/{{PREFIX}}-header.liquid`):

```liquid
{%- liquid
  assign menu_handle = section.settings.menu
  if menu_handle == blank
    assign menu_handle = '{{PREFIX}}-main-menu'
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
- Section groups: `sections/header-group.json` → `{"type":"header","sections":{"header":{"type":"{{PREFIX}}-header","settings":{"menu":"{{PREFIX}}-main-menu"}}},"order":["header"]}` (and the footer equivalent with `"type":"footer"`).

**The menus** are seeded by `seed/create-menus.mjs` — GraphQL `menuCreate` / `menuUpdate`, idempotent by handle, mirroring the React Navbar + Footer from the inventory:

```js
const link = (title, url, items = []) => ({ title, type: 'HTTP', url, items });
const Q_MENUS = `{ menus(first:20){ nodes { id handle title } } }`;
// upsert(handle,title,items): menuUpdate if handle exists else menuCreate
```

**Use dedicated handles** (`{{PREFIX}}-main-menu`, `{{PREFIX}}-footer`) rather than overwriting the store-wide `main-menu` / `footer`, which the currently-published theme also renders. Overwriting those is a destructive change to live navigation — never do it in a factory build. The `link_list` setting lets the merchant repoint from the theme editor either way.

Menus require the `write_online_store_navigation` scope.
