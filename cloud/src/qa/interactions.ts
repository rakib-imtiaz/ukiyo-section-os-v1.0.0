// Interaction rubric ("click verify"), split in two so the capture never decides anything:
//
//   planInteractions  — inventories of both sites → matching, link verdicts, commerce denylist,
//                       click budget, and the exact list of clicks the capture must perform.
//   scoreInteractions — the plan + what each click did → verdicts, totals and the report.
//
// Ported from templates/factory/qa/interaction-verify.mjs: same matching, statuses, issue texts,
// issue ids (the plan keeps every issue in the order the old loop produced it) and totals.
import { computeShopifyPath, isCatalogPath, linkTargetMatches } from './routing';
import { siteProblems } from './segment';
import { preparedDice, textPreparer } from './text';
import type {
  CaptureProblem, CaptureStatus, ClickEffect, ClickEffects, ClickPlan, InteractionsCaptureRoute, InteractionsPageResult,
  InteractionsReport, InventoryItem, PlanEvent, PlannedClick, PlannedRoute, QaIssue,
} from './types';

export const INTERACTION_RULES = {
  /** Interactive (non-link) elements actually clicked per route; overflow is reported, never silent. */
  maxClicksPerRoute: 15,
  /** Fuzzy accessible-name match needed to pair a React element with a Shopify one. */
  fuzzyMatch: 0.8,
} as const;

// ---------- pure helpers (unit tested) ----------

export function effectSummary(effect: ClickEffect | null | undefined): string {
  if (!effect || effect.error) return `error: ${effect?.error ?? 'unknown'}`;
  if (effect.navigatedTo) return `navigates to ${effect.navigatedTo}`;
  if (effect.overlayAppeared) return 'opens overlay/modal';
  if (effect.ariaFlipped) return 'toggles expanded state';
  if (!effect.noop) return `mutates DOM (${(effect.domDelta ?? 0) > 0 ? '+' : ''}${effect.domDelta} nodes)`;
  return 'no visible effect';
}

/**
 * Commerce/destructive controls that QA must NEVER actually click (real carts, real checkouts,
 * real newsletter signups). They are verified by presence/match only (`verified_static`).
 * The capture enforces the same list again as a safety net.
 */
export const COMMERCE_CLICK_DENYLIST = /add.?to.?cart|add.?to.?(bag|basket)|buy.?now|\bbuy\b|checkout|subscribe|sign.?up|newsletter|\bsubmit\b|place.?order|pay.?now|pre.?order/i;

/** Denylist check over an inventory item: accessible name, id/class, or a form submit control. */
export function isDenylistedClick(item: Partial<Pick<InventoryItem, 'name' | 'idClass' | 'isSubmit'>> | null | undefined): boolean {
  if (!item) return false;
  if (item.isSubmit) return true;
  return COMMERCE_CLICK_DENYLIST.test(item.name || '') || COMMERCE_CLICK_DENYLIST.test(item.idClass || '');
}

/**
 * Two click effects are equivalent when they produce the same class of outcome. When BOTH
 * navigate, the destinations must also match (route-mapped via handles).
 */
export function effectsEquivalent(reactEffect: ClickEffect | null | undefined, shopifyEffect: ClickEffect | null | undefined, handles: Record<string, string> = {}): boolean {
  if (!reactEffect || !shopifyEffect || reactEffect.error || shopifyEffect.error) return false;
  if (reactEffect.navigatedTo && shopifyEffect.navigatedTo) {
    return linkTargetMatches(reactEffect.navigatedTo, shopifyEffect.navigatedTo, handles);
  }
  if (reactEffect.overlayAppeared && shopifyEffect.overlayAppeared) return true;
  if (reactEffect.ariaFlipped && shopifyEffect.ariaFlipped) return true;
  if (!reactEffect.noop && !shopifyEffect.noop) return true;
  return Boolean(reactEffect.noop && shopifyEffect.noop);
}

const emptyPage = (route: string): InteractionsPageResult => ({ route, elements: 0, tested: 0, same: 0, different: 0, missing: 0, clicked: 0, verifiedStatic: 0, untested: 0, skippedClicks: 0 });
const target = (item: InventoryItem) => ({ tag: item.tag, name: item.name, ordinal: item.ordinal });

// ---------- pass 1: plan ----------

export interface PlanInput { iter: number; handles: Record<string, string>; routes: InteractionsCaptureRoute[] }

export function planInteractions(input: PlanInput): ClickPlan {
  const { handles } = input;
  const routes: PlannedRoute[] = [];
  const clicks: PlannedClick[] = [];
  const problems: CaptureProblem[] = [];

  for (const captured of input.routes) {
    const { route, shopifyPath } = captured;
    if (!shopifyPath) continue;
    const page = emptyPage(route);
    const events: PlanEvent[] = [];
    const planned = () => routes.push({ page, events });
    const captureFail = (site: 'react' | 'shopify', found: string[]) => {
      for (const problem of found) problems.push({ route, site, problem });
      page.status = 'capture_failed';
      page.reason = `${site}: ${found.join('; ')}`.slice(0, 200);
      planned();
    };

    if (captured.error) { page.status = 'error'; page.reason = captured.error.slice(0, 200); planned(); continue; }
    const react = captured.react; const shopify = captured.shopify;
    if (!react || !react.ok) { page.status = 'unreachable'; planned(); continue; }
    const reactProblems = siteProblems(react.health, 'react');
    if (reactProblems.length) { captureFail('react', reactProblems); continue; }
    if (!shopify) { page.status = 'error'; page.reason = 'shopify page not captured'; planned(); continue; }
    if (shopify.status == null && shopify.health?.navError) { captureFail('shopify', siteProblems(shopify.health, 'shopify')); continue; }
    // section comparison already reports missing pages / unseeded catalog
    if (shopify.status == null || shopify.status === 404) { page.status = isCatalogPath(shopifyPath) ? 'catalog_unseeded' : 'missing_page'; planned(); continue; }
    const shopifyProblems = siteProblems(shopify.health, 'shopify');
    if (shopifyProblems.length) { captureFail('shopify', shopifyProblems); continue; }

    const reactItems = (react.items ?? []).filter((item) => item.visible);
    const shopifyItems = (shopify.items ?? []).filter((item) => item.visible);
    page.elements = reactItems.length;
    const shopifyByKey = new Map(shopifyItems.map((item) => [item.key, item]));
    // Names tokenized once per route (same results as diceSimilarity on the raw names).
    const prepare = textPreparer();
    const reactNames = reactItems.map((item) => prepare(item.name));
    const shopifyNames = shopifyItems.map((item) => prepare(item.name));
    const fuzzyFind = (reactIndex: number) => {
      const reactItem = reactItems[reactIndex];
      let best: InventoryItem | null = null; let bestScore = 0;
      for (let index = 0; index < shopifyItems.length; index += 1) {
        const candidate = shopifyItems[index];
        if (candidate.kind !== reactItem.kind) continue;
        const score = preparedDice(reactNames[reactIndex], shopifyNames[index]);
        if (score > bestScore) { best = candidate; bestScore = score; }
      }
      return bestScore >= INTERACTION_RULES.fuzzyMatch ? best : null;
    };

    // Links: static target verification. Commerce/destructive actions: NEVER clicked — presence/
    // match verified statically. Remaining actions: real clicks (capped). Overflow beyond the cap
    // is NOT scored (coverage_gap only).
    const actionItems = reactItems.filter((item) => item.kind === 'action');
    const denied = new Set(actionItems.filter((item) => isDenylistedClick(item)));
    const clickable = actionItems.filter((item) => !denied.has(item));
    const clickBudget = new Set(clickable.slice(0, INTERACTION_RULES.maxClicksPerRoute));
    page.skippedClicks = clickable.length - clickBudget.size;
    if (page.skippedClicks > 0) {
      events.push({ issue: { kind: 'coverage_gap', page: route, title: `${page.skippedClicks} interactive element(s) beyond the ${INTERACTION_RULES.maxClicksPerRoute}-click budget were not exercised`, detail: 'These elements are EXCLUDED from the interaction score (untested is not passed). Raise MAX_CLICKS_PER_ROUTE or verify manually.' } });
    }

    for (const [reactIndex, item] of reactItems.entries()) {
      const match = shopifyByKey.get(item.key) ?? fuzzyFind(reactIndex);
      if (!match) {
        // Presence check is itself a static verification — a missing element is tested-and-failed.
        page.tested++; page.missing++;
        events.push({ issue: { kind: 'missing_interaction', page: route, title: `Missing on Shopify: ${item.tag} "${item.name || item.href}" (${item.region})`, detail: item.kind === 'link' ? `React link -> ${item.href}` : 'Interactive element absent from the clone.' } });
        continue;
      }
      if (item.kind === 'link') {
        page.tested++;
        if (linkTargetMatches(item.href, match.href, handles)) page.same++;
        else {
          page.different++;
          events.push({ issue: { kind: 'interaction_target', page: route, title: `Link "${item.name}" points to the wrong place`, detail: `React -> ${item.href} · Shopify -> ${match.href} (expected ${computeShopifyPath((item.href || '').split(/[?#]/)[0], handles) ?? item.href})` } });
        }
        continue;
      }
      if (denied.has(item)) {
        // verified_static: present + name-matched, deliberately not clicked (real commerce action).
        page.tested++; page.verifiedStatic++; page.same++;
        continue;
      }
      if (!clickBudget.has(item)) { page.untested++; continue; } // beyond budget: NOT scored, flagged via coverage_gap
      page.tested++; page.clicked++;
      const index = clicks.length;
      clicks.push({ i: index, route, shopifyPath, react: target(item), shopify: target(match) });
      events.push({ click: index, name: item.name });
    }
    const reactKeys = new Set(reactItems.map((reactItem) => reactItem.key));
    for (const [index, item] of shopifyItems.entries()) {
      if (!reactKeys.has(item.key) && !reactNames.some((name) => preparedDice(name, shopifyNames[index]) >= INTERACTION_RULES.fuzzyMatch)) {
        events.push({ issue: { kind: 'extra_interaction', page: route, title: `Extra on Shopify: ${item.tag} "${item.name || item.href}"`, detail: 'Not present in the React original (informational).' } });
      }
    }
    planned();
  }

  const plan: ClickPlan = { v: 1, iter: input.iter, handles, routes, clicks };
  const capture = interactionsCaptureStatus(routes.map((entry) => entry.page), problems);
  if (capture) plan.capture = capture;
  return plan;
}

function interactionsCaptureStatus(pages: InteractionsPageResult[], problems: CaptureProblem[]): CaptureStatus | null {
  const lost = pages.filter((page) => page.status === 'unreachable' || page.status === 'error' || page.status === 'capture_failed');
  const allLost = pages.length > 0 && lost.length === pages.length;
  if (!problems.length && !allLost) return null;
  const reason = allLost ? `no page could be captured (${lost.length} of ${pages.length} failed)` : undefined;
  return { failed: Boolean(reason), ...(reason ? { reason } : {}), problems };
}

// ---------- pass 2: score ----------

export interface ScoreInput { plan: ClickPlan; effects: ClickEffects[]; reactBase: string; shopifyBase: string }

export function scoreInteractions(input: ScoreInput): { report: InteractionsReport; markdown: string } {
  const { plan } = input;
  const iter = plan.iter;
  const effectsByClick = new Map(input.effects.map((entry) => [entry.i, entry]));
  const issues: QaIssue[] = [];
  let issueSeq = 0;
  const issueId = () => `i${iter}-${++issueSeq}`;
  const pages: InteractionsPageResult[] = [];

  for (const planned of plan.routes) {
    const page: InteractionsPageResult = { ...planned.page };
    for (const event of planned.events) {
      if ('issue' in event) { issues.push({ id: issueId(), ...event.issue }); continue; }
      const captured = effectsByClick.get(event.click);
      const reactEffect: ClickEffect = captured?.react ?? { error: 'click not captured' };
      const shopifyEffect: ClickEffect = captured?.shopify ?? { error: 'click not captured' };
      if (reactEffect.refused || shopifyEffect.refused) {
        // The capture's own commerce safety net refused the click: verified statically, like the denylist.
        page.clicked--; page.verifiedStatic++; page.same++;
        continue;
      }
      if (effectsEquivalent(reactEffect, shopifyEffect, plan.handles)) page.same++;
      else {
        page.different++;
        const kind = shopifyEffect?.noop && !reactEffect?.noop ? 'interaction_noop' : 'interaction_target';
        issues.push({ id: issueId(), kind, page: page.route, title: `"${event.name}" behaves differently`, detail: `React: ${effectSummary(reactEffect)} · Shopify: ${effectSummary(shopifyEffect)}${shopifyEffect?.consoleErrors?.length ? `\nShopify console errors: ${shopifyEffect.consoleErrors.join(' | ')}` : ''}` });
      }
    }
    pages.push(page);
  }

  // Score = tested-equivalent / tested-total. "Tested" means clicked or statically verified
  // (links, commerce-denylisted controls, presence checks). Untested overflow beyond the click
  // budget is EXCLUDED from the score — untested is never counted as passed.
  const totalTested = pages.reduce((sum, page) => sum + page.tested, 0);
  const totalSame = pages.reduce((sum, page) => sum + page.same, 0);
  const totalUntested = pages.reduce((sum, page) => sum + page.untested, 0);
  const interaction = totalTested ? totalSame / totalTested : 0;
  // extra_interaction and coverage_gap are informational: excluded from the fixer's FIX-THESE scoring issues
  const scoringIssues = issues.filter((issue) => issue.kind !== 'extra_interaction' && issue.kind !== 'coverage_gap');
  const report: InteractionsReport = { interaction: Number(interaction.toFixed(4)), tested: totalTested, same: totalSame, untested: totalUntested, issues: scoringIssues, informational: issues.filter((issue) => !scoringIssues.includes(issue)), pages };
  if (plan.capture) report.capture = plan.capture;
  return { report, markdown: interactionsMarkdown(input, report) };
}

function interactionsMarkdown(input: ScoreInput, report: InteractionsReport): string {
  const iter = input.plan.iter;
  const { interaction, same: totalSame, tested: totalTested, untested: totalUntested, pages, issues: scoringIssues } = report;
  const capture = report.capture;
  return [
    `# Interaction verification — iteration ${iter}`, '',
    `React (truth): ${input.reactBase}`, `Shopify (clone): ${input.shopifyBase}`, '',
    `> Scoring note: parity = tested-equivalent / tested-total. Commerce/destructive controls`,
    `> (add-to-cart, buy, checkout, subscribe, form submits) are never clicked — they are verified`,
    `> statically ("Static" column) and count as tested. Elements beyond the click budget are`,
    `> untested and EXCLUDED from the score (reported as coverage_gap).`, '',
    ...(capture ? [
      capture.failed ? `> **CAPTURE FAILED:** ${capture.reason}. This is not a clone score — fix the capture problem and re-run the check.` : `> **Capture problems:** ${capture.problems.length} page load(s) could not be captured and are EXCLUDED from the score.`,
      ...capture.problems.slice(0, 20).map((problem) => `> - \`${problem.route}\` (${problem.site}): ${problem.problem}`), '',
    ] : []),
    `**Interaction parity: ${(interaction * 100).toFixed(1)}%** (${totalSame}/${totalTested} tested elements behave the same${totalUntested ? `; ${totalUntested} untested, excluded` : ''})`, '',
    '| Route | Elements (R) | Tested | Same | Static | Missing | Different | Clicked | Untested |',
    '|---|---|---|---|---|---|---|---|---|',
    ...pages.map((page) => `| ${page.route} | ${page.elements} | ${page.tested} | ${page.same} | ${page.verifiedStatic} | ${page.missing} | ${page.different} | ${page.clicked} | ${page.untested} |`),
    '',
    `## Behavioral differences (${scoringIssues.length})`, '',
    ...scoringIssues.map((issue) => `- **[${issue.kind}]** \`${issue.page}\` ${issue.title}${issue.detail ? `\n  ${issue.detail.replace(/\n/g, '\n  ')}` : ''}`),
    '',
  ].join('\n');
}
