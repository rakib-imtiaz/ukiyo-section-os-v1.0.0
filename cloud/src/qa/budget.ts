// How much CPU a QA request will cost, estimated BEFORE it is scored.
//
// The scorers are quadratic by design (every React section against every Shopify section, every
// React control against every Shopify control), and they must stay exactly as they are (the
// golden tests pin their numbers). The Cloud is one Node process: a crafted 8 MB upload could
// hold the event loop — every customer's heartbeat, build step and sign-in — for minutes. So the
// routes estimate the work first and refuse uploads over a per-request budget (413) and accounts
// over an hourly budget (429).
//
// Units are roughly microseconds of scoring on a typical server core, from benchmarks of the
// prepared comparisons in text.ts (crafted worst cases measured at 1-2x of real time): section
// alignment ~0.2 µs per pair (its DP table) plus ~0.035 µs per token of the smaller side (big
// token sets); control matching ~0.1 µs per pair plus ~0.008 µs per token (names are at most 200
// characters, small sets). Token counts are
// bounded from text length (a token is 2+ characters plus a separator), so the estimate runs high
// for real text and close for crafted text.
import { segmentLayout } from './segment';
import type { CalibrateRequest, InteractionsCaptureRoute, InventoryItem, LayoutDump, SectionsCaptureRoute } from './types';

const SECTION_COST = { pair: 0.2, token: 0.035 };
const NAME_COST = { pair: 0.1, token: 0.008 };

/** Most tokens a text of this length can have. */
const maxTokens = (text: string | null | undefined) => Math.ceil(((text?.length ?? 0) + 1) / 3);

/**
 * Cost of comparing every text of `left` with every text of `right` (and headings, counted as
 * part of the pair constant): per left item, |right| pairs, each costing at most the smaller side.
 */
function crossCost(left: number[], right: number[], unit: { pair: number; token: number }): number {
  if (!left.length || !right.length) return 0;
  const rightTotal = right.reduce((sum, tokens) => sum + tokens, 0);
  let cost = 0;
  for (const tokens of left) cost += right.length * unit.pair + unit.token * Math.min(right.length * tokens, rightTotal);
  return cost;
}

const sectionTokens = (layout: LayoutDump | null | undefined) => segmentLayout(layout).map((section) => maxTokens(section.text));

/** POST /v1/qa/sections: one alignment per route that has both sides. */
export function sectionsWork(routes: SectionsCaptureRoute[]): number {
  let cost = 0;
  for (const route of routes) {
    if (!route.shopifyPath || !route.react?.layout || !route.shopify?.layout) continue;
    cost += crossCost(sectionTokens(route.react.layout), sectionTokens(route.shopify.layout), SECTION_COST);
  }
  return cost;
}

/** POST /v1/qa/calibrate: one alignment (the candidate defaults to the reference). */
export function calibrateWork(request: CalibrateRequest): number {
  const reference = sectionTokens(request.reference.layout);
  return crossCost(reference, request.candidate ? sectionTokens(request.candidate.layout) : reference, SECTION_COST);
}

/**
 * POST /v1/qa/interactions/plan: React controls without a key match are fuzzy-matched against
 * every Shopify control, and Shopify controls without a key match against every React one.
 */
export function interactionsWork(routes: InteractionsCaptureRoute[]): number {
  let cost = 0;
  for (const route of routes) {
    if (!route.shopifyPath) continue;
    const react = (route.react?.items ?? []).filter((item) => item.visible);
    const shopify = (route.shopify?.items ?? []).filter((item) => item.visible);
    if (!react.length || !shopify.length) continue;
    const reactKeys = new Set(react.map((item) => item.key));
    const shopifyKeys = new Set(shopify.map((item) => item.key));
    const tokens = (items: InventoryItem[]) => items.map((item) => maxTokens(item.name));
    cost += crossCost(tokens(react.filter((item) => !shopifyKeys.has(item.key))), tokens(shopify), NAME_COST);
    cost += crossCost(tokens(shopify.filter((item) => !reactKeys.has(item.key))), tokens(react), NAME_COST);
  }
  return cost;
}
