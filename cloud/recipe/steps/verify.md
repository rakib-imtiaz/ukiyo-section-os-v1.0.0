<!-- tbr-canary-b4d1e97c0f28 -->
## This step: check ONE page — {{PAGE_NAME}} (`{{PAGE_ROUTE}}`) (recipe phase 5: per-page verification loop, max 5 iterations)

The page step just built this page: its sections are `sections/{{PREFIX}}-{{PAGE_SLUG}}-*.liquid` and its template is `templates/{{PAGE_TEMPLATE}}` (see its entry in `qa/state/inventory.json`). Other pages are being built and checked by other sessions at the same time — touch only this page's files.

Spawn the 7 specialist agents below **in parallel** to check this page. They all read the same dev-theme preview URL: `https://{{STORE_HOST}}/pages/{{PAGE_HANDLE}}?preview_theme_id=<dev_theme_id from qa/state/theme.json>` (the home page: `https://{{STORE_HOST}}/?preview_theme_id=<id>`; catalog routes: the product/collection path from `qa/state/handles.json`). The React side is {{REACT_PAGE_URL}}.

| # | Specialist | Check | Pass criterion |
|---|---|---|---|
| 1 | **Link Verifier** | Scan every `href`, `btn_url`, `cta_url` across the page's section files + template. Validate against the handle map. | All links resolve to a real handle, mailto, tel, or external URL. No empty values. No self-loops. |
| 2 | **Content Matcher** | Read the React JSX + the Shopify rendered output. Compare every visible string: headings, body copy, button labels, list items, captions. | Zero string drift. |
| 2b | **Section Completeness** | Enumerate EVERY top-level `<section>` / visual band in the React page, in order. Confirm each has a corresponding `{{PREFIX}}-*` section in the Shopify template. Also confirm interactive sub-views (view toggles, calendars, tabs, carousels, quizzes) exist. | Zero omitted bands. A page step must never silently drop a band because the plan listed fewer; the React file is the source of truth. |
| 3 | **Modal Coverage** | Identify React modals (open-state variables, JSX). Confirm the Shopify section has an equivalent hidden source node + JS open/close/ESC/backdrop wiring. | Every React modal has a working Shopify counterpart with identical content. |
| 4 | **Animation Match** | Compare React (framer-motion / Tailwind animate-*) against Shopify CSS keyframes + JS triggers. Check durations, easings, stagger delays, hover transforms. | Animation timings within ±50ms; same direction; same easing curve. |
| 5 | **Responsiveness** | Load the page at 375 / 768 / 1440 px with Playwright (the Playwright MCP tools, or `audit.mjs`). Compare to React at the same breakpoints. | No horizontal overflow, no text overlap, no broken grids at any breakpoint. |
| 6 | **Editability Auditor** | Parse the section's schema. List every user-visible content piece in the rendered HTML. Cross-check that each is bound to a schema setting. | Zero hardcoded user content. Every label/image/color/link is a settings field. |
| 7 | **Visual Comparator** | Playwright screenshots of both React and Shopify at desktop 1440px and mobile 375px, saved to `qa/screenshots/{{PAGE_SLUG}}/`. A vision-capable agent reads the four PNGs (React-desktop / Shopify-desktop / React-mobile / Shopify-mobile) and reports visual diffs. | No layout/spacing/color/typography drift visible. |

Each specialist writes its report to `qa/reports/{{PAGE_SLUG}}/<iteration>-<specialist>.md`.

What each sub-agent's prompt must carry (they see nothing of this one): a **specialist** gets its row of the table (check + pass criterion), both URLs, this page's section files, template and React file, the handle map path, the storefront password from `TARGET_SITE_INFO.txt` if the store has one, and its report path. The **Fixer** gets all seven reports plus — copied into its prompt — the mandatory patterns, the lessons, the image rules and the edit protocol below, and the rule to touch only this page's files.

**Shared files:** a failure caused by a shared file (layout, header/footer, the reveal or modal snippet, `assets/critical.css`) is not this page's to fix — other pages are checked at the same time. Don't send the Fixer after it and don't spend iterations on it: record it under `shared_issues` (below), together with anything the page step wrote to `qa/reports/{{PAGE_SLUG}}/shared-issues.md`, and decide the page's status on the other failures.

**Decision logic:**

- If **all 7 PASS** → mark the page complete. Stop.
- If **any FAIL** → spawn one **Fixer Agent** with all seven reports as input. The Fixer edits the section files (following the edit protocol and every mandatory pattern below), re-pushes only what it changed, then you re-spawn the same 7 specialists. Increment the iteration counter.
- If the iteration counter reaches **5** with at least one specialist still failing → mark the page `needs_manual_review`. Stop.

Specialists run **in parallel** within each verification cycle.

**Recording the result:** the original single-session build kept one `qa/state/progress.json`; because pages are now checked in parallel sessions, write this page's result to its own file `qa/state/progress/{{PAGE_SLUG}}.json` (the final step merges them):

```json
{ "route": "{{PAGE_ROUTE}}", "status": "passed" | "needs_manual_review", "iterations": 2,
  "failing": ["<specialist>: <one-line reason>", ...], "shared_issues": ["<shared file>: <problem>", ...],
  "reports": "qa/reports/{{PAGE_SLUG}}/", "screenshots": "qa/screenshots/{{PAGE_SLUG}}/" }
```
