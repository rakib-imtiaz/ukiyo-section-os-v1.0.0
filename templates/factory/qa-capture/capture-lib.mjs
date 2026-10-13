// QA capture library — runs on the customer's PC and only COLLECTS evidence: raw layout dumps,
// click inventories, click effects, page health and screenshots. It contains no scoring rule:
// segmentation thresholds, matching, click planning, verdicts and scores live in ThemeBot Cloud
// (cloud/src/qa). It deliberately does not import templates/factory/qa/qa-shared.mjs.
//
// The browser helpers (Playwright loading, password wall, overlay dismissal, settle, SPA route
// fallback, route discovery, click recording) are the same as the local QA scripts', so the Cloud
// sees exactly what those scripts saw.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = process.cwd();

// ---------- Playwright ----------

export async function loadPlaywright() {
  // FACTORY_PW_ROOT / PW_ROOT env first, then the app's own node_modules (walking up from here).
  const roots = [];
  for (const env of [process.env.FACTORY_PW_ROOT, process.env.PW_ROOT]) {
    if (env && env.trim()) roots.push(env.trim());
  }
  for (let dir = import.meta.dirname; ; ) {
    roots.push(path.join(dir, 'node_modules'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const candidates = roots.flatMap((root) => [path.join(root, 'playwright', 'index.mjs'), path.join(root, 'playwright', 'index.js')]);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  throw new Error(`Playwright not found. Set FACTORY_PW_ROOT (or PW_ROOT) to a node_modules dir containing playwright. Tried: ${candidates.join(', ')}`);
}

// ---------- Page helpers ----------

/** Shopify storefront password wall. Safe no-op when absent. */
export async function handlePassword(page, password = process.env.STORE_PASSWORD) {
  if (!password) return false;
  const input = page.locator('input#Password, input[name="password"]');
  try { await input.waitFor({ state: 'visible', timeout: 3000 }); } catch { return false; }
  await input.fill(password);
  const submit = page.locator('form[action="/password"] button[type="submit"], form[action*="password"] [type="submit"]');
  if (await submit.count() > 0) await submit.first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
  return true;
}

/** Best-effort dismissal of consent/cookie overlays. */
export async function dismissOverlays(page) {
  const selectors = [
    '[id*="cookie" i] button', '[class*="cookie" i] button', '[id*="consent" i] button',
    '[class*="consent" i] button', '[aria-label*="accept" i]', 'button:has-text("Accept")',
    '[class*="gdpr" i] button',
  ];
  for (const selector of selectors) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 300 })) { await button.click({ timeout: 1000 }); await page.waitForTimeout(300); return true; }
    } catch { /* not present */ }
  }
  return false;
}

/** Settle: networkidle -> scroll-through (lazy load + reveals) -> quiet wait -> freeze animations. */
export async function settle(page, { quietMs = 1200 } = {}) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(quietMs);
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}' }).catch(() => {});
}

/** Navigate to a route; a non-home route that 404s (client-side routing) is reached by clicking its nav link. */
export async function gotoRoute(page, base, route, { password } = {}) {
  const url = base.replace(/\/$/, '') + route;
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await handlePassword(page, password);
  if (route !== '/' && (!response || response.status() === 404)) {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await handlePassword(page, password);
    const link = page.locator(`a[href="${route}"], a[href="${route}/"]`).first();
    if (await link.count() === 0) return { ok: false, status: response?.status() ?? 0 };
    await link.click({ timeout: 5000 });
    await page.waitForURL((current) => current.pathname.replace(/\/$/, '') === route.replace(/\/$/, ''), { timeout: 10_000 }).catch(() => {});
  }
  return { ok: true, status: response?.status() ?? 200 };
}

/**
 * Open a Shopify page (with the dev-theme preview). Never throws: a failed load comes back as
 * { status: null, navError }. When the password wall swallowed the request, the page is opened
 * again so the capture shows the requested route, not the page the password form redirected to.
 */
export async function gotoShopify(page, url, password = process.env.STORE_PASSWORD) {
  let response = null;
  let navError = null;
  try { response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); }
  catch (error) { navError = String(error?.message ?? error).split('\n')[0].slice(0, 200); }
  if (navError) return { status: null, navError };
  if (await handlePassword(page, password)) {
    const wanted = new URL(url).pathname.replace(/\/$/, '') || '/';
    const landed = new URL(page.url()).pathname.replace(/\/$/, '') || '/';
    if (landed !== wanted) {
      try { response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); }
      catch (error) { return { status: null, navError: String(error?.message ?? error).split('\n')[0].slice(0, 200) }; }
    }
  }
  return { status: response ? response.status() : null, navError: response ? null : 'no response' };
}

/** What the browser is showing — lets the Cloud tell "capture failed" from "clone is wrong". */
export async function pageHealth(page, { status = null, navError = null } = {}) {
  const probe = await page.evaluate(() => {
    const body = document.body;
    const visible = (el) => { const rect = el.getBoundingClientRect(); const style = getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
    const gate = [...document.querySelectorAll('form[action*="password"] input[type="password"], input#Password')].some(visible);
    return {
      finalPath: location.pathname,
      passwordGate: gate || location.pathname.replace(/\/$/, '') === '/password',
      textLength: body ? (body.innerText || '').trim().length : 0,
      elementCount: body ? body.querySelectorAll('*').length : 0,
      mediaCount: document.querySelectorAll('img,video,picture,canvas,svg').length,
      bodyHeight: body ? body.scrollHeight : 0,
      title: (document.title || '').slice(0, 200),
    };
  }).catch((error) => ({ finalPath: null, passwordGate: false, textLength: 0, elementCount: 0, mediaCount: 0, bodyHeight: 0, title: '', probeError: String(error?.message ?? error).slice(0, 200) }));
  return { status, navError, ...probe };
}

// ---------- Raw layout dump (segmentation happens in the Cloud) ----------

/**
 * The page body as content blocks: the children of main || body (minus header/footer/nav and
 * non-content tags), plus — while a level holds a single wrapper — that wrapper's children, up to
 * 3 levels. No size rule is applied here; every block carries its box, text, headings, media,
 * links and a structure fingerprint.
 */
export async function dumpLayout(page) {
  return page.evaluate(() => {
    const NON_CONTENT = ['HEADER', 'FOOTER', 'NAV', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK'];
    const MAX_CHAIN = 3; // the Cloud's current rule reads one level; two more leave room for rule changes
    const main = document.querySelector('main');
    const root = main || document.body;
    const content = (el) => [...el.children].filter((child) => child instanceof HTMLElement && !NON_CONTENT.includes(child.tagName));
    const shapeOf = (el, depth) => {
      if (depth === 0 || !el.children.length) return el.tagName;
      return `${el.tagName}(${[...el.children].slice(0, 12).map((child) => shapeOf(child, depth - 1)).join(',')})`;
    };
    const hash = (text) => { let value = 5381; for (let index = 0; index < text.length; index++) value = ((value << 5) + value + text.charCodeAt(index)) >>> 0; return value.toString(36); };
    const blocks = [];
    const describe = (el, parent) => {
      const rect = el.getBoundingClientRect();
      const id = blocks.length;
      blocks.push({
        id, parent, tag: el.tagName,
        x: rect.left + window.scrollX, y: rect.top + window.scrollY, w: rect.width, h: rect.height,
        childCount: el.children.length,
        headings: [...el.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => h.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 10),
        text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
        imgCount: el.querySelectorAll('img,video,picture,svg[width]').length,
        imgAlts: [...el.querySelectorAll('img[alt]')].map((img) => img.getAttribute('alt')).filter(Boolean).slice(0, 10),
        linkCount: el.querySelectorAll('a[href]').length,
        shapeHash: hash(shapeOf(el, 3)),
      });
      return id;
    };
    let level = content(root).map((el) => ({ el, id: describe(el, -1) }));
    for (let depth = 0; depth < MAX_CHAIN && level.length === 1; depth++) {
      const wrapper = level[0];
      const kids = content(wrapper.el);
      if (!kids.length) break;
      level = kids.map((el) => ({ el, id: describe(el, wrapper.id) }));
    }
    return { viewportWidth: window.innerWidth, root: main ? 'main' : 'body', blocks };
  });
}

// ---------- Click inventory + click recording ----------

export async function inventory(page) {
  return page.evaluate(() => {
    const clickables = [...document.querySelectorAll('a[href], button, [role="button"], [onclick], summary, input[type="submit"], input[type="button"], [aria-haspopup], [aria-expanded], label[for]')];
    const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const seen = new Map();
    const items = [];
    for (const el of clickables) {
      if (!(el instanceof HTMLElement)) continue;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const inHeader = Boolean(el.closest('header, nav'));
      const inFooter = Boolean(el.closest('footer'));
      const accessibleName = name(el);
      if (!accessibleName && el.tagName !== 'A') continue;
      const tag = el.tagName.toLowerCase();
      const isLink = tag === 'a' && el.getAttribute('href');
      const baseKey = `${tag}|${accessibleName.toLowerCase()}`;
      const ordinal = (seen.get(baseKey) ?? 0) + 1;
      seen.set(baseKey, ordinal);
      const type = (el.getAttribute('type') || '').toLowerCase();
      const inForm = Boolean(el.closest('form'));
      const isSubmit = inForm && ((tag === 'input' && type === 'submit') || (tag === 'button' && (type === 'submit' || type === '')));
      items.push({
        key: `${baseKey}|${ordinal}`,
        tag, name: accessibleName, ordinal,
        kind: isLink ? 'link' : 'action',
        href: isLink ? el.getAttribute('href') : null,
        visible: rect.width > 0 && rect.height > 0,
        region: inHeader ? 'header' : inFooter ? 'footer' : 'main',
        ariaExpanded: el.getAttribute('aria-expanded'),
        idClass: `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`.trim().slice(0, 200),
        isSubmit,
      });
    }
    return items;
  });
}

/**
 * SAFETY NET (must stay on the PC): controls that would create real carts, checkouts, orders or
 * signups are never clicked, whatever the click plan says.
 */
export const COMMERCE_CLICK_DENYLIST = /add.?to.?cart|add.?to.?(bag|basket)|buy.?now|\bbuy\b|checkout|subscribe|sign.?up|newsletter|\bsubmit\b|place.?order|pay.?now|pre.?order/i;

export function isDenylistedClick(item) {
  if (!item) return false;
  if (item.isSubmit) return true;
  return COMMERCE_CLICK_DENYLIST.test(item.name || '') || COMMERCE_CLICK_DENYLIST.test(item.idClass || '');
}

const CLICK_SETTLE_MS = 800;

/** Fresh load, click one element, record what happened (navigation, overlay, aria toggle, DOM delta). */
export async function recordClickEffect(page, base, route, item, opts) {
  if (isDenylistedClick(item)) return { refused: true };
  const nav = await gotoRoute(page, base, route, opts);
  if (!nav.ok) return { error: 'route unreachable' };
  await handlePassword(page, opts.password);
  await dismissOverlays(page);
  await page.waitForLoadState('networkidle').catch(() => {});

  const consoleErrors = [];
  const networkCalls = [];
  const onConsole = (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 160)); };
  const onRequest = (request) => { try { const url = new URL(request.url()); if (networkCalls.length < 10) networkCalls.push(`${request.method()} ${url.pathname}`); } catch { /* ignore */ } };
  page.on('console', onConsole);
  page.on('request', onRequest);

  const beforeUrl = page.url();
  const before = await page.evaluate(() => ({
    nodes: document.querySelectorAll('*').length,
    overlays: [...document.querySelectorAll('*')].filter((el) => { const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return (style.position === 'fixed' || style.position === 'absolute') && rect.width * rect.height > innerWidth * innerHeight * 0.3 && style.display !== 'none' && style.visibility !== 'hidden'; }).length,
  })).catch(() => ({ nodes: 0, overlays: 0 }));

  // Re-locate with the SAME accessible-name keying as the inventory (aria-label included).
  const handle = await page.evaluateHandle(({ tag, name, ordinal }) => {
    const accName = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = name.toLowerCase();
    const matches = [...document.querySelectorAll(tag)].filter((el) => accName(el) === target);
    return matches[ordinal - 1] || null;
  }, { tag: item.tag, name: item.name, ordinal: item.ordinal });
  const element = handle.asElement();
  const effect = { navigatedTo: null, overlayAppeared: false, domDelta: 0, ariaFlipped: false, consoleErrors: [], networkCalls: [], noop: false };
  const detach = () => { page.off('console', onConsole); page.off('request', onRequest); };
  if (!element) {
    effect.error = 'element not found on this load';
    effect.consoleErrors = consoleErrors.slice(0, 3);
    detach();
    return effect;
  }
  // Safety net on the live element too (the plan names it, the page decides what it really is).
  const live = await element.evaluate((el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const inForm = Boolean(el.closest('form'));
    return {
      name: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      idClass: `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`.trim().slice(0, 200),
      isSubmit: inForm && ((tag === 'input' && type === 'submit') || (tag === 'button' && (type === 'submit' || type === ''))),
    };
  }).catch(() => null);
  if (live && isDenylistedClick(live)) { detach(); return { refused: true }; }
  try {
    const ariaBefore = await element.getAttribute('aria-expanded').catch(() => null);
    await element.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await element.click({ timeout: 4000, force: false });
    await page.waitForTimeout(CLICK_SETTLE_MS);
    const afterUrl = page.url();
    if (afterUrl !== beforeUrl) {
      effect.navigatedTo = afterUrl.replace(base.replace(/\/$/, ''), '').split('?')[0] || '/';
    } else {
      const after = await page.evaluate(() => ({
        nodes: document.querySelectorAll('*').length,
        overlays: [...document.querySelectorAll('*')].filter((el) => { const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return (style.position === 'fixed' || style.position === 'absolute') && rect.width * rect.height > innerWidth * innerHeight * 0.3 && style.display !== 'none' && style.visibility !== 'hidden'; }).length,
      })).catch(() => before);
      effect.domDelta = after.nodes - before.nodes;
      effect.overlayAppeared = after.overlays > before.overlays;
      const ariaAfter = await element.getAttribute('aria-expanded').catch(() => null);
      effect.ariaFlipped = ariaBefore != null && ariaAfter != null && ariaBefore !== ariaAfter;
      effect.noop = !effect.overlayAppeared && !effect.ariaFlipped && Math.abs(effect.domDelta) < 3;
    }
  } catch (error) {
    effect.error = error.message?.slice(0, 120);
  }
  effect.consoleErrors = consoleErrors.slice(0, 3);
  effect.networkCalls = networkCalls;
  detach();
  return effect;
}

// ---------- Routes ----------

/** React route -> Shopify path (needed to know which page to open; the Cloud has its own copy). */
export function computeShopifyPath(route, handles = {}) {
  if (handles[route]) return handles[route];
  if (route === '/') return '/';
  if (route === '/blog' || route === '/journal') return null;
  if (/^\/(products|collections|blogs)(\/|$)/.test(route)) return route;
  return `/pages/${route.replace(/^\//, '').replace(/\//g, '-')}`;
}

/** Tolerant parser for qa/state/handles.json. */
export function parseHandles(raw) {
  const map = {};
  if (!raw || typeof raw !== 'object') return map;
  const entries = Array.isArray(raw) ? raw : Object.entries(raw).map(([key, value]) => ({ key, value }));
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && typeof entry.route === 'string') {
      const handle = entry.shopify_path || (entry.handle ? `/pages/${entry.handle}` : null);
      if (handle) map[entry.route] = handle.startsWith('/') ? handle : `/pages/${handle}`;
    } else if (entry && typeof entry.key === 'string' && typeof entry.value === 'string') {
      const route = entry.key.startsWith('/') ? entry.key : null;
      if (route) map[route] = entry.value.startsWith('/') ? entry.value : `/pages/${entry.value}`;
    }
  }
  return map;
}

export function loadHandles() {
  const handlesPath = path.join(ROOT, 'qa', 'state', 'handles.json');
  if (!existsSync(handlesPath)) {
    console.warn('[qa] WARNING: handles.json missing — falling back to heuristic route mapping; scores may be unreliable (expected at qa/state/handles.json)');
    return { handles: {}, missing: true };
  }
  try { return { handles: parseHandles(JSON.parse(readFileSync(handlesPath, 'utf8'))), missing: false }; }
  catch (error) {
    console.warn(`[qa] WARNING: handles.json unparseable (${error?.message ?? 'unknown error'}) — falling back to heuristic route mapping; scores may be unreliable`);
    return { handles: {}, missing: false };
  }
}

/** React routes: handles.json keys + same-origin nav links crawled from the home page. */
export async function discoverRoutes(page, reactBase, handles) {
  const routes = new Set(['/']);
  for (const route of Object.keys(handles)) routes.add(route);
  await page.goto(reactBase, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter(Boolean),
  ).catch(() => []);
  for (const href of links) {
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    const clean = href.split(/[?#]/)[0].replace(/\/$/, '') || '/';
    if (/\.(pdf|jpg|jpeg|png|webp|svg|zip|xml)$/i.test(clean)) continue;
    if (/^\/(cart|checkout|account|admin|cdn)/.test(clean)) continue;
    routes.add(clean);
  }
  return [...routes].sort();
}

// ---------- Files ----------

export function shopifyState() {
  const themePath = path.join(ROOT, 'qa', 'state', 'theme.json');
  if (!existsSync(themePath)) return { previewSuffix: '', host: null };
  try {
    const theme = JSON.parse(readFileSync(themePath, 'utf8'));
    return { previewSuffix: theme.dev_theme_id ? `preview_theme_id=${theme.dev_theme_id}` : '', host: theme.host ?? null };
  } catch { return { previewSuffix: '', host: null }; }
}

export function withPreview(base, routePath, previewSuffix) {
  const url = base.replace(/\/$/, '') + routePath;
  if (!previewSuffix) return url;
  return url + (url.includes('?') ? '&' : '?') + previewSuffix;
}

/** Same folders as the local QA scripts, so the Pictures tab and the fix agent find them. */
export function screenshotDir(iteration, route) {
  const safe = route === '/' ? '_home' : route.replace(/\//g, '_');
  const dir = path.join(ROOT, 'qa', 'screenshots', 'factory', String(iteration), safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** qa/capture/factory/<iter>/ — raw evidence the desktop uploads to the Cloud. */
export function captureDir(iteration) {
  const dir = path.join(ROOT, 'qa', 'capture', 'factory', String(iteration));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeCapture(iteration, name, data) {
  const target = path.join(captureDir(iteration), name);
  writeFileSync(target, JSON.stringify(data));
  return target;
}

export function readCapture(iteration, name) {
  return JSON.parse(readFileSync(path.join(captureDir(iteration), name), 'utf8'));
}

export const errorText = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 200);
