// Anomaly flags: accounts whose use doesn't look like one customer's team on its own computers.
// Nothing here blocks anyone — flags are for an admin to review (and revoke via /v1/admin).
//
// Read from security_events (sign-ins, heartbeats, hand-backs, refusals), the pass log (every
// heartbeat that got a pass, kept 7 days) and the devices table. Limits are per 24 hours and
// scale with the account's seats and with the window asked for.
//
//   many_networks          more distinct networks (/24, /48) than a team plausibly uses
//   many_devices           more distinct computers than the seats explain
//   many_fingerprints      sign-ins (or token use) from more machine fingerprints than seats explain
//   seat_churn             seats taken and handed back over and over (a seat passed around)
//   seats_full             people repeatedly turned away because every seat was taken
//   token_reuse            a computer's refresh token presented by a different machine, or a rotated
//                          token presented again after its successor was used (a copied sign-in)
//   impossible_concurrency one device identity heartbeating like two machines (pass rate), or
//                          alternating between networks minutes apart (a cloned install)
//   recipe_harvest         build steps marked done seconds after they were handed out (or never
//                          handed out at all): a script walking the step engine to collect every
//                          step's prompt, not Claude Code doing the work
import type { CloudContext } from '../context';
import type { AccountRow } from '../db';
import { ensureSecuritySchema, type SecurityEventRow } from './events';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A device that is quiet for this long gives its seat up (devices.ts ACTIVE_WINDOW_MS). */
const SEAT_HOLD_MS = 15 * MINUTE;

export interface SecurityThresholds {
  /** many_networks: flag when distinct networks > max(minNetworks, networksPerSeat × seats). */
  minNetworks: number;
  networksPerSeat: number;
  /** many_devices: distinct devices > max(minDevices, devicesPerSeat × seats). */
  minDevices: number;
  devicesPerSeat: number;
  /** many_fingerprints: distinct sign-in fingerprints > max(minFingerprints, seats + fingerprintSlack). */
  minFingerprints: number;
  fingerprintSlack: number;
  /** seat_churn: activations + hand-backs > max(minChurn, churnPerSeat × seats). */
  minChurn: number;
  churnPerSeat: number;
  /** seats_full: refusals > this. */
  seatsFull: number;
  /** impossible_concurrency: a device with more passes than this in any 60 minutes (normal: 12). */
  passesPerHour: number;
  /** …or more than busyHourPasses passes in at least busyHours separate clock hours. */
  busyHourPasses: number;
  busyHours: number;
  /** …or this many network switches, each within quickSwitchMs of the previous event. */
  quickSwitches: number;
  quickSwitchMs: number;
  /** recipe_harvest: more than this many steps reported done within fastStepMs of being handed out. */
  fastSteps: number;
  fastStepMs: number;
}

export const DEFAULT_THRESHOLDS: SecurityThresholds = {
  minNetworks: 4, networksPerSeat: 2,
  minDevices: 4, devicesPerSeat: 2,
  minFingerprints: 3, fingerprintSlack: 2,
  minChurn: 12, churnPerSeat: 6,
  seatsFull: 4,
  passesPerHour: 30, busyHourPasses: 20, busyHours: 2,
  quickSwitches: 3, quickSwitchMs: 10 * MINUTE,
  fastSteps: 5, fastStepMs: 30_000,
};

export type Severity = 'low' | 'medium' | 'high';
export type SecurityRule = 'many_networks' | 'many_devices' | 'many_fingerprints' | 'seat_churn' | 'seats_full' | 'token_reuse' | 'impossible_concurrency' | 'recipe_harvest';

export interface SecurityFlag {
  rule: SecurityRule;
  severity: Severity;
  value: number;
  limit: number;
  message: string;
  detail?: Record<string, unknown>;
}

export interface AccountFlags {
  account: { id: string; email: string | null; plan: string | null; seats: number; status: string | null };
  /** Sum of severities (low 1, medium 3, high 8): the review order. */
  score: number;
  flags: SecurityFlag[];
}

export interface SecurityFlagsReport {
  generatedAt: string;
  windowHours: number;
  accounts: AccountFlags[];
}

const WEIGHT: Record<Severity, number> = { low: 1, medium: 3, high: 8 };

interface PassRow { account_id: string; device_id: string; issued_at: number }
interface FastStepRow { account_id: string; build_id: string; step_id: string }
interface DeviceRow { id: string; account_id: string; fingerprint_hash: string; created_at: number }

/** Over the limit → medium; over twice the limit → high. */
const graded = (value: number, limit: number): Severity => (value > 2 * limit ? 'high' : 'medium');

export function computeSecurityFlags(
  ctx: Pick<CloudContext, 'db' | 'now'>,
  options: { hours?: number; accountId?: string; thresholds?: Partial<SecurityThresholds> } = {},
): SecurityFlagsReport {
  ensureSecuritySchema(ctx.db);
  const sql = ctx.db.sql;
  const now = ctx.now();
  const hours = Math.min(24 * 30, Math.max(1, options.hours ?? 24));
  const since = now - hours * HOUR;
  const scale = Math.max(1, hours / 24);
  const limits = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const only = options.accountId;

  const events = (only
    ? sql.prepare('SELECT * FROM security_events WHERE account_id = ? AND at >= ? ORDER BY at, id').all(only, since)
    : sql.prepare('SELECT * FROM security_events WHERE at >= ? ORDER BY at, id').all(since)) as unknown as SecurityEventRow[];
  // Passes from a little before the window too, to tell a seat taken in the window from one held.
  const passes = (only
    ? sql.prepare('SELECT account_id, device_id, issued_at FROM pass_log WHERE account_id = ? AND issued_at >= ? ORDER BY issued_at').all(only, since - SEAT_HOLD_MS)
    : sql.prepare('SELECT account_id, device_id, issued_at FROM pass_log WHERE issued_at >= ? ORDER BY issued_at').all(since - SEAT_HOLD_MS)) as unknown as PassRow[];
  const newDevices = (only
    ? sql.prepare('SELECT id, account_id, fingerprint_hash, created_at FROM devices WHERE account_id = ? AND created_at >= ?').all(only, since)
    : sql.prepare('SELECT id, account_id, fingerprint_hash, created_at FROM devices WHERE created_at >= ?').all(since)) as unknown as DeviceRow[];

  // Steps reported done within seconds of being handed out — or never handed out (a result row
  // the Cloud inserted itself has issued_at = finished_at). Real steps are Claude Code sessions
  // that take minutes.
  let fastSteps: FastStepRow[] = [];
  try {
    fastSteps = (only
      ? sql.prepare("SELECT b.account_id, s.build_id, s.step_id FROM build_steps s JOIN builds b ON b.id = s.build_id WHERE b.account_id = ? AND s.status = 'done' AND s.finished_at >= ? AND s.finished_at - s.issued_at < ?").all(only, since, limits.fastStepMs)
      : sql.prepare("SELECT b.account_id, s.build_id, s.step_id FROM build_steps s JOIN builds b ON b.id = s.build_id WHERE s.status = 'done' AND s.finished_at >= ? AND s.finished_at - s.issued_at < ?").all(since, limits.fastStepMs)) as unknown as FastStepRow[];
  } catch { fastSteps = []; } // a database without the step engine's tables

  const byAccount = new Map<string, { events: SecurityEventRow[]; passes: PassRow[]; devices: DeviceRow[]; fastSteps: FastStepRow[] }>();
  const bucket = (accountId: string) => {
    let entry = byAccount.get(accountId);
    if (!entry) { entry = { events: [], passes: [], devices: [], fastSteps: [] }; byAccount.set(accountId, entry); }
    return entry;
  };
  for (const event of events) bucket(event.account_id).events.push(event);
  for (const pass of passes) bucket(pass.account_id).passes.push(pass);
  for (const device of newDevices) bucket(device.account_id).devices.push(device);
  for (const step of fastSteps) bucket(step.account_id).fastSteps.push(step);

  const accounts: AccountFlags[] = [];
  for (const [accountId, data] of byAccount) {
    const account: AccountRow | null = ctx.db.accountById(accountId);
    const seats = account?.seats ?? 1;
    const flags: SecurityFlag[] = [];
    const count = (kind: SecurityEventRow['kind']) => data.events.filter((event) => event.kind === kind).length;
    const windowPasses = data.passes.filter((pass) => pass.issued_at >= since);

    // Networks.
    const networks = new Set(data.events.map((event) => event.ip_prefix).filter((prefix): prefix is string => prefix != null));
    const networkLimit = Math.ceil(Math.max(limits.minNetworks, limits.networksPerSeat * seats) * scale);
    if (networks.size > networkLimit) {
      flags.push({ rule: 'many_networks', severity: graded(networks.size, networkLimit), value: networks.size, limit: networkLimit, message: `Used from ${networks.size} different networks in ${hours} h (limit ${networkLimit} for ${seats} seat${seats === 1 ? '' : 's'}).`, detail: { networks: [...networks].slice(0, 20) } });
    }

    // Devices.
    const devices = new Set<string>([
      ...data.events.map((event) => event.device_id).filter((id): id is string => id != null),
      ...windowPasses.map((pass) => pass.device_id),
      ...data.devices.map((device) => device.id),
    ]);
    const deviceLimit = Math.ceil(Math.max(limits.minDevices, limits.devicesPerSeat * seats) * scale);
    if (devices.size > deviceLimit) {
      flags.push({ rule: 'many_devices', severity: graded(devices.size, deviceLimit), value: devices.size, limit: deviceLimit, message: `${devices.size} different computers used it in ${hours} h (limit ${deviceLimit}).` });
    }

    // Fingerprints seen signing in (or presenting a token), plus computers first seen in the window.
    const fingerprints = new Set<string>([
      ...data.events.filter((event) => event.kind === 'signin' || event.kind === 'fingerprint_mismatch').map((event) => event.fingerprint).filter((value): value is string => value != null),
      ...data.devices.map((device) => device.fingerprint_hash),
    ]);
    const fingerprintLimit = Math.ceil(Math.max(limits.minFingerprints, seats + limits.fingerprintSlack) * scale);
    if (fingerprints.size > fingerprintLimit) {
      flags.push({ rule: 'many_fingerprints', severity: graded(fingerprints.size, fingerprintLimit), value: fingerprints.size, limit: fingerprintLimit, message: `Signed in from ${fingerprints.size} different machines in ${hours} h (limit ${fingerprintLimit}).` });
    }

    // Seat churn: seats taken (a pass after ≥15 quiet minutes, or the first pass) plus seats given back.
    const passesByDevice = new Map<string, number[]>();
    for (const pass of data.passes) {
      const times = passesByDevice.get(pass.device_id);
      if (times) times.push(pass.issued_at); else passesByDevice.set(pass.device_id, [pass.issued_at]);
    }
    let activations = 0;
    for (const times of passesByDevice.values()) {
      times.forEach((at, index) => { if (at >= since && (index === 0 || at - times[index - 1] > SEAT_HOLD_MS)) activations += 1; });
    }
    const handBacks = count('release') + count('signout') + count('admin_release');
    const churn = activations + handBacks;
    const churnLimit = Math.ceil(Math.max(limits.minChurn, limits.churnPerSeat * seats) * scale);
    if (churn > churnLimit) {
      flags.push({ rule: 'seat_churn', severity: graded(churn, churnLimit), value: churn, limit: churnLimit, message: `Seats were taken and handed back ${churn} times in ${hours} h (limit ${churnLimit}).`, detail: { activations, handBacks, signIns: count('signin') } });
    }

    const refusals = count('seats_full');
    const refusalLimit = Math.ceil(limits.seatsFull * scale);
    if (refusals > refusalLimit) {
      flags.push({ rule: 'seats_full', severity: graded(refusals, refusalLimit), value: refusals, limit: refusalLimit, message: `Turned away ${refusals} times because all ${seats} seat${seats === 1 ? ' was' : 's were'} in use.` });
    }

    // A token presented by the wrong machine, or a rotated token coming back after its successor was
    // used (two copies of one computer's sign-in — the Cloud has already signed that computer out).
    const mismatches = data.events.filter((event) => event.kind === 'fingerprint_mismatch');
    const reuses = data.events.filter((event) => event.kind === 'token_reuse');
    if (mismatches.length || reuses.length) {
      const times = (count: number) => `${count} time${count === 1 ? '' : 's'}`;
      const message = [
        reuses.length ? `A computer's sign-in was used in two places: a replaced sign-in token came back ${times(reuses.length)} after its successor was in use, so that computer was signed out.` : '',
        mismatches.length ? `A computer's sign-in token was used from a different machine ${times(mismatches.length)}.` : '',
      ].filter(Boolean).join(' ');
      flags.push({
        rule: 'token_reuse', severity: 'high', value: mismatches.length + reuses.length, limit: 0, message,
        detail: { devices: [...new Set([...reuses, ...mismatches].map((event) => event.device_id))], reused: reuses.length, otherMachine: mismatches.length },
      });
    }

    // One device identity behaving like two machines.
    let worstRate: { device: string; passes: number; busyHours: number } | null = null;
    for (const [device, times] of passesByDevice) {
      const inWindow = times.filter((at) => at >= since);
      let maxInHour = 0;
      for (let start = 0, end = 0; end < inWindow.length; end += 1) {
        while (inWindow[end] - inWindow[start] >= HOUR) start += 1;
        maxInHour = Math.max(maxInHour, end - start + 1);
      }
      const perClockHour = new Map<number, number>();
      for (const at of inWindow) perClockHour.set(Math.floor(at / HOUR), (perClockHour.get(Math.floor(at / HOUR)) ?? 0) + 1);
      const busy = [...perClockHour.values()].filter((value) => value > limits.busyHourPasses).length;
      if ((maxInHour > limits.passesPerHour || busy >= limits.busyHours) && (!worstRate || maxInHour > worstRate.passes)) worstRate = { device, passes: maxInHour, busyHours: busy };
    }
    if (worstRate) {
      flags.push({
        rule: 'impossible_concurrency', severity: worstRate.passes > limits.passesPerHour ? 'high' : 'medium', value: worstRate.passes, limit: limits.passesPerHour,
        message: `One computer took ${worstRate.passes} passes within an hour (one app takes about 12) — its identity is probably running on more than one machine.`,
        detail: { reason: 'pass_rate', device: worstRate.device, busyHours: worstRate.busyHours },
      });
    }
    const byDevice = new Map<string, SecurityEventRow[]>();
    for (const event of data.events) {
      if (!event.device_id || !event.ip_prefix || (event.kind !== 'heartbeat' && event.kind !== 'signin')) continue;
      const list = byDevice.get(event.device_id);
      if (list) list.push(event); else byDevice.set(event.device_id, [event]);
    }
    let worstHop: { device: string; switches: number; networks: number } | null = null;
    for (const [device, list] of byDevice) {
      let switches = 0;
      for (let index = 1; index < list.length; index += 1) {
        if (list[index].ip_prefix !== list[index - 1].ip_prefix && list[index].at - list[index - 1].at < limits.quickSwitchMs) switches += 1;
      }
      if (switches >= limits.quickSwitches && (!worstHop || switches > worstHop.switches)) worstHop = { device, switches, networks: new Set(list.map((event) => event.ip_prefix)).size };
    }
    if (worstHop) {
      flags.push({
        rule: 'impossible_concurrency', severity: 'high', value: worstHop.switches, limit: limits.quickSwitches,
        message: `One computer switched between ${worstHop.networks} networks ${worstHop.switches} times, minutes apart — the same install is probably running in two places.`,
        detail: { reason: 'network_hopping', device: worstHop.device, networks: worstHop.networks },
      });
    }

    const fastLimit = Math.ceil(limits.fastSteps * scale);
    if (data.fastSteps.length > fastLimit) {
      const builds = new Set(data.fastSteps.map((step) => step.build_id));
      const kinds = new Set(data.fastSteps.map((step) => step.step_id.split(':')[0]));
      flags.push({
        rule: 'recipe_harvest', severity: graded(data.fastSteps.length, fastLimit), value: data.fastSteps.length, limit: fastLimit,
        message: `${data.fastSteps.length} build steps were reported done within ${Math.round(limits.fastStepMs / 1000)} s of being handed out (or without being handed out) across ${builds.size} build${builds.size === 1 ? '' : 's'} — a script collecting step prompts? (A desktop that re-created a lost build also reports its finished steps at once.)`,
        detail: { builds: builds.size, stepKinds: [...kinds].sort() },
      });
    }

    if (!flags.length) continue;
    accounts.push({
      account: { id: accountId, email: account?.email ?? null, plan: account?.plan ?? null, seats, status: account?.status ?? null },
      score: flags.reduce((sum, flag) => sum + WEIGHT[flag.severity], 0),
      flags,
    });
  }
  accounts.sort((left, right) => right.score - left.score || (left.account.email ?? left.account.id).localeCompare(right.account.email ?? right.account.id));
  return { generatedAt: new Date(now).toISOString(), windowHours: hours, accounts };
}
