-- Per-project deploy target memory: remember the last theme each project deployed to
-- so the UI can preselect it (and show "last deployed") on the next deploy.
--
-- Additive, same style as 003 — no rewrite of earlier migrations. Columns are set by the
-- deploy flow on SUCCESS only; NULL means the project has never deployed successfully.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_theme_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_deployed_at TIMESTAMPTZ;
