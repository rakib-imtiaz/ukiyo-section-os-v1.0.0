The 16 patterns every section must follow (clone-theme.md "Patterns the orchestrator enforces"
merged with seed/CONVENTIONS.md). One fragment per rule; keep the numbering stable — reports and
fix sessions refer to rules by number. Text before the first fragment marker is never sent.

<!-- @fragment rules-intro -->
<!-- tbr-canary-2c6b9e4f1a70 -->
## Mandatory patterns — enforced in every section you write or fix (violations break the page)

<!-- @fragment rule-1 -->
1. **Every section** has `class="full-width"` on its outer `<section>`: `<section class="full-width {{PREFIX}}-<name>">`. `full-width` is REQUIRED (the theme's grid container constrains children to a center column otherwise).
<!-- @fragment rule-2 -->
2. **No Tailwind classes** in markup. Raw CSS only, inside an inline `{% stylesheet %}`, scoped by `{{PREFIX}}-<sectionname>` class names.
<!-- @fragment rule-3 -->
3. **No Lucide imports** (no icon/library imports at all). Inline SVGs replace every icon.
<!-- @fragment rule-4 -->
4. **All internal links** use `shopify://pages/<handle>` with handles from `qa/state/handles.json`. No empty URL values, no self-loops.
<!-- @fragment rule-5 -->
5. **All scroll reveals** use the global reveal snippet's `[data-{{PREFIX}}-reveal]` attribute (it has the working IntersectionObserver + safety-net; the exact name is in `qa/state/bootstrap.json`) — never invent per-section reveal classes that default to `opacity: 0`.
<!-- @fragment rule-6 -->
6. **Schema validation rules:**
   - Every block / setting `name` ≤ 25 chars
   - No `default: ""` on text/textarea (omit instead)
   - No `default` on `url` type
   - Range `(default - min) % step === 0`
   - Every section has a `presets` array
<!-- @fragment rule-7 -->
7. **Modal pattern:** hidden source node with `data-modal-source="<name>"` + the shared modal snippet rendered once per layout + JS that clones the source on open, closes on backdrop, ESC and X button, locks body scroll and traps focus.
<!-- @fragment rule-8 -->
8. **Inline `{% stylesheet %}` and `{% javascript %}`** per section — nothing project-wide goes into `assets/theme.css` or `assets/theme.js`.
<!-- @fragment rule-9 -->
9. **`prefers-reduced-motion`** guard on every keyframe + transition longer than 200ms.
<!-- @fragment rule-10 -->
10. **Cubic-bezier `(.165,.84,.44,1)`** on user-facing transitions.
<!-- @fragment rule-11 -->
11. **Header/footer are menu-driven sections**, never hardcoded snippets: a `link_list` setting reading `linklists`, with a hardcoded fallback branch, wrapped in section groups. Layout uses `{% sections 'header-group' %}` / `{% sections 'footer-group' %}` — never `{% render %}` for nav.
<!-- @fragment rule-12 -->
12. **Section-scoping JS:** `var s = (document.currentScript && document.currentScript.closest('.x')) || document.querySelector('.x');` — the naive ternary `document.currentScript ? …closest(…) : …` resolves to `null` once Shopify bundles section JS and silently disables the section.
<!-- @fragment rule-13 -->
13. **No filters inside `{% if %}`.** `{% if forloop.index0 | modulo: 2 %}` is a Liquid syntax error → 422. Assign first: `{% assign m = forloop.index0 | modulo: 2 %}{% if m == 1 %}`.
<!-- @fragment rule-14 -->
14. **No comparisons in output tags.** `{{ a == b }}` renders `a`. Use `{% if %}` + `assign`.
<!-- @fragment rule-15 -->
15. **Toggle SVG visibility via attributes** (`setAttribute` / `removeAttribute('hidden')`), not the `.hidden` property (`hidden` exists only on HTMLElement).
<!-- @fragment rule-16 -->
16. **Nav bars must not wrap or overlap.** Put `white-space: nowrap` on nav links/buttons, never let the nav flex-shrink below its content (`min-width: 0` on the nav flex child causes links to overlap the CTAs), and pick a desktop breakpoint wide enough to fit every link + CTA. Remember the page container has a `max-width` — widening the viewport past it buys no extra room.
