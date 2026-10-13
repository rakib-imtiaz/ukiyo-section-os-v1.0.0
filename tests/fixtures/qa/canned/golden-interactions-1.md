# Interaction verification — iteration 1

React (truth): http://127.0.0.1:59290
Shopify (clone): http://127.0.0.1:59291

> Scoring note: parity = tested-equivalent / tested-total. Commerce/destructive controls
> (add-to-cart, buy, checkout, subscribe, form submits) are never clicked — they are verified
> statically ("Static" column) and count as tested. Elements beyond the click budget are
> untested and EXCLUDED from the score (reported as coverage_gap).

**Interaction parity: 78.6%** (11/14 tested elements behave the same)

| Route | Elements (R) | Tested | Same | Static | Missing | Different | Clicked | Untested |
|---|---|---|---|---|---|---|---|---|
| / | 9 | 9 | 6 | 1 | 1 | 2 | 2 | 0 |
| /about | 5 | 5 | 5 | 0 | 0 | 0 | 1 | 0 |

## Behavioral differences (3)

- **[missing_interaction]** `/` Missing on Shopify: a "Read all reviews" (main)
  React link -> https://example.com/reviews
- **[interaction_noop]** `/` "Open gallery" behaves differently
  React: opens overlay/modal · Shopify: no visible effect
- **[interaction_target]** `/` Link "About us" points to the wrong place
  React -> /about · Shopify -> /pages/contact (expected /pages/about)
