The model assignment policy (cost control) from clone-theme.md, split by the step that needs it.
Each step's own session model is chosen by the Cloud (manifest "model"); these fragments cover the
sub-agents a step spawns and the per-page routing the inventory records. Text before the first
fragment marker is never sent.

<!-- @fragment models-tiers -->
<!-- tbr-canary-f07d4b2c9e61 -->
## Sub-agent models (cost control) — MANDATORY

Sub-agents must NOT inherit this session's model by default. Every sub-agent is spawned with the `Agent` tool's `model` parameter set explicitly to the cheapest tier that can do its job. Omitting `model` makes the sub-agent inherit the session's model and burns the usage limit — that is the failure this policy prevents.

Available tiers (pass the alias, not the full id):

| Alias | Model | Use for |
|---|---|---|
| `opus` | Opus 4.8 (`claude-opus-4-8`) | Hardest creative/judgment work only |
| `sonnet` | Sonnet 5 (`claude-sonnet-5`) | Moderate reasoning, simple code-gen, vision checks |
| `haiku` | Haiku 4.5 (`claude-haiku-4-5`) | Mechanical/deterministic: HTTP calls, string/schema diff |

<!-- @fragment models-store-agents -->
For this step: store setup agents A / B / C / D → `model: "haiku"` (pure REST + GraphQL calls), e.g. `Agent(subagent_type: "general-purpose", model: "haiku", …)`.

<!-- @fragment models-verify-agents -->
For this step:

| Agent | `model` | Rationale |
|---|---|---|
| Specialists 1, 2, 2b, 6 (Link, Content, Completeness, Editability) | `haiku` | Deterministic text/schema diff |
| Specialists 3, 4, 5, 7 (Modal, Animation, Responsiveness, Visual) | `sonnet` | Need vision / timing judgment |
| Fixer | `opus` | Rewrites Liquid/CSS/JS from 7 reports |

If a `haiku` specialist returns an ambiguous/low-confidence verdict, re-run just that one check at `sonnet` — do not blanket-upgrade the tier.

<!-- @fragment models-page-routing -->
## Page routing rule (the biggest single spend)

Each page is built in its own session, on the tier you record here. Decide each page's tier from what you found:

- **complex** → `"model": "opus"` if the page has any of: >4 top-level sections, a modal, a quiz/multi-step form, a view toggle/tabs/calendar/carousel, or non-trivial custom animation logic.
- **simple** → `"model": "sonnet"` otherwise.

Record the chosen tier next to each page in `qa/state/inventory.json` (`"complexity": "complex"|"simple"`, `"model": "opus"|"sonnet"`) so the assignment is auditable and reused verbatim by any later fixer for that page.
