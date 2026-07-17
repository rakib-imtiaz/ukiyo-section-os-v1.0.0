export type FactoryJobStatus =
  | 'draft' | 'queued' | 'scaffolding' | 'cloning' | 'qa_running' | 'fixing'
  | 'converged' | 'exhausted' | 'blocked' | 'aborted' | 'failed' | 'paused' | 'canceled';

export const TERMINAL_STATUSES: FactoryJobStatus[] = ['converged', 'exhausted', 'aborted', 'failed', 'canceled'];
export const ACTIVE_STATUSES: FactoryJobStatus[] = ['scaffolding', 'cloning', 'qa_running', 'fixing'];

export type IterationKind = 'clone' | 'qa' | 'fix';
export type IterationStatus = 'running' | 'succeeded' | 'failed' | 'timed_out' | 'killed' | 'regressed';

export type RunOutcome = 'final' | 'blocked' | 'aborted' | 'sentinel' | 'exit' | 'timeout' | 'inactivity' | 'killed' | 'usage_limit' | 'spawn_error';

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
  storefrontPassword?: string;
  reactFilesPath?: string;
  prefix?: string;
  devThemeName?: string;
  autoswap?: boolean;
  autoQa?: boolean;
  qaMode?: 'sections' | 'interactions' | 'both';
  maxIterations?: number;
  scoreThreshold?: number;
}

// Global factory settings persisted in app_settings under 'factory_settings'.
export interface FactorySettings {
  concurrency: number;
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
