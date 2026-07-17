-- Clone Factory: parallel autonomous store cloning with self-QA convergence.

CREATE TABLE IF NOT EXISTS factory_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  workspace_path TEXT NOT NULL,
  react_url TEXT NOT NULL,
  store_url TEXT NOT NULL,
  client_id_cipher TEXT NOT NULL,
  client_secret_cipher TEXT NOT NULL,
  storefront_password_cipher TEXT,
  prefix TEXT NOT NULL,
  dev_theme_name TEXT NOT NULL,
  autoswap BOOLEAN NOT NULL DEFAULT FALSE,
  auto_qa BOOLEAN NOT NULL DEFAULT TRUE,
  qa_mode TEXT NOT NULL DEFAULT 'both',
  qa_engine TEXT NOT NULL DEFAULT 'playwright',
  status TEXT NOT NULL DEFAULT 'queued',
  status_detail TEXT,
  iteration INTEGER NOT NULL DEFAULT 0,
  max_iterations INTEGER NOT NULL DEFAULT 5,
  score_threshold REAL NOT NULL DEFAULT 0.92,
  last_score REAL,
  score_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS factory_iterations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES factory_jobs(id) ON DELETE CASCADE,
  iteration INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  score REAL,
  breakdown JSONB,
  report_path TEXT,
  log_path TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_factory_iterations_job ON factory_iterations(job_id, started_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Additive column for existing installs (idempotent).
ALTER TABLE factory_jobs ADD COLUMN IF NOT EXISTS qa_engine TEXT NOT NULL DEFAULT 'playwright';
