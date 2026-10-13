Lessons from the earlier clones (CA89, Back to Earth). Each fragment is one lesson; the manifest
decides which steps receive which lessons. Text before the first fragment marker is never sent.

<!-- @fragment lessons-intro -->
<!-- tbr-canary-58e2c0d74a19 -->
## Lessons from earlier clones (CA89, Back to Earth) — apply them

<!-- @fragment lesson-tailwind -->
- Tailwind classes don't work in raw Shopify Liquid — sections must use inline `{% stylesheet %}` blocks with raw CSS keyed off the 2-3 char prefix (`{{PREFIX}}-`).
<!-- @fragment lesson-full-width -->
- Sections need `class="full-width"` on the outer `<section>` element to span the viewport (the theme uses a CSS grid container that constrains children to a center column by default).
<!-- @fragment lesson-reveal -->
- Reveal animations need a default-visible safety net; per-section IntersectionObservers fail silently and leave content stuck at `opacity: 0`.
<!-- @fragment lesson-handles -->
- Internal links must use `shopify://pages/<handle>` with handles that match what's actually in the Shopify Admin (e.g., `our-team`, not `team`).
<!-- @fragment lesson-cli-oauth -->
- Shopify CLI's interactive OAuth doesn't work in Claude Code's non-TTY shell — use the REST Assets API directly with a token minted via OAuth `client_credentials` (here: `mint()` from `qa/lib.mjs`, which `push.mjs`, `pull.mjs` and `preflight.mjs` already use).
<!-- @fragment lesson-header-footer -->
- **Header + footer must be SECTIONS driven by Shopify navigation menus (`linklists`), never hardcoded snippets.** A hardcoded nav leaves Online Store → Navigation showing the stock "Home, Catalog, Contact" menu, and the merchant can't edit the nav.
<!-- @fragment lesson-current-script -->
- **`document.currentScript` is null-ish inside `{% javascript %}`.** Shopify bundles all section JS into one external file, so `document.currentScript.closest('.my-section')` returns `null` and any `if (!s) return;` guard silently kills the section's JS (filters, accordions, quizzes, counters all die with no error). Always write `var s = (document.currentScript && document.currentScript.closest('.x')) || document.querySelector('.x');`
<!-- @fragment lesson-svg-hidden -->
- **`hidden` is an HTMLElement property, not an SVGElement one.** `svg.hidden = true` is a no-op expando. Toggle SVG icon visibility with `setAttribute` / `removeAttribute('hidden')`.
<!-- @fragment lesson-liquid-output -->
- **Liquid output tags can't do comparisons.** `{{ a == b }}` renders `a`, not a boolean. Use `{% if %}` + `assign`.
<!-- @fragment lesson-dead-media -->
- Source React apps often reference **dead external image/video URLs**. Verify every asset returns 200 and swap dead ones; don't ship broken media.
