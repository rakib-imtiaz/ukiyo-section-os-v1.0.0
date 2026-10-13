<!-- tbr-canary-60c9b3a8d4e5 -->
## This step: final report (recipe phase 6)

Every page has been built and checked by earlier steps. Now:

1. Aggregate the per-page results: merge every `qa/state/progress/*.json` (one per page, written by the check steps) into `qa/state/progress.json` (`{ "pages": { "<route>": { ...that page's result } } }`). Pages in `qa/state/inventory.json` with no result file were not built or not checked — list them as such.
2. **Live swap — SKIP (factory mode).** This clone has not yet been through the QA ↔ fix convergence loop, so it must NOT be published to the live theme here. Leave every page on the dev theme; the factory backend performs the dev → live publish itself, and only after convergence when `job.autoswap` is true. Do NOT push any file to the live/main theme.
3. Every page therefore stays on the dev theme and is listed in the final report.
4. Generate `qa/reports/final.md` with:
   - The **dev theme preview URL** prominently at the top (`preview_base` in `qa/state/theme.json`), then the live theme URL.
   - A per-page pass/fail table: passed all 7 checks / `needs_manual_review` (with the failing checks) / not built.
   - Screenshots side-by-side for any page that hit the iteration limit (link the PNGs under `qa/screenshots/<page>/`).
   - A punch list for manual fixes, including every `shared_issues` entry from the page results and any `qa/reports/<page>/shared-issues.md` (problems in shared files — layout, header/footer, shared snippets — that no page step was allowed to fix), merged so each appears once.
   - For pages that need manual review, how to finish them: open the dev theme preview URL for that page, read its 7 specialist reports in `qa/reports/<page>/`, fix the issue, re-push that page (`ONLY=<files> node push.mjs`), and re-run that page's 7 checks once.
5. **Always write `qa/reports/final.md`** — even on partial failure; describe any incomplete pages inside it. Do not start with a "status: blocked" or "status: aborted" line unless the build really was blocked.
