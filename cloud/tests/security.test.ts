import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import type { CloudContext } from '../src/context';
import { CloudDb } from '../src/db';
import { errorHandler, notFound } from '../src/middleware';
import { RateLimiter } from '../src/rate-limit';
import { computeSecurityFlags, ipPrefix, recordSecurityEvent, registerSecurityRoutes, securityEvents, type SecurityEventInput } from '../src/security';
import { stripZeroWidth, watermarkPrompt } from '../src/watermark';

const ADMIN = 'test-admin-token-0123456789abcdef';
const START = Date.parse('2026-10-01T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const silent = { info() {}, warn() {}, error() {} };

let dir: string;
let clock: number;
let ctx: CloudContext;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tb-security-test-'));
  clock = START;
  const config = loadConfig({ NODE_ENV: 'test', CLOUD_DATA_DIR: dir, ADMIN_TOKEN: ADMIN });
  ctx = { config, db: new CloudDb(':memory:'), now: () => clock, mailer: { async send() {} }, limiter: new RateLimiter(() => clock), log: silent };
});
afterEach(() => {
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const account = (email: string, seats = 1) => ctx.db.createAccount(email, { seats }, START - 30 * 24 * HOUR).id;
function device(accountId: string, name: string, createdAt = START - 7 * 24 * HOUR) {
  const id = `dev_${name}`;
  ctx.db.sql.prepare('INSERT INTO devices (id, account_id, fingerprint_hash, name, platform, app_version, created_at, activated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, accountId, `fp_${name}`, name, 'win32', '1.0.0', createdAt, createdAt, createdAt);
  return id;
}
const event = (input: SecurityEventInput) => recordSecurityEvent(ctx, input);
const pass = (accountId: string, deviceId: string, at: number) =>
  ctx.db.sql.prepare('INSERT INTO pass_log (account_id, device_id, app_version, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(accountId, deviceId, '1.0.0', at, at + 15 * MINUTE);
const rulesOf = (accountId: string, hours = 24) => computeSecurityFlags(ctx, { hours }).accounts.find((entry) => entry.account.id === accountId)?.flags.map((flag) => flag.rule) ?? [];

/** A normal day: two app sessions on one computer, one network, a heartbeat (pass) every 5 minutes. */
function normalDay(accountId: string, deviceId: string, network = '198.51.100.20') {
  for (const [from, to] of [[START - 20 * HOUR, START - 12 * HOUR], [START - 6 * HOUR, START - HOUR]]) {
    event({ kind: 'signin', accountId, deviceId, ip: network, fingerprintHash: `fp_${deviceId}`, at: from });
    for (let at = from; at < to; at += 5 * MINUTE) { pass(accountId, deviceId, at); event({ kind: 'heartbeat', accountId, deviceId, ip: network, at }); }
    event({ kind: 'release', accountId, deviceId, ip: network, at: to });
  }
}

describe('ipPrefix', () => {
  it('reduces addresses to their network', () => {
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('::ffff:198.51.100.9')).toBe('198.51.100.0/24');
    expect(ipPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(ipPrefix('2001:db8::')).toBe('2001:db8:0::/48');
    expect(ipPrefix('fe80::1%eth0')).toBe('fe80:0:0::/48');
    expect(ipPrefix('not an ip')).toBeNull();
    expect(ipPrefix(undefined)).toBeNull();
  });
});

describe('recordSecurityEvent', () => {
  it('stores the network prefix only and skips repeat heartbeats from the same network', () => {
    const accountId = account('a@example.com');
    const deviceId = device(accountId, 'a');
    event({ kind: 'heartbeat', accountId, deviceId, ip: '203.0.113.5', at: START });
    event({ kind: 'heartbeat', accountId, deviceId, ip: '203.0.113.99', at: START + 5 * MINUTE }); // same /24, recent
    event({ kind: 'heartbeat', accountId, deviceId, ip: '198.51.100.1', at: START + 10 * MINUTE }); // new network
    event({ kind: 'heartbeat', accountId, deviceId, ip: '198.51.100.1', at: START + 75 * MINUTE }); // an hour later
    event({ kind: 'release', accountId, deviceId, ip: '198.51.100.1', at: START + 80 * MINUTE });
    const rows = securityEvents(ctx.db, { accountId }).reverse();
    expect(rows.map((row) => [row.kind, row.ip_prefix])).toEqual([
      ['heartbeat', '203.0.113.0/24'], ['heartbeat', '198.51.100.0/24'], ['heartbeat', '198.51.100.0/24'], ['release', '198.51.100.0/24'],
    ]);
    expect(JSON.stringify(rows)).not.toContain('203.0.113.5');
  });

  it('never throws, even with a closed database or a bad kind', () => {
    const warnings: string[] = [];
    const broken = { db: new CloudDb(':memory:'), now: () => clock, log: { ...silent, warn: (message: string) => { warnings.push(message); } } };
    recordSecurityEvent(broken, { kind: 'nope' as never, accountId: 'acc_x' });
    broken.db.close();
    expect(() => recordSecurityEvent(broken, { kind: 'signin', accountId: 'acc_x', ip: '203.0.113.5' })).not.toThrow();
    expect(warnings).toHaveLength(2);
  });

  it('prunes events older than 30 days', () => {
    const accountId = account('old@example.com');
    event({ kind: 'signin', accountId, at: START - 40 * 24 * HOUR });
    event({ kind: 'signin', accountId, at: START });
    expect(securityEvents(ctx.db, { accountId })).toHaveLength(1);
  });
});

describe('anomaly flags', () => {
  it('flags steps marked done seconds after they were handed out (a script harvesting step prompts)', () => {
    const build = (accountId: string, id: string) => ctx.db.sql.prepare("INSERT INTO builds (id, account_id, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)").run(id, accountId, START - HOUR, START - HOUR);
    const step = (buildId: string, stepId: string, issuedAt: number, finishedAt: number, status = 'done') =>
      ctx.db.sql.prepare('INSERT INTO build_steps (build_id, step_id, kind, attempt, status, issued_at, finished_at) VALUES (?, ?, ?, 1, ?, ?, ?)').run(buildId, stepId, stepId.split(':')[0], status, issuedAt, finishedAt);
    // A real build: every step is a Claude Code session of minutes.
    const honest = account('honest@example.com');
    build(honest, 'bld_honest');
    ['preflight', 'inventory', 'bootstrap', 'store-setup', 'page:home', 'verify:home', 'final'].forEach((id, index) => step('bld_honest', id, START - 10 * HOUR + index * 20 * MINUTE, START - 10 * HOUR + index * 20 * MINUTE + 12 * MINUTE));
    // A scraper: one step of each kind per build, reported done at once (or never handed out).
    const scraper = account('scraper@example.com');
    for (let index = 0; index < 4; index += 1) {
      build(scraper, `bld_s${index}`);
      for (const id of ['preflight', 'inventory', 'bootstrap']) step(`bld_s${index}`, id, START - 2 * HOUR + index * MINUTE, START - 2 * HOUR + index * MINUTE + 3_000);
      step(`bld_s${index}`, 'final', START - HOUR, START - HOUR); // a result for a step never handed out
    }
    step('bld_s0', 'page:about', START - HOUR, START - HOUR + 1_000, 'failed'); // only "done" counts
    expect(rulesOf(honest)).toEqual([]);
    const flag = computeSecurityFlags(ctx).accounts.find((entry) => entry.account.id === scraper)?.flags.find((entry) => entry.rule === 'recipe_harvest');
    expect(flag).toMatchObject({ severity: 'high', value: 16, limit: 5, detail: { builds: 4, stepKinds: ['bootstrap', 'final', 'inventory', 'preflight'] } });
    expect(computeSecurityFlags(ctx, { hours: 24, thresholds: { fastSteps: 20 } }).accounts).toEqual([]);
  });

  it('leaves normal use alone', () => {
    const solo = account('solo@example.com');
    normalDay(solo, device(solo, 'solo'));
    const team = account('team@example.com', 3);
    for (const [index, name] of ['t1', 't2', 't3'].entries()) normalDay(team, device(team, name), `198.51.10${index}.20`);
    expect(computeSecurityFlags(ctx).accounts).toEqual([]);
  });

  it('flags one account used from many networks', () => {
    const accountId = account('roam@example.com');
    const deviceId = device(accountId, 'roam');
    for (let index = 0; index < 6; index += 1) event({ kind: 'heartbeat', accountId, deviceId, ip: `203.0.${index}.10`, at: START - (index + 1) * 2 * HOUR });
    const report = computeSecurityFlags(ctx);
    expect(report.accounts[0].flags[0]).toMatchObject({ rule: 'many_networks', value: 6, limit: 4, severity: 'medium' });
  });

  it('flags many computers and machine fingerprints on a one-seat account', () => {
    const accountId = account('shared@example.com');
    for (let index = 0; index < 7; index += 1) {
      const deviceId = device(accountId, `pc${index}`, START - (index + 1) * HOUR);
      event({ kind: 'signin', accountId, deviceId, ip: '198.51.100.20', fingerprintHash: `fp_pc${index}`, at: START - (index + 1) * HOUR });
    }
    expect(rulesOf(accountId)).toEqual(expect.arrayContaining(['many_devices', 'many_fingerprints']));
    const flags = computeSecurityFlags(ctx).accounts[0].flags;
    expect(flags.find((flag) => flag.rule === 'many_devices')).toMatchObject({ value: 7, limit: 4 });
    expect(flags.find((flag) => flag.rule === 'many_fingerprints')).toMatchObject({ value: 7, limit: 3 });
  });

  it('flags a seat passed around (churn) and people repeatedly turned away', () => {
    const accountId = account('churn@example.com');
    const a = device(accountId, 'a');
    const b = device(accountId, 'b');
    for (let round = 0; round < 8; round += 1) {
      const deviceId = round % 2 ? a : b;
      const at = START - 23 * HOUR + round * 2 * HOUR;
      pass(accountId, deviceId, at);
      pass(accountId, deviceId, at + 5 * MINUTE);
      event({ kind: 'release', accountId, deviceId, at: at + 10 * MINUTE });
      event({ kind: 'seats_full', accountId, deviceId: deviceId === a ? b : a, at: at + MINUTE });
    }
    const flags = computeSecurityFlags(ctx).accounts[0].flags;
    expect(flags.find((flag) => flag.rule === 'seat_churn')).toMatchObject({ value: 16, limit: 12, detail: { activations: 8, handBacks: 8 } });
    expect(flags.find((flag) => flag.rule === 'seats_full')).toMatchObject({ value: 8, limit: 4 });
  });

  it('flags a sign-in token used from another machine as high severity', () => {
    const accountId = account('token@example.com');
    const deviceId = device(accountId, 'tok');
    event({ kind: 'fingerprint_mismatch', accountId, deviceId, ip: '203.0.113.9', fingerprintHash: 'fp_other', at: START - HOUR });
    const [entry] = computeSecurityFlags(ctx).accounts;
    expect(entry.flags).toEqual([expect.objectContaining({ rule: 'token_reuse', severity: 'high', value: 1 })]);
    expect(entry.score).toBe(8);
  });

  it('flags one device identity heartbeating like two machines', () => {
    const accountId = account('clone@example.com');
    const deviceId = device(accountId, 'clone');
    // Two copies of the same install, each heartbeating every 5 minutes: a pass every 2.5 minutes,
    // and the two copies' heartbeats coming from two networks in turn.
    for (let at = START - 3 * HOUR, index = 0; at < START; at += 150_000, index += 1) {
      pass(accountId, deviceId, at);
      event({ kind: 'heartbeat', accountId, deviceId, ip: index % 2 ? '203.0.113.7' : '198.51.100.7', at });
    }
    const flags = computeSecurityFlags(ctx).accounts[0].flags.filter((flag) => flag.rule === 'impossible_concurrency');
    expect(flags.map((flag) => flag.detail?.reason).sort()).toEqual(['network_hopping', 'pass_rate']);
    expect(flags.every((flag) => flag.severity === 'high' || flag.detail?.reason === 'pass_rate')).toBe(true);
    expect(flags.find((flag) => flag.detail?.reason === 'pass_rate')?.value).toBe(24);
    // 24 passes an hour is over the "busy hour" line (20) in 3 clock hours → flagged, as medium.
    expect(flags.find((flag) => flag.detail?.reason === 'pass_rate')?.severity).toBe('medium');
  });

  it('only looks at the window asked for, and sorts the worst accounts first', () => {
    const roam = account('roam@example.com');
    const roamDevice = device(roam, 'roam');
    for (let index = 0; index < 6; index += 1) event({ kind: 'heartbeat', accountId: roam, deviceId: roamDevice, ip: `203.0.${index}.10`, at: START - 30 * HOUR - index * HOUR });
    expect(computeSecurityFlags(ctx, { hours: 24 }).accounts).toEqual([]);
    expect(computeSecurityFlags(ctx, { hours: 48 }).accounts).toEqual([]); // limit scales: 4 × 2 days = 8
    const thief = account('thief@example.com');
    event({ kind: 'fingerprint_mismatch', accountId: thief, deviceId: device(thief, 'thief'), at: START - HOUR });
    const roamer = account('roamer@example.com');
    const roamerDevice = device(roamer, 'roamer');
    for (let index = 0; index < 6; index += 1) event({ kind: 'heartbeat', accountId: roamer, deviceId: roamerDevice, ip: `192.0.${index}.10`, at: START - index * HOUR });
    expect(computeSecurityFlags(ctx).accounts.map((entry) => entry.account.email)).toEqual(['thief@example.com', 'roamer@example.com']);
    expect(computeSecurityFlags(ctx, { accountId: roamer }).accounts.map((entry) => entry.account.email)).toEqual(['roamer@example.com']);
  });
});

describe('admin security routes', () => {
  let server: Server;
  let base: string;
  beforeEach(async () => {
    const app = express();
    registerSecurityRoutes(app, ctx);
    app.use(express.json({ limit: '16kb' })); // the app's global parser comes after, as in app.ts
    app.use(notFound);
    app.use(errorHandler(ctx));
    server = await new Promise<Server>((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = { Authorization: `Bearer ${ADMIN}` }) => {
    const raw = typeof body === 'string';
    const response = await fetch(`${base}/v1/admin/security${route}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': raw ? 'text/plain' : 'application/json' }) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };

  it('requires the admin token', async () => {
    expect((await call('GET', '/flags', undefined, {})).status).toBe(401);
    expect((await call('POST', '/leak', { text: 'x' }, { Authorization: 'Bearer wrong' })).body.code).toBe('UNAUTHORIZED');
  });

  it('GET /flags and /events list flagged accounts and their events', async () => {
    const accountId = account('token@example.com');
    event({ kind: 'fingerprint_mismatch', accountId, deviceId: device(accountId, 'x'), ip: '203.0.113.9', at: START - HOUR });
    const flags = await call('GET', '/flags?hours=24');
    expect(flags.status).toBe(200);
    expect(flags.body).toMatchObject({ windowHours: 24, accounts: [{ account: { id: accountId, email: 'token@example.com' }, flags: [{ rule: 'token_reuse' }] }] });
    const events = await call('GET', `/events?account=${accountId}`);
    expect(events.body.events).toEqual([expect.objectContaining({ kind: 'fingerprint_mismatch', network: '203.0.113.0/24', account: accountId })]);
  });

  it('POST /leak names the account a leaked prompt was sent to (JSON over 16 KB, or plain text)', async () => {
    const owners = ['first@example.com', 'second@example.com', 'third@example.com'].map((email) => account(email));
    const nouns = ['header', 'footer', 'hero', 'gallery', 'newsletter', 'testimonial', 'collection'];
    const prompt = Array.from({ length: 160 }, (_, index) =>
      `- Section ${index} does not reuse the ${nouns[index % 7]} block — make sure that every ${nouns[(index + 3) % 7]} setting is editable, and keep the **${nouns[(index + 5) % 7]} rule** simple.`).join('\n');
    const sent = owners.map((accountId) => watermarkPrompt(prompt, { accountId, buildId: `bld_${accountId}`, stepId: 'page:home', db: ctx.db, secret: 'pepper' }));
    expect(sent[1].length).toBeGreaterThan(16 * 1024);

    const json = await call('POST', '/leak', { text: stripZeroWidth(sent[1]) });
    expect(json.status).toBe(200);
    expect(json.body.candidates[0]).toMatchObject({ accountId: owners[1], email: 'second@example.com', best: { stepId: 'page:home' } });
    expect(json.body.candidates[0].confidence).toBeGreaterThan(0.99);

    const plain = await call('POST', '/leak', sent[2].slice(0, 5000));
    expect(plain.body.candidates[0]).toMatchObject({ accountId: owners[2], zeroWidth: true });

    expect((await call('POST', '/leak', { text: '   ' })).status).toBe(400);
    const audit = ctx.db.sql.prepare("SELECT account_id, detail FROM audit WHERE action = 'security.leak_checked' ORDER BY id").all() as Array<{ account_id: string; detail: string }>;
    expect(audit.map((row) => row.account_id)).toEqual([owners[1], owners[2]]);
    expect(audit.every((row) => !row.detail.includes('Section'))).toBe(true); // the text is never stored
  });
});
