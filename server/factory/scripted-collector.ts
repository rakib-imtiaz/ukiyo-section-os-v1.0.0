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
import { centeredWindowArgs, prepareFreshWindow } from '../window-placement';
import type { CollectorResult } from './partner-api';
import { config } from '../config';

export interface ScriptedInput {
  shop: string;            // full myshopify domain, e.g. acme.myshopify.com ('' when createStore)
  /** Easy mode: create a REAL store first (admin "Create store" flow, never a dev store). */
  createStore?: boolean;
  storeName?: string;
  /** Easy-mode retry with a remembered store: if the signed-in account can't open `shop` (it was
   *  made under another Shopify login), create a fresh store for this account instead. */
  createIfUnreachable?: boolean;
  /** Told when the signed-in account can't open `shop`, so the caller can forget it. */
  onShopUnreachable?: (shop: string) => void;
  /** Called as soon as the new store's domain is known (and again with its storefront password). */
  onShop?: (shop: string, storefrontPassword: string | null) => void;
  handleName: string;      // the store handle (subdomain)
  appName: string;         // <project>_bot
  projectLabel: string;
  scopes: string;          // comma-separated AUTOPILOT_SCOPES
  /** When set, every logged step also saves a screenshot of the bot's window to
   *  <shotsDir>/<run timestamp>/NN-<step>.png — the record for debugging a failed setup. */
  shotsDir?: string;
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

/** Chrome refused the profile because another window already has it open. Chrome exits with
 *  code 21 for this on Windows, which Playwright reports only as "browser has been closed". */
function isProfileInUse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  // macOS/Linux: a second launch on a locked profile hands off to the running Chrome instead.
  return /ProcessSingleton|user data directory is already in use|profile.*in use|Opening in existing browser session|exitCode=21\b/i.test(message);
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
    const { appName, scopes } = input;
    let log = input.log;
    let shop = input.shop;
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
          executablePath: chrome?.executablePath,
          // macOS/Linux: the everyday profile's cookies are encrypted with the OS keychain; Playwright's
          // default flags swap in a fake one, which would open the profile signed out.
          ignoreDefaultArgs: process.platform === 'win32' ? undefined : ['--password-store=basic', '--use-mock-keychain'],
          viewport: { width: 1280, height: 900 },
          args: [`--profile-directory=${real.profile}`, '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble', ...centeredWindowArgs()],
        });
      } else {
        if (input.useRealProfile && !real) log('Could not locate your Chrome profile — falling back to the ThemeBot profile (a one-time login may be needed).');
        await mkdir(input.profileDir, { recursive: true });
        // Dedicated fallback profile: a one-time manual Shopify login persists here across runs.
        // A window that is still closing holds the profile for a moment — retry a few times.
        for (let attempt = 1; ; attempt += 1) {
          try {
            prepareFreshWindow(input.profileDir);
            context = await chromium.launchPersistentContext(input.profileDir, {
              headless: false,
              executablePath: chrome?.executablePath,
              viewport: { width: 1280, height: 900 },
              args: ['--no-first-run', '--no-default-browser-check', ...centeredWindowArgs()],
            });
            break;
          } catch (error) {
            if (attempt >= 3 || !isProfileInUse(error)) throw error;
            log('The ThemeBot Chrome window is still open — waiting for it to close…');
            await new Promise((resolve) => setTimeout(resolve, 5000));
            throwIfAborted();
          }
        }
      }
      const page = context.pages()[0] ?? await context.newPage();

      // Step screenshots: one per logged line, taken in order (a queue, so they never overlap).
      if (input.shotsDir) {
        const runDir = path.join(input.shotsDir, new Date().toISOString().replace(/[:.]/g, '-'));
        let count = 0;
        let queue: Promise<void> = mkdir(runDir, { recursive: true }).then(() => {}, () => {});
        const snap = (label: string) => {
          const name = `${String(++count).padStart(2, '0')}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'step'}.png`;
          queue = queue.then(() => page.screenshot({ path: path.join(runDir, name) }).then(() => {}, () => {}));
        };
        log = (text: string) => { input.log(text); snap(text); };
        input.log(`Saving a screenshot of every step to ${runDir}`);
      }

      // 0a. A remembered store may belong to a different Shopify login than the one signed in now.
      let createNow = Boolean(input.createStore);
      if (!createNow && shop && input.createIfUnreachable !== undefined) {
        const access = await canOpenStore(page, shop, abort.signal);
        throwIfAborted();
        if (access === 'no') {
          input.onShopUnreachable?.(shop);
          if (!input.createIfUnreachable || !input.storeName) {
            await input.onDone({ clientId: null, clientSecret: null, status: 'failed', note: `The Shopify account signed in to the ThemeBot window can't open ${shop} — it belongs to a different login. Sign in with that account, or start over to create a new store.` });
            return;
          }
          log(`${shop} belongs to a different Shopify login than the one signed in now — forgetting it and creating a new store for this account.`);
          shop = '';
          createNow = true;
        }
      }

      // 0. Easy mode: create the real store first and learn its generated domain.
      if (createNow) {
        const created = await createRealStore(page, input.storeName ?? '', log, abort.signal);
        throwIfAborted();
        if (!created) { await input.onDone({ clientId: null, clientSecret: null, status: 'failed', note: 'Could not create the store (the Create store flow did not reach a store admin page).' }); return; }
        shop = created;
        input.onShop?.(shop, null);
        await nameStore(page, shop, input.storeName ?? '', log);
        throwIfAborted();
      }

      // 0b. The build's page checks need the storefront password to get past "Private mode".
      //     Stores ThemeBot creates get the standard password. In the customer edition a store the
      //     agency already had keeps its own password — we only read it, never change a client's
      //     store behind their back. (Our internal edition sets the standard one everywhere.)
      const keepExisting = config.edition === 'customer' && !createNow;
      const password = await ensureStorefrontPassword(page, shop, keepExisting ? null : DEFAULT_STOREFRONT_PASSWORD, log);
      if (password) input.onShop?.(shop, password);
      throwIfAborted();

      // 1. Reach the dashboard; wait out a manual login if one appears; read the org id.
      log('Opening the Shopify Dev Dashboard…');
      await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const startOrg = await waitForDashboardOrg(page, log, abort.signal);
      throwIfAborted();
      if (!startOrg) { await input.onDone({ clientId: null, clientSecret: null, status: 'failed', note: 'Could not reach your Dev Dashboard (still on a login page after 6 minutes?).' }); return; }

      // 1b. The dashboard opens on whichever organization was used LAST — possibly another client's.
      //     Find the org that actually owns this store; never create anything anywhere else.
      const orgId = await findOrgForShop(page, shop, createNow, log, abort.signal);
      throwIfAborted();
      if (!orgId) { await input.onDone({ clientId: null, clientSecret: null, status: 'failed', note: `Stopped for safety: none of your Shopify organizations lists ${shop}, so no app was created. Open the ThemeBot window, check the store is in your account, then press Continue.` }); return; }
      log(`In organization ${orgId} (it owns ${shop}). Preparing the app…`);

      // 2–3. Create (or reuse) the app in this org, capture its id.
      const appId = await ensureApp(page, orgId, appName, scopes, log, abort.signal);
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
      if (error instanceof Error && error.message === '__needs_login__') {
        log('Not signed in to Shopify in the ThemeBot profile yet — sign in once in the ThemeBot sign-in window.');
        await input.onDone({ clientId: null, clientSecret: null, status: 'failed', note: 'not logged in — sign in once in the ThemeBot sign-in window, then press Continue' });
        return;
      }
      if (isProfileInUse(error)) {
        await input.onDone({ clientId: null, clientSecret: null, status: 'failed', note: 'The ThemeBot sign-in window is still open — close it, then press Continue.' });
        return;
      }
      // Playwright errors carry the whole Chrome command line and call log — show only the first line.
      input.onError(error instanceof Error ? `Scripted bot failed: ${error.message.split('\n')[0].replace(/\s*Browser logs:.*$/s, '').slice(0, 200)}` : 'Scripted bot failed.');
    } finally {
      await close();
    }
  })();

  return { abort, close };
}

// --- Real store creation (calibrated 2026-09-24 by walking the flow with the user) --------------
//   https://admin.shopify.com/?no_redirect=true is the "Welcome back — Choose a store or create a
//   new one" picker with a "Create new store" button (no need to open any store's admin first).
//   Fallback: store switcher (top-right) → "View all" → "All stores" dialog → "Create store".
//   Shopify creates the store IMMEDIATELY and redirects to
//     /signup/<uuid>/subscribe/checkout?...&shopPermanentDomain=<handle>.myshopify.com  (card form)
//   → "Skip" (top-right) → "What can we help you do?" → "Skip" → /store/<handle>?welcome.
//   The store starts on a 3-day trial named "My Store". We NEVER type on the checkout page.
const STORE = {
  createStore: /^\s*(\+\s*)?create (a )?(new )?store\s*$/i,
  viewAll: /^\s*view all\s*$/i,
  skip: /^\s*skip( for now| all)?\s*$/i,
  permanentDomain: /shopPermanentDomain=([a-z0-9][a-z0-9-]*)\.myshopify\.com/i,
  storeAdmin: /admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)(?:[/?#]|$)/i,
  signup: /admin\.shopify\.com\/signup\//i,
  captcha: /captcha|verify you are human|are you a robot/i,
};

async function clickFirstVisible(page: Page, candidates: Array<import('playwright').Locator>): Promise<boolean> {
  for (const locator of candidates) {
    const target = locator.first();
    if (await target.isVisible().catch(() => false)) { await target.click().catch(() => {}); return true; }
  }
  return false;
}

/** Create a real store through the admin "Create store" flow; returns <handle>.myshopify.com or null. */
async function createRealStore(page: Page, storeName: string, log: (t: string) => void, signal: AbortSignal): Promise<string | null> {
  log(`Opening Shopify admin to create "${storeName}"…`);
  await page.goto('https://admin.shopify.com/?no_redirect=true', { waitUntil: 'domcontentloaded' }).catch(() => {});

  // Wait until we are signed in and inside some store's admin (the switcher lives there).
  // Signing in inside a script-driven window fails for Google accounts ("This browser or app may
  // not be secure"), so the script never waits on a login page: it stops and the app offers a
  // plain, script-free ThemeBot window for the one-time sign-in (see /easy/signin-window).
  const signedInBy = Date.now() + 60_000;
  let loginSince = 0;
  while (Date.now() < signedInBy) {
    if (signal.aborted) return null;
    if (STORE.storeAdmin.test(page.url()) || /admin\.shopify\.com\/?(\?|$)/.test(page.url()) && !SELECTORS.loginHost.test(page.url())) break;
    if (SELECTORS.loginHost.test(page.url())) {
      loginSince = loginSince || Date.now();
      if (Date.now() - loginSince > 6000) throw new Error('__needs_login__');
    } else loginSince = 0;
    await page.waitForTimeout(1500).catch(() => {});
  }
  await page.waitForTimeout(2000).catch(() => {});
  const before = page.url();

  // Open the "All stores" dialog and press Create store.
  log('Opening the store list…');
  // The picker renders client-side — give the "Create new store" button time to appear.
  await page.getByRole('button', { name: STORE.createStore }).first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
  if (SELECTORS.loginHost.test(page.url())) throw new Error('__needs_login__');
  let clicked =await clickFirstVisible(page, [page.getByRole('button', { name: STORE.createStore }), page.getByRole('link', { name: STORE.createStore })]);
  if (!clicked) {
    // Top-right store switcher: the last button in the top bar carries the current store's name.
    await clickFirstVisible(page, [page.locator('[aria-label*="store" i][aria-haspopup]'), page.locator('header [aria-haspopup]').last(), page.locator('[data-polaris-topbar] button').last()]);
    await page.waitForTimeout(800).catch(() => {});
    await clickFirstVisible(page, [page.getByRole('button', { name: STORE.viewAll }), page.getByRole('link', { name: STORE.viewAll }), page.getByText(STORE.viewAll)]);
    await page.waitForTimeout(1200).catch(() => {});
    clicked = await clickFirstVisible(page, [page.getByRole('button', { name: STORE.createStore }), page.getByRole('link', { name: STORE.createStore }), page.getByText(STORE.createStore)]);
  }
  if (!clicked) { log('Could not find "Create store" (calibrate STORE selectors).'); return null; }
  log('Creating the store — Shopify sets it up now…');

  // Walk the post-create screens: read the domain, press Skip on the card page and the survey.
  // SAFETY: the store we started on (possibly a live client store) must never be mistaken for the
  // new one — only a handle Shopify announced via the signup flow counts.
  const previousHandle = STORE.storeAdmin.exec(before)?.[1] ?? null;
  let handle: string | null = null;
  let sawSignup = false;
  const doneBy = Date.now() + 8 * 60_000;
  let waitingNoted = false;
  while (Date.now() < doneBy) {
    if (signal.aborted) return null;
    const url = page.url();
    if (STORE.signup.test(url)) sawSignup = true;
    const fromParam = STORE.permanentDomain.exec(url)?.[1];
    if (fromParam && handle !== fromParam) { handle = fromParam; log(`Store created: ${handle}.myshopify.com`); }
    const admin = STORE.storeAdmin.exec(url)?.[1];
    if (admin && admin !== previousHandle && !STORE.signup.test(url) && (handle ? admin === handle : sawSignup)) {
      handle = admin;
      log('Store admin is open — the store is ready.');
      return `${handle}.myshopify.com`;
    }
    const body = (await page.textContent('body').catch(() => '')) ?? '';
    if (SELECTORS.loginHost.test(url) || STORE.captcha.test(body)) {
      if (!waitingNoted) { log('WAITING FOR LOGIN — Shopify wants a check in the ThemeBot window; finish it there and the bot continues.'); waitingNoted = true; }
    } else if (STORE.signup.test(url) && await clickFirstVisible(page, [page.getByRole('button', { name: STORE.skip }), page.getByRole('link', { name: STORE.skip })])) {
      // Skip is pressed ONLY on /signup/ pages (card form, survey) — never inside a store admin.
      log(/checkout|subscribe/i.test(url) ? 'Skipped the plan / payment screen (no card entered).' : 'Skipped a setup question.');
      await page.waitForTimeout(1500).catch(() => {});
      continue;
    }
    await page.waitForTimeout(2000).catch(() => {});
  }
  // Timed out on the screens but we did learn the domain: the store exists, so carry on with it.
  return handle ? `${handle}.myshopify.com` : null;
}

/** Best-effort, time-boxed: set the store's display name (it starts as "My Store").
 *  Calibrated 2026-09-24: Settings → General → "Store contact details" row links to
 *  /settings/general/store-contact-details, a page with a "Store name" field; Shopify's contextual
 *  save bar shows "Save" only after a change. Pages use Polaris web components, so only
 *  Playwright locators (which pierce shadow DOM) see the fields. */
async function nameStore(page: Page, shop: string, storeName: string, log: (t: string) => void) {
  if (!storeName) return;
  const handle = shop.replace(/\.myshopify\.com$/i, '');
  try {
    await page.goto(`https://admin.shopify.com/store/${handle}/settings/general/store-contact-details`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const field = page.getByLabel(/store name/i).first();
    await field.waitFor({ state: 'visible', timeout: 20_000 });
    if ((await field.inputValue().catch(() => '')) === storeName) { log(`The store is already called "${storeName}".`); return; }
    await field.fill(storeName);
    const save = page.getByRole('button', { name: /^\s*save\s*$/i }).last();
    await save.waitFor({ state: 'visible', timeout: 10_000 });
    await save.click();
    await page.waitForTimeout(2500);
    log(`Named the store "${storeName}".`);
  } catch {
    log('Could not rename the store — it keeps its default name (cosmetic only).');
  }
}

/** Best-effort: read the storefront password new stores are protected with. */
/** ThemeBot's standard storefront password for stores it builds. New stores are password-protected
 *  (Private mode) until a plan is chosen; the build's checks need to get past that gate. */
export const DEFAULT_STOREFRONT_PASSWORD = '12345';

/** The storefront "Password" box on Online Store → Preferences. It sits inside the embedded Online
 *  Store app frame (verified 2026-09-27), so search every frame, not just the page. */
async function findPasswordBox(page: Page) {
  for (let i = 0; i < 15; i += 1) {
    for (const frame of page.frames()) {
      const box = frame.getByLabel(/^\s*password\s*$/i).first();
      if (await box.isVisible().catch(() => false)) return box;
    }
    await page.waitForTimeout(1000).catch(() => {});
  }
  return null;
}

/** Set the storefront password to `wanted`, save, and read it back. Returns the password that is
 *  actually in place (the old one if saving failed), or null if the store has no password box.
 *  With `wanted` null it only reads the current password. */
async function ensureStorefrontPassword(page: Page, shop: string, wanted: string | null, log: (t: string) => void): Promise<string | null> {
  const handle = shop.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/i, '');
  const url = `https://admin.shopify.com/store/${handle}/online_store/preferences`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    let box = await findPasswordBox(page);
    if (!box) { log('No storefront password box found (the store may already be open to everyone).'); return null; }
    const current = (await box.inputValue().catch(() => '')).trim();
    if (wanted === null) { log(current ? "Using the store's existing storefront password." : 'This store has no storefront password set.'); return current || null; }
    if (current === wanted) { log(`Storefront password is already "${wanted}".`); return wanted; }
    log(`Setting the storefront password to "${wanted}"…`);
    await box.fill(wanted).catch(() => {});
    // The admin's save bar ("Save") shows once the field changes — in the page or the app frame.
    let saved = false;
    for (let i = 0; i < 10 && !saved; i += 1) {
      await page.waitForTimeout(700).catch(() => {});
      for (const frame of [page.mainFrame(), ...page.frames()]) {
        const save = frame.getByRole('button', { name: /^\s*save\s*$/i }).first();
        if (await save.isVisible().catch(() => false) && await save.isEnabled().catch(() => false)) { await save.click().catch(() => {}); saved = true; break; }
      }
    }
    await page.waitForTimeout(2500).catch(() => {});
    // Read it back from a fresh load — the only proof it stuck.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    box = await findPasswordBox(page);
    const after = box ? (await box.inputValue().catch(() => '')).trim() : '';
    if (after === wanted) { log(`Storefront password set to "${wanted}".`); return wanted; }
    log(after ? `Could not change the storefront password — keeping the existing one.` : 'Could not read the storefront password back.');
    return after || current || null;
  } catch { return null; }
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
      if (!announced) { announced = true; await page.waitForTimeout(6000).catch(() => {}); continue; }  // grace for SSO redirects
      throw new Error('__needs_login__');
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

/** Can the signed-in account open this store's admin? 'unknown' when Shopify asks for a login
 *  (the dashboard step handles that) or the page never settles. */
async function canOpenStore(page: Page, shop: string, signal: AbortSignal): Promise<'yes' | 'no' | 'unknown'> {
  const handle = shop.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/i, '').trim().toLowerCase();
  if (!handle) return 'unknown';
  await page.goto(`https://admin.shopify.com/store/${handle}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  for (let i = 0; i < 10; i += 1) {
    if (signal.aborted) return 'unknown';
    await page.waitForTimeout(1500).catch(() => {});
    if (SELECTORS.loginHost.test(page.url())) return 'unknown';
    const text = await page.innerText('body').catch(() => '');
    if (/doesn.t have permission|don.t have permission|switch accounts/i.test(text)) return 'no';
    if (!page.url().includes(`/store/${handle}`)) return 'no';   // bounced to the stores list
    if (/\b(Home|Orders|Products|Customers)\b/.test(text)) return 'yes';
  }
  return 'unknown';
}

/** Which organization owns this store? Read from the store's OWN admin: Settings → Apps →
 *  Develop apps links to that organization's Dev Dashboard (verified 2026-09-27: friartucks →
 *  213631064, a freshly created store → its own new org). Account-wide pages are no use here —
 *  the admin store picker ignores organization_id and the dashboard's "Recent stores" list is
 *  account-wide, which is how the old check picked the wrong org. */
async function findOrgForShop(page: Page, shop: string, justCreated: boolean, log: (t: string) => void, signal: AbortSignal): Promise<string | null> {
  const handle = shop.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/i, '').trim().toLowerCase();
  if (!handle) return null;
  log(`Finding which Shopify organization owns ${shop}…`);
  // A store created minutes ago can take a moment before its settings pages are ready.
  const rounds = justCreated ? 4 : 2;
  for (let round = 0; round < rounds; round += 1) {
    if (signal.aborted) return null;
    await page.goto(`https://admin.shopify.com/store/${handle}/settings/apps/development`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    for (let i = 0; i < 10; i += 1) {
      if (signal.aborted) return null;
      await page.waitForTimeout(1500).catch(() => {});
      if (SELECTORS.loginHost.test(page.url())) throw new Error('__needs_login__');
      const text = await page.innerText('body').catch(() => '');
      if (/doesn.t have permission|don.t have permission/i.test(text)) { log(`The signed-in Shopify account can't open ${shop}.`); return null; }
      const hrefs = await page.$$eval('a[href*="dev.shopify.com/dashboard/"]', (links) => links.map((a) => a.getAttribute('href') ?? '')).catch(() => [] as string[]);
      const org = hrefs.map((href) => /dev\.shopify\.com\/dashboard\/(\d+)/.exec(href)?.[1]).find(Boolean);
      if (org) return org;
    }
    if (round < rounds - 1) { log('The store settings are not ready yet — trying again in 15 seconds…'); await page.waitForTimeout(15_000).catch(() => {}); }
  }
  log(`Could not tell which organization owns ${shop} — stopping before creating anything.`);
  return null;
}

/** Create the app (or reuse one already named appName) and return its numeric app id. */
async function ensureApp(page: Page, orgId: string, appName: string, scopes: string, log: (t: string) => void, signal: AbortSignal): Promise<string | null> {
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
  // "Start from Dev Dashboard" card (re-checked 2026-09-24): an "App name" box with a 0/30
  // counter and a "Create app" button (type=button — no longer a form submit).
  const nameBox = page.getByLabel(/app name/i).first();
  await nameBox.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  if (await nameBox.isVisible().catch(() => false)) await nameBox.fill(appName.slice(0, 30)).catch(() => {});
  else await page.locator(SELECTORS.appNameInput).last().fill(appName.slice(0, 30)).catch(() => {});
  // The Sept 2026 form also has App URL (prefilled) and a Scopes box on the same page.
  const scopesBox = page.getByLabel(/^\s*scopes\s*$/i).first();
  if (scopes && await scopesBox.isVisible().catch(() => false)) await scopesBox.fill(scopes).catch(() => {});
  const createButton = page.getByRole('button', { name: /^\s*create( app)?\s*$/i }).last();
  if (await createButton.isVisible().catch(() => false)) await createButton.click().catch(() => {});
  else await page.locator(SELECTORS.createAppButton).last().click().catch(() => {});
  // Sept 2026: "Create app" opens a "Release version" dialog (optional description + Release) —
  // the app is only created once Release is pressed. Success lands on /apps/{id}/….
  const appUrl = /\/apps\/(\d+)(?:[/?#]|$)/;
  let released = false;
  for (let i = 0; i < 30 && !appUrl.test(page.url()); i += 1) {
    if (signal.aborted) return null;
    if (!released) {
      const dialog = page.getByRole('dialog').filter({ hasText: /release version/i }).first();
      const release = dialog.getByRole('button', { name: /^\s*release\s*$/i }).first();
      if (await release.isVisible().catch(() => false)) {
        log('Shopify asks to release the first version — pressing Release.');
        await page.waitForTimeout(400).catch(() => {});   // let that step's screenshot show the dialog
        await release.click().catch(() => {});
        released = true;
      }
    }
    await page.waitForTimeout(1000).catch(() => {});
  }
  const id = appUrl.exec(page.url())?.[1] ?? null;
  if (id) { log(`App created (${id}).`); return id; }

  // Shopify didn't navigate. Say why if the page shows an error, then check whether the app
  // was created anyway (slow redirects do happen) before giving up.
  const pageError = await page.locator('[role="alert"], [class*="error" i], [class*="critical" i]')
    .filter({ hasText: /\S/ }).first().innerText({ timeout: 1500 }).catch(() => '');
  log(`App creation did not open the new app (still on ${page.url().replace(/^https?:\/\//, '').slice(0, 80)}).${pageError ? ` Shopify says: ${pageError.replace(/\s+/g, ' ').trim().slice(0, 160)}` : ''}`);
  if (signal.aborted) return null;
  await page.waitForTimeout(1500).catch(() => {});   // keep the error on screen for that step's screenshot
  await page.goto(`https://dev.shopify.com/dashboard/${orgId}/apps`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000).catch(() => {});
  const created = page.locator(`a[href*="/apps/"]`, { hasText: appName }).first();
  const href = (await created.isVisible().catch(() => false)) ? await created.getAttribute('href').catch(() => null) : null;
  const found = href && /\/apps\/(\d+)/.exec(href)?.[1];
  if (found) { log(`Found the app in your apps list after all (${found}) — carrying on.`); return found; }
  return null;
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

/** One-off: rename a store using ThemeBot's own Chrome profile (already signed in to Shopify).
 *  Used after a build finishes when the in-flow rename was skipped. The profile must be free
 *  (no sign-in window / setup script using it at the same time). */
export async function renameStoreInProfile(profileDir: string, shop: string, storeName: string, log: (t: string) => void = () => {}): Promise<boolean> {
  const chrome = detectEngines().find((e) => e.id === 'chrome' && e.available);
  prepareFreshWindow(profileDir);
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false, executablePath: chrome?.executablePath, viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check', ...centeredWindowArgs()],
  });
  const messages: string[] = [];
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await nameStore(page, shop, storeName, (text) => { messages.push(text); log(text); });
    return messages.some((text) => text.startsWith('Named the store'));
  } finally { await context.close().catch(() => {}); }
}

export interface StoreAccess {
  shop: string;
  /** yes = listed for the signed-in account; no = not listed; signed-out = no Shopify login in the
   *  ThemeBot window; unknown = could not tell (window open, page never loaded…). */
  access: 'yes' | 'no' | 'signed-out' | 'unknown';
  account: string | null;
  storeName: string | null;
  reason?: 'window-open' | 'busy' | 'launch-failed' | 'timeout';
  checkedAt: number;
}

/** Read-only: which Shopify login the ThemeBot window uses, and does that login list this store?
 *  Opens the admin store picker in a hidden window with the ThemeBot profile — no clicks. */
export async function checkStoreAccess(profileDir: string, shop: string): Promise<StoreAccess> {
  const sub = shop.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/i, '').trim().toLowerCase();
  const base = { shop, account: null, storeName: null, checkedAt: Date.now() };
  let context: BrowserContext;
  try {
    await mkdir(profileDir, { recursive: true });
    const chrome = detectEngines().find((e) => e.id === 'chrome' && e.available);
    context = await chromium.launchPersistentContext(profileDir, { headless: true, executablePath: chrome?.executablePath, args: ['--no-first-run', '--no-default-browser-check'] });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return { ...base, access: 'unknown', reason: isProfileInUse(error) ? 'window-open' : 'launch-failed' };
  }
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://admin.shopify.com/?no_redirect=true', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    for (let i = 0; i < 12; i += 1) {
      await page.waitForTimeout(1500).catch(() => {});
      if (SELECTORS.loginHost.test(page.url())) return { ...base, access: 'signed-out' };
      const rows = await page.$$eval('a[href*="/store/"]', (links) => links.map((a) => ({ href: a.getAttribute('href') ?? '', text: (a.textContent ?? '').replace(/\s+/g, ' ').trim() }))).catch(() => []);
      if (!rows.length) continue;
      const body = await page.innerText('body').catch(() => '');
      const account = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(body)?.[0] ?? null;
      const row = rows.find((r) => new RegExp(`/store/${sub}(?:[/?#]|$)`, 'i').test(r.href) || r.text.toLowerCase().includes(`${sub}.myshopify.com`));
      const storeName = row ? (row.text.replace(new RegExp(`${sub}\\.myshopify\\.com\\s*$`, 'i'), '').trim() || null) : null;
      return { ...base, account, storeName, access: row ? 'yes' : 'no' };
    }
    return { ...base, access: 'unknown', reason: 'timeout' };
  } finally {
    await context.close().catch(() => {});
  }
}

/** One-off: give an existing store the standard storefront password using ThemeBot's own Chrome
 *  profile (must be free — no ThemeBot window open). Returns the password now in place. */
export async function setStorefrontPasswordInProfile(profileDir: string, shop: string, password = DEFAULT_STOREFRONT_PASSWORD, log: (t: string) => void = () => {}): Promise<string | null> {
  const chrome = detectEngines().find((e) => e.id === 'chrome' && e.available);
  prepareFreshWindow(profileDir);
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false, executablePath: chrome?.executablePath, viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check', ...centeredWindowArgs()],
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    return await ensureStorefrontPassword(page, shop, password, log);
  } finally { await context.close().catch(() => {}); }
}
