<!-- tbr-canary-c83a5f0e12d9 -->
## This step: inventory — the build plan (recipe phase 1)

Walk the React source (`react_files/`) and produce the JSON inventory the rest of the build works from. The preflight step cached each route's HTML under `qa/state/react-html/` and listed the reachable pages in `qa/reports/preflight.md` — start from those.

Write the inventory to `qa/state/inventory.json`, plus a human-readable copy in `qa/reports/inventory.md`. Headless: there is no approval pause — write both and finish.

If `qa/state/inventory.json` already exists (a resumed or rebuilt build), start from it and keep every existing page's `route`, `shopify_handle` and `template` unchanged — pages, templates and links already built depend on them. Only add what is missing and correct what is plainly wrong against the React source.

```json
{
  "pages":   [{ "route": "/about", "name": "About", "react_file": "src/pages/AboutPage.tsx", "shopify_handle": "about", "template": "page.{{PREFIX}}_about.json", "band_count": 6, "bands": ["hero", "story", "team", "values", "faq", "cta"], "features": ["modal"], "complexity": "complex", "model": "opus" }, ...],
  "header":  { "nav_items": [...], "dropdowns": {...} },
  "footer":  { "columns": [...], "social": [...], "policies": [...] },
  "blog":    { "data_file": "src/data/blogArticles.ts", "articles": [...] },
  "images":  [{ "react_path": "/public/hero.jpg", "intended_handle": "hero", "status": 200 }, ...],
  "modals":  [{ "react_component": "Modal", "used_in": ["AboutPage", "HomePage"] }, ...],
  "anim_libs": ["framer-motion", "gsap"]
}
```

The factory turns **every entry in `pages` into its own build step and its own check step**, so this list is the build plan. Rules for `pages`:

- One entry per routed page of the React app (`src/pages/*` and the router config), the home page included (`"route": "/"`). Leave out pure redirects and the 404 page.
- `route` — the React route, starting with `/`. `name` — a short human label ("Home", "About", "Our Team").
- `react_file` — the page component's path, relative to `react_files/`.
- `shopify_handle` — the Shopify page handle this route will get. Internal links will point to `shopify://pages/<handle>`, so it must be exactly what the store setup step creates (e.g. `our-team`, not `team`).
- `template` — the Shopify template this route renders through: `page.{{PREFIX}}_<handle>.json` for content pages, with every `-` in the handle written as `_` (handle `our-team` → `page.{{PREFIX}}_our_team.json`), `index.json` for the home page. This name is final: the page step writes exactly this file and the store setup step derives each page's `template_suffix` from it; for product / collection routes (`/products/*`, `/collections/*`, PDP/PLP-style pages) `product.json` / `collection.json`, or a `product.{{PREFIX}}_<handle>.json` alternate template when pages need different layouts. Mark those routes `"type": "product"` / `"type": "collection"` so the store setup step seeds them as real catalog objects.
- `band_count` and `bands` — EVERY top-level `<section>` / visual band of the React page, in order. Never undercount: the per-page check compares against the React file, and the build progress counts these.
- `features` — interactive features found on the page: modal, quiz / multi-step form, view toggle, tabs, calendar, carousel, non-trivial custom animation logic.
- `complexity` + `model` — see the page routing rule below.

Also record:

- `header` / `footer` — the nav items, dropdowns (including any subtitle lines under dropdown items), footer columns, social links and policy links exactly as the React Navbar and Footer render them. Later steps build menu-driven header/footer sections and seed Shopify navigation menus from this.
- `blog` — the data file and every article (title, body, tags, date, image).
- `images` — every image / video the React app uses, with the HTTP status you got for it (see the dead-media lesson).
- `modals` and `anim_libs` — as shown.

Add a short summary to `qa/reports/inventory.md`: the page list with routes, handles, band counts and chosen tiers, the blog plan and the handle mapping.
