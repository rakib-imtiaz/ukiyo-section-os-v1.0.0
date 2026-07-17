import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

const production = process.env.NODE_ENV === 'production';

function value(name: string, fallback = '') {
  return process.env[name]?.trim() || fallback;
}

function secret(name: string, developmentFallback: string) {
  const resolved = value(name, production ? '' : developmentFallback);
  if (!resolved) throw new Error(`${name} is required in production.`);
  return resolved;
}

function encryptionKey() {
  const configured = value('APP_ENCRYPTION_KEY');
  if (configured) {
    const decoded = Buffer.from(configured, 'base64');
    if (decoded.length === 32) return decoded;
    if (production) throw new Error('APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return createHash('sha256').update('section-os-development-encryption-key').digest();
}

export const config = {
  production,
  port: Number(value('PORT', '8787')),
  appUrl: value('APP_URL', 'http://localhost:8787').replace(/\/$/, ''),
  databaseUrl: value('DATABASE_URL'),
  shopify: {
    clientId: value('SHOPIFY_CLIENT_ID'),
    clientSecret: value('SHOPIFY_CLIENT_SECRET'),
    scopes: value('SHOPIFY_SCOPES', 'read_themes,write_themes'),
    apiVersion: value('SHOPIFY_API_VERSION', '2026-07'),
    legacyShop: value('SHOPIFY_SHOP'),
    legacyToken: value('SHOPIFY_ADMIN_ACCESS_TOKEN'),
  },
  security: {
    encryptionKey: encryptionKey(),
    sessionSecret: secret('SESSION_SECRET', 'section-os-development-session-secret-change-me'),
    apiKeyPepper: secret('API_KEY_PEPPER', 'section-os-development-api-pepper-change-me'),
    cookieSecure: production,
  },
  billing: {
    enabled: value('BILLING_ENABLED', 'false') === 'true',
    planName: value('SHOPIFY_PLAN_NAME', 'Section OS Pro'),
    price: Number(value('SHOPIFY_PLAN_PRICE', '0')),
    currency: value('SHOPIFY_PLAN_CURRENCY', 'USD'),
    trialDays: Number(value('SHOPIFY_PLAN_TRIAL_DAYS', '14')),
  },
  // Clone Factory — local operator tool: disabled in production unless explicitly enabled.
  factory: {
    enabled: value('FACTORY_ENABLED', production ? 'false' : 'true') === 'true',
    workspaceRoot: value('FACTORY_WORKSPACE_ROOT', 'C:/patrick_workspace/shopify_works'),
    claudePath: value('FACTORY_CLAUDE_PATH', path.join(homedir(), '.local', 'bin', 'claude.exe')),
    playwrightRoot: value('FACTORY_PW_ROOT', 'C:/patrick_workspace/qa/node_modules'),
    defaultConcurrency: Number(value('FACTORY_CONCURRENCY', '2')),
    launchStaggerSec: Number(value('FACTORY_LAUNCH_STAGGER_SEC', '90')),
    inactivityTimeoutMin: Number(value('FACTORY_INACTIVITY_TIMEOUT_MIN', '20')),
    cloneTimeoutMin: Number(value('FACTORY_CLONE_TIMEOUT_MIN', '240')),
    fixTimeoutMin: Number(value('FACTORY_FIX_TIMEOUT_MIN', '60')),
    qaTimeoutMin: Number(value('FACTORY_QA_TIMEOUT_MIN', '30')),
  },
  // Integrated PTY terminal — LOCAL OPERATOR TOOL. A browser-reachable real shell:
  // enabled in dev, OFF in production, and connections are localhost-only (see terminal.ts).
  terminal: {
    enabled: value('TERMINAL_ENABLED', production ? 'false' : 'true') === 'true',
    cwd: value('TERMINAL_CWD', path.resolve('.')),
    shell: value('TERMINAL_SHELL', ''),
  },
  // Integrated browser — LOCAL OPERATOR TOOL. A managed Playwright browser streamed into
  // the app (live view + Claude-drivable via local MCP). Enabled in dev, OFF in production,
  // localhost-only (see browser.ts). engine: auto | chromium (isolated) | chrome | msedge.
  browser: {
    enabled: value('BROWSER_ENABLED', production ? 'false' : 'true') === 'true',
    engine: value('BROWSER_ENGINE', 'auto'),
    headless: value('BROWSER_HEADLESS', 'true') === 'true',
    width: Number(value('BROWSER_WIDTH', '1280')),
    height: Number(value('BROWSER_HEIGHT', '800')),
    startUrl: value('BROWSER_START_URL', 'https://www.google.com'),
    // Persistent profile: cookies/sign-ins/extension state survive stop/start and app restarts.
    // MUST live outside the project tree — Chrome writes here constantly and the dev file-watcher
    // (vite / node --watch) crashes with EBUSY if it tries to watch these churning files.
    profileDir: value('BROWSER_PROFILE_DIR', path.join(homedir(), '.themebot', 'browser-profile')),
    // Extra unpacked extension dirs (';'-separated). The Claude extension is auto-detected
    // from the user's real Chrome profiles on top of these.
    extensions: value('BROWSER_EXTENSIONS', ''),
  },
};

export function validateProductionConfig() {
  if (!production) return;
  const missing = [
    ['DATABASE_URL', config.databaseUrl],
    ['SHOPIFY_CLIENT_ID', config.shopify.clientId],
    ['SHOPIFY_CLIENT_SECRET', config.shopify.clientSecret],
    ['APP_URL', config.appUrl],
  ].filter(([, configured]) => !configured).map(([name]) => name);
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(', ')}.`);
  if (!config.appUrl.startsWith('https://')) throw new Error('APP_URL must use HTTPS in production.');
  if (config.billing.enabled && config.billing.price <= 0) throw new Error('SHOPIFY_PLAN_PRICE must be greater than zero when billing is enabled.');
}
