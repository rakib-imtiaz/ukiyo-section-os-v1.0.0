// Test harness for the QA scoring API: the real Cloud app (cloud/src/app.ts mounts the QA routes
// before its app-wide 16 kB JSON parser) on port 0, a real-time clock (so the desktop's pass check
// agrees with the Cloud's), captured emails and a temp data folder.
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCloud } from '../src/app';
import { loadConfig } from '../src/config';
import type { MailMessage } from '../src/mailer';

const ADMIN = 'qa-test-admin-token-0123456789abcdef';
const silent = { info() {}, warn() {}, error() {} };

export interface QaTestCloud {
  base: string;
  publicKey: string;
  ctx: ReturnType<typeof createCloud>['ctx'];
  advance(ms: number): void;
  call(method: string, route: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Record<string, any>; bytes: number }>;
  /** Creates an account, signs a device in and returns a fresh pass for it. */
  pass(email?: string, fingerprint?: string): Promise<string>;
  /** POST to a QA route with a pass. */
  qa(route: string, body: unknown, pass: string): Promise<{ status: number; body: Record<string, any>; bytes: number }>;
  close(): Promise<void>;
}

export async function startQaCloud(): Promise<QaTestCloud> {
  const dir = mkdtempSync(path.join(tmpdir(), 'tb-qa-cloud-test-'));
  let offset = 0;
  const now = () => Date.now() + offset;
  const sent: MailMessage[] = [];
  const config = loadConfig({ NODE_ENV: 'test', CLOUD_DATA_DIR: dir, ADMIN_TOKEN: ADMIN });
  const cloud = createCloud({ config, now, mailer: { async send(message) { sent.push(message); } }, log: silent });

  const app = cloud.app;
  const server = await new Promise<Server>((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call: QaTestCloud['call'] = async (method, route, body, headers = {}) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: payload,
    });
    const text = await response.text();
    let parsed: Record<string, any> = {};
    try { parsed = text ? JSON.parse(text) as Record<string, any> : {}; } catch { parsed = { raw: text }; }
    return { status: response.status, body: parsed, bytes: payload ? Buffer.byteLength(payload) : 0 };
  };

  let accounts = 0;
  const harness: QaTestCloud = {
    base,
    publicKey: cloud.publicKey,
    ctx: cloud.ctx,
    advance(ms) { offset += ms; },
    call,
    async pass(email = `qa${++accounts}@example.com`, fingerprint = 'f'.repeat(64)) {
      const created = await call('POST', '/v1/admin/accounts', { email, seats: 3 }, { Authorization: `Bearer ${ADMIN}` });
      if (created.status >= 300) throw new Error(`createAccount failed: ${JSON.stringify(created.body)}`);
      await call('POST', '/v1/auth/start', { email });
      const mail = [...sent].reverse().find((entry) => entry.to === email && /sign-in code/.test(entry.subject));
      const code = mail && /^(\d{6}) is your/.exec(mail.subject)?.[1];
      if (!code) throw new Error(`no code was emailed to ${email}`);
      const device = { fingerprint, name: 'QA PC', platform: 'win32', appVersion: '1.0.0' };
      const verified = await call('POST', '/v1/auth/verify', { email, code, device });
      if (verified.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(verified.body)}`);
      const beat = await call('POST', '/v1/devices/heartbeat', { refreshToken: verified.body.refreshToken, fingerprint, appVersion: '1.0.0' });
      if (beat.status !== 200) throw new Error(`heartbeat failed: ${JSON.stringify(beat.body)}`);
      return beat.body.pass as string;
    },
    qa: (route, body, pass) => call('POST', `/v1/qa${route}`, body, { Authorization: `Pass ${pass}` }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cloud.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}
