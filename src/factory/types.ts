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

export interface FactorySettings {
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
