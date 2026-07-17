// Interaction tester ("click verify"): enumerate every clickable element on both
// sites, exercise the interactive ones, record what each click does, and diff the
// behaviors. Links are verified statically (target mapping); buttons/toggles are
// clicked with state isolation. Deterministic — no LLM involved.
//
// Env: REACT_BASE, SHOPIFY_BASE, STORE_PASSWORD, ITER, PW_ROOT
// Reads: qa/state/handles.json, qa/state/theme.json
// Writes: qa/reports/factory/interactions-<iter>.{json,md}
import {
  loadPlaywright, settle, gotoRoute, dismissOverlays, handlePassword,
  discoverRoutes, computeShopifyPath, isCatalogPath, loadHandles, shopifyState, withPreview,
  diceSimilarity, writeJsonReport, writeMdReport,
  effectSummary, effectsEquivalent, isDenylistedClick, linkTargetMatches as linkTargetMatchesShared,
} from './qa-shared.mjs';

const REACT_BASE = process.env.REACT_BASE;
const SHOPIFY_BASE = process.env.SHOPIFY_BASE;
const ITER = Number(process.env.ITER || '1');
if (!REACT_BASE || !SHOPIFY_BASE) { console.error('REACT_BASE and SHOPIFY_BASE are required'); process.exit(1); }

const MAX_CLICKS_PER_ROUTE = 15; // interactive (non-link) elements actually clicked; overflow is reported, never silent
const CLICK_SETTLE_MS = 800;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: process.env.QA_HEADED !== '1' });
const handles = loadHandles();
const { previewSuffix } = shopifyState();

// ---------- inventory (runs in-page) ----------

async function inventory(page) {
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
      // Submit controls inside forms: input[type=submit], button[type=submit], or a typeless
      // <button> in a form (defaults to submit). These are never clicked by QA.
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

// ---------- click effect recording ----------

async function recordClickEffect(page, base, route, item, opts) {
  // Fresh load isolates state between clicks.
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

  // Re-locate using the SAME accessible-name keying as the inventory (aria-label included),
  // so icon-only controls (hamburger, cart, close — named via aria-label with no text) match
  // instead of timing out and producing false "behaves differently" findings.
  const handle = await page.evaluateHandle(({ tag, name, ordinal }) => {
    const accName = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = name.toLowerCase();
    const matches = [...document.querySelectorAll(tag)].filter((el) => accName(el) === target);
    return matches[ordinal - 1] || null;
  }, { tag: item.tag, name: item.name, ordinal: item.ordinal });
  const element = handle.asElement();
  const effect = { navigatedTo: null, overlayAppeared: false, domDelta: 0, ariaFlipped: false, consoleErrors: [], networkCalls: [], noop: false };
  if (!element) {
    effect.error = 'element not found on this load';
    effect.consoleErrors = consoleErrors.slice(0, 3);
    page.off('console', onConsole); page.off('request', onRequest);
    return effect;
  }
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
  page.off('console', onConsole);
  page.off('request', onRequest);
  return effect;
}

// Navigation destinations are compared with the same route-mapping tolerance as links.
const equivalent = (reactEffect, shopifyEffect) => effectsEquivalent(reactEffect, shopifyEffect, handles);
const linkTargetMatches = (reactHref, shopifyHref) => linkTargetMatchesShared(reactHref, shopifyHref, handles);

// ---------- main ----------

const discovery = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const routes = await discoverRoutes(discovery, REACT_BASE, handles);
await discovery.close();
console.log(`click-verifying ${routes.length} route(s)`);

const issues = [];
let issueSeq = 0;
const issueId = () => `i${ITER}-${++issueSeq}`;
const pages = [];
let totalTested = 0;
let totalSame = 0;
let totalUntested = 0;

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const reactPage = await context.newPage();
const shopifyPage = await context.newPage();
const shopifyOpts = { password: process.env.STORE_PASSWORD };

for (const route of routes) {
  const shopifyPath = computeShopifyPath(route, handles);
  if (!shopifyPath) continue;
  const pageResult = { route, elements: 0, tested: 0, same: 0, different: 0, missing: 0, clicked: 0, verifiedStatic: 0, untested: 0, skippedClicks: 0 };

  try {
    const reactNav = await gotoRoute(reactPage, REACT_BASE, route, {});
    if (!reactNav.ok) { pageResult.status = 'unreachable'; pages.push(pageResult); continue; }
    await dismissOverlays(reactPage);
    await settle(reactPage, { quietMs: 600 });
    const shopifyUrl = withPreview(SHOPIFY_BASE, shopifyPath, previewSuffix);
    const nav = await shopifyPage.goto(shopifyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => null);
    await handlePassword(shopifyPage, shopifyOpts.password);
    if (!nav || nav.status() === 404) { pageResult.status = isCatalogPath(shopifyPath) ? 'catalog_unseeded' : 'missing_page'; pages.push(pageResult); continue; } // section-compare already reports missing pages / unseeded catalog
    await dismissOverlays(shopifyPage);
    await settle(shopifyPage, { quietMs: 600 });

    const reactItems = (await inventory(reactPage)).filter((item) => item.visible);
    const shopifyItems = (await inventory(shopifyPage)).filter((item) => item.visible);
    pageResult.elements = reactItems.length;
    const shopifyByKey = new Map(shopifyItems.map((item) => [item.key, item]));
    const fuzzyFind = (reactItem) => {
      let best = null; let bestScore = 0;
      for (const candidate of shopifyItems) {
        if (candidate.kind !== reactItem.kind) continue;
        const score = diceSimilarity(reactItem.name, candidate.name);
        if (score > bestScore) { best = candidate; bestScore = score; }
      }
      return bestScore >= 0.8 ? best : null;
    };

    // Links: static target verification. Commerce/destructive actions (add-to-cart, buy, checkout,
    // subscribe, form submits): NEVER clicked — presence/match verified statically. Remaining
    // actions: real clicks (capped). Overflow beyond the cap is NOT scored (coverage_gap only).
    const actionItems = reactItems.filter((item) => item.kind === 'action');
    const denied = new Set(actionItems.filter((item) => isDenylistedClick(item)));
    const clickable = actionItems.filter((item) => !denied.has(item));
    const clickBudget = new Set(clickable.slice(0, MAX_CLICKS_PER_ROUTE));
    pageResult.skippedClicks = clickable.length - clickBudget.size;
    if (pageResult.skippedClicks > 0) {
      issues.push({ id: issueId(), kind: 'coverage_gap', page: route, title: `${pageResult.skippedClicks} interactive element(s) beyond the ${MAX_CLICKS_PER_ROUTE}-click budget were not exercised`, detail: 'These elements are EXCLUDED from the interaction score (untested is not passed). Raise MAX_CLICKS_PER_ROUTE or verify manually.' });
    }

    for (const item of reactItems) {
      const match = shopifyByKey.get(item.key) ?? fuzzyFind(item);
      if (!match) {
        // Presence check is itself a static verification — a missing element is tested-and-failed.
        pageResult.tested++; totalTested++;
        pageResult.missing++;
        issues.push({ id: issueId(), kind: 'missing_interaction', page: route, title: `Missing on Shopify: ${item.tag} "${item.name || item.href}" (${item.region})`, detail: item.kind === 'link' ? `React link -> ${item.href}` : 'Interactive element absent from the clone.' });
        continue;
      }
      if (item.kind === 'link') {
        pageResult.tested++; totalTested++;
        if (linkTargetMatches(item.href, match.href)) { pageResult.same++; totalSame++; }
        else {
          pageResult.different++;
          issues.push({ id: issueId(), kind: 'interaction_target', page: route, title: `Link "${item.name}" points to the wrong place`, detail: `React -> ${item.href} · Shopify -> ${match.href} (expected ${computeShopifyPath((item.href || '').split(/[?#]/)[0], handles) ?? item.href})` });
        }
        continue;
      }
      if (denied.has(item)) {
        // verified_static: present + name-matched, deliberately not clicked (real commerce action).
        pageResult.tested++; totalTested++;
        pageResult.verifiedStatic++;
        pageResult.same++; totalSame++;
        continue;
      }
      if (!clickBudget.has(item)) { pageResult.untested++; totalUntested++; continue; } // beyond budget: NOT scored, flagged via coverage_gap
      pageResult.tested++; totalTested++;
      pageResult.clicked++;
      const reactEffect = await recordClickEffect(reactPage, REACT_BASE, route, item, {});
      const shopifyEffect = await recordClickEffect(shopifyPage, SHOPIFY_BASE, shopifyPath, match, shopifyOpts);
      if (equivalent(reactEffect, shopifyEffect)) { pageResult.same++; totalSame++; }
      else {
        pageResult.different++;
        const kind = shopifyEffect?.noop && !reactEffect?.noop ? 'interaction_noop' : 'interaction_target';
        issues.push({ id: issueId(), kind, page: route, title: `"${item.name}" behaves differently`, detail: `React: ${effectSummary(reactEffect)} · Shopify: ${effectSummary(shopifyEffect)}${shopifyEffect?.consoleErrors?.length ? `\nShopify console errors: ${shopifyEffect.consoleErrors.join(' | ')}` : ''}` });
      }
    }
    for (const item of shopifyItems) {
      if (!reactItems.some((reactItem) => reactItem.key === item.key || diceSimilarity(reactItem.name, item.name) >= 0.8)) {
        issues.push({ id: issueId(), kind: 'extra_interaction', page: route, title: `Extra on Shopify: ${item.tag} "${item.name || item.href}"`, detail: 'Not present in the React original (informational).' });
      }
    }
    pages.push(pageResult);
    console.log(`  ${route}: ${pageResult.same}/${pageResult.tested} tested-same, ${pageResult.missing} missing, ${pageResult.different} different (${pageResult.clicked} clicked, ${pageResult.verifiedStatic} static, ${pageResult.untested} untested)`);
  } catch (error) {
    pageResult.status = 'error';
    pageResult.reason = error.message?.slice(0, 200);
    pages.push(pageResult);
    console.log(`  ${route}: ERROR ${error.message}`);
  }
}

await browser.close();

// Score = tested-equivalent / tested-total. "Tested" means clicked or statically verified
// (links, commerce-denylisted controls, presence checks). Untested overflow beyond the click
// budget is EXCLUDED from the score — untested is never counted as passed.
const interaction = totalTested ? totalSame / totalTested : 0;
// extra_interaction and coverage_gap are informational: excluded from the fixer's FIX-THESE scoring issues
const scoringIssues = issues.filter((issue) => issue.kind !== 'extra_interaction' && issue.kind !== 'coverage_gap');
writeJsonReport(`interactions-${ITER}.json`, { interaction: Number(interaction.toFixed(4)), tested: totalTested, same: totalSame, untested: totalUntested, issues: scoringIssues, informational: issues.filter((issue) => !scoringIssues.includes(issue)), pages });

const md = [
  `# Interaction verification — iteration ${ITER}`, '',
  `React (truth): ${REACT_BASE}`, `Shopify (clone): ${SHOPIFY_BASE}`, '',
  `> Scoring note: parity = tested-equivalent / tested-total. Commerce/destructive controls`,
  `> (add-to-cart, buy, checkout, subscribe, form submits) are never clicked — they are verified`,
  `> statically ("Static" column) and count as tested. Elements beyond the click budget are`,
  `> untested and EXCLUDED from the score (reported as coverage_gap).`, '',
  `**Interaction parity: ${(interaction * 100).toFixed(1)}%** (${totalSame}/${totalTested} tested elements behave the same${totalUntested ? `; ${totalUntested} untested, excluded` : ''})`, '',
  '| Route | Elements (R) | Tested | Same | Static | Missing | Different | Clicked | Untested |',
  '|---|---|---|---|---|---|---|---|---|',
  ...pages.map((page) => `| ${page.route} | ${page.elements} | ${page.tested} | ${page.same} | ${page.verifiedStatic} | ${page.missing} | ${page.different} | ${page.clicked} | ${page.untested} |`),
  '',
  `## Behavioral differences (${scoringIssues.length})`, '',
  ...scoringIssues.map((issue) => `- **[${issue.kind}]** \`${issue.page}\` ${issue.title}${issue.detail ? `\n  ${issue.detail.replace(/\n/g, '\n  ')}` : ''}`),
  '',
].join('\n');
writeMdReport(`interactions-${ITER}.md`, md);
console.log(`interaction=${interaction.toFixed(3)} issues=${scoringIssues.length}`);
