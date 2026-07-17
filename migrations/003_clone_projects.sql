-- Clone-projects: factory clones become first-class rows in `projects` so the
-- library/Projects UI indexes cloned stores alongside hand-built sections.
--
-- Design notes (additive, no rewrite of 001/002):
--   * `kind` discriminates 'section' (default, existing rows) from 'clone'.
--   * `factory_job_id` links a clone-project to its factory_jobs row. ON DELETE CASCADE:
--     deleting a factory job removes its mirror project (no undeletable orphans — the
--     section-CRUD delete endpoint is shop-scoped and cannot reach shopless clones).
--   * `clone_meta` carries the badge-friendly clone payload (react_url, store_url,
--     status, status_detail, last_score). Never contains ciphers/secrets.
--   * shop scoping relaxed: a clone job may have NO connected OAuth shop, so shop_id
--     becomes nullable. Clone-projects use shop_id = NULL (a "local" scope sentinel).
--     Existing UNIQUE(shop_id, handle) treats NULLs as distinct, so clone handles are
--     deduped instead by the partial unique index on factory_job_id (upsert target).

ALTER TABLE projects ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'section';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS factory_job_id TEXT REFERENCES factory_jobs(id) ON DELETE CASCADE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS clone_meta JSONB;
ALTER TABLE projects ALTER COLUMN shop_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_factory_job ON projects(factory_job_id) WHERE factory_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_kind ON projects(kind, updated_at DESC);
