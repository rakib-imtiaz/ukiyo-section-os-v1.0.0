// Deterministic, LLM-free credential collector. A hand-coded Playwright step-machine drives a
// DEDICATED persistent Chrome profile (the user logs into Shopify once by hand — solving the
// hCaptcha themselves — and the session then persists, so later runs are captcha-free) through
// create-app → scopes → release → install → harvest, delivering the Client ID + Secret in-process.
//
// Trade-off vs the LLM bot: no token cost, no model latency, no refusals, and far faster — but
// SELECTOR-BRITTLE. Every fragile locator lives in the SELECTORS map below so a Shopify UI change
// is a one-file fix.
//
// CALIBRATED 2026-07-22 against the live dev.shopify.com dashboard (Spring '26). Verified facts
// this file depends on — re-check these first if it breaks:
//   • dev.shopify.com/dashboard 302→ /dashboard/{ORG_ID}/apps. EVERY dashboard path is org-scoped;
//     the ORG_ID must be read out of the URL before anything else works.
//   • Create app: /dashboard/{ORG}/apps/new → "Start from Dev Dashboard" App-name box + Create →
//     redirects to /dashboard/{ORG}/apps/{APP_ID}/versions/new with a fresh Active version. APP_ID
//     is in the URL.
//   • The version editor has TWO scope textareas: required (first) then Optional. Fill the first.
//     A header "Release" button opens a "Release this new version?" dialog whose own "Release"
//     submit button commits (name/message optional → blank is fine).
//   • Settings tab: Client ID is a readonly input holding a 32-hex string; a "Reveal client secret"
//     button flips the secret <input type=password> to a readable shpss_… value.
//   • Org-by-DOMAIN match (the renamed-store bug): the dashboard store list uses opaque handles
//     (zezzzp-pc) that do NOT equal the myshopify subdomain, so we match on the INSTALL picker
//     instead: admin.shopify.com/?organization_id={ORG}&no_redirect=true&redirect=
//     /oauth/redirect_from_developer_dashboard?client_id={CLIENT_ID} lists every store in the org
//     with its real *.myshopify.com domain as an oauth redirect link. Cross-org installs are
//     refused there with "can only be installed on stores that are part of the same organization",
//     which is exactly how we detect "store lives in a different org".

import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectEngines } from '../browser';
import type { CollectorResult } from './partner-api';

export interface ScriptedInput {
  shop: string;            // full myshopify domain, e.g. acme.myshopify.com
  handleName: string;      // the store handle (subdomain)
  appName: string;         // <project>_bot
  projectLabel: string;
  scopes: string;          // comma-separated AUTOPILOT_SCOPES
  profileDir: string;      // dedicated fallback profile (used only when useRealProfile is false)
  /** Reuse the user's everyday Chrome profile (already signed into Shopify → no login wall).
   *  Requires Chrome to be fully closed (Chrome locks a profile to one running instance). */
  useRealProfile?: boolean;
  /** Which Chrome profile DIRECTORY to open (e.g. "Default", "Profile 2"). Overrides the env
   *  default. Pick the one that's signed into the right Shopify account (see listChromeProfiles). */
  chromeProfile?: string;
  log: (text: string) => void;
  onDone: (result: CollectorResult) => void | Promise<void>;
  onError: (message: string) => void;
}

/** Standard Chrome "User Data" root per platform. THEMEBOT_CHROME_PROFILE overrides which profile
 *  directory inside it to open (default "Default") — set it if the Shopify login lives in another
 *  profile (e.g. "Profile 2"). We never READ the cookie store; Chrome decrypts its own cookies in
 *  place when Playwright opens the profile with the real Chrome channel. */
function chromeUserDataDir(): string | null {
  const home = os.homedir();
  const candidates: Record<string, string> = {
    win32: path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data'),
    darwin: path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    linux: path.join(home, '.config', 'google-chrome'),
  };
  const dir = candidates[process.platform];
  return dir && existsSync(dir) ? dir : null;
}

function realChromeProfile(override?: string): { userDataDir: string; profile: string } | null {
  const userDataDir = chromeUserDataDir();
  if (!userDataDir) return null;
  const profile = (override ?? process.env.THEMEBOT_CHROME_PROFILE ?? 'Default').trim() || 'Default';
  return { userDataDir, profile };
}

/** Enumerate the installed Chrome profiles so the wizard can let the user pick the one signed into
 *  the right Shopify account. Reads the "Local State" profile.info_cache — the app reading its own
 *  local config at runtime (dir name + the account label Chrome already shows in its own switcher). */
export function listChromeProfiles(): Array<{ dir: string; label: string }> {
  const userDataDir = chromeUserDataDir();
  if (!userDataDir) return [];
  try {
    const raw = readFileSync(path.join(userDataDir, 'Local State'), 'utf8');
    const cache = (JSON.parse(raw) as { profile?: { info_cache?: Record<string, { name?: string; user_name?: string; gaia_name?: string }> } }).profile?.info_cache ?? {};
    const rows = Object.entries(cache).map(([dir, info]) => {
      const email = info.user_name?.trim();
      const name = (info.gaia_name || info.name || '').trim();
      const label = [name, email].filter(Boolean).join(email && name ? ' · ' : '') || dir;
      return { dir, label: label === dir ? dir : `${label} (${dir})` };
    });
    // Default first, then Profile N in natural order.
    return rows.sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.dir.localeCompare(b.dir, undefined, { numeric: true })));
  } catch { return []; }
}

/** True if a Chrome process is currently running (which would lock the real profile). Best-effort:
 *  on failure we assume NOT running rather than blocking the run outright. */
function isChromeRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
      return /chrome\.exe/i.test(out);
    }
    const out = execFileSync('pgrep', ['-x', process.platform === 'darwin' ? 'Google Chrome' : 'chrome'], { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch { return false; }
}

export interface ScriptedHandle {
  abort: AbortController;
  close: () => Promise<void>;
}

// --- All fragile selectors in one place (the "one-file fix" when Shopify changes its UI) -------
const SELECTORS = {
  loginHost: /accounts\.shopify\.com|\/login|identity|\/lookup/i,
  // A resolved, org-scoped dashboard URL: /dashboard/<digits>/…  (the redirect target after login)
  dashboardOrg: /dev\.shopify\.com\/dashboard\/(\d+)(?:\/|$)/i,
  appNameInput: 'input[type="text"]',                              // the only text box on /apps/new
  createAppButton: 'button[type="submit"]',                        // "Create" beside the App-name box
  scopesTextarea: 'textarea',                                      // first textarea = required scopes
  releaseHeaderButton: 'button:has-text("Release")',              // opens the confirm dialog
  releaseConfirmButton: 'button[type="submit"]:has-text("Release")', // dialog commit
  revealSecretButton: 'button[aria-label="Reveal client secret"]',
  // Install picker (admin.shopify.com): one oauth redirect link per store in the org.
  installStoreLink: 'a[href*="/oauth/redirect_from_developer_dashboard"]',
  installButton: 'button:has-text("Install"), a:has-text("Install")',
  crossOrgError: /part of the same organization/i,
};

const DASHBOARD_URL = 'https://dev.shopify.com/dashboard';
const HEX32 = /^[0-9a-f]{32}$/i;
const SHPSS = /^shpss_[A-Za-z0-9_-]+$/;

export function runScriptedCollector(input: ScriptedInput): ScriptedHandle {
  const abort = new AbortController();
  let context: BrowserContext | null = null;
  const close = async () => { const c = context; context = null; if (c) await c.close().catch(() => {}); };

  void (async () => {
    const { log, shop, appName, scopes } = input;
    const throwIfAborted = () => { if (abort.signal.aborted) throw new Error('__aborted__'); };

    try {
      const chrome = detectEngines().find((e) => e.id === 'chrome' && e.available);
      const real = input.useRealProfile ? realChromeProfile(input.chromeProfile) : null;

      if (input.useRealProfile && real) {
        // Reuse the user's everyday, already-signed-in Chrome profile → no login wall. Chrome locks
        // a profile to one running instance, so it must be fully closed first.
        if (isChromeRunning()) {
          await input.onDone({ clientId: null, clientSecret: null, status: 'failed', note: 'Please fully close Google Chrome (every window), then click Run again — the bot needs exclusive access to your signed-in profile. Your session stays intact; it reopens your own profile.' });
          return;
        }
        log(`Opening your Chrome profile "${real.profile}" (already signed in — no login needed)…`);
        context = await chromium.launchPersistentContext(real.userDataDir, {
          headless: false,
          channel: chrome ? 'chrome' : undefined,
          viewport: { width: 1280, height: 900 },
          args: [`--profile-directory=${real.profile}`, '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble'],
        });
      } else {
        if (input.useRealProfile && !real) log('Could not locate your Chrome profile — falling back to the ThemeBot profile (a one-time login may be needed).');
        await mkdir(input.profileDir, { recursive: true });
        // Dedicated fallback profile: a one-time manual Shopify login persists here across runs.
        context = await chromium.launchPersistentContext(input.profileDir, {
          headless: false,
          channel: chrome ? 'chrome' : undefined,
          viewport: { width: 1280, height: 900 },
          args: ['--no-first-run', '--no-default-browser-check'],
        });
      }
      const page = context.pages()[0] ?? await context.newPage();

      // 1. Reach the dashboard; wait out a manual login if one appears; read the org id.
      log('Opening the Shopify Dev Dashboard…');
      await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const orgId = await waitForDashboardOrg(page, log, abort.signal);
      throwIfAborted();
      if (!orgId) { await input.onDone({ clientId: null, clientSecret: null, status: 'failed', note: 'Could not reach your Dev Dashboard (still on a login page after 6 minutes?).' }); return; }
      log(`In organization ${orgId}. Preparing the app…`);

      // 2–3. Create (or reuse) the app in this org, capture its id.
      const appId = await ensureApp(page, orgId, appName, log, abort.signal);
      throwIfAborted();
      if (!appId) { await input.onDone({ clientId: null, clientSecret: null, status: 'failed', note: 'Could not create the app in the Dev Dashboard (layout may have changed — calibrate SELECTORS.createAppButton).' }); return; }

      // 4. Add scopes + release a version.
      await setScopesAndRelease(page, orgId, appId, scopes, log, abort.signal);
      throwIfAborted();

      // 5. Read Client ID + Secret from Settings (needed BEFORE install — the install picker is
      //    keyed by client_id).
      log('Reading the app credentials…');
      const creds = await harvestCredentials(page, orgId, appId, log, abort.signal);
      throwIfAborted();
      if (!creds.clientId) { await input.onDone({ clientId: null, clientSecret: null, status: 'partial', note: 'Reached the app but could not read the Client ID — copy the keys from the browser window.' }); return; }

      // 6. Install on the target store, matched by DOMAIN in the org's install picker.
      const installed = await installOnStore(page, orgId, creds.clientId, shop, log, abort.signal);
      throwIfAborted();
      if (installed === 'cross-org') {
        await input.onDone({ clientId: creds.clientId, clientSecret: creds.clientSecret, status: 'partial', note: `Got the keys, but ${shop} is in a DIFFERENT organization than this app — install it manually, or re-run after switching to that store's org in the ThemeBot window.` });
        return;
      }
      if (installed === 'no-plan') {
        await input.onDone({ clientId: creds.clientId, clientSecret: creds.clientSecret, status: 'partial', note: `Got the keys, but "Install" is disabled on ${shop} — activate the $1/month starter plan on that store, then install.` });
        return;
      }
      if (installed === 'not-found') {
        await input.onDone({ clientId: creds.clientId, clientSecret: creds.clientSecret, status: 'partial', note: `Got the keys, but ${shop} was not in this organization's store list — install manually if needed.` });
        return;
      }

      if (creds.clientId && creds.clientSecret) {
        await input.onDone({ clientId: creds.clientId, clientSecret: creds.clientSecret, status: 'delivered', note: null });
      } else {
        await input.onDone({ clientId: creds.clientId, clientSecret: null, status: 'partial', note: 'Read the Client ID and installed the app, but could not reveal the Secret — copy it from the browser window.' });
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

/** Poll until an org-scoped dashboard URL is reached, prompting the user to log in if a login page
 *  shows. Returns the org id (digits) or null on timeout. */
async function waitForDashboardOrg(page: Page, log: (t: string) => void, signal: AbortSignal): Promise<string | null> {
  const deadline = Date.now() + 6 * 60_000;
  let announced = false;
  while (Date.now() < deadline) {
    if (signal.aborted) return null;
    const org = SELECTORS.dashboardOrg.exec(page.url());
    if (org) return org[1];
    if (SELECTORS.loginHost.test(page.url())) {
      if (!announced) { log('WAITING FOR LOGIN — please log in in the ThemeBot window; the bot continues automatically once you are in.'); announced = true; }
    } else {
      // On the dashboard but not yet org-scoped (or a blank tab) — nudge toward the dashboard root.
      await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const org2 = SELECTORS.dashboardOrg.exec(page.url());
      if (org2) return org2[1];
    }
    await page.waitForTimeout(3000).catch(() => {});
  }
  return null;
}

/** Create the app (or reuse one already named appName) and return its numeric app id. */
async function ensureApp(page: Page, orgId: string, appName: string, log: (t: string) => void, signal: AbortSignal): Promise<string | null> {
  // Reuse: search the apps list for an existing <name>_bot before creating a duplicate.
  await page.goto(`https://dev.shopify.com/dashboard/${orgId}/apps`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1200).catch(() => {});
  const existing = page.locator(`a[href*="/apps/"]`, { hasText: appName }).first();
  if (await existing.isVisible().catch(() => false)) {
    const href = await existing.getAttribute('href').catch(() => null);
    const id = href && /\/apps\/(\d+)/.exec(href)?.[1];
    if (id) { log(`Reusing existing app "${appName}" (${id}).`); return id; }
  }
  if (signal.aborted) return null;

  log(`Creating app "${appName}"…`);
  await page.goto(`https://dev.shopify.com/dashboard/${orgId}/apps/new`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1000).catch(() => {});
  // "Start from Dev Dashboard" card: an App-name box + a Create submit button.
  await page.locator(SELECTORS.appNameInput).last().fill(appName).catch(() => {});
  await page.locator(SELECTORS.createAppButton).last().click().catch(() => {});
  // Success lands on /apps/{id}/versions/new.
  await page.waitForURL(/\/apps\/\d+\/versions\/new/, { timeout: 20_000 }).catch(() => {});
  const id = /\/apps\/(\d+)\//.exec(page.url())?.[1] ?? null;
  return id;
}

/** On the version editor: fill the required-scopes textarea and release (blank version name). */
async function setScopesAndRelease(page: Page, orgId: string, appId: string, scopes: string, log: (t: string) => void, signal: AbortSignal): Promise<void> {
  if (!/\/versions\/new/.test(page.url())) {
    await page.goto(`https://dev.shopify.com/dashboard/${orgId}/apps/${appId}/versions/new`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1200).catch(() => {});
  }
  if (signal.aborted) return;
  log('Setting access scopes…');
  const scopeField = page.locator(SELECTORS.scopesTextarea).first();
  if (await scopeField.isVisible().catch(() => false)) {
    await scopeField.fill(scopes).catch(() => {});
  } else {
    log('Could not find the scopes field — calibrate SELECTORS.scopesTextarea.');
  }

  log('Releasing the version…');
  await page.locator(SELECTORS.releaseHeaderButton).first().click().catch(() => {}); // opens dialog
  await page.waitForTimeout(800).catch(() => {});
  // Dialog "Release this new version?" → its own Release submit (leave name/message blank).
  const confirm = page.locator(SELECTORS.releaseConfirmButton).last();
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click().catch(() => {});
  } else {
    // Fallback: any visible submit inside the dialog.
    await page.getByRole('button', { name: /^release$/i }).last().click().catch(() => {});
  }
  await page.waitForTimeout(2000).catch(() => {});
}

/** Read Client ID + Secret from the app's Settings tab. */
async function harvestCredentials(page: Page, orgId: string, appId: string, log: (t: string) => void, signal: AbortSignal): Promise<{ clientId: string | null; clientSecret: string | null }> {
  await page.goto(`https://dev.shopify.com/dashboard/${orgId}/apps/${appId}/settings`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1200).catch(() => {});
  if (signal.aborted) return { clientId: null, clientSecret: null };

  // Reveal the secret so its <input> value becomes readable.
  const reveal = page.locator(SELECTORS.revealSecretButton).first();
  if (await reveal.isVisible().catch(() => false)) { await reveal.click().catch(() => {}); await page.waitForTimeout(500).catch(() => {}); }

  // Read every input value and classify by shape (order-independent, robust to layout changes).
  const values = await page.locator('input').evaluateAll((els) => (els as HTMLInputElement[]).map((el) => el.value)).catch(() => [] as string[]);
  const clientId = values.find((v) => HEX32.test(v)) ?? null;
  const clientSecret = values.find((v) => SHPSS.test(v)) ?? null;
  if (!clientId) log('Could not read a Client ID on the Settings page (calibrate the harvest step).');
  if (!clientSecret) log('Could not read a revealed Client Secret (calibrate SELECTORS.revealSecretButton).');
  return { clientId, clientSecret };
}

/** Install the app on the target store, matched by DOMAIN in the org's install picker.
 *  Returns 'ok' | 'cross-org' | 'no-plan' | 'not-found'. */
async function installOnStore(page: Page, orgId: string, clientId: string, shop: string, log: (t: string) => void, signal: AbortSignal): Promise<'ok' | 'cross-org' | 'no-plan' | 'not-found'> {
  log(`Installing on ${shop}…`);
  const pickerUrl = `https://admin.shopify.com/?organization_id=${orgId}&no_redirect=true&redirect=${encodeURIComponent(`/oauth/redirect_from_developer_dashboard?client_id=${clientId}`)}`;
  await page.goto(pickerUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500).catch(() => {});
  if (signal.aborted) return 'not-found';

  // The picker lists every store in the org. Match the row whose text carries the target domain
  // (renamed stores keep their .myshopify.com domain, so this is reliable where display names lie).
  const handle = shop.replace(/\.myshopify\.com$/i, '');
  const links = page.locator(SELECTORS.installStoreLink);
  const count = await links.count().catch(() => 0);
  let target: import('playwright').Locator | null = null;
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const href = (await link.getAttribute('href').catch(() => '')) ?? '';
    const rowText = (await link.textContent().catch(() => '')) ?? '';
    const ctx = (await link.evaluate((el) => el.closest('li,div,tr')?.textContent ?? '').catch(() => '')) ?? '';
    if (href.includes(`/store/${handle}/`) || rowText.includes(shop) || ctx.includes(shop) || ctx.includes(handle)) { target = link; break; }
  }
  if (!target) { log(`${shop} not found in organization ${orgId}'s store list.`); return 'not-found'; }

  await target.click().catch(() => {});
  await page.waitForTimeout(3000).catch(() => {});

  // Cross-org guard: the install page refuses with a clear banner.
  const body = (await page.textContent('body').catch(() => '')) ?? '';
  if (SELECTORS.crossOrgError.test(body)) { log('That store belongs to a different organization.'); return 'cross-org'; }

  const install = page.locator(SELECTORS.installButton).first();
  if (await install.isVisible().catch(() => false)) {
    if (await install.isDisabled().catch(() => false)) { log('"Install" is disabled — the store likely has no active plan.'); return 'no-plan'; }
    await install.click().catch(() => {});
    await page.waitForTimeout(3000).catch(() => {});
    return 'ok';
  }
  // No install button but no error — treat as already installed / OK.
  return 'ok';
}
