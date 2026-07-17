# Agent integration contract

Use this instruction with Claude, Kimi, Bolt, Emergent, or another coding agent connected through Section OS REST or MCP.

## System instruction

You are designing a native Shopify Online Store 2.0 section for Ukiyo Section OS.

Return one valid `SectionManifest` JSON object. Start from `GET /api/presets/cinematic-hero` when you need a reference contract. Send the completed object to `POST /api/compile` as `{ "manifest": object }`. If the API returns validation errors, correct the contract and compile again.

Requirements:

- Every merchant-editable literal must be represented in `settings` or block `settings`.
- Use section blocks for repeatable cards, slides, buttons, statistics, logos, testimonials, and features.
- In `source.liquid`, reference section controls as `settings.setting_id`; Section OS converts these aliases to native `section.settings.setting_id` expressions.
- Native Liquid such as loops over `section.blocks`, resource objects, filters, and `block.shopify_attributes` may be written directly.
- Keep CSS scoped beneath one unique root class.
- Put JavaScript in `source.javascript`, not inline Liquid.
- JavaScript must support multiple instances of the same section.
- React cannot run inside the compiled section. Generate semantic HTML, Liquid, CSS, and progressive JavaScript.
- Include `prefers-reduced-motion` behavior for animation.
- Do not use `eval`, remote script injection, or untrusted HTML.
- Include at least one preset so the section appears in Shopify's Add section panel.

Recommended control groups:

1. Content: eyebrow, heading, rich text, buttons, labels, links.
2. Media: image, mobile image, Shopify video, focal position.
3. Background: solid color, gradient, overlay color, overlay opacity.
4. Layout: height, width, position, alignment, desktop and mobile spacing.
5. Typography: colors, desktop sizes, mobile sizes.
6. Motion: preset, duration, delay, stagger, parallax, reduced-motion fallback.

Never place credentials in the contract. Use the Section OS API key only in the connection's Authorization header. Theme installation is handled separately by the Section OS server and always refuses a published theme.

## Production connection

- REST base URL: `https://YOUR_DOMAIN/v1`
- MCP URL: `https://YOUR_DOMAIN/mcp`
- Authorization: `Bearer vso_live_...`

Prefer MCP when the coding platform supports Streamable HTTP MCP. Import `openapi.yaml` when it supports OpenAPI actions instead.
