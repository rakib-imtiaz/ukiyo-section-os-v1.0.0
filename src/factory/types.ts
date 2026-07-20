export type JobStatus =
  | 'draft' | 'queued' | 'scaffolding' | 'cloning' | 'qa_running' | 'fixing'
  | 'converged' | 'exhausted' | 'blocked' | 'aborted' | 'failed' | 'paused' | 'canceled';

export const TERMINAL: JobStatus[] = ['converged', 'exhausted', 'aborted', 'failed', 'canceled'];

export interface Job {
  id: string; name: string; slug: string; workspace_path: string; react_url: string; store_url: string;
  prefix: string; dev_theme_name: string; autoswap: boolean; auto_qa: boolean; qa_mode: string;
  status: JobStatus; status_detail: string | null; iteration: number; max_iterations: number;
  score_threshold: number; last_score: number | null; score_history: Array<{ iter: number; score: number; at: string }>;
  error: string | null; created_at: string; updated_at: string; started_at: string | null; finished_at: string | null;
  running: boolean;
}

export interface Iteration {
  id: string; job_id: string; iteration: number; kind: 'clone' | 'qa' | 'fix'; status: string;
  score: number | null; breakdown: Record<string, unknown> | null; report_path: string | null; log_path: string | null;
  started_at: string; finished_at: string | null;
}

/** Per-iteration QA subscores — ride inside Iteration.breakdown.subscores since wave 3. */
export interface QaSubscores { presence: number | null; text: number | null; interaction: number | null }

/** One defect from the deterministic QA reports (sections-<iter>.json / interactions-<iter>.json). */
export interface QaIssue { id: string; kind: string; page: string; title: string; detail?: string }

/** Shape of qa/reports/factory/sections-<iter>.json (issues are all scoring). */
export interface SectionsReport { presence?: number; text?: number; issues?: QaIssue[]; pages?: unknown[] }
/** Shape of qa/reports/factory/interactions-<iter>.json (issues scoring, informational separate). */
export interface InteractionsReport { interaction?: number; issues?: QaIssue[]; informational?: QaIssue[]; pages?: unknown[] }

export interface QaSelftestResult { ok: boolean; score: number | null; subscores: QaSubscores | null; log: string; error?: string }

/** A saved store (006): secrets are encrypted server-side and never echoed — this is the
 *  public, safe-to-render shape returned by GET /api/factory/stores. */
export interface FactoryStore {
  id: string; label: string; shop_domain: string; client_id: string;
  has_storefront_password: boolean; created_at: string; updated_at: string;
}

export interface CredCheckResult {
  ok: boolean; detail?: string; shopName?: string | null;
  scopes?: { required: Array<{ scope: string; granted: boolean }>; recommended: Array<{ scope: string; granted: boolean }> };
  /** Present only when the canary write-test was explicitly requested. */
  push?: { ok: boolean; detail: string };
}

const ISSUE_KIND_META: Record<string, { label: string; tone: 'destructive' | 'warning' | 'secondary' | 'info' }> = {
  missing_page: { label: 'Missing page', tone: 'destructive' },
  missing_section: { label: 'Missing section', tone: 'destructive' },
  text_drift: { label: 'Text drift', tone: 'warning' },
  extra_section: { label: 'Extra section', tone: 'secondary' },
  missing_interaction: { label: 'Missing interaction', tone: 'destructive' },
  interaction_target: { label: 'Wrong target', tone: 'warning' },
  interaction_noop: { label: 'Dead control', tone: 'warning' },
  extra_interaction: { label: 'Extra interaction', tone: 'secondary' },
  coverage_gap: { label: 'Coverage gap', tone: 'secondary' },
  catalog_unseeded: { label: 'Catalog unseeded', tone: 'warning' },
};

/** Badge label/tone for a QA issue kind; unknown kinds degrade to a readable info badge. */
export function issueKindMeta(kind: string): { label: string; tone: 'destructive' | 'warning' | 'secondary' | 'info' } {
  return ISSUE_KIND_META[kind] ?? { label: kind.replace(/_/g, ' '), tone: 'info' };
}

export type BotModel = 'opus' | 'sonnet' | 'haiku';

/** How the wizard collects the Shopify app's Client ID + Secret. */
export type CollectionMethod = 'llm' | 'scripted' | 'bookmarklet' | 'partnerapi' | 'manual';

export interface FactorySettings {
  cloneModel: BotModel; collectorModel: BotModel;
  concurrency: number; launchStaggerSec: number; inactivityTimeoutMin: number; cloneTimeoutMin: number;
  fixTimeoutMin: number; qaTimeoutMin: number; defaultMaxIterations: number; defaultScoreThreshold: number;
  scoreWeights: { presence: number; text: number; interaction: number };
  noProgressEpsilon: number; earlyStopOnNoProgress: boolean; pauseQueueOnUsageLimit: boolean;
  keepIterations: number; secretScrub: boolean; extraAllow: string[];
}

export interface SchedulerStatus { running: string[]; queuePaused: boolean; queuePausedReason: string | null; }

export interface SettingsResponse {
  settings: FactorySettings;
  locked: Record<string, boolean>;
  scheduler?: SchedulerStatus;
  paths?: { workspaceRoot: string; claudePath: string; playwrightRoot: string };
}

export const STATUS_META: Record<JobStatus, { label: string; tone: 'info' | 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  draft: { label: 'Draft', tone: 'secondary' },
  queued: { label: 'Queued', tone: 'secondary' },
  scaffolding: { label: 'Scaffolding', tone: 'info' },
  cloning: { label: 'Cloning', tone: 'info' },
  qa_running: { label: 'QA running', tone: 'info' },
  fixing: { label: 'Fixing', tone: 'info' },
  converged: { label: 'Converged', tone: 'success' },
  exhausted: { label: 'Needs review', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'warning' },
  aborted: { label: 'Aborted', tone: 'destructive' },
  failed: { label: 'Failed', tone: 'destructive' },
  paused: { label: 'Paused', tone: 'secondary' },
  canceled: { label: 'Canceled', tone: 'secondary' },
};
