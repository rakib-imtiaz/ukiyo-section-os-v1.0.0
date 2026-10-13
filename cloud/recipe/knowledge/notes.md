Conditional notes: the step engine fills a placeholder with one of these only when it applies
(manifest "notes"). Text before the first fragment marker is never sent.

<!-- @fragment note-rebuilt-page -->
<!-- tbr-canary-8b3e1f5a7c06 -->
> **THIS IS A REBUILD — this page was already built in an earlier run.** Its template and all planned sections are on disk: do not rewrite those files. Check them quickly (renders, no missing section, pushed to the dev theme) and fix only real problems. Reuse existing snippets, assets and settings instead of recreating them. Spend your effort only on what is actually missing or broken.

<!-- @fragment note-regression -->
7. **REGRESSION WARNING:** the previous fix iteration LOWERED the match score. Re-read your previous edits in `seed/edits.log`, prefer restoring from `seed/.snapshots/` where your change broke something, and be conservative.
