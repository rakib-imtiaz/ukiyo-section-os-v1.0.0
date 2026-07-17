# {{NAME}} Clone — Builder Conventions (read before writing any section)

You are building Shopify Liquid sections that clone a React site. The React source at `react_files/` is the source of truth for which bands exist, their order, and their copy. Section prefix for this project: `{{PREFIX}}-`.

## MANDATORY patterns (violations break the page — all 16 are enforced)

1. Every section's outer element: `<section class="full-width {{PREFIX}}-<name>">`. `full-width` is REQUIRED (the theme's grid container constrains children otherwise).
2. NO Tailwind classes in markup. Raw CSS only, inside `{% stylesheet %}`, class-scoped by `{{PREFIX}}-<name>`.
3. NO icon/library imports. Inline SVGs replace every Lucide icon.
4. All internal links use `shopify://pages/<handle>` with handles from `qa/state/handles.json`. No empty URL values, no self-loops.
5. Scroll reveals use the global reveal snippet's `data-{{PREFIX}}-reveal` attribute (default-visible safety net). Never invent per-section reveal classes that default to `opacity: 0`.
6. Schema rules: every setting/block `name` <= 25 chars; NO `default: ""` on text/textarea (omit instead); NO `default` on `url` type; range `(default - min) % step === 0`; every section has a `presets` array.
7. Modal pattern: hidden `<div data-modal-source="<name>">` + shared modal snippet rendered once per layout + JS clones source on open, closes on backdrop/ESC/X, locks body scroll, traps focus.
8. Inline `{% stylesheet %}` and `{% javascript %}` per section — nothing project-wide in `assets/theme.css` / `theme.js`.
9. `prefers-reduced-motion` guard on every keyframe + transition longer than 200ms.
10. Transitions use `cubic-bezier(.165,.84,.44,1)`.
11. Header/footer are menu-driven SECTIONS (`link_list` setting reading `linklists`, hardcoded fallback branch), wrapped in section groups. Layout uses `{% sections 'header-group' %}` / `{% sections 'footer-group' %}` — never `{% render %}` for nav.
12. Section-scoping JS: `var s = (document.currentScript && document.currentScript.closest('.x')) || document.querySelector('.x');` — the naive ternary resolves to `null` once Shopify bundles section JS and silently disables the section.
13. No Liquid filters inside `{% if %}` (`{% if x | modulo: 2 %}` is a 422). Assign first: `{% assign m = x | modulo: 2 %}{% if m == 1 %}`.
14. No comparisons in output tags. `{{ a == b }}` renders `a`. Use `{% if %}` + `assign`.
15. Toggle SVG visibility with `setAttribute`/`removeAttribute('hidden')`, never the `.hidden` property (HTMLElement-only).
16. Nav bars must not wrap or overlap: `white-space: nowrap` on nav links/buttons, never `min-width: 0` on the nav flex child, desktop breakpoint wide enough for every link + CTA.

## Images

`image_picker` id `image` + text id `image_url` fallback pattern:
`{% if section.settings.image %}{{ section.settings.image | image_url: width: N }}{% else %}{{ section.settings.image_url }}{% endif %}`
Verify every external asset URL returns 200 before shipping it as a default.

## Edit protocol (MANDATORY for every fix session)

1. **Pull first**: `node pull.mjs` (MODE=backup snapshots cloud state to `qa/state/cloud-backup/<ts>/`) before touching any theme file. The cloud is the source of truth.
2. **Log every edit**: append to `seed/edits.log` — `<ISO timestamp> | <file path> | <one-line summary> | pre-edit-size=<bytes> | pre-edit-sha=<short hash>`.
3. **Snapshot before overwrite**: copy the pre-edit file to `seed/.snapshots/<timestamp>/` first.
4. **Push only edited files**: `ONLY=<a,b> node push.mjs`. NEVER bulk-push the whole tree.

## What to output

- Section `.liquid` files to `sections/`, templates to `templates/`, snippets to `snippets/`.
- Push via `push.mjs` (mints its own token; respects rate limits).
- Never write to the published (MAIN) theme unless job.json `autoswap` is true and all checks passed.
