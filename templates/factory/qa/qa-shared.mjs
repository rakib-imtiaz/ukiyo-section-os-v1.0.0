// Shared QA library: Playwright loading, page settling, route discovery,
// section segmentation + fingerprinting, similarity + alignment, report writers.
// Pure functions (similarity, alignment, scoring) are exported for unit tests.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = process.cwd();

// ---------- Playwright ----------

export async function loadPlaywright() {
  // Resolution order (no hardcoded machine path):
  //   1. FACTORY_PW_ROOT env (explicit override).
  //   2. PW_ROOT env (passed by the factory runner from config.factory.playwrightRoot).
  //   3. the app's OWN installed Playwright — repo `node_modules/playwright`, discovered by
  //      walking up from this file so it resolves relative to the workspace/repo.
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
  const candidates = roots.flatMap((root) => [
    path.join(root, 'playwright', 'index.mjs'),
    path.join(root, 'playwright', 'index.js'),
  ]);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  throw new Error(`Playwright not found. Set FACTORY_PW_ROOT (or PW_ROOT) to a node_modules dir containing playwright, or install playwright in the app. Tried: ${candidates.join(', ')}`);
}

// ---------- Page interaction helpers ----------

/** Shopify storefront password wall (lifted from gallactic). Safe no-op when absent. */
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

/** Best-effort dismissal of consent/cookie overlays that would skew comparison. */
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

/** Settle protocol: networkidle -> scroll-through (lazy load + reveals) -> quiet wait -> freeze animations. */
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

/**
 * Navigate to a route with SPA fallback: if a non-home route serves the home shell
 * (client-side routing without SSR), navigate by clicking the matching nav link instead.
 */
export async function gotoRoute(page, base, route, { password } = {}) {
  const url = base.replace(/\/$/, '') + route;
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await handlePassword(page, password);
  if (route !== '/' && (!response || response.status() === 404)) {
    // try client-side navigation from home
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await handlePassword(page, password);
    const link = page.locator(`a[href="${route}"], a[href="${route}/"]`).first();
    if (await link.count() === 0) return { ok: false, status: response?.status() ?? 0 };
    await link.click({ timeout: 5000 });
    await page.waitForURL((current) => current.pathname.replace(/\/$/, '') === route.replace(/\/$/, ''), { timeout: 10_000 }).catch(() => {});
  }
  return { ok: true, status: response?.status() ?? 200 };
}

// ---------- Route discovery ----------

/** Map a React route to the Shopify storefront path (gallactic heuristics + handles.json overrides). */
export function computeShopifyPath(route, handles = {}) {
  if (handles[route]) return handles[route];
  if (route === '/') return '/';
  if (route === '/blog' || route === '/journal') return null; // blog base needs the blog handle — supplied via handles.json
  return `/pages/${route.replace(/^\//, '').replace(/\//g, '-')}`;
}

/** Tolerant parser for qa/state/handles.json — accepts several shapes the clone run may write. */
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
    return {};
  }
  try { return parseHandles(JSON.parse(readFileSync(handlesPath, 'utf8'))); }
  catch (error) {
    console.warn(`[qa] WARNING: handles.json unparseable (${error?.message ?? 'unknown error'}) — falling back to heuristic route mapping; scores may be unreliable`);
    return {};
  }
}

/** Discover React routes: handles.json keys + same-origin nav links crawled from the home page. */
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

// ---------- Section segmentation + fingerprints (runs in-page) ----------

export async function segmentSections(page) {
  return page.evaluate(() => {
    const isSkippable = (el) => ['HEADER', 'FOOTER', 'NAV', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK'].includes(el.tagName);
    const root = document.querySelector('main') || document.body;
    let candidates = [...root.children].filter((el) => el instanceof HTMLElement && !isSkippable(el));
    // unwrap single-child wrappers (page containers) up to 4 levels
    for (let depth = 0; depth < 4 && candidates.length === 1; depth++) {
      const only = candidates[0];
      const children = [...only.children].filter((el) => el instanceof HTMLElement && !isSkippable(el));
      if (children.length <= 1) break;
      candidates = children;
    }
    const shapeOf = (el, depth) => {
      if (depth === 0 || !el.children.length) return el.tagName;
      return `${el.tagName}(${[...el.children].slice(0, 12).map((child) => shapeOf(child, depth - 1)).join(',')})`;
    };
    const hash = (text) => { let value = 5381; for (let index = 0; index < text.length; index++) value = ((value << 5) + value + text.charCodeAt(index)) >>> 0; return value.toString(36); };
    const sections = [];
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      if (rect.height < 120 || rect.width < window.innerWidth * 0.6) continue;
      const headings = [...el.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => h.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 10);
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      sections.push({
        headings,
        text: text.slice(0, 4000),
        imgCount: el.querySelectorAll('img,video,picture,svg[width]').length,
        imgAlts: [...el.querySelectorAll('img[alt]')].map((img) => img.getAttribute('alt')).filter(Boolean).slice(0, 10),
        linkCount: el.querySelectorAll('a[href]').length,
        shapeHash: hash(shapeOf(el, 3)),
        childCount: el.children.length,
        bbox: { y: Math.round(top), height: Math.round(rect.height) },
      });
    }
    return sections;
  });
}

// ---------- Similarity + alignment (pure — unit tested) ----------

export function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((token) => token.length > 1);
}

/** Dice coefficient over token sets (order-insensitive, length-robust). */
export function diceSimilarity(textA, textB) {
  const tokensA = tokenize(textA); const tokensB = tokenize(textB);
  // Both empty (e.g. symbol-only names like "✕" / "+") — only equal if the raw strings match,
  // so a symbol-named control doesn't fuzzy-match every other symbol-named control.
  if (!tokensA.length && !tokensB.length) return (textA || '').trim().toLowerCase() === (textB || '').trim().toLowerCase() ? 1 : 0;
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA); const setB = new Set(tokensB);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  return (2 * shared) / (setA.size + setB.size);
}

export function headingsMatch(sectionA, sectionB) {
  const normalize = (heading) => heading.toLowerCase().replace(/\s+/g, ' ').trim();
  const headingsA = (sectionA.headings || []).map(normalize); const headingsB = (sectionB.headings || []).map(normalize);
  return headingsA.length > 0 && headingsB.length > 0 && headingsA.some((heading) => headingsB.includes(heading));
}

export function pairScore(sectionA, sectionB) {
  const text = diceSimilarity(sectionA.text, sectionB.text);
  return headingsMatch(sectionA, sectionB) ? Math.max(text, 0.7) : text;
}

/**
 * Order-preserving alignment (LCS with similarity weights).
 * Returns { pairs: [{a, b, score}], missing: [indexA...], extra: [indexB...] }.
 */
export function alignSections(listA, listB, threshold = 0.55) {
  const rows = listA.length; const cols = listB.length;
  const table = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const score = pairScore(listA[i], listB[j]);
      const take = score >= threshold ? score + table[i + 1][j + 1] : -Infinity;
      table[i][j] = Math.max(take, table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = []; const matchedA = new Set(); const matchedB = new Set();
  let i = 0; let j = 0;
  while (i < rows && j < cols) {
    const score = pairScore(listA[i], listB[j]);
    if (score >= threshold && table[i][j] === score + table[i + 1][j + 1]) {
      pairs.push({ a: i, b: j, score }); matchedA.add(i); matchedB.add(j); i++; j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return {
    pairs,
    missing: listA.map((_, index) => index).filter((index) => !matchedA.has(index)),
    extra: listB.map((_, index) => index).filter((index) => !matchedB.has(index)),
  };
}

/** First N visibly-different strings between two matched sections (for actionable reports). */
export function textDiffSamples(sectionA, sectionB, limit = 3) {
  const sentences = (text) => (text || '').split(/(?<=[.!?])\s+|\n+/).map((entry) => entry.trim()).filter((entry) => entry.length > 3);
  const fromA = sentences(sectionA.text); const setB = new Set(sentences(sectionB.text).map((entry) => entry.toLowerCase()));
  return fromA.filter((sentence) => !setB.has(sentence.toLowerCase())).slice(0, limit);
}

export function sectionTitle(section) {
  return section.headings?.[0] || tokenize(section.text).slice(0, 8).join(' ') || '(unnamed section)';
}

// ---------- Interaction diff classification (pure — unit tested) ----------

export function effectSummary(effect) {
  if (!effect || effect.error) return `error: ${effect?.error ?? 'unknown'}`;
  if (effect.navigatedTo) return `navigates to ${effect.navigatedTo}`;
  if (effect.overlayAppeared) return 'opens overlay/modal';
  if (effect.ariaFlipped) return 'toggles expanded state';
  if (!effect.noop) return `mutates DOM (${effect.domDelta > 0 ? '+' : ''}${effect.domDelta} nodes)`;
  return 'no visible effect';
}

/** Two click effects are equivalent when they produce the same class of outcome. */
export function effectsEquivalent(reactEffect, shopifyEffect) {
  if (!reactEffect || !shopifyEffect || reactEffect.error || shopifyEffect.error) return false;
  if (reactEffect.navigatedTo && shopifyEffect.navigatedTo) return true; // both navigate — targets checked at link level
  if (reactEffect.overlayAppeared && shopifyEffect.overlayAppeared) return true;
  if (reactEffect.ariaFlipped && shopifyEffect.ariaFlipped) return true;
  if (!reactEffect.noop && !shopifyEffect.noop) return true;
  return Boolean(reactEffect.noop && shopifyEffect.noop);
}

/** A React href matches a Shopify href when equal, or when Shopify carries the mapped path. */
export function linkTargetMatches(reactHref, shopifyHref, handles = {}) {
  if (!reactHref || !shopifyHref) return false;
  const clean = (href) => href.split(/[?#]/)[0].replace(/\/$/, '') || '/';
  const react = clean(reactHref);
  const shopify = clean(shopifyHref);
  if (/^https?:|^mailto:|^tel:/.test(react)) return react === shopify;
  if (react === shopify) return true;
  const expected = computeShopifyPath(react, handles);
  return expected != null && shopify === clean(expected);
}

// ---------- Report writers ----------

export function writeJsonReport(name, data) {
  const dir = path.join(ROOT, 'qa', 'reports', 'factory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
}

export function writeMdReport(name, markdown) {
  const dir = path.join(ROOT, 'qa', 'reports', 'factory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), markdown);
}

export function screenshotDir(iteration, route) {
  const safe = route === '/' ? '_home' : route.replace(/\//g, '_');
  const dir = path.join(ROOT, 'qa', 'screenshots', 'factory', String(iteration), safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
