// Section comparison rubric: React (truth) vs Shopify (clone), route by route. Ported from
// templates/factory/qa/section-compare.mjs — same statuses, issues, ids, totals and markdown —
// plus capture health: a page the browser could not capture properly is excluded and reported
// as a capture problem instead of being scored as a 0% clone.
import { isCatalogPath } from './routing';
import { segmentLayout, siteProblems } from './segment';
import { alignSections, diceSimilarity, sectionTitle, textDiffSamples } from './text';
import type { CaptureProblem, CaptureStatus, QaIssue, SectionsCaptureRoute, SectionsPageResult, SectionsReport } from './types';

export const SECTION_RULES = {
  /** Matched sections below this text similarity get a text_drift issue. */
  textDriftThreshold: 0.9,
  /** Per-pair score = textWeight × text + (1 − textWeight) × structure match. */
  textWeight: 0.8,
} as const;

export interface SectionsInput { iter: number; reactBase: string; shopifyBase: string; routes: SectionsCaptureRoute[] }

export function scoreSections(input: SectionsInput): { report: SectionsReport; markdown: string } {
  const { iter } = input;
  const pages: SectionsPageResult[] = [];
  const issues: QaIssue[] = [];
  const problems: CaptureProblem[] = [];
  let issueSeq = 0;
  const issueId = () => `s${iter}-${++issueSeq}`;
  const pairTextScores: number[] = [];

  for (const captured of input.routes) {
    const { route, shopifyPath } = captured;
    if (!shopifyPath) { pages.push({ route, status: 'skipped', reason: 'no shopify mapping (blog base?)' }); continue; }
    const pageResult: SectionsPageResult = { route, shopifyPath, status: 'ok', reactSections: 0, matched: 0, missing: 0, extra: 0, textScore: null };
    const fail = (reason: string) => { pageResult.status = 'unreachable'; pageResult.reason = reason.slice(0, 200); pages.push(pageResult); };
    const captureFail = (site: 'react' | 'shopify', found: string[]) => {
      for (const problem of found) problems.push({ route, site, problem });
      pageResult.status = 'capture_failed';
      pageResult.reason = `${site}: ${found.join('; ')}`.slice(0, 200);
      pages.push(pageResult);
    };

    const react = captured.react;
    if (!react) { fail(captured.error || 'react page not captured'); continue; }
    if (!react.ok) { pageResult.status = 'unreachable'; pageResult.reason = `react route HTTP ${react.status ?? 0}`; pages.push(pageResult); continue; }
    const reactProblems = siteProblems(react.health, 'react');
    if (reactProblems.length) { captureFail('react', reactProblems); continue; }
    const reactSections = segmentLayout(react.layout);
    pageResult.reactSections = reactSections.length;
    if (captured.error) { fail(captured.error); continue; }

    const shopify = captured.shopify;
    if (!shopify) { fail('shopify page not captured'); continue; }
    if (shopify.status == null && shopify.health?.navError) { captureFail('shopify', siteProblems(shopify.health, 'shopify')); continue; }
    if (shopify.status == null || shopify.status === 404) {
      const status = shopify.status ?? 'n/a';
      if (isCatalogPath(shopifyPath)) {
        // Catalog route with no backing product/collection: the theme can't fix this — the
        // catalog was never seeded. Classified separately and EXCLUDED from the presence
        // denominator (like 'unreachable') so it's reported loudly instead of poisoning the score.
        pageResult.status = 'catalog_unseeded';
        pageResult.reason = `HTTP ${status} — product/collection not seeded`;
        issues.push({ id: issueId(), kind: 'catalog_unseeded', page: route, title: `Catalog route ${shopifyPath} does not exist on the store (HTTP ${status})`, detail: `The product/collection behind React route ${route} does not exist on the store — seed the catalog (productCreate/collectionCreate + publish to the Online Store channel) and record the mapping in qa/state/handles.json. This route is excluded from the presence score until seeded.` });
      } else {
        // Missing page: every React section on it counts as missing (penalizes presence).
        pageResult.status = 'missing_page';
        pageResult.missing = reactSections.length;
        issues.push({ id: issueId(), kind: 'missing_page', page: route, title: `Shopify page ${shopifyPath} does not exist (HTTP ${status})`, detail: `React route ${route} (${reactSections.length} sections) has no working Shopify counterpart at ${shopifyPath}.` });
      }
      pages.push(pageResult); continue;
    }
    const shopifyProblems = siteProblems(shopify.health, 'shopify');
    if (shopifyProblems.length) { captureFail('shopify', shopifyProblems); continue; }

    const shopifySections = segmentLayout(shopify.layout);
    const alignment = alignSections(reactSections, shopifySections);
    pageResult.matched = alignment.pairs.length;
    pageResult.missing = alignment.missing.length;
    pageResult.extra = alignment.extra.length;

    const perSection: NonNullable<SectionsPageResult['sections']> = [];
    for (const pair of alignment.pairs) {
      const reactSection = reactSections[pair.a];
      const shopifySection = shopifySections[pair.b];
      const textScore = diceSimilarity(reactSection.text, shopifySection.text);
      const structureMatch = reactSection.shapeHash === shopifySection.shapeHash;
      // Per-pair score folds in a modest structure component: 0.8*text + 0.2*(structure ? 1 : 0).
      pairTextScores.push(SECTION_RULES.textWeight * textScore + (1 - SECTION_RULES.textWeight) * (structureMatch ? 1 : 0));
      perSection.push({ react: sectionTitle(reactSection), order: [pair.a, pair.b], textScore: Number(textScore.toFixed(3)), structureMatch });
      if (textScore < SECTION_RULES.textDriftThreshold) {
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
  }

  // Score only over reachable routes (ok = compared, missing_page = counts as all-missing).
  // 'unreachable'/'skipped'/'catalog_unseeded'/'capture_failed' routes are excluded from the
  // denominator so a flaky load or an unseeded catalog doesn't tank the score.
  const scored = pages.filter((page) => page.status === 'ok' || page.status === 'missing_page');
  const unseeded = pages.filter((page) => page.status === 'catalog_unseeded');
  const totalReactSections = scored.reduce((sum, page) => sum + (page.reactSections || 0), 0);
  const totalMatched = scored.reduce((sum, page) => sum + (page.matched || 0), 0);
  const presence = totalReactSections ? totalMatched / totalReactSections : 0;
  const text = pairTextScores.length ? pairTextScores.reduce((sum, score) => sum + score, 0) / pairTextScores.length : 0;

  const report: SectionsReport = { presence: Number(presence.toFixed(4)), text: Number(text.toFixed(4)), catalogUnseeded: unseeded.map((page) => page.route), pages, issues };
  const capture = sectionsCaptureStatus(pages, problems, scored.length, totalReactSections);
  if (capture) report.capture = capture;
  return { report, markdown: sectionsMarkdown(input, report, totalMatched, totalReactSections) };
}

/** Null when capture was healthy everywhere; `failed` when nothing at all could be measured. */
function sectionsCaptureStatus(pages: SectionsPageResult[], problems: CaptureProblem[], scoredCount: number, totalReactSections: number): CaptureStatus | null {
  const attempted = pages.filter((page) => page.status !== 'skipped');
  const lost = attempted.filter((page) => page.status === 'unreachable' || page.status === 'capture_failed');
  if (!problems.length && !(attempted.length && lost.length === attempted.length)) return null;
  let reason: string | undefined;
  if (attempted.length && scoredCount === 0) reason = `no page could be captured (${lost.length} of ${attempted.length} failed)`;
  else if (scoredCount > 0 && totalReactSections === 0 && problems.length) reason = 'the React site rendered no comparable sections';
  return { failed: Boolean(reason), ...(reason ? { reason } : {}), problems };
}

function sectionsMarkdown(input: SectionsInput, report: SectionsReport, totalMatched: number, totalReactSections: number): string {
  const { iter } = input;
  const { pages, issues, presence, text } = report;
  const unseeded = pages.filter((page) => page.status === 'catalog_unseeded');
  const lines = [
    `# Section comparison — iteration ${iter}`,
    '',
    `React (truth): ${input.reactBase}`, `Shopify (clone): ${input.shopifyBase}`, '',
    `> Scoring note: the text subscore blends per-section text similarity with DOM structure:`,
    `> pairScore = 0.8 x textScore + 0.2 x (structureMatch ? 1 : 0). The per-section \`textScore\``,
    `> column below stays pure text similarity; \`structureMatch\` shows the structure signal.`, '',
    ...(unseeded.length ? [
      `> **WARNING — CATALOG NOT SEEDED:** ${unseeded.length} catalog route(s) 404 on Shopify and are`,
      `> EXCLUDED from the presence score: ${unseeded.map((page) => page.route).join(', ')}.`,
      `> Seed the products/collections (productCreate/collectionCreate + publish) and re-run QA.`, '',
    ] : []),
    ...captureMarkdown(report.capture),
    `**Section presence: ${(presence * 100).toFixed(1)}%** (${totalMatched}/${totalReactSections}) · **Text match: ${(text * 100).toFixed(1)}%**`, '',
    '| Route | Status | Sections (R) | Matched | Missing | Extra | Text |',
    '|---|---|---|---|---|---|---|',
    ...pages.map((page) => `| ${page.route} | ${page.status} | ${page.reactSections ?? '-'} | ${page.matched ?? '-'} | ${page.missing ?? '-'} | ${page.extra ?? '-'} | ${page.textScore != null ? `${Math.round(page.textScore * 100)}%` : '-'} |`),
    '',
    `## Issues (${issues.length})`, '',
    ...issues.map((issue) => `- **[${issue.kind}]** \`${issue.page}\` ${issue.title}${issue.detail ? `\n  ${issue.detail.replace(/\n/g, '\n  ')}` : ''}`),
    '',
    `Screenshots: \`qa/screenshots/factory/${iter}/<route>/{react,shopify}-{desktop,mobile}.png\``, '',
  ];
  return lines.join('\n');
}

/** Markdown block describing capture problems (empty when there were none). */
export function captureMarkdown(capture: CaptureStatus | undefined): string[] {
  if (!capture) return [];
  const lines = capture.failed
    ? [`> **CAPTURE FAILED:** ${capture.reason ?? 'nothing could be measured'}. This is not a clone score — fix the capture problem and re-run the check.`]
    : [`> **Capture problems:** ${capture.problems.length} page load(s) could not be captured and are EXCLUDED from the score.`];
  for (const problem of capture.problems.slice(0, 20)) lines.push(`> - \`${problem.route}\` (${problem.site}): ${problem.problem}`);
  lines.push('');
  return lines;
}
