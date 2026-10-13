// Test harness: a real Cloud on port 0 with a movable clock, captured emails and a temp data folder.
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCloud } from '../src/app';
import { loadConfig } from '../src/config';
import type { MailMessage } from '../src/mailer';

export const ADMIN = 'test-admin-token-0123456789abcdef';
export const WEBHOOK_SECRET = 'whsec_test_secret';
export const START = Date.parse('2026-10-01T12:00:00Z');
export const MINUTE = 60_000;

const silent = { info() {}, warn() {}, error() {} };

export interface TestCloud {
  base: string;
  sent: MailMessage[];
  publicKey: string;
  now(): number;
  advance(ms: number): void;
  call(method: string, route: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Record<string, any> }>;
  admin(method: string, route: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }>;
  webhook(payload: unknown, options?: { signature?: string; raw?: string }): Promise<{ status: number; body: Record<string, any> }>;
  lastCode(email: string): string;
  createAccount(email: string, fields?: Record<string, unknown>): Promise<Record<string, any>>;
  signIn(email: string, device: { fingerprint: string; name?: string; appVersion?: string }): Promise<{ status: number; body: Record<string, any> }>;
  heartbeat(refreshToken: string, fingerprint: string, appVersion?: string): Promise<{ status: number; body: Record<string, any> }>;
  close(): Promise<void>;
}

export const FP_A = 'a'.repeat(64);
export const FP_B = 'b'.repeat(64);
export const FP_C = 'c'.repeat(64);

export async function startTestCloud(env: Record<string, string> = {}): Promise<TestCloud> {
  const dir = mkdtempSync(path.join(tmpdir(), 'tb-cloud-test-'));
  let clock = START;
  const sent: MailMessage[] = [];
  const config = loadConfig({ NODE_ENV: 'test', CLOUD_DATA_DIR: dir, ADMIN_TOKEN: ADMIN, LEMONSQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET, LEMONSQUEEZY_VARIANT_SEATS: '111:5', ...env });
  const cloud = createCloud({ config, now: () => clock, mailer: { async send(message) { sent.push(message); } }, log: silent });
  const server = await new Promise<Server>((resolve) => { const listening = cloud.app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call: TestCloud['call'] = async (method, route, body, headers = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
  };

  const harness: TestCloud = {
    base, sent, publicKey: cloud.publicKey,
    now: () => clock,
    advance(ms) { clock += ms; },
    call,
    admin: (method, route, body) => call(method, `/v1/admin${route}`, body, { Authorization: `Bearer ${ADMIN}` }),
    async webhook(payload, options = {}) {
      const raw = options.raw ?? JSON.stringify(payload);
      const signature = options.signature ?? createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
      const response = await fetch(`${base}/v1/webhooks/lemonsqueezy`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': signature }, body: raw });
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
    lastCode(email) {
      const message = [...sent].reverse().find((entry) => entry.to === email && /sign-in code/.test(entry.subject));
      const code = message && /^(\d{6}) is your/.exec(message.subject)?.[1];
      if (!code) throw new Error(`no code was emailed to ${email}`);
      return code;
    },
    async createAccount(email, fields = {}) {
      const result = await harness.admin('POST', '/accounts', { email, ...fields });
      if (result.status >= 300) throw new Error(`createAccount failed: ${JSON.stringify(result.body)}`);
      return result.body.account as Record<string, any>;
    },
    async signIn(email, device) {
      await call('POST', '/v1/auth/start', { email });
      return call('POST', '/v1/auth/verify', { email, code: harness.lastCode(email), device: { fingerprint: device.fingerprint, name: device.name ?? 'PC', platform: 'win32', appVersion: device.appVersion ?? '1.0.0' } });
    },
    heartbeat: (refreshToken, fingerprint, appVersion = '1.0.0') => call('POST', '/v1/devices/heartbeat', { refreshToken, fingerprint, appVersion }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cloud.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}
