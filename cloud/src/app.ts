// Assembles the ThemeBot Cloud HTTP API. index.ts runs it; tests build it with their own clock,
// mailer and data folder and listen on port 0.
//
//   /v1/health, /v1/public-key          public
//   /v1/webhooks/lemonsqueezy           signed by Lemon Squeezy (raw body)
//   /v1/auth/start, /v1/auth/verify     email-code sign-in
//   /v1/devices/heartbeat|signout|release   a signed-in install (refresh token)
//   /v1/session                         a valid pass (the pattern the build and QA routes follow)
//   /v1/qa/*                            QA scoring (a valid pass; its own 8 MB parser — src/qa)
//   /v1/builds/*                        the recipe, one step at a time (a valid pass; watermarked — src/steps)
//   /v1/admin/security/*                anomaly flags, events, leak lookup (ADMIN_TOKEN; 1 MB parser)
//   /v1/admin/*                         ADMIN_TOKEN
//
// Body parsers: the webhooks (raw), QA (8 MB) and admin security (1 MB) routers parse their own
// bodies AFTER their auth check, so they are mounted before the app-wide 16 kB JSON parser — which
// would otherwise answer 413 to every large QA capture or leaked text. Everything else (auth,
// devices, admin, builds) takes small bodies through the 16 kB parser. Every parser inflates gzip.
import express from 'express';
import { publicAccount } from './accounts';
import { adminRouter } from './admin';
import { authRouter } from './auth';
import type { CloudConfig } from './config';
import { consoleLog, handle, type CloudContext, type CloudLog } from './context';
import { CloudDb } from './db';
import { devicesRouter } from './devices';
import { createMailer, type Mailer } from './mailer';
import { errorHandler, notFound, requirePass, securityHeaders, type PassLocals } from './middleware';
import { rawPublicKey } from './passes';
import { pruneQaRounds, registerQaRoutes } from './qa';
import { RateLimiter, limitByIp } from './rate-limit';
import { pruneSecurityEvents, registerSecurityRoutes } from './security';
import { registerStepRoutes } from './steps';
import { createPromptDecorator } from './watermark';
import { webhooksRouter } from './webhooks';

export interface CreateCloudOptions {
  config: CloudConfig;
  now?: () => number;
  mailer?: Mailer;
  log?: CloudLog;
}

export function createCloud(options: CreateCloudOptions) {
  const { config } = options;
  const log = options.log ?? consoleLog(config.production);
  const now = options.now ?? Date.now;
  const db = new CloudDb(config.dbFile);
  const ctx: CloudContext = { config, db, now, mailer: options.mailer ?? createMailer(config, log), limiter: new RateLimiter(now), log };
  const publicKey = rawPublicKey(config.signingKey);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders(config.production));
  app.use(limitByIp(ctx, 'global', 1200, 5 * 60_000));

  app.get('/v1/health', (_request, response) => { response.json({ ok: true, name: 'ThemeBot Cloud', time: new Date(now()).toISOString() }); });
  /** The key the desktop app pins at build time (THEMEBOT_CLOUD_PUBKEY) to verify passes. */
  app.get('/v1/public-key', (_request, response) => { response.json({ algorithm: 'Ed25519', publicKey }); });

  app.use('/v1/webhooks', webhooksRouter(ctx)); // raw body — must come before the JSON parser
  // Large bodies, each router with its own parser behind its auth check (creates its tables too):
  registerQaRoutes(app, ctx); // /v1/qa — pass, then up to 8 MB of captured evidence
  registerSecurityRoutes(app, ctx); // /v1/admin/security — admin token, then up to 1 MB (leaked texts)
  app.use(express.json({ limit: '16kb' }));
  app.use('/v1/auth', authRouter(ctx));
  app.use('/v1/devices', devicesRouter(ctx));
  /** GET /v1/session (Authorization: Pass …) → who the pass belongs to. Also a link check for the app. */
  app.get('/v1/session', requirePass(ctx), handle((_request, response) => {
    const { pass, account, device } = response.locals as PassLocals;
    response.json({ account: publicAccount(account), device: { id: device.id, name: device.name }, passExpiresAt: new Date(pass.exp * 1000).toISOString() });
  }));
  app.use('/v1/admin', adminRouter(ctx));
  // The recipe, one step at a time; every prompt is watermarked for the account/build/step it goes to.
  registerStepRoutes(app, ctx, { decoratePrompt: createPromptDecorator(db, { secret: config.pepper, now, log }) });
  app.use(notFound);
  app.use(errorHandler(ctx));

  // Housekeeping: forget stale rate-limit windows; hourly, prune old codes, passes, revoked tokens
  // (90 d+) and rotated tokens a week after their successor was used (db.ts prune),
  // scored QA rounds (90 d) and security events (30 d). Watermark send logs are kept: a leak can
  // surface months later (docs/SECURITY.md).
  let ticks = 0;
  const prune = () => {
    const at = now();
    for (const [name, run] of [['core', () => db.prune(at)], ['qa rounds', () => pruneQaRounds(db, at)], ['security events', () => pruneSecurityEvents(db, at)]] as const) {
      try { run(); } catch (error) { log.error(`prune failed (${name})`, { error: error instanceof Error ? error.message : String(error) }); }
    }
  };
  prune();
  const housekeeping = setInterval(() => { ctx.limiter.sweep(); ticks += 1; if (ticks % 12 === 0) prune(); }, 5 * 60_000);
  housekeeping.unref();

  return {
    app,
    ctx,
    publicKey,
    close() { clearInterval(housekeeping); db.close(); },
  };
}
