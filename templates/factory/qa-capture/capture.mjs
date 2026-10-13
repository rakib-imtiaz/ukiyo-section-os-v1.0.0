// QA capture (ThemeBot Cloud scoring). Opens the React site (truth) and the Shopify clone, and
// writes RAW evidence for the Cloud to score — no thresholds, matching or scores in here.
//
//   node capture.mjs sections <iter>   -> qa/capture/factory/<iter>/sections.json (+ screenshots in
//                                         qa/screenshots/factory/<iter>/<route>/{react,shopify}-{desktop,mobile}.png)
//   node capture.mjs inventory <iter>  -> qa/capture/factory/<iter>/inventory.json   (interactions pass 1)
//   node capture.mjs clicks <iter>     -> reads qa/capture/factory/<iter>/plan.json (the Cloud's click plan),
//                                         performs exactly those clicks -> effects.json   (interactions pass 2)
//   node capture.mjs calibrate <outFile> [--url <u>]  -> the known-good fixture pair, for the self-test
//
// Run with cwd = the job workspace. Env: REACT_BASE, SHOPIFY_BASE, STORE_PASSWORD, ITER,
// PW_ROOT / FACTORY_PW_ROOT, QA_HEADED. Exit 0 once the capture file is written.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  computeShopifyPath, discoverRoutes, dismissOverlays, dumpLayout, errorText, gotoRoute, gotoShopify, inventory,
  loadHandles, loadPlaywright, pageHealth, readCapture, recordClickEffect, screenshotDir, settle, shopifyState,
  withPreview, writeCapture,
} from './capture-lib.mjs';

const mode = process.argv[2];
const VIEWPORTS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 375, height: 812 }];
const started = Date.now();

const failedHealth = (navError) => ({ status: null, navError, finalPath: null, passwordGate: false, textLength: 0, elementCount: 0, mediaCount: 0, bodyHeight: 0, title: '' });

function siteEnv() {
  const REACT_BASE = process.env.REACT_BASE;
  const SHOPIFY_BASE = process.env.SHOPIFY_BASE;
  const ITER = Number(process.argv[3] || process.env.ITER || '1');
  if (!REACT_BASE || !SHOPIFY_BASE) { console.error('REACT_BASE and SHOPIFY_BASE are required'); process.exit(1); }
  return { REACT_BASE, SHOPIFY_BASE, ITER };
}

async function launch() {
  const { chromium } = await loadPlaywright();
  return chromium.launch({ headless: process.env.QA_HEADED !== '1' });
}

async function routesToVisit(browser, reactBase, handles) {
  const discovery = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const routes = await discoverRoutes(discovery, reactBase, handles);
  await discovery.close();
  return routes;
}

// ---------- sections ----------

async function captureSections() {
  const { REACT_BASE, SHOPIFY_BASE, ITER } = siteEnv();
  const browser = await launch();
  const { handles, missing: handlesMissing } = loadHandles();
  const { previewSuffix } = shopifyState();
  const routes = await routesToVisit(browser, REACT_BASE, handles);
  console.log(`capturing sections on ${routes.length} route(s): ${routes.join(', ')}`);

  const captured = [];
  for (const route of routes) {
    const shopifyPath = computeShopifyPath(route, handles);
    const entry = { route, shopifyPath: shopifyPath ?? null };
    if (!shopifyPath) { captured.push(entry); continue; }
    let context = null;
    try {
      context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const reactPage = await context.newPage();
      const shopifyPage = await context.newPage();

      const reactNav = await gotoRoute(reactPage, REACT_BASE, route, {});
      if (!reactNav.ok) { entry.react = { ok: false, status: reactNav.status }; continue; }
      await dismissOverlays(reactPage);
      await settle(reactPage);
      entry.react = { ok: true, status: reactNav.status, health: await pageHealth(reactPage, { status: reactNav.status }), layout: await dumpLayout(reactPage) };

      const shopifyNav = await gotoShopify(shopifyPage, withPreview(SHOPIFY_BASE, shopifyPath, previewSuffix));
      if (shopifyNav.status == null || shopifyNav.status === 404) {
        entry.shopify = { status: shopifyNav.status, health: shopifyNav.navError ? failedHealth(shopifyNav.navError) : null };
        continue;
      }
      await dismissOverlays(shopifyPage);
      await settle(shopifyPage);
      entry.shopify = { status: shopifyNav.status, health: await pageHealth(shopifyPage, { status: shopifyNav.status }), layout: await dumpLayout(shopifyPage) };

      // Screenshots: full page per site per viewport (same files the local QA writes).
      const shots = screenshotDir(ITER, route);
      for (const viewport of VIEWPORTS) {
        await reactPage.setViewportSize({ width: viewport.width, height: viewport.height });
        await shopifyPage.setViewportSize({ width: viewport.width, height: viewport.height });
        await reactPage.waitForTimeout(400);
        await shopifyPage.waitForTimeout(400);
        await reactPage.screenshot({ path: path.join(shots, `react-${viewport.name}.png`), fullPage: true }).catch(() => {});
        await shopifyPage.screenshot({ path: path.join(shots, `shopify-${viewport.name}.png`), fullPage: true }).catch(() => {});
      }
      console.log(`  ${route}: react ${entry.react.layout.blocks.length} block(s), shopify ${entry.shopify.layout.blocks.length} block(s)`);
    } catch (error) {
      entry.error = errorText(error);
      console.log(`  ${route}: ERROR ${entry.error}`);
    } finally {
      captured.push(entry);
      await context?.close().catch(() => {});
    }
  }
  await browser.close();
  const file = writeCapture(ITER, 'sections.json', { kind: 'sections', iter: ITER, reactBase: REACT_BASE, shopifyBase: SHOPIFY_BASE, handles, handlesMissing, routes: captured, durationMs: Date.now() - started });
  console.log(`sections capture written: ${file}`);
}

// ---------- interactions, pass 1: inventories ----------

/**
 * Upload size: elements with no box can't be clicked or seen (like the display:none ones the
 * inventory already skips), and `key` is rebuilt by the Cloud from tag + name + ordinal.
 */
const uploadable = (items) => items.filter((item) => item.visible).map(({ key: _key, ...item }) => item);

async function captureInventory() {
  const { REACT_BASE, SHOPIFY_BASE, ITER } = siteEnv();
  const browser = await launch();
  const { handles, missing: handlesMissing } = loadHandles();
  const { previewSuffix } = shopifyState();
  const routes = await routesToVisit(browser, REACT_BASE, handles);
  console.log(`capturing click inventories on ${routes.length} route(s)`);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const reactPage = await context.newPage();
  const shopifyPage = await context.newPage();
  const captured = [];
  for (const route of routes) {
    const shopifyPath = computeShopifyPath(route, handles);
    const entry = { route, shopifyPath: shopifyPath ?? null };
    if (!shopifyPath) { captured.push(entry); continue; }
    try {
      const reactNav = await gotoRoute(reactPage, REACT_BASE, route, {});
      if (!reactNav.ok) { entry.react = { ok: false, status: reactNav.status }; continue; }
      await dismissOverlays(reactPage);
      await settle(reactPage, { quietMs: 600 });
      entry.react = { ok: true, status: reactNav.status, health: await pageHealth(reactPage, { status: reactNav.status }) };
      const shopifyNav = await gotoShopify(shopifyPage, withPreview(SHOPIFY_BASE, shopifyPath, previewSuffix));
      if (shopifyNav.status == null || shopifyNav.status === 404) {
        entry.shopify = { status: shopifyNav.status, health: shopifyNav.navError ? failedHealth(shopifyNav.navError) : null };
        continue;
      }
      await dismissOverlays(shopifyPage);
      await settle(shopifyPage, { quietMs: 600 });
      entry.react.items = uploadable(await inventory(reactPage));
      entry.shopify = { status: shopifyNav.status, health: await pageHealth(shopifyPage, { status: shopifyNav.status }), items: uploadable(await inventory(shopifyPage)) };
      console.log(`  ${route}: react ${entry.react.items.length} element(s), shopify ${entry.shopify.items.length} element(s)`);
    } catch (error) {
      entry.error = errorText(error);
      console.log(`  ${route}: ERROR ${entry.error}`);
    } finally {
      captured.push(entry);
    }
  }
  await browser.close();
  const file = writeCapture(ITER, 'inventory.json', { kind: 'inventory', iter: ITER, reactBase: REACT_BASE, shopifyBase: SHOPIFY_BASE, handles, handlesMissing, routes: captured, durationMs: Date.now() - started });
  console.log(`inventory capture written: ${file}`);
}

// ---------- interactions, pass 2: the planned clicks ----------

async function captureClicks() {
  const { REACT_BASE, SHOPIFY_BASE, ITER } = siteEnv();
  const plan = readCapture(ITER, 'plan.json');
  const clicks = Array.isArray(plan?.clicks) ? plan.clicks : [];
  const { previewSuffix } = shopifyState();
  const shopifyOpts = { password: process.env.STORE_PASSWORD };
  console.log(`performing ${clicks.length} planned click(s) on each site`);
  const effects = [];
  if (clicks.length) {
    const browser = await launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const reactPage = await context.newPage();
    const shopifyPage = await context.newPage();
    let warmRoute = null;
    for (const click of clicks) {
      if (click.route !== warmRoute) {
        // Same state the local script clicked from: the route freshly loaded + settled on both
        // sites (the Shopify load also opens the dev-theme preview session the clicks rely on).
        warmRoute = click.route;
        try { const nav = await gotoRoute(reactPage, REACT_BASE, click.route, {}); if (nav.ok) { await dismissOverlays(reactPage); await settle(reactPage, { quietMs: 600 }); } } catch { /* the click records the failure */ }
        try { const nav = await gotoShopify(shopifyPage, withPreview(SHOPIFY_BASE, click.shopifyPath, previewSuffix)); if (nav.status != null) { await dismissOverlays(shopifyPage); await settle(shopifyPage, { quietMs: 600 }); } } catch { /* same */ }
      }
      let reactEffect; let shopifyEffect;
      try { reactEffect = await recordClickEffect(reactPage, REACT_BASE, click.route, click.react, {}); } catch (error) { reactEffect = { error: errorText(error).slice(0, 120) }; }
      try { shopifyEffect = await recordClickEffect(shopifyPage, SHOPIFY_BASE, click.shopifyPath, click.shopify, shopifyOpts); } catch (error) { shopifyEffect = { error: errorText(error).slice(0, 120) }; }
      effects.push({ i: click.i, react: reactEffect, shopify: shopifyEffect });
    }
    await browser.close();
  }
  const file = writeCapture(ITER, 'effects.json', { kind: 'effects', iter: ITER, effects, durationMs: Date.now() - started });
  console.log(`click effects written: ${file}`);
}

// ---------- calibration fixture ----------

// Full-width bands tall and wide enough to be sections, with distinct headings + prose.
function fixtureHtml() {
  const section = (heading, body) => `
  <section style="min-height:260px;padding:48px 24px;border-bottom:1px solid #ddd">
    <h2>${heading}</h2>
    <p>${body}</p>
    <a href="/collections/all">Browse the collection</a>
  </section>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>QA calibration fixture</title></head>
<body style="margin:0;font-family:sans-serif">
<main>
  ${section('Handcrafted crystal jewelry', 'Every piece is cut, polished, and set by hand in our studio. Ethically sourced stones with full provenance, shipped worldwide in recycled packaging.')}
  ${section('The spring collection has arrived', 'Fresh amethyst, rose quartz, and citrine designs inspired by first light. Limited runs of forty pieces per design, numbered and signed.')}
  ${section('What our customers say', 'Rated 4.9 out of 5 across two thousand verified reviews. The clasp quality and stone clarity keep people coming back season after season.')}
  ${section('Care and repair for life', 'Free resizing within sixty days and lifetime repair on every chain and setting. Post your piece to us and we return it restored within two weeks.')}
  ${section('Join the studio newsletter', 'Monthly notes from the bench: new stones, restock alerts, and subscriber-only early access to each seasonal drop. No spam, unsubscribe anytime.')}
</main>
</body>
</html>`;
}

async function captureCalibration() {
  const outFile = process.argv[3];
  if (!outFile) { console.error('usage: capture.mjs calibrate <outFile> [--url <u>]'); process.exit(1); }
  const urlFlag = process.argv.indexOf('--url');
  const targetUrl = urlFlag !== -1 ? process.argv[urlFlag + 1] : null;
  let fixtureDir = null;
  let browser = null;
  try {
    let urls;
    let modeName;
    if (targetUrl) { urls = [targetUrl, targetUrl]; modeName = 'url'; }
    else {
      fixtureDir = mkdtempSync(path.join(tmpdir(), 'qa-calibrate-'));
      writeFileSync(path.join(fixtureDir, 'reference.html'), fixtureHtml());
      writeFileSync(path.join(fixtureDir, 'candidate.html'), fixtureHtml());
      urls = [pathToFileURL(path.join(fixtureDir, 'reference.html')).href, pathToFileURL(path.join(fixtureDir, 'candidate.html')).href];
      modeName = 'fixture';
    }
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const load = async (url) => {
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, { quietMs: 300 });
      return { health: await pageHealth(page, { status: response ? response.status() : null }), layout: await dumpLayout(page) };
    };
    const reference = await load(urls[0]);
    const candidate = await load(urls[1]);
    writeFileSync(outFile, JSON.stringify({ reference, candidate, mode: modeName }));
    console.log(`calibration capture written: ${outFile}`);
  } catch (error) {
    writeFileSync(outFile, JSON.stringify({ error: String(error?.stack ?? error).slice(0, 2000) }));
    console.error(`CALIBRATION CAPTURE FAILED: ${error?.stack ?? error}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  }
}

const modes = { sections: captureSections, inventory: captureInventory, clicks: captureClicks, calibrate: captureCalibration };
if (!modes[mode]) { console.error(`usage: capture.mjs <${Object.keys(modes).join('|')}> <iter>`); process.exit(2); }
await modes[mode]();
