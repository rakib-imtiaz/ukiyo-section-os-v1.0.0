<!-- tbr-canary-3e8f0a6d5c17 -->
## This step: build ONE page — {{PAGE_NAME}} (`{{PAGE_ROUTE}}`) (recipe phase 4)

| | |
|---|---|
| React route | `{{PAGE_ROUTE}}` — live at {{REACT_PAGE_URL}} |
| React file | `react_files/{{PAGE_REACT_FILE}}` (if that path is wrong, find the page component for this route) |
| Shopify handle | `{{PAGE_HANDLE}}` |
| Template | `templates/{{PAGE_TEMPLATE}}` |
| Planned bands | {{PAGE_BANDS}} (see this page's entry in `qa/state/inventory.json`) |
| Section prefix | `{{PREFIX}}-` |

Your inputs on disk:

- `qa/state/inventory.json` — this page's entry (bands in order, features, modals).
- `qa/state/handles.json` — the handle map, so internal links resolve.
- `qa/state/images.json` — the image CDN map, so `<img src>` settings have working defaults.
- `qa/state/theme.json` — the dev theme ID.
- `qa/state/bootstrap.json` — the shared names: reveal attribute, reveal snippet, modal snippet (and how to use them). Read the reveal and modal snippets themselves before you use them, so your markup and JS match what they actually provide.

Other pages are being built by other sessions at the same time. **Touch only this page's files**: its sections (`sections/{{PREFIX}}-{{PAGE_SLUG}}-*.liquid`), its template, and any snippet only this page uses (name it `snippets/{{PREFIX}}-{{PAGE_SLUG}}-*.liquid`). Shared files (layout, header/footer, the reveal and modal snippets, `assets/critical.css`) belong to the bootstrap step: don't edit them; if one is genuinely broken for this page, write the file, the problem and the fix it needs to `qa/reports/{{PAGE_SLUG}}/shared-issues.md` — the check and final steps carry it into the punch list.
{{REBUILD_NOTE}}
### Your task

1. Read the React page top-to-bottom. Identify each visual section (hero, features grid, CTA, etc.) — every band, in order; never silently drop one because the plan listed fewer.
2. For each section, create `sections/{{PREFIX}}-{{PAGE_SLUG}}-<sectionname>.liquid` with:
   - `<section class="full-width {{PREFIX}}-<sectionname>">` — `full-width` is **mandatory**.
   - An inline `{% stylesheet %}` block with raw CSS keyed off the section's class prefix. **NO Tailwind classes in markup.**
   - Inline SVGs replacing every Lucide icon. **No imports.**
   - Schema settings for every visible string, image, link, color, toggle, repeated unit. **No hardcoded user-facing content.**
   - Schema rules: name ≤ 25 chars, no `default: ""` on text/textarea, no default on `url` type, range default `(default-min) % step === 0`.
   - The `image_picker` + `image_url` text fallback pattern for images.
   - Scroll reveals via the global snippet's reveal attribute (`data-{{PREFIX}}-reveal`, as recorded in `qa/state/bootstrap.json`) — the default-visible variant; let the safety-net catch IntersectionObserver failures.
   - Modal pattern: hidden `<div data-modal-source="<name>">` + JS that clones it into the shared modal shell on open + handles ESC/backdrop/focus.
   - `prefers-reduced-motion` guards on all animations.
   - Transitions use `cubic-bezier(.165,.84,.44,1)`.
3. Create `templates/{{PAGE_TEMPLATE}}` referencing the new sections, in React order, seeded with the React data. Set every `btn_url` / `cta_url` setting to `shopify://pages/<handle>` from the handle map.
4. Push this page's section files + snippets + template via the REST Assets API with a minted token: `ONLY=<file1,file2,...> node push.mjs` (never a bare `node push.mjs` — other pages are pushing too).
5. Hand-off: the check step for this page runs next, in its own session.
