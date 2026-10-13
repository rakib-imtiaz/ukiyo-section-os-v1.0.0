// ThemeBot Cloud storage: one SQLite file (node:sqlite, built into Node 24 — no native addon).
//
// Schema changes are append-only migrations tracked with PRAGMA user_version. Every timestamp is
// Unix milliseconds. Modules keep their own queries next to their routes and use `db.sql`
// directly; only the rows several modules share (accounts, devices, settings, audit) have helpers
// here. Tables for later phases (builds, recipe_versions, watermarks) exist already; migration 2
// gives builds their step history (build_steps), used by cloud/src/steps; migration 3 lets refresh
// tokens rotate (cloud/src/tokens.ts).
import { DatabaseSync } from 'node:sqlite';
import { newId } from './crypto';

export type AccountStatus = 'active' | 'inactive';

export interface AccountRow {
  id: string;
  email: string;
  plan: string;
  seats: number;
  status: AccountStatus;
  expires_at: number | null;
  source: string;
  ls_customer_id: string | null;
  ls_subscription_id: string | null;
  ls_order_id: string | null;
  ls_variant_id: string | null;
  ls_status: string | null;
  ls_updated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DeviceRow {
  id: string;
  account_id: string;
  fingerprint_hash: string;
  name: string;
  platform: string;
  app_version: string;
  created_at: number;
  /** Start of the device's current hold on a seat: when seats run short, the oldest holds win. */
  activated_at: number;
  /** Last sign-in or heartbeat. 0 = seat handed back (app closed) while staying signed in. */
  last_seen_at: number;
  /** Set when signed out (by the user or an admin) — the device must sign in again. */
  signed_out_at: number | null;
  passes_issued: number;
}

/**
 * One refresh token (only its hash is stored). Heartbeats from a current app rotate it (see
 * cloud/src/tokens.ts): the presented token is then superseded and points to its successor.
 */
export interface RefreshTokenRow {
  id: string;
  token_hash: string;
  account_id: string;
  device_id: string;
  created_at: number;
  /** Last time the token was presented (heartbeat, release). Null = never used yet. */
  last_used_at: number | null;
  revoked_at: number | null;
  /** The token that replaced this one at a heartbeat (null = still the current token). */
  successor_id: string | null;
  superseded_at: number | null;
  /** Peppered hash of the app's rotation key used when this token was rotated (identifies a retry). */
  rotation_key_hash: string | null;
  /** 'token_reuse' when revoked because a copy of the sign-in was caught (else null). */
  revoked_reason: string | null;
}

/** Days a rotated refresh token is kept after its successor was used (reuse detection looks there). */
export const SUPERSEDED_TOKEN_DAYS = 7;

/** A schema step: SQL, or a function for steps that must look before they change (idempotent). */
type Migration = string | ((sql: DatabaseSync) => void);

const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'standard',
    seats INTEGER NOT NULL DEFAULT 3 CHECK (seats >= 1),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    expires_at INTEGER,
    source TEXT NOT NULL DEFAULT 'admin',
    ls_customer_id TEXT,
    ls_subscription_id TEXT,
    ls_order_id TEXT,
    ls_variant_id TEXT,
    ls_status TEXT,
    ls_updated_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX accounts_ls_subscription ON accounts (ls_subscription_id);

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    fingerprint_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_version TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    activated_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    signed_out_at INTEGER,
    passes_issued INTEGER NOT NULL DEFAULT 0,
    UNIQUE (account_id, fingerprint_hash)
  );

  CREATE TABLE login_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    used_at INTEGER,
    ip TEXT
  );
  CREATE INDEX login_codes_email ON login_codes (email, created_at);

  CREATE TABLE refresh_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX refresh_tokens_device ON refresh_tokens (device_id);

  -- Minimal record of issued passes (kept 7 days): which device, which version, when.
  CREATE TABLE pass_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    app_version TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX pass_log_issued ON pass_log (issued_at);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    account_id TEXT,
    detail TEXT
  );
  CREATE INDEX audit_account ON audit (account_id, at);

  -- Webhook deliveries already applied (idempotency: a redelivery is acknowledged, not re-applied).
  CREATE TABLE webhook_events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    event TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );

  -- Reserved for later phases: builds run against the Cloud recipe, recipe versions, watermarks.
  CREATE TABLE builds (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    device_id TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE recipe_versions (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    notes TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE watermarks (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    build_id TEXT,
    mark TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  `,
  // 2 — Phase 2 step engine (cloud/src/steps): a build carries its job details, its page plan and
  // the recipe version it runs; every step handed out (and how it ended) is a build_steps row.
  `
  ALTER TABLE builds ADD COLUMN recipe_version TEXT;
  ALTER TABLE builds ADD COLUMN meta TEXT;
  ALTER TABLE builds ADD COLUMN pages TEXT;
  ALTER TABLE builds ADD COLUMN steps_issued INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX builds_account ON builds (account_id, created_at);

  CREATE TABLE build_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    build_id TEXT NOT NULL REFERENCES builds (id) ON DELETE CASCADE,
    step_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    session TEXT,
    device_id TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    issued_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX build_steps_build ON build_steps (build_id, step_id, id);
  `,
  // 3 — refresh-token rotation (cloud/src/tokens.ts): a rotated token points to its successor and
  // keeps the hash of the rotation key the app sent, so a heartbeat whose answer was lost can fetch
  // the same successor again; revoked_reason says when tokens were revoked for reuse. Existing
  // tokens get NULLs (= current) and keep working; they start rotating at their first heartbeat
  // from an app that asks for it. Adds only what is missing.
  (sql) => {
    const columns = new Set((sql.prepare('PRAGMA table_info(refresh_tokens)').all() as Array<{ name: string }>).map((column) => column.name));
    for (const [name, type] of [['successor_id', 'TEXT'], ['superseded_at', 'INTEGER'], ['rotation_key_hash', 'TEXT'], ['revoked_reason', 'TEXT']] as const) {
      if (!columns.has(name)) sql.exec(`ALTER TABLE refresh_tokens ADD COLUMN ${name} ${type}`);
    }
    sql.exec('CREATE INDEX IF NOT EXISTS refresh_tokens_superseded ON refresh_tokens (superseded_at)');
  },
];

/** Columns an account update may touch (everything else is fixed or managed here). */
const ACCOUNT_FIELDS = ['plan', 'seats', 'status', 'expires_at', 'source', 'ls_customer_id', 'ls_subscription_id', 'ls_order_id', 'ls_variant_id', 'ls_status', 'ls_updated_at'] as const;
export type AccountPatch = Partial<Pick<AccountRow, typeof ACCOUNT_FIELDS[number]>>;

export class CloudDb {
  readonly sql: DatabaseSync;

  constructor(file: string) {
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.sql.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate() {
    const current = Number((this.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      this.transaction(() => {
        const step = MIGRATIONS[version];
        if (typeof step === 'string') this.sql.exec(step); else step(this.sql);
        this.sql.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  /** Runs fn atomically (BEGIN IMMEDIATE: one writer at a time). Not re-entrant. */
  transaction<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.sql.exec('COMMIT');
      return result;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  close() { if (this.sql.isOpen) this.sql.close(); }

  // ---- accounts -------------------------------------------------------------------------------
  accountById(id: string): AccountRow | null {
    return (this.sql.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined) ?? null;
  }

  accountByEmail(email: string): AccountRow | null {
    return (this.sql.prepare('SELECT * FROM accounts WHERE email = ?').get(email.trim().toLowerCase()) as AccountRow | undefined) ?? null;
  }

  accountBySubscription(subscriptionId: string): AccountRow | null {
    return (this.sql.prepare('SELECT * FROM accounts WHERE ls_subscription_id = ?').get(subscriptionId) as AccountRow | undefined) ?? null;
  }

  listAccounts(): AccountRow[] {
    return this.sql.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all() as unknown as AccountRow[];
  }

  createAccount(email: string, fields: AccountPatch, now: number): AccountRow {
    const id = newId('acc');
    this.sql.prepare('INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, email.trim().toLowerCase(), now, now);
    return this.updateAccount(id, fields, now);
  }

  updateAccount(id: string, patch: AccountPatch, now: number): AccountRow {
    const entries = Object.entries(patch).filter(([key, value]) => (ACCOUNT_FIELDS as readonly string[]).includes(key) && value !== undefined);
    if (entries.length) {
      const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
      this.sql.prepare(`UPDATE accounts SET ${assignments}, updated_at = ? WHERE id = ?`).run(...entries.map(([, value]) => value as string | number | null), now, id);
    }
    const row = this.accountById(id);
    if (!row) throw new Error(`Account ${id} not found.`);
    return row;
  }

  // ---- devices --------------------------------------------------------------------------------
  deviceById(id: string): DeviceRow | null {
    return (this.sql.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined) ?? null;
  }

  devicesForAccount(accountId: string): DeviceRow[] {
    return this.sql.prepare('SELECT * FROM devices WHERE account_id = ? ORDER BY created_at').all(accountId) as unknown as DeviceRow[];
  }

  // ---- settings -------------------------------------------------------------------------------
  getSetting(key: string): string | null {
    return (this.sql.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  setSetting(key: string, value: string, now: number) {
    this.sql.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, value, now);
  }

  // ---- audit ----------------------------------------------------------------------------------
  /** Who did what. Never put codes, tokens or passes in `detail`. */
  audit(now: number, actor: string, action: string, accountId: string | null, detail: Record<string, unknown> = {}) {
    this.sql.prepare('INSERT INTO audit (at, actor, action, account_id, detail) VALUES (?, ?, ?, ?, ?)').run(now, actor, action, accountId, JSON.stringify(detail));
  }

  /**
   * Housekeeping: old login codes, pass log rows, dead refresh tokens and audit entries.
   * Rotated (superseded) tokens go after SUPERSEDED_TOKEN_DAYS once their successor has been used —
   * one row per heartbeat, like the pass log. A superseded token whose successor was never used is
   * that computer's way back in (its answer was lost), so it stays as long as a current token does.
   */
  prune(now: number) {
    const day = 24 * 60 * 60 * 1000;
    this.sql.prepare('DELETE FROM login_codes WHERE created_at < ?').run(now - day);
    this.sql.prepare('DELETE FROM pass_log WHERE issued_at < ?').run(now - 7 * day);
    this.sql.prepare('DELETE FROM refresh_tokens WHERE revoked_at IS NOT NULL AND revoked_at < ?').run(now - 90 * day);
    this.sql.prepare(`DELETE FROM refresh_tokens WHERE revoked_at IS NULL AND superseded_at IS NOT NULL AND superseded_at < ?
      AND NOT EXISTS (SELECT 1 FROM refresh_tokens AS next WHERE next.id = refresh_tokens.successor_id AND next.last_used_at IS NULL AND next.superseded_at IS NULL AND next.revoked_at IS NULL)`)
      .run(now - SUPERSEDED_TOKEN_DAYS * day);
    this.sql.prepare('DELETE FROM webhook_events WHERE received_at < ?').run(now - 90 * day);
    this.sql.prepare('DELETE FROM audit WHERE at < ?').run(now - 365 * day);
  }
}
