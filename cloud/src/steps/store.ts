// Builds and their step history in the Cloud database (tables: builds, build_steps — migration 2).
import { newId } from '../crypto';
import type { CloudContext } from '../context';
import type { BuildPage, StepRecord } from './plan';

export type BuildStatus = 'running' | 'blocked' | 'aborted' | 'done';

/** Job details the app sends when a build starts; they fill the recipe's placeholders. */
export interface BuildMeta {
  name: string;
  prefix: string;
  storeHost: string;
  reactUrl: string;
  root: string;
  devThemeName: string;
  qaEngine: string;
  /** Routes a Rebuild found already built (their page steps verify instead of rewriting). */
  rebuiltRoutes: string[];
  appVersion: string | null;
}

export interface BuildRow {
  id: string;
  account_id: string;
  device_id: string | null;
  status: BuildStatus;
  detail: string | null;
  created_at: number;
  updated_at: number;
  recipe_version: string | null;
  meta: string | null;
  pages: string | null;
  steps_issued: number;
}

export interface LoadedBuild { row: BuildRow; meta: BuildMeta; pages: BuildPage[] }

/** Outcomes the app reports for a step. 'done' = its signal file appeared. */
export const STEP_OUTCOMES = ['done', 'failed', 'blocked', 'aborted', 'timeout', 'inactivity', 'usage_limit', 'spawn_error', 'killed'] as const;
export type StepOutcome = typeof STEP_OUTCOMES[number];

export function createBuild(ctx: CloudContext, accountId: string, deviceId: string, meta: BuildMeta, recipeVersion: string): BuildRow {
  const now = ctx.now();
  const id = newId('bld');
  ctx.db.sql.prepare('INSERT INTO builds (id, account_id, device_id, status, detail, created_at, updated_at, recipe_version, meta, pages, steps_issued) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 0)')
    .run(id, accountId, deviceId, 'running', now, now, recipeVersion, JSON.stringify(meta));
  return getBuildRow(ctx, id)!;
}

export function getBuildRow(ctx: CloudContext, id: string): BuildRow | null {
  return (ctx.db.sql.prepare('SELECT * FROM builds WHERE id = ?').get(id) as BuildRow | undefined) ?? null;
}

export function loadBuild(row: BuildRow): LoadedBuild {
  let meta: BuildMeta;
  try { meta = JSON.parse(row.meta ?? '{}') as BuildMeta; } catch { meta = {} as BuildMeta; }
  let pages: BuildPage[] = [];
  try { pages = row.pages ? JSON.parse(row.pages) as BuildPage[] : []; } catch { pages = []; }
  return { row, meta: { ...meta, rebuiltRoutes: Array.isArray(meta.rebuiltRoutes) ? meta.rebuiltRoutes : [] }, pages };
}

export function savePages(ctx: CloudContext, buildId: string, pages: BuildPage[]) {
  ctx.db.sql.prepare('UPDATE builds SET pages = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(pages), ctx.now(), buildId);
}

export function setBuildStatus(ctx: CloudContext, buildId: string, status: BuildStatus, detail: string | null) {
  ctx.db.sql.prepare('UPDATE builds SET status = ?, detail = ?, updated_at = ? WHERE id = ?').run(status, detail, ctx.now(), buildId);
}

interface StepRow { id: number; step_id: string; attempt: number; session: string | null; status: string; detail: string | null }

/** Per step id: done?, failures in this session, attempts, last status/detail. */
export function stepRecords(ctx: CloudContext, buildId: string, session: string | null): Map<string, StepRecord> {
  const rows = ctx.db.sql.prepare('SELECT id, step_id, attempt, session, status, detail FROM build_steps WHERE build_id = ? ORDER BY id').all(buildId) as unknown as StepRow[];
  const records = new Map<string, StepRecord>();
  for (const row of rows) {
    const record = records.get(row.step_id) ?? { done: false, failuresThisSession: 0, attempts: 0, lastStatus: null, lastDetail: null };
    if (row.status === 'done') record.done = true;
    if (row.status === 'failed' && session && row.session === session) record.failuresThisSession += 1;
    record.attempts = Math.max(record.attempts, row.attempt);
    record.lastStatus = row.status;
    record.lastDetail = row.detail;
    records.set(row.step_id, record);
  }
  return records;
}

/** Records that a step was handed out; returns its attempt number. Counts toward the build's cap. */
export function recordIssue(ctx: CloudContext, buildId: string, stepId: string, kind: string, session: string | null, deviceId: string): number {
  return ctx.db.transaction(() => {
    const previous = ctx.db.sql.prepare('SELECT MAX(attempt) AS attempt FROM build_steps WHERE build_id = ? AND step_id = ?').get(buildId, stepId) as { attempt: number | null };
    const attempt = (previous.attempt ?? 0) + 1;
    const now = ctx.now();
    ctx.db.sql.prepare('INSERT INTO build_steps (build_id, step_id, kind, attempt, session, device_id, status, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(buildId, stepId, kind, attempt, session, deviceId, 'issued', now);
    ctx.db.sql.prepare("UPDATE builds SET steps_issued = steps_issued + 1, status = CASE WHEN status = 'done' THEN status ELSE 'running' END, updated_at = ? WHERE id = ?").run(now, buildId);
    return attempt;
  });
}

/**
 * Most step rows one build may hold. A real build stays far below (even 200 pages at the issue cap
 * is ~2 500 issues + 120 fix rounds + one late result per step); without a cap, results the Cloud
 * never handed out (accepted on purpose, see recordResult) would let one account write rows
 * without limit — and every /next reads all of a build's rows.
 */
export const MAX_STEP_ROWS_PER_BUILD = 5000;

/**
 * Records how a step ended: closes its newest still-open row, or adds a row when the Cloud never
 * saw it handed out (e.g. a result that arrives after a lost connection, or the steps a recreated
 * build carries over). A repeat of the step's last result changes nothing, and once the build
 * holds MAX_STEP_ROWS_PER_BUILD rows such unmatched results are ignored. Returns whether it
 * recorded anything.
 */
export function recordResult(ctx: CloudContext, buildId: string, stepId: string, kind: string, outcome: StepOutcome, detail: string | null, session: string | null, deviceId: string): boolean {
  const now = ctx.now();
  return ctx.db.transaction(() => {
    const open = ctx.db.sql.prepare("SELECT id FROM build_steps WHERE build_id = ? AND step_id = ? AND status = 'issued' ORDER BY id DESC LIMIT 1").get(buildId, stepId) as { id: number } | undefined;
    if (open) {
      ctx.db.sql.prepare('UPDATE build_steps SET status = ?, detail = ?, finished_at = ?, session = COALESCE(?, session) WHERE id = ?').run(outcome, detail, now, session, open.id);
    } else {
      const last = ctx.db.sql.prepare('SELECT status FROM build_steps WHERE build_id = ? AND step_id = ? ORDER BY id DESC LIMIT 1').get(buildId, stepId) as { status: string } | undefined;
      if (last?.status === outcome) return false;
      const rows = Number((ctx.db.sql.prepare('SELECT COUNT(*) AS n FROM build_steps WHERE build_id = ?').get(buildId) as { n: number }).n);
      if (rows >= MAX_STEP_ROWS_PER_BUILD) return false;
      const previous = ctx.db.sql.prepare('SELECT MAX(attempt) AS attempt FROM build_steps WHERE build_id = ? AND step_id = ?').get(buildId, stepId) as { attempt: number | null };
      ctx.db.sql.prepare('INSERT INTO build_steps (build_id, step_id, kind, attempt, session, device_id, status, detail, issued_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(buildId, stepId, kind, Math.max(1, previous.attempt ?? 0), session, deviceId, outcome, detail, now, now);
    }
    ctx.db.sql.prepare('UPDATE builds SET updated_at = ? WHERE id = ?').run(now, buildId);
    return true;
  });
}

/**
 * Turns a step's "done" into a failed attempt (its required outputs are missing — see
 * plan.ts REQUIRED_OUTPUTS). The rows keep their session, so a done that turns out hollow in the
 * session that reported it counts toward that session's MAX_TRIES. Returns the rows changed.
 */
export function rejectDone(ctx: CloudContext, buildId: string, stepId: string, detail: string): number {
  const now = ctx.now();
  const changed = Number(ctx.db.sql.prepare("UPDATE build_steps SET status = 'failed', detail = ? WHERE build_id = ? AND step_id = ? AND status = 'done'").run(detail, buildId, stepId).changes);
  if (changed) ctx.db.sql.prepare('UPDATE builds SET updated_at = ? WHERE id = ?').run(now, buildId);
  return changed;
}

/** Step history for GET /v1/builds/:id (no prompts are ever stored). */
export function stepHistory(ctx: CloudContext, buildId: string) {
  return ctx.db.sql.prepare('SELECT step_id, kind, attempt, status, detail, issued_at, finished_at FROM build_steps WHERE build_id = ? ORDER BY id').all(buildId) as unknown as Array<{ step_id: string; kind: string; attempt: number; status: string; detail: string | null; issued_at: number; finished_at: number | null }>;
}

export function countFixIssues(ctx: CloudContext, buildId: string): number {
  return Number((ctx.db.sql.prepare("SELECT COUNT(*) AS n FROM build_steps WHERE build_id = ? AND kind = 'fix'").get(buildId) as { n: number }).n);
}
