// Test harness for the step engine: the real Cloud (createCloud) on port 0 with a temp data folder,
// with a second registerStepRoutes mounted in FRONT of it so each test picks its own prompt
// decorator (default: identity — the prompts come out exactly as rendered). cloud/src/app.ts wires
// the real thing (watermark decorator); tests/integration-e2e.test.ts exercises that one. The
// front mount gets its own 16 KB JSON parser scoped to /v1/builds, so the app's other routers (QA's
// 8 MB parser, …) still see their bodies first.
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createCloud } from '../src/app';
import { loadConfig } from '../src/config';
import type { MailMessage } from '../src/mailer';
import { errorHandler } from '../src/middleware';
import { registerStepRoutes, type PromptDecorator } from '../src/steps';

export const ADMIN = 'test-admin-token-0123456789abcdef';
export const START = Date.parse('2026-10-01T12:00:00Z');
export const MINUTE = 60_000;
export const FP_A = 'a'.repeat(64);
export const FP_B = 'b'.repeat(64);

const silent = { info() {}, warn() {}, error() {} };

type Reply = { status: number; body: Record<string, any> };

export interface StepsCloud {
  base: string;
  publicKey: string;
  now(): number;
  advance(ms: number): void;
  call(method: string, route: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
  admin(method: string, route: string, body?: unknown): Promise<Reply>;
  /** Creates an account, signs a device in and returns a fresh pass for it. */
  account(email: string, fingerprint?: string): Promise<{ accountId: string; pass: string; refreshToken: string; fingerprint: string }>;
  /** A fresh pass for an already signed-in device. */
  pass(refreshToken: string, fingerprint: string): Promise<string>;
  /** Calls a /v1/builds route with a pass. */
  builds(pass: string, method: string, route: string, body?: unknown): Promise<Reply>;
  close(): Promise<void>;
}

/** clock 'fixed' starts at START and moves only with advance(); 'real' follows Date.now (needed when
 *  the desktop-side pass check, which uses the real clock, verifies the passes). */
export async function startStepsCloud(options: { clock?: 'fixed' | 'real'; decoratePrompt?: PromptDecorator } = {}): Promise<StepsCloud> {
  const dir = mkdtempSync(path.join(tmpdir(), 'tb-steps-cloud-'));
  let clock = START;
  const now = options.clock === 'real' ? () => Date.now() + (clock - START) : () => clock;
  const sent: MailMessage[] = [];
  const config = loadConfig({ NODE_ENV: 'test', CLOUD_DATA_DIR: dir, ADMIN_TOKEN: ADMIN });
  const cloud = createCloud({ config, now, mailer: { async send(message) { sent.push(message); } }, log: silent });

  const app = express();
  app.disable('x-powered-by');
  app.use('/v1/builds', express.json({ limit: '16kb' }));
  registerStepRoutes(app, cloud.ctx, { decoratePrompt: options.decoratePrompt });
  app.use(cloud.app);
  app.use(errorHandler(cloud.ctx));
  const server = await new Promise<Server>((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call: StepsCloud['call'] = async (method, route, body, headers = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    return { status: response.status, body: raw ? JSON.parse(raw) as Record<string, any> : {} };
  };
  const admin: StepsCloud['admin'] = (method, route, body) => call(method, `/v1/admin${route}`, body, { Authorization: `Bearer ${ADMIN}` });
  const lastCode = (email: string) => {
    const message = [...sent].reverse().find((entry) => entry.to === email && /sign-in code/.test(entry.subject));
    const code = message && /^(\d{6}) is your/.exec(message.subject)?.[1];
    if (!code) throw new Error(`no code was emailed to ${email}`);
    return code;
  };
  const pass: StepsCloud['pass'] = async (refreshToken, fingerprint) => {
    const beat = await call('POST', '/v1/devices/heartbeat', { refreshToken, fingerprint, appVersion: '1.0.0' });
    if (beat.status !== 200) throw new Error(`heartbeat failed: ${JSON.stringify(beat.body)}`);
    return beat.body.pass as string;
  };

  return {
    base, publicKey: cloud.publicKey,
    now,
    advance(ms) { clock += ms; },
    call, admin, pass,
    async account(email, fingerprint = FP_A) {
      const created = await admin('POST', '/accounts', { email, seats: 3 });
      if (created.status >= 300) throw new Error(`createAccount failed: ${JSON.stringify(created.body)}`);
      await call('POST', '/v1/auth/start', { email });
      const verified = await call('POST', '/v1/auth/verify', { email, code: lastCode(email), device: { fingerprint, name: 'PC', platform: 'win32', appVersion: '1.0.0' } });
      if (verified.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(verified.body)}`);
      const refreshToken = verified.body.refreshToken as string;
      return { accountId: created.body.account.id as string, refreshToken, fingerprint, pass: await pass(refreshToken, fingerprint) };
    },
    builds: (token, method, route, body) => call(method, `/v1/builds${route}`, body, { Authorization: `Pass ${token}` }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cloud.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A build request like the desktop app sends. */
export function buildRequest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Wild & Sacred', prefix: 'ws', storeHost: 'wild-sacred.myshopify.com', reactUrl: 'https://wild-sacred.example.com',
    root: 'C:\\builds\\wild_sacred', devThemeName: 'Wild & Sacred Clone (dev)', qaEngine: 'playwright', appVersion: '1.0.0',
    ...overrides,
  };
}

export const PAGES = [
  { route: '/', name: 'Home', handle: '', template: 'index.json', file: 'src/pages/HomePage.tsx', bands: 7, model: 'opus' },
  { route: '/about', name: 'About', handle: 'about', template: 'page.ws_about.json', file: 'src/pages/AboutPage.tsx', bands: 3, model: 'sonnet' },
  { route: '/our-team', handle: 'our-team', file: 'src/pages/OurTeamPage.tsx', bands: 5 },
];
