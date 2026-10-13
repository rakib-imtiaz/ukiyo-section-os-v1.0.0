// ThemeBot Cloud — entry point. `npm run cloud:dev` (or: node --import tsx cloud/src/index.ts).
// See docs/DESKTOP.md ("ThemeBot Cloud") for the environment variables and admin calls.
import type { Server } from 'node:http';
import { createCloud } from './app';
import { loadConfig } from './config';
import { lemonSqueezyStartupWarnings } from './webhooks';

const config = loadConfig();
const cloud = createCloud({ config });
const { log } = cloud.ctx;

const server: Server = cloud.app.listen(config.port, config.host, () => {
  log.info(`ThemeBot Cloud listening on http://${config.host}:${config.port}`, { production: config.production });
  log.info('pass signing public key (build the app with THEMEBOT_CLOUD_PUBKEY set to this)', { publicKey: cloud.publicKey });
  if (!config.production) {
    log.info(`data folder: ${config.dataDir}`);
    log.info(`admin token: ${config.adminToken} (dev only — set ADMIN_TOKEN in production)`);
    if (!config.mail.resendApiKey) log.info('RESEND_API_KEY not set: sign-in codes are printed here instead of emailed');
  }
  if (!config.lemonSqueezy.webhookSecret) log.warn('LEMONSQUEEZY_WEBHOOK_SECRET not set: /v1/webhooks/lemonsqueezy answers 503');
  // No product allowlist in production: warn, don't refuse — purchases already grant nothing (fail
  // closed), and the admin variantSeats setting (in the database) can supply the list at runtime.
  for (const warning of lemonSqueezyStartupWarnings(cloud.ctx)) log.warn(warning);
  if (!config.adminToken) log.warn('ADMIN_TOKEN not set: the admin API is off');
  // Behind Caddy every request comes from the proxy: without trust proxy all customers share one
  // rate-limit bucket (one person can lock everyone out of sign-in); with `true` any client can
  // pick its own address through X-Forwarded-For if the proxy appends to it.
  if (config.production && config.trustProxy === false) log.warn('CLOUD_TRUST_PROXY not set: behind a reverse proxy every client shares one rate-limit bucket — set it to the number of proxies (1 behind Caddy)');
  if (config.trustProxy === true) log.warn('CLOUD_TRUST_PROXY=true trusts every X-Forwarded-For hop (clients can spoof their address); set the number of proxies instead (1 behind Caddy)');
});
server.on('error', (error) => { log.error('server error', { error: error.message }); process.exit(1); });

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info(`${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(() => { cloud.close(); process.exit(0); });
  server.closeIdleConnections();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
