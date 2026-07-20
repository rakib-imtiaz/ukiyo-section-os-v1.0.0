// Deterministic, LLM-free credential collector. A hand-coded Playwright step-machine drives a
// DEDICATED persistent Chrome profile (the user logs into Shopify once by hand — solving the
// hCaptcha themselves — and the session then persists, so later runs are captcha-free) through
// create-app → scopes → release → install → harvest, delivering the Client ID + Secret in-process.
//
// Trade-off vs the LLM bot: no token cost, no model latency, no refusals, and far faster — but
// SELECTOR-BRITTLE. Every fragile locator lives in the SELECTORS map below so a Shopify UI change
// is a one-file fix. This ships as a working skeleton; the selectors need live calibration against
// the real dev.shopify.com dashboard (see the plan's verification section).

import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { detectEngines } from '../browser';
import type { CollectorResult } from './partner-api';

export interface ScriptedInput {
  shop: string;            // full myshopify domain, e.g. acme.myshopify.com
  handleName: string;      // the store handle (subdomain)
  appName: string;         // <project>_bot
  projectLabel: string;
  scopes: string;          // comma-separated AUTOPILOT_SCOPES
  profileDir: string;      // persistent profile dir (survives runs → stays logged in)
  log: (text: string) => void;
  onDone: (result: CollectorResult) => void | Promise<void>;
  onError: (message: string) => void;
}

export interface ScriptedHandle {
  abort: AbortController;
  close: () => Promise<void>;
}

// --- All fragile selectors in one place (the "one-file fix" when Shopify changes its UI) -------
const SELECTORS = {
  loginHost: /accounts\.shopify\.com|\/login|identity/i,
  dashboardReady: /dev\.shopify\.com\/dashboard/i,
  storesLink: 'a:has-text("Stores"), [href*="/stores"]',
  createAppButton: 'button:has-text("Create app"), a:has-text("Create app")',
  appNameInput: 'input[name*="name" i], input[aria-label*="name" i]',
  scopesTextarea: 'textarea, input[aria-label*="scope" i]',
  releaseButton: 'button:has-text("Release")',
  installButton: 'button:has-text("Install app"), a:has-text("Install app")',
  installConfirm: 'button:has-text("Install")',
  clientIdValue: '[aria-label*="Client ID" i], [data-client-id]',
  revealSecret: 'button:has-text("Reveal"), button[aria-label*="reveal" i]',
  clientSecretValue: '[aria-label*="Client secret" i], [data-client-secret]',
};

const DASHBOARD_URL = 'https://dev.shopify.com/dashboard';

const HEX32 = /\b[0-9a-f]{32}\b/i;
const SHPSS = /\bshpss_[A-Za-z0-9_-]+\b/;

export function runScriptedCollector(input: ScriptedInput): ScriptedHandle {
  const abort = new AbortController();
  let context: BrowserContext | null = null;
  const close = async () => { const c = context; context = null; if (c) await c.close().catch(() => {}); };

  void (async () => {
    const { log, shop, appName, scopes } = input;
    const throwIfAborted = () => { if (abort.signal.aborted) throw new Error('__aborted__'); };

    try {
      await mkdir(input.profileDir, { recursive: true });
      // Prefer the user's installed Chrome (channel) so fonts/plugins match a real browser and the
      // persisted login looks legitimate to Shopify; fall back to bundled Chromium.
      const chrome = detectEngines().find((e) => e.id === 'chrome' && e.available);
      context = await chromium.launchPersistentContext(input.profileDir, {
        headless: false,
        channel: chrome ? 'chrome' : undefined,
        viewport: { width: 1280, height: 900 },
        args: ['--no-first-run', '--no-default-browser-check'],
      });
      const page = context.pages()[0] ?? await context.newPage();

      // 1. Reach the dashboard; wait out a manual login if one appears.
      log('Opening the Shopify Dev Dashboard…');
      await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForDashboard(page, log, abort.signal);
      throwIfAborted();

      // 2. Verify this org owns the target store — matched by DOMAIN, never display name.
      log('Verifying the store is in this organization…');
      const owned = await orgOwnsStore(page, shop, log, abort.signal);
      if (!owned) { await input.onDone({ clientId: null, clientSecret: null, status: 'failed', note: `store ${shop} not found in any Dev Dashboard organization (checked by domain).` }); return; }

      // 3–5. Create/find app, set scopes, release, install. This is the selector-heavy stretch.
      log(`Preparing the app "${appName}"…`);
      await ensureApp(page, appName, scopes, shop, log, abort.signal);
      throwIfAborted();

      // 6. Harvest Client ID + Secret from Settings.
      log('Reading the app credentials…');
      const creds = await harvestCredentials(page, log, abort.signal);
      throwIfAborted();

      if (creds.clientId && creds.clientSecret) {
        await input.onDone({ clientId: creds.clientId, clientSecret: creds.clientSecret, status: 'delivered', note: null });
      } else if (creds.clientId) {
        await input.onDone({ clientId: creds.clientId, clientSecret: null, status: 'partial', note: 'Read the Client ID but could not reveal/read the Secret — copy it from the browser window.' });
      } else {
        await input.onDone({ clientId: null, clientSecret: null, status: 'partial', note: 'Reached the app but could not read the credentials automatically — the dashboard layout may have changed. Copy the keys from the browser window.' });
      }
    } catch (error) {
      if (error instanceof Error && error.message === '__aborted__') return; // stopped by user
      input.onError(error instanceof Error ? `Scripted bot failed: ${error.message}` : 'Scripted bot failed.');
    } finally {
      await close();
    }
  })();

  return { abort, close };
}

/** Poll until the dashboard is reachable, prompting the user to log in if a login page shows. */
async function waitForDashboard(page: Page, log: (t: string) => void, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 6 * 60_000;
  let announced = false;
  while (Date.now() < deadline) {
    if (signal.aborted) return;
    const url = page.url();
    if (SELECTORS.dashboardReady.test(url)) return;
    if (SELECTORS.loginHost.test(url)) {
      if (!announced) { log('WAITING FOR LOGIN — please log in in the ThemeBot window; the bot continues automatically once you are in.'); announced = true; }
    }
    await page.waitForTimeout(3000).catch(() => {});
    // Nudge back toward the dashboard once the login host is gone.
    if (!SELECTORS.dashboardReady.test(page.url()) && !SELECTORS.loginHost.test(page.url())) {
      await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }
  throw new Error('timed out waiting for the Dev Dashboard (not logged in?)');
}

/** Check whether the current org's Stores list contains the target DOMAIN. Best-effort: reads the
 *  full stores page text (renamed stores keep their domain, so we never match on display name). */
async function orgOwnsStore(page: Page, shop: string, log: (t: string) => void, signal: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal.aborted) return false;
    await page.goto('https://dev.shopify.com/dashboard/stores', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500).catch(() => {});
    const body = (await page.textContent('body').catch(() => '')) ?? '';
    if (body.includes(shop)) return true;
    // Not here — try switching organization (best-effort; org-switcher UI varies).
    const switched = await tryNextOrg(page, log).catch(() => false);
    if (!switched) break;
  }
  return false;
}

async function tryNextOrg(page: Page, log: (t: string) => void): Promise<boolean> {
  const switcher = page.locator('button:has-text("organization"), [aria-label*="organization" i]').first();
  if (!(await switcher.isVisible().catch(() => false))) return false;
  log('Store not in this organization — trying the next one…');
  await switcher.click().catch(() => {});
  const option = page.getByRole('menuitem').nth(1);
  if (!(await option.isVisible().catch(() => false))) return false;
  await option.click().catch(() => {});
  await page.waitForTimeout(1500).catch(() => {});
  return true;
}

/** Create the app if missing, set scopes, and release. Selector-heavy — logs each sub-step so a
 *  failure points at exactly where the dashboard layout diverged. */
async function ensureApp(page: Page, appName: string, scopes: string, shop: string, log: (t: string) => void, signal: AbortSignal): Promise<void> {
  await page.goto('https://dev.shopify.com/dashboard/apps', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1200).catch(() => {});
  const existing = page.getByText(appName, { exact: true }).first();
  if (await existing.isVisible().catch(() => false)) {
    log(`Reusing existing app "${appName}".`);
    await existing.click().catch(() => {});
  } else {
    log(`Creating app "${appName}"…`);
    await page.locator(SELECTORS.createAppButton).first().click().catch(() => {});
    await page.locator(SELECTORS.appNameInput).first().fill(appName).catch(() => {});
    await page.getByRole('button', { name: /create/i }).first().click().catch(() => {});
    await page.waitForTimeout(1500).catch(() => {});
  }
  if (signal.aborted) return;

  // Scopes: type the comma-separated list into the access-scopes field, then Release (blank name).
  log('Setting access scopes…');
  const scopeField = page.locator(SELECTORS.scopesTextarea).first();
  if (await scopeField.isVisible().catch(() => false)) {
    await scopeField.fill(scopes).catch(() => {});
  } else {
    log('Could not find the scopes field — it may be behind a "Select scopes" dialog; skipping (calibrate SELECTORS.scopesTextarea).');
  }
  const release = page.locator(SELECTORS.releaseButton).first();
  if (await release.isVisible().catch(() => false)) { await release.click().catch(() => {}); await page.getByRole('button', { name: /release/i }).last().click().catch(() => {}); }

  // Install on the store (never touch billing).
  log('Installing the app on the store…');
  const install = page.locator(SELECTORS.installButton).first();
  if (await install.isVisible().catch(() => false)) {
    await install.click().catch(() => {});
    await page.waitForTimeout(1000).catch(() => {});
    await page.locator(SELECTORS.installConfirm).first().click().catch(() => {});
  }
  await page.waitForTimeout(1200).catch(() => {});
}

/** Read Client ID + Secret from the app's Settings tab. Falls back to scraping the page text for a
 *  32-hex id and a shpss_ secret if the specific value selectors miss. */
async function harvestCredentials(page: Page, log: (t: string) => void, signal: AbortSignal): Promise<{ clientId: string | null; clientSecret: string | null }> {
  await page.getByRole('tab', { name: /settings/i }).first().click().catch(() => {});
  await page.waitForTimeout(800).catch(() => {});
  // Reveal the secret if there's a reveal control.
  const reveal = page.locator(SELECTORS.revealSecret).first();
  if (await reveal.isVisible().catch(() => false)) { await reveal.click().catch(() => {}); await page.waitForTimeout(400).catch(() => {}); }
  if (signal.aborted) return { clientId: null, clientSecret: null };

  const body = (await page.textContent('body').catch(() => '')) ?? '';
  const clientId = HEX32.exec(body)?.[0] ?? null;
  const clientSecret = SHPSS.exec(body)?.[0] ?? null;
  if (!clientId) log('Could not locate a Client ID on the Settings page (calibrate SELECTORS.clientIdValue).');
  if (!clientSecret) log('Could not locate a revealed Client Secret (calibrate SELECTORS.revealSecret / clientSecretValue).');
  return { clientId, clientSecret };
}
