export type JobStatus =
  | 'draft' | 'queued' | 'scaffolding' | 'cloning' | 'qa_running' | 'fixing'
  | 'converged' | 'exhausted' | 'blocked' | 'aborted' | 'failed' | 'paused' | 'canceled' | 'checked';

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

/** How the wizard collects the Shopify app's Client ID + Secret. 'managed' drives ThemeBot's
 *  own built-in browser (easy mode); the others are the expert wizard's options. */
export type CollectionMethod = 'llm' | 'managed' | 'scripted' | 'bookmarklet' | 'partnerapi' | 'manual';

// ---------- Easy mode ("do it for me") ----------

/** Result of GET /api/factory/shopify-login — is the built-in browser signed in to Shopify? */
export interface LoginStatus { signedIn: boolean; checkedAt: number; url: string | null; detail: string; browserAvailable: boolean }

export type Framework = 'next' | 'vite' | 'cra' | 'remix' | 'gatsby' | 'astro' | 'unknown';
export interface ProjectInfo { root: string; name: string | null; framework: Framework; devScript: string | null; pages: string[]; hasNodeModules: boolean }
export interface UploadResult { intakeId: string; reactFilesPath: string; info: ProjectInfo }

export type PreviewPhase = 'queued' | 'installing' | 'starting' | 'capturing' | 'done' | 'failed' | 'stopped';
export type ActivityKind = 'step' | 'cmd' | 'net' | 'out' | 'ok' | 'err' | 'info';
export interface ActivityEvent { at: number; kind: ActivityKind; text: string }
export type PreviewStageId = 'prepare' | 'install' | 'start' | 'check' | 'capture';
export interface PreviewStage { id: PreviewStageId; label: string; state: 'pending' | 'active' | 'done' | 'failed' | 'skipped'; startedAt: number | null; endedAt: number | null }
export interface PreviewRun { id: string; phase: PreviewPhase; source: { path?: string; url?: string }; keepAlive: boolean; url: string | null; log: string[]; events?: ActivityEvent[]; stages?: PreviewStage[]; error: string | null; elapsedSec: number; hasScreenshot: boolean }

export type EasyStepId = 'signin' | 'store' | 'app' | 'keys' | 'test' | 'site' | 'clone';
export type EasyStepState = 'pending' | 'active' | 'done' | 'failed' | 'skipped';
export interface EasyStep { id: EasyStepId; label: string; state: EasyStepState; detail: string | null }
export interface EasyRun {
  id: string; phase: 'running' | 'needs_login' | 'done' | 'failed' | 'canceled';
  storeName: string; siteUrl: string | null; reactFilesPath: string | null; intakeId: string | null;
  shop: string | null; jobId: string | null; error: string | null; liveSiteId: string | null;
  steps: EasyStep[]; startedAt: number; updatedAt: number;
  /** 'scripted' = ThemeBot's own browser window (default); 'llm' = the AI bot in your Chrome. */
  method?: 'scripted' | 'llm';
}
/** Read-only check: which Shopify login the ThemeBot window uses, and does it list this store? */
export interface StoreAccess { shop: string; access: 'yes' | 'no' | 'signed-out' | 'unknown'; account: string | null; storeName: string | null; reason?: 'window-open' | 'busy' | 'launch-failed' | 'timeout'; checkedAt: number }
export interface EasyStatus { run: EasyRun | null; collector: { running: boolean; log: Array<{ at: number; text: string; kind?: 'thought' | 'action' | 'system' }> } }

/** Friendly framework label for the confirmation screen. */
export const FRAMEWORK_LABEL: Record<Framework, string> = {
  next: 'Next.js', vite: 'Vite + React', cra: 'Create React App', remix: 'Remix', gatsby: 'Gatsby', astro: 'Astro', unknown: 'a JavaScript project',
};

export interface FactorySettings {
  cloneModel: BotModel; collectorModel: BotModel;
  concurrency: number; launchStaggerSec: number; inactivityTimeoutMin: number; cloneTimeoutMin: number;
  fixTimeoutMin: number; qaTimeoutMin: number; defaultMaxIterations: number; defaultScoreThreshold: number;
  scoreWeights: { presence: number; text: number; interaction: number };
  noProgressEpsilon: number; earlyStopOnNoProgress: boolean; pauseQueueOnUsageLimit: boolean;
  keepIterations: number; secretScrub: boolean; extraAllow: string[];
  /** One-time "check in my Chrome" setup (Chrome + Claude extension + sign-ins) confirmed by the user. */
  browserQaSetup: { done: boolean; doneAt: string | null };
}

/** How ThemeBot checks its work. */
export type QaEngine = 'playwright' | 'headed' | 'chrome';

export interface SchedulerStatus { running: string[]; queuePaused: boolean; queuePausedReason: string | null; }

export interface SettingsResponse {
  settings: FactorySettings;
  locked: Record<string, boolean>;
  scheduler?: SchedulerStatus;
  paths?: { workspaceRoot: string; claudePath: string; playwrightRoot: string };
}

export const STATUS_META: Record<JobStatus, { label: string; tone: 'info' | 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  draft: { label: 'Draft', tone: 'secondary' },
  queued: { label: 'Waiting to start', tone: 'secondary' },
  scaffolding: { label: 'Preparing', tone: 'info' },
  cloning: { label: 'Building', tone: 'info' },
  qa_running: { label: 'Checking', tone: 'info' },
  fixing: { label: 'Fixing differences', tone: 'info' },
  converged: { label: 'Done', tone: 'success' },
  exhausted: { label: 'Needs a look', tone: 'warning' },
  blocked: { label: 'Paused, needs you', tone: 'warning' },
  aborted: { label: 'Stopped', tone: 'destructive' },
  failed: { label: 'Failed', tone: 'destructive' },
  paused: { label: 'Paused by you', tone: 'secondary' },
  canceled: { label: 'Cancelled', tone: 'secondary' },
  checked: { label: 'Checked', tone: 'info' },
};


/** Turn scheduler/runner wording into a sentence a store owner understands. */
export function plainDetail(detail: string | null | undefined): string {
  if (!detail) return '';
  return detail
    .replace(/CLI stalled:\s*no CLI activity for (\d+)m/i, 'Paused: nothing happened for $1 minutes')
    .replace(/no CLI activity for (\d+)m/i, 'nothing happened for $1 minutes')
    .replace(/Headless \/clone-theme run in progress/i, 'Building the theme…')
    .replace(/Waiting for a free slot/i, 'Waiting for its turn to start')
    // The button for a paused/interrupted build says Resume, not Retry.
    .replace(/Interrupted by server (restart|shutdown) — press Retry to resume/i, 'Paused because ThemeBot restarted')
    .replace(/Paused by user — press Retry to resume/i, 'Paused by you')
    .replace(/\bCLI\b/g, 'build session')
    .replace(/\bQA\b/g, 'checking');
}

/** Status of one round, in plain words. */
export function plainRoundStatus(status: string): string {
  const map: Record<string, string> = {
    running: 'in progress', interrupted: 'stopped part-way (paused or ThemeBot restarted)', killed: 'stopped (paused)', succeeded: 'done', failed: 'failed', timed_out: 'stopped — nothing happened for too long',
    aborted: 'stopped', canceled: 'cancelled', regressed: 'got worse than the round before', blocked: 'paused, needs you',
  };
  return map[status] ?? status.replace(/_/g, ' ');
}

/** Developer mode (Connections page) reveals terminal/browser/log tools. */
export const isDeveloperMode = () => { try { return localStorage.getItem('themebot-developer-mode') === '1'; } catch { return false; } };

/** Live code: theme files the build changed (see GET /jobs/:id/code). */
export interface LiveCodeFile { path: string; mtime: number; size: number; content: string; truncated: boolean }
export interface LiveCodeResponse { files: LiveCodeFile[]; recent: Array<{ path: string; mtime: number; size: number }>; total: number; now: number }

/** Build progress (GET /jobs/:id/progress): the plan against what exists on disk. */
export interface BuildProgress {
  step: { n: string; label: string } | null;
  planned: boolean;
  pages: Array<{ route: string; name: string; planned: number; built: number; hasTemplate: boolean }>;
  totals: { pagesPlanned: number; pagesStarted: number; pagesDone: number; sectionsPlanned: number; sectionsBuilt: number; changedThisRun: number };
  files: Record<string, number>;
  startedAt: number; elapsedMs: number; etaMs: number | null;
}
