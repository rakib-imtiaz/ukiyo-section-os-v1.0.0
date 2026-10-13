# Section comparison — iteration 1

React (truth): http://127.0.0.1:59290
Shopify (clone): http://127.0.0.1:59291

> Scoring note: the text subscore blends per-section text similarity with DOM structure:
> pairScore = 0.8 x textScore + 0.2 x (structureMatch ? 1 : 0). The per-section `textScore`
> column below stays pure text similarity; `structureMatch` shows the structure signal.

**Section presence: 83.3%** (5/6) · **Text match: 92.7%**

| Route | Status | Sections (R) | Matched | Missing | Extra | Text |
|---|---|---|---|---|---|---|
| / | ok | 4 | 3 | 1 | 0 | 85% |
| /about | ok | 2 | 2 | 0 | 0 | 100% |

## Issues (2)

- **[text_drift]** `/` "Wild & Sacred botanical rituals" text drifts from React (54% match)
  React strings missing/different on Shopify:
  > Wild & Sacred botanical rituals Handcrafted botanical rituals for modern life.
  > Small batch blends made in Oregon.
  > Every jar is poured by hand and sealed with beeswax.
- **[missing_section]** `/` Missing section: "Loved by many" (band 3 of 4)
  React band at y=692 (321px, 0 media, 1 links). Excerpt: Loved by many Customers love the calming evening rituals. Five stars across two thousand verified reviews, with the sleep blend the most reordered tea of the year. Read all reviews

Screenshots: `qa/screenshots/factory/1/<route>/{react,shopify}-{desktop,mobile}.png`
