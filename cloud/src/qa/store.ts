// What the Cloud remembers about QA rounds: one row per (account, build, iteration) with the score
// and the issue keys. It backs the "fixed since last iteration" delta when a client does not send
// the previous round's issues, and gives the operator a per-account record of scored rounds.
// No page content is stored. Rows are kept 90 days.
import type { CloudDb } from '../db';

const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
/**
 * Storage bounds. Without them one account could store ~8 MB of issue keys per call under any
 * number of made-up buildRef/iter pairs (900 calls an hour) and fill the disk. A real round has a
 * few hundred keys of ~100 bytes; past the byte cap the rest of the keys are not remembered (the
 * "fixed since last iteration" list may then miss a few — the client's own prevIssues win anyway).
 */
export const MAX_STORED_KEY_BYTES = 256 * 1024;
export const MAX_ROUNDS_PER_ACCOUNT = 2000;

/** Creates the QA table if it is missing. Idempotent — safe to call on every start. */
export function ensureQaSchema(db: CloudDb) {
  db.sql.exec(`
    CREATE TABLE IF NOT EXISTS qa_rounds (
      account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      build_ref TEXT NOT NULL,
      iter INTEGER NOT NULL,
      device_id TEXT,
      score REAL NOT NULL,
      subscores TEXT NOT NULL,
      issue_keys TEXT NOT NULL,
      issue_count INTEGER NOT NULL,
      capture_failed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, build_ref, iter)
    );
    CREATE INDEX IF NOT EXISTS qa_rounds_created ON qa_rounds (created_at);
  `);
}

export interface QaRound {
  accountId: string;
  deviceId: string | null;
  buildRef: string;
  iter: number;
  score: number;
  subscores: Record<string, number | null>;
  issueKeys: string[];
  captureFailed: boolean;
}

let lastPrune = 0;

/** Unique keys, in order, up to MAX_STORED_KEY_BYTES of JSON. */
function keysToStore(keys: string[]): string[] {
  const kept: string[] = [];
  let bytes = 2;
  for (const key of new Set(keys)) {
    bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
    if (bytes > MAX_STORED_KEY_BYTES) break;
    kept.push(key);
  }
  return kept;
}

export function saveRound(db: CloudDb, round: QaRound, now: number) {
  db.transaction(() => {
    db.sql.prepare(`
      INSERT INTO qa_rounds (account_id, build_ref, iter, device_id, score, subscores, issue_keys, issue_count, capture_failed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, build_ref, iter) DO UPDATE SET
        device_id = excluded.device_id, score = excluded.score, subscores = excluded.subscores, issue_keys = excluded.issue_keys,
        issue_count = excluded.issue_count, capture_failed = excluded.capture_failed, created_at = excluded.created_at
    `).run(round.accountId, round.buildRef, round.iter, round.deviceId, round.score, JSON.stringify(round.subscores), JSON.stringify(keysToStore(round.issueKeys)), round.issueKeys.length, round.captureFailed ? 1 : 0, now);
    // Oldest rounds beyond the per-account cap go first.
    db.sql.prepare(`
      DELETE FROM qa_rounds WHERE account_id = ? AND rowid IN (
        SELECT rowid FROM qa_rounds WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
      )
    `).run(round.accountId, round.accountId, MAX_ROUNDS_PER_ACCOUNT);
  });
  if (now - lastPrune > PRUNE_EVERY_MS) { lastPrune = now; pruneQaRounds(db, now); }
}

/** Issue keys of the round before `iter` for this build, or null when unknown / not measured. */
export function previousRoundKeys(db: CloudDb, accountId: string, buildRef: string, iter: number): string[] | null {
  const row = db.sql.prepare('SELECT issue_keys, capture_failed FROM qa_rounds WHERE account_id = ? AND build_ref = ? AND iter = ?')
    .get(accountId, buildRef, iter - 1) as { issue_keys: string; capture_failed: number } | undefined;
  if (!row || row.capture_failed) return null;
  try {
    const keys = JSON.parse(row.issue_keys) as unknown;
    return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : null;
  } catch { return null; }
}

export function pruneQaRounds(db: CloudDb, now: number) {
  db.sql.prepare('DELETE FROM qa_rounds WHERE created_at < ?').run(now - KEEP_MS);
}
