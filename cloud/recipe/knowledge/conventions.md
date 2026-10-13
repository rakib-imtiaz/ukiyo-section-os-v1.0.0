The rest of seed/CONVENTIONS.md (the 16 rules live in rules.md). Text before the first fragment
marker is never sent.

<!-- @fragment conv-source-of-truth -->
<!-- tbr-canary-a91f3d6e2b08 -->
You are building Shopify Liquid sections that clone a React site. The React source at `react_files/` is the source of truth for which bands exist, their order, and their copy. Section prefix for this project: `{{PREFIX}}-`.

<!-- @fragment conv-images -->
## Images

`image_picker` id `image` + text id `image_url` fallback pattern:
`{% if section.settings.image %}{{ section.settings.image | image_url: width: N }}{% else %}{{ section.settings.image_url }}{% endif %}`
Use the CDN URLs in `qa/state/images.json` as `image_url` defaults. Verify every external asset URL returns 200 before shipping it as a default.

<!-- @fragment conv-edit-protocol -->
## Edit protocol (MANDATORY for every fix to files already pushed)

1. **Pull first**: `node pull.mjs` (MODE=backup snapshots the cloud state to `qa/state/cloud-backup/<ts>/`) before touching any theme file. The cloud is the source of truth.
2. **Log every edit**: append to `seed/edits.log` — `<ISO timestamp> | <file path> | <one-line summary> | pre-edit-size=<bytes> | pre-edit-sha=<short hash>`.
3. **Snapshot before overwrite**: copy the pre-edit file to `seed/.snapshots/<timestamp>/` first.
4. **Push only edited files**: `ONLY=<a,b> node push.mjs`. NEVER bulk-push the whole tree.

<!-- @fragment conv-output -->
## What to output

- Section `.liquid` files to `sections/`, templates to `templates/`, snippets to `snippets/`.
- Push via `push.mjs` (mints its own token; respects rate limits).
- Never write to the published (MAIN) theme. When `job.json` `autoswap` is true, the factory publishes the dev theme itself after all checks pass.
