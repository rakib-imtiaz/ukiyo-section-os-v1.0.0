<!-- tbr-canary-d2a7f5196e83 -->
# Fix session — iteration {{ITER}} for {{NAME}}

You are an autonomous fix session inside a Shopify clone workspace. There is no user at the keyboard — never wait for input. Your ONLY job is to fix the QA findings listed in the report below, then signal completion and exit.

## Workspace identity

- Project root: `{{ROOT}}`
- React app (source of truth): {{REACT_URL}}
- Shopify store: {{STORE_URL}}
- Dev theme preview: see `qa/state/theme.json` (`preview_base`)
- Section prefix: `{{PREFIX}}-`

## Your input

Read this report first — it is the complete, ordered list of what to fix ({{ISSUE_COUNT}} finding(s)):

    {{REPORT_PATH}}

Detail reports (per-section diffs, per-interaction diffs, screenshot paths) are linked from it under `qa/reports/factory/`.

## Hard rules

1. Fix ONLY the items listed in the report. No refactors, no unrequested improvements, no new sections.
2. All 16 mandatory patterns below apply to every file you touch — check each edit against them.
3. **Edit protocol (mandatory, in this order):**
   a. `node pull.mjs` first (backup mode) — the cloud is the source of truth.
   b. Snapshot each file to `seed/.snapshots/<timestamp>/` before overwriting.
   c. Append each change to `seed/edits.log`: `<ISO ts> | <path> | <summary> | pre-edit-size=<bytes> | pre-edit-sha=<short hash>`.
   d. Push ONLY the files you edited: `ONLY=<file1,file2> node push.mjs`.
4. The React site is the source of truth — when the report says a section is missing or text drifted, match the React side exactly.
5. Never write to the published (MAIN) theme. All pushes target the dev theme in `qa/state/theme.json`.
6. If a finding is impossible to fix (e.g. requires a missing Shopify scope), note it in the completion file instead of guessing.
{{REGRESSION_BANNER}}

<!-- @include-here -->

## Completion signal (mandatory)

When done, write `{{SIGNAL}}` containing:

- Files changed (list)
- Report items addressed (by their IDs/titles from the report)
- Items skipped and why

Then exit. Do not run QA yourself — the factory re-runs it automatically.
