-- Best-iteration memory: the convergence loop records which QA iteration scored highest
-- (`best_iteration`) and what that score was (`best_score`) so the UI and post-run tooling
-- can point at the best snapshot even when a later fix session regresses the score.
--
-- Additive, same style as 003/004 — no rewrite of earlier migrations. Written by the
-- convergence loop as scores arrive; NULL means no scored QA iteration has completed yet.

ALTER TABLE factory_jobs ADD COLUMN IF NOT EXISTS best_iteration INTEGER;
ALTER TABLE factory_jobs ADD COLUMN IF NOT EXISTS best_score DOUBLE PRECISION;
