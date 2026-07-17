// Section comparator: crawl the React app (source of truth) and the Shopify clone
// route by route, segment each page into visual sections, align them, and report
// what matches, what is missing, and what drifted. Deterministic — no LLM involved.
//
// Env: REACT_BASE, SHOPIFY_BASE, STORE_PASSWORD, ITER, PW_ROOT
// Reads: qa/state/handles.json, qa/state/theme.json
// Writes: qa/reports/factory/sections-<iter>.{json,md}, qa/screenshots/factory/<iter>/...
import path from 'node:path';
import {
  loadPlaywright, settle, gotoRoute, dismissOverlays, segmentSections,
  alignSections, diceSimilarity, textDiffSamples, sectionTitle,
  discoverRoutes, computeShopifyPath, loadHandles, shopifyState, withPreview,
  writeJsonReport, writeMdReport, screenshotDir, handlePassword,
} from './qa-shared.mjs';

const REACT_BASE = process.env.REACT_BASE;
const SHOPIFY_BASE = process.env.SHOPIFY_BASE;
const ITER = Number(process.env.ITER || '1');
if (!REACT_BASE || !SHOPIFY_BASE) { console.error('REACT_BASE and SHOPIFY_BASE are required'); process.exit(1); }

const VIEWPORTS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 375, height: 812 }];
const TEXT_DRIFT_THRESHOLD = 0.9;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: process.env.QA_HEADED !== '1' });
const handles = loadHandles();
const { previewSuffix } = shopifyState();

const discovery = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const routes = await discoverRoutes(discovery, REACT_BASE, handles);
await discovery.close();
console.log(`comparing ${routes.length} route(s): ${routes.join(', ')}`);

const pages = [];
const issues = [];
let issueSeq = 0;
const issueId = () => `s${ITER}-${++issueSeq}`;
const pairTextScores = [];

for (const route of routes) {
  const shopifyPath = computeShopifyPath(route, handles);
  if (!shopifyPath) { pages.push({ route, status: 'skipped', reason: 'no shopify mapping (blog base?)' }); continue; }
  const pageResult = { route, shopifyPath, status: 'ok', reactSections: 0, matched: 0, missing: 0, extra: 0, textScore: null };

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const reactPage = await context.newPage();
    const shopifyPage = await context.newPage();

    const reactNav = await gotoRoute(reactPage, REACT_BASE, route, {});
    if (!reactNav.ok) { pageResult.status = 'unreachable'; pageResult.reason = `react route HTTP ${reactNav.status}`; pages.push(pageResult); await context.close(); continue; }
    await dismissOverlays(reactPage);
    await settle(reactPage);

    const reactSections = await segmentSections(reactPage);
    pageResult.reactSections = reactSections.length;

    const shopifyUrl = withPreview(SHOPIFY_BASE, shopifyPath, previewSuffix);
    const shopifyNav = await shopifyPage.goto(shopifyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => null);
    await handlePassword(shopifyPage);
    if (!shopifyNav || shopifyNav.status() === 404) {
      // Missing page: every React section on it counts as missing (penalizes presence).
      pageResult.status = 'missing_page';
      pageResult.missing = reactSections.length;
      issues.push({ id: issueId(), kind: 'missing_page', page: route, title: `Shopify page ${shopifyPath} does not exist (HTTP ${shopifyNav?.status() ?? 'n/a'})`, detail: `React route ${route} (${reactSections.length} sections) has no working Shopify counterpart at ${shopifyPath}.` });
      pages.push(pageResult); await context.close(); continue;
    }
    await dismissOverlays(shopifyPage);
    await settle(shopifyPage);

    const shopifySections = await segmentSections(shopifyPage);

    const alignment = alignSections(reactSections, shopifySections);
    pageResult.matched = alignment.pairs.length;
    pageResult.missing = alignment.missing.length;
    pageResult.extra = alignment.extra.length;

    // Screenshots: full page per site per viewport + per-section clips at desktop.
    const shots = screenshotDir(ITER, route);
    for (const viewport of VIEWPORTS) {
      await reactPage.setViewportSize({ width: viewport.width, height: viewport.height });
      await shopifyPage.setViewportSize({ width: viewport.width, height: viewport.height });
      await reactPage.waitForTimeout(400);
      await shopifyPage.waitForTimeout(400);
      await reactPage.screenshot({ path: path.join(shots, `react-${viewport.name}.png`), fullPage: true }).catch(() => {});
      await shopifyPage.screenshot({ path: path.join(shots, `shopify-${viewport.name}.png`), fullPage: true }).catch(() => {});
    }

    const perSection = [];
    for (const pair of alignment.pairs) {
      const reactSection = reactSections[pair.a];
      const shopifySection = shopifySections[pair.b];
      const textScore = diceSimilarity(reactSection.text, shopifySection.text);
      pairTextScores.push(textScore);
      const entry = { react: sectionTitle(reactSection), order: [pair.a, pair.b], textScore: Number(textScore.toFixed(3)), structureMatch: reactSection.shapeHash === shopifySection.shapeHash };
      perSection.push(entry);
      if (textScore < TEXT_DRIFT_THRESHOLD) {
        const samples = textDiffSamples(reactSection, shopifySection);
        issues.push({
          id: issueId(), kind: 'text_drift', page: route,
          title: `"${sectionTitle(reactSection)}" text drifts from React (${Math.round(textScore * 100)}% match)`,
          detail: samples.length ? `React strings missing/different on Shopify:\n${samples.map((sample) => `> ${sample}`).join('\n')}` : 'Wording differs — compare the screenshots.',
        });
      }
    }
    for (const index of alignment.missing) {
      const section = reactSections[index];
      issues.push({
        id: issueId(), kind: 'missing_section', page: route,
        title: `Missing section: "${sectionTitle(section)}" (band ${index + 1} of ${reactSections.length})`,
        detail: `React band at y=${section.bbox.y} (${section.bbox.height}px, ${section.imgCount} media, ${section.linkCount} links). Excerpt: ${section.text.slice(0, 200)}`,
      });
    }
    for (const index of alignment.extra) {
      const section = shopifySections[index];
      issues.push({ id: issueId(), kind: 'extra_section', page: route, title: `Extra Shopify section not in React: "${sectionTitle(section)}"`, detail: `Excerpt: ${section.text.slice(0, 160)}` });
    }
    pageResult.sections = perSection;
    pageResult.textScore = perSection.length ? Number((perSection.reduce((sum, entry) => sum + entry.textScore, 0) / perSection.length).toFixed(3)) : null;
    pages.push(pageResult);
    await context.close();
    console.log(`  ${route}: ${pageResult.matched}/${pageResult.reactSections} matched, ${pageResult.missing} missing, ${pageResult.extra} extra`);
  } catch (error) {
    pageResult.status = 'unreachable';
    pageResult.reason = error.message?.slice(0, 200);
    pages.push(pageResult);
    console.log(`  ${route}: ERROR ${error.message}`);
  }
}

await browser.close();

// Score only over reachable routes (ok = compared, missing_page = counts as all-missing).
// 'unreachable'/'skipped' routes are excluded from the denominator so a flaky React load
// doesn't tank the score while the report separately lists them as excluded.
const scored = pages.filter((page) => page.status === 'ok' || page.status === 'missing_page');
const totalReactSections = scored.reduce((sum, page) => sum + (page.reactSections || 0), 0);
const totalMatched = scored.reduce((sum, page) => sum + (page.matched || 0), 0);
const presence = totalReactSections ? totalMatched / totalReactSections : 0;
const text = pairTextScores.length ? pairTextScores.reduce((sum, score) => sum + score, 0) / pairTextScores.length : 0;

writeJsonReport(`sections-${ITER}.json`, { presence: Number(presence.toFixed(4)), text: Number(text.toFixed(4)), pages, issues });

const md = [
  `# Section comparison — iteration ${ITER}`,
  '',
  `React (truth): ${REACT_BASE}`, `Shopify (clone): ${SHOPIFY_BASE}`, '',
  `**Section presence: ${(presence * 100).toFixed(1)}%** (${totalMatched}/${totalReactSections}) · **Text match: ${(text * 100).toFixed(1)}%**`, '',
  '| Route | Status | Sections (R) | Matched | Missing | Extra | Text |',
  '|---|---|---|---|---|---|---|',
  ...pages.map((page) => `| ${page.route} | ${page.status} | ${page.reactSections ?? '-'} | ${page.matched ?? '-'} | ${page.missing ?? '-'} | ${page.extra ?? '-'} | ${page.textScore != null ? `${Math.round(page.textScore * 100)}%` : '-'} |`),
  '',
  `## Issues (${issues.length})`, '',
  ...issues.map((issue) => `- **[${issue.kind}]** \`${issue.page}\` ${issue.title}${issue.detail ? `\n  ${issue.detail.replace(/\n/g, '\n  ')}` : ''}`),
  '',
  `Screenshots: \`qa/screenshots/factory/${ITER}/<route>/{react,shopify}-{desktop,mobile}.png\``, '',
].join('\n');
writeMdReport(`sections-${ITER}.md`, md);
console.log(`presence=${presence.toFixed(3)} text=${text.toFixed(3)} issues=${issues.length}`);
