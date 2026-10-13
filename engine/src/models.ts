// THE model + price table for ThemeBot Engine. Every model id, price and per-model API setting the
// engine uses lives here and nowhere else.
//
// Verified 2026-10-14 against the claude-api skill (models catalog cached 2026-10-06):
//   claude-opus-5-5            $4 / $20 per MTok, cache read $0.20, 5-min cache write $5, 1-hour $8.
//                              1M context, 128K output. Thinking is always on (adaptive); effort is the
//                              control, and its API default is `medium`, so it is always sent.
//   claude-sonnet-5-5          $2 / $10, cache read $0.20, writes $2.50 / $4. 1M context, 128K output.
//   claude-haiku-4-5-20251001  $1 / $5, cache read $0.10, writes $1.25 / $2. 200K context, 64K output.
//                              The dated full id of Claude Haiku 4.5 (alias claude-haiku-4-5). No
//                              adaptive thinking and no `effort` parameter (both 400), so neither is sent.
//                              Prompts under 4096 tokens are not cached on it.
// Fallback targets (prices only — the server picks them under `fallbacks: "default"` when a request
// is declined by a safety classifier; those attempts bill at the fallback model's own rates):
//   claude-opus-5 and claude-opus-4-8 $5 / $25, cache read $0.50, writes $6.25 / $10;
//   claude-sonnet-5 $2 / $10, cache read $0.20, writes $2.50 / $4.
//
// Tier aliases are what the recipe and the runner pass (`--model opus|sonnet|haiku`, and the Agent
// tool's `model` field). Re-check this file against the skill whenever a model id changes.

export type Tier = 'opus' | 'sonnet' | 'haiku';
export const TIERS: readonly Tier[] = ['opus', 'sonnet', 'haiku'];
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** USD per million tokens. */
export interface Rates { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }

export interface ModelSpec {
  tier: Tier | null;
  id: string;
  name: string;
  rates: Rates;
  contextWindow: number;
  maxOutput: number;
  /** max_tokens the engine asks for per request (the budget can lower it). */
  requestMaxTokens: number;
  /** 'adaptive' = send thinking {type:'adaptive'}; 'off' = send no thinking field (Haiku 4.5: none). */
  thinking: 'adaptive' | 'off';
  /** output_config.effort to send; null = the model takes no effort parameter. */
  effort: Effort | null;
  /** Server-side refusal fallback (beta). 'default' = Anthropic picks the fallback by refusal category. */
  fallbacks: 'default' | null;
  /** thinking.display "updates": short progress notes between tool calls (beta). */
  progressUpdates: boolean;
  /** Server-side compaction once the context passes compactionTrigger input tokens (beta). */
  compaction: boolean;
  compactionTrigger: number;
  /** Prompts shorter than this are silently not cached. */
  minCacheTokens: number;
}

export const MODELS: Record<Tier, ModelSpec> = {
  opus: {
    tier: 'opus', id: 'claude-opus-5-5', name: 'Claude Opus 5.5',
    rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
    contextWindow: 1_000_000, maxOutput: 128_000, requestMaxTokens: 64_000,
    // Opus is the tier for the hardest judgment work (complex pages, the fixer); the skill's floor for
    // intelligence-sensitive work is `high`. Tune with THEMEBOT_ENGINE_EFFORT_OPUS.
    thinking: 'adaptive', effort: 'high',
    fallbacks: 'default', progressUpdates: true, compaction: true, compactionTrigger: 150_000, minCacheTokens: 512,
  },
  sonnet: {
    tier: 'sonnet', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5',
    rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    contextWindow: 1_000_000, maxOutput: 128_000, requestMaxTokens: 64_000,
    // `medium` is the documented starting point for agentic coding and multistep tool use on Sonnet 5.5.
    thinking: 'adaptive', effort: 'medium',
    fallbacks: 'default', progressUpdates: true, compaction: true, compactionTrigger: 150_000, minCacheTokens: 512,
  },
  haiku: {
    tier: 'haiku', id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5',
    rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
    contextWindow: 200_000, maxOutput: 64_000, requestMaxTokens: 32_000,
    thinking: 'off', effort: null,
    fallbacks: null, progressUpdates: false, compaction: false, compactionTrigger: 150_000, minCacheTokens: 4096,
  },
};

/** Models the engine never asks for but can be billed for (refusal fallbacks). */
const BILLED_ONLY: Record<string, Rates> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
};

/** Where a declined request can be re-run under `fallbacks: "default"` (for worst-case budgeting). */
export const FALLBACK_TARGETS: Record<Tier, string[]> = {
  opus: ['claude-opus-5', 'claude-opus-4-8'],
  sonnet: ['claude-sonnet-5'],
  haiku: [],
};

/** A model this table does not know is billed at the highest rates in it — never under-counted. */
const UNKNOWN_RATES: Rates = (() => {
  const all = [...Object.values(MODELS).map((model) => model.rates), ...Object.values(BILLED_ONLY)];
  const max = (key: keyof Rates) => Math.max(...all.map((rates) => rates[key]));
  return { input: max('input'), output: max('output'), cacheRead: max('cacheRead'), cacheWrite5m: max('cacheWrite5m'), cacheWrite1h: max('cacheWrite1h') };
})();

export const BETAS = {
  fallbacks: 'server-side-fallback-2026-07-01',
  progressUpdates: 'thinking-display-updates-2026-08-18',
  compaction: 'compact-2026-01-12',
} as const;

/** Rates for a model id the API reports (exact id or a dated variant of a known one). */
export function ratesFor(modelId: string): { rates: Rates; known: boolean } {
  const id = modelId.trim().toLowerCase();
  for (const spec of Object.values(MODELS)) if (id === spec.id) return { rates: spec.rates, known: true };
  if (BILLED_ONLY[id]) return { rates: BILLED_ONLY[id], known: true };
  // Dated snapshots of a known id (e.g. claude-opus-5-20260101) — longest known prefix wins.
  const known = [...Object.values(MODELS).map((spec) => [spec.id, spec.rates] as const), ...Object.entries(BILLED_ONLY)]
    .filter(([prefix]) => id.startsWith(`${prefix}-`)).sort((a, b) => b[0].length - a[0].length)[0];
  return known ? { rates: known[1], known: true } : { rates: UNKNOWN_RATES, known: false };
}

/** The highest rate of each kind this tier's request can be billed at (itself or a fallback target). */
export function worstCaseRates(spec: ModelSpec): Rates {
  const targets = spec.fallbacks && spec.tier ? FALLBACK_TARGETS[spec.tier].map((id) => ratesFor(id).rates) : [];
  const all = [spec.rates, ...targets];
  const max = (key: keyof Rates) => Math.max(...all.map((rates) => rates[key]));
  return { input: max('input'), output: max('output'), cacheRead: max('cacheRead'), cacheWrite5m: max('cacheWrite5m'), cacheWrite1h: max('cacheWrite1h') };
}

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/** A tier alias or one of our full ids → its tier. */
export function tierOf(value: unknown): Tier | null {
  if (isTier(value)) return value;
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return TIERS.find((tier) => MODELS[tier].id === id) ?? null;
}

const RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 };
/** The lower of two tiers (a sub-agent never runs above the session's tier — we pay for it). */
export function capTier(wanted: Tier, ceiling: Tier): Tier {
  return RANK[wanted] <= RANK[ceiling] ? wanted : ceiling;
}

/**
 * The spec a session or sub-agent runs with, after operator overrides:
 *   THEMEBOT_ENGINE_EFFORT_<TIER>=low|medium|high|xhigh|max   per-tier effort (models that take one)
 *   THEMEBOT_ENGINE_BETAS=off                                 no fallbacks, progress notes or compaction
 */
export function resolveModel(tier: Tier, env: NodeJS.ProcessEnv = process.env): ModelSpec {
  const base = MODELS[tier];
  const spec: ModelSpec = { ...base, rates: { ...base.rates } };
  const effort = env[`THEMEBOT_ENGINE_EFFORT_${tier.toUpperCase()}`]?.trim().toLowerCase();
  if (spec.effort && effort && (EFFORTS as readonly string[]).includes(effort)) spec.effort = effort as Effort;
  if (env.THEMEBOT_ENGINE_BETAS?.trim().toLowerCase() === 'off') {
    spec.fallbacks = null; spec.progressUpdates = false; spec.compaction = false;
  }
  return spec;
}
