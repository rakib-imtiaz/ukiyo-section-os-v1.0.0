// Security events: a small record of what each account's computers do — sign-ins, heartbeats,
// seats handed back, refusals — kept 30 days. flags.ts reads it (with the devices table and the
// pass log) to flag accounts that look shared or cloned.
//
// Privacy: only the network prefix (/24 for IPv4, /48 for IPv6) and the already-peppered
// fingerprint hash are stored — never a full IP address or a raw fingerprint.
//
// recordSecurityEvent never throws: a failure to record must not break a sign-in or heartbeat.
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import type { CloudContext } from '../context';
import type { CloudDb } from '../db';

export const SECURITY_EVENT_KINDS = [
  'signin', // a computer signed in (new or returning device)
  'heartbeat', // a seat heartbeat that got a pass (recorded once per hour per device and network)
  'release', // the app handed its seat back while closing
  'signout', // the user signed this computer out
  'admin_release', // an admin signed the device out
  'seats_full', // a sign-in or heartbeat refused because every seat was taken
  'fingerprint_mismatch', // a refresh token presented from a different computer
  'token_reuse', // a rotated refresh token presented again after its successor was used: the device was signed out
] as const;
export type SecurityEventKind = typeof SECURITY_EVENT_KINDS[number];

export interface SecurityEventInput {
  kind: SecurityEventKind;
  accountId: string;
  deviceId?: string | null;
  /** request.ip — only its network prefix is stored. */
  ip?: string | null;
  /** fingerprintHash(ctx, raw) — never the raw fingerprint. */
  fingerprintHash?: string | null;
  /** Unix ms (default ctx.now()). */
  at?: number;
}

export interface SecurityEventRow {
  id: number;
  at: number;
  account_id: string;
  device_id: string | null;
  kind: SecurityEventKind;
  ip_prefix: string | null;
  fingerprint: string | null;
}

const HOUR = 60 * 60_000;
export const SECURITY_EVENT_RETENTION_MS = 30 * 24 * HOUR;
/** A heartbeat from the same device and network within this long adds nothing new. */
const HEARTBEAT_REPEAT_MS = HOUR;

const sqlOf = (db: CloudDb | DatabaseSync): DatabaseSync => ('sql' in db ? db.sql : db);
const ensured = new WeakSet<DatabaseSync>();

export function ensureSecuritySchema(db: CloudDb | DatabaseSync) {
  const sql = sqlOf(db);
  if (ensured.has(sql)) return;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      account_id TEXT NOT NULL,
      device_id TEXT,
      kind TEXT NOT NULL,
      ip_prefix TEXT,
      fingerprint TEXT
    );
    CREATE INDEX IF NOT EXISTS security_events_account ON security_events (account_id, at);
    CREATE INDEX IF NOT EXISTS security_events_device ON security_events (device_id, at);
    CREATE INDEX IF NOT EXISTS security_events_at ON security_events (at);
  `);
  ensured.add(sql);
}

/** "203.0.113.7" → "203.0.113.0/24"; IPv6 → its /48; IPv4-mapped IPv6 → the IPv4 /24; junk → null. */
export function ipPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null;
  let address = ip.trim().split('%')[0];
  if (/^::ffff:/i.test(address) && isIP(address.slice(7)) === 4) address = address.slice(7);
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.');
    return `${a}.${b}.${c}.0/24`;
  }
  if (version !== 6) return null;
  const [head, tail] = address.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups = tail === undefined ? headGroups : [...headGroups, ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'), ...tailGroups];
  return `${groups.slice(0, 3).map((group) => parseInt(group || '0', 16).toString(16)).join(':')}::/48`;
}

const lastPrune = new WeakMap<DatabaseSync, number>();

export function pruneSecurityEvents(db: CloudDb | DatabaseSync, now: number) {
  const sql = sqlOf(db);
  ensureSecuritySchema(db);
  sql.prepare('DELETE FROM security_events WHERE at < ?').run(now - SECURITY_EVENT_RETENTION_MS);
  lastPrune.set(sql, now);
}

/**
 * Records one event. Call it from sign-in, heartbeat, release, sign-out and the refusals (see
 * docs/SECURITY.md for where). Never throws.
 */
export function recordSecurityEvent(ctx: Pick<CloudContext, 'db' | 'now'> & { log?: CloudContext['log'] }, event: SecurityEventInput) {
  try {
    if (!(SECURITY_EVENT_KINDS as readonly string[]).includes(event.kind)) throw new Error(`unknown security event kind ${event.kind}`);
    const sql = ctx.db.sql;
    ensureSecuritySchema(ctx.db);
    const at = event.at ?? ctx.now();
    const prefix = ipPrefix(event.ip);
    if (event.kind === 'heartbeat' && event.deviceId) {
      const last = sql.prepare("SELECT ip_prefix, at FROM security_events WHERE device_id = ? AND kind = 'heartbeat' ORDER BY at DESC, id DESC LIMIT 1").get(event.deviceId) as { ip_prefix: string | null; at: number } | undefined;
      if (last && last.ip_prefix === prefix && at - last.at < HEARTBEAT_REPEAT_MS && at >= last.at) return;
    }
    sql.prepare('INSERT INTO security_events (at, account_id, device_id, kind, ip_prefix, fingerprint) VALUES (?, ?, ?, ?, ?, ?)')
      .run(at, event.accountId, event.deviceId ?? null, event.kind, prefix, event.fingerprintHash ?? null);
    if (at - (lastPrune.get(sql) ?? 0) > HOUR) pruneSecurityEvents(ctx.db, at);
  } catch (error) {
    ctx.log?.warn('security event not recorded', { kind: event.kind, account: event.accountId, error: error instanceof Error ? error.message : String(error) });
  }
}

export function securityEvents(db: CloudDb | DatabaseSync, options: { accountId?: string; since?: number; limit?: number } = {}): SecurityEventRow[] {
  const sql = sqlOf(db);
  ensureSecuritySchema(db);
  const since = options.since ?? 0;
  const limit = Math.min(5000, Math.max(1, options.limit ?? 200));
  return (options.accountId
    ? sql.prepare('SELECT * FROM security_events WHERE account_id = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?').all(options.accountId, since, limit)
    : sql.prepare('SELECT * FROM security_events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?').all(since, limit)) as unknown as SecurityEventRow[];
}
