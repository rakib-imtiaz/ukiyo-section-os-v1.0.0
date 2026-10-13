export type FactoryJobStatus =
  | 'draft' | 'queued' | 'scaffolding' | 'cloning' | 'qa_running' | 'fixing'
  | 'converged' | 'exhausted' | 'blocked' | 'aborted' | 'failed' | 'paused' | 'canceled'
  // After a check (or fix rounds) the user started by hand: resting, with a fresh match score.
  | 'checked';

export const TERMINAL_STATUSES: FactoryJobStatus[] = ['converged', 'exhausted', 'aborted', 'failed', 'canceled'];
export const ACTIVE_STATUSES: FactoryJobStatus[] = ['scaffolding', 'cloning', 'qa_running', 'fixing'];

export type IterationKind = 'clone' | 'qa' | 'fix';
export type IterationStatus = 'running' | 'succeeded' | 'failed' | 'timed_out' | 'killed' | 'regressed';

// 'budget': a ThemeBot Engine session stopped at the build's budget cap (never from Claude Code).
export type RunOutcome = 'final' | 'blocked' | 'aborted' | 'sentinel' | 'exit' | 'timeout' | 'inactivity' | 'killed' | 'usage_limit' | 'spawn_error' | 'budget';

export interface RunResult {
  outcome: RunOutcome;
  exitCode: number | null;
  signalFile?: string;
  detail?: string;
}

export interface JobIntake {
  name: string;
  reactUrl: string;
  storeUrl: string;
  clientId: string;
  clientSecret: string;
  /** When set, credentials are pulled from this saved store server-side (secret never round-trips). */
  savedStoreId?: string;
  storefrontPassword?: string;
  reactFilesPath?: string;
  prefix?: string;
  devThemeName?: string;
  qaEngine?: string;
  autoswap?: boolean;
  autoQa?: boolean;
  qaMode?: 'sections' | 'interactions' | 'both';
  maxIterations?: number;
  scoreThreshold?: number;
}

// Global factory settings persisted in app_settings under 'factory_settings'.
/** Claude CLI model aliases the bots can run on. */
export type BotModel = 'opus' | 'sonnet' | 'haiku';
export const BOT_MODELS: readonly BotModel[] = ['opus', 'sonnet', 'haiku'];

/** How the wizard collects the Shopify app's Client ID + Secret. */
/** 'managed' = a Claude agent drives ThemeBot's own built-in browser over the local MCP endpoint
 *  (easy mode: the user signs in once in the Browser view, the bot does the rest there). */
export type CollectionMethod = 'llm' | 'managed' | 'scripted' | 'bookmarklet' | 'partnerapi' | 'manual';
export const COLLECTION_METHODS: readonly CollectionMethod[] = ['manual', 'bookmarklet', 'scripted', 'llm', 'managed', 'partnerapi'];

/** What runs build/fix sessions: the Claude Code CLI (default), or ThemeBot Engine (our own agent on
 *  the Claude API, paid with ThemeBot's key — engine/). Opt-in; THEMEBOT_BUILD_ENGINE overrides it. */
export type BuildEngine = 'claude-code' | 'themebot';
export const BUILD_ENGINES: readonly BuildEngine[] = ['claude-code', 'themebot'];

export interface FactorySettings {
  /** Which engine runs the build sessions. */
  buildEngine: BuildEngine;
  /** ThemeBot Engine only: the most one build may spend on the Claude API, in USD (all its sessions). */
  engineBudgetUsd: number;
  /** Model for clone + fix sessions (the heavy theme work). */
  cloneModel: BotModel;
  /** Model for the key-collector Chrome bot. Opus recommended — smaller models tend to refuse the mission. */
  collectorModel: BotModel;
  concurrency: number;
  /** ThemeBot Cloud builds: how many page steps of ONE build run at once (1-4). */
  pageConcurrency: number;
  launchStaggerSec: number;
  inactivityTimeoutMin: number;
  cloneTimeoutMin: number;
  fixTimeoutMin: number;
  qaTimeoutMin: number;
  defaultMaxIterations: number;
  defaultScoreThreshold: number;
  scoreWeights: { presence: number; text: number; interaction: number };
  noProgressEpsilon: number;
  earlyStopOnNoProgress: boolean;
  pauseQueueOnUsageLimit: boolean;
  keepIterations: number;
  secretScrub: boolean;
  extraAllow: string[];
  /** One-time "check in my Chrome" setup (Chrome + Claude extension + sign-ins) confirmed by the user. */
  browserQaSetup: { done: boolean; doneAt: string | null };
}

export const DEFAULT_SCORE_WEIGHTS = { presence: 0.5, text: 0.3, interaction: 0.2 };

export interface QaSubscores { presence: number | null; text: number | null; interaction: number | null; }

export interface QaResult {
  score: number;
  subscores: QaSubscores;
  breakdown: Record<string, unknown>;
  summaryPath: string; // workspace-relative path to qa-summary-<iter>.md
  issueCount: number;
}
