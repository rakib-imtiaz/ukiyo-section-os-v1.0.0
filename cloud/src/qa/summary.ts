// The composite score and the fixer-facing summary (qa-summary-<iter>.md). Ported from
// server/factory/qa.ts (compositeScore, the fixed-issue delta, renderSummary) — same numbers,
// same markdown — plus a capture-failed banner when nothing could be measured.
import type { CaptureProblem, CaptureStatus, QaIssue, QaSubscores, ScoreWeights, SummaryRequest, SummaryResponse } from './types';

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = { presence: 0.5, text: 0.3, interaction: 0.2 };

/** Weighted mean over the subscores that were measured (absent ones are renormalized away). */
export function compositeScore(subscores: QaSubscores, weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS): number {
  const parts: Array<[number, number]> = [];
  if (subscores.presence != null) parts.push([subscores.presence, weights.presence]);
  if (subscores.text != null) parts.push([subscores.text, weights.text]);
  if (subscores.interaction != null) parts.push([subscores.interaction, weights.interaction]);
  const totalWeight = parts.reduce((sum, [, weight]) => sum + weight, 0);
  if (!totalWeight) return 0;
  return parts.reduce((sum, [score, weight]) => sum + score * weight, 0) / totalWeight;
}

/** Identity of an issue across iterations (ids are per-iteration, so they can't be used). */
export function issueKey(issue: Pick<QaIssue, 'kind' | 'page' | 'title'>): string { return `${issue.kind}|${issue.page}|${issue.title}`; }

/** FIX THESE ordering: what to fix first. */
export const ISSUE_PRIORITY: Record<string, number> = { missing_section: 0, missing_page: 1, structure_drift: 2, text_drift: 3, missing_interaction: 4, interaction_noop: 5, interaction_target: 6, extra_section: 7 };

export interface RenderInput {
  jobName: string;
  iteration: number;
  score: number;
  scoreThreshold: number;
  subscores: QaSubscores;
  issues: QaIssue[];
  fixedKeys: string[];
  unreachable: string[];
  handlesMissing: boolean;
  capture?: CaptureStatus | null;
}

export function renderSummary(input: RenderInput): string {
  const { iteration, score, subscores, issues, fixedKeys, unreachable, handlesMissing, capture } = input;
  const pct = (value: number | null) => value == null ? 'n/a' : `${Math.round(value * 100)}%`;
  const lines = [
    `# QA summary — iteration ${iteration} for ${input.jobName}`,
    '',
  ];
  if (capture?.failed) {
    lines.push(`> **CAPTURE FAILED — no score this round.** ${capture.reason ?? 'Nothing could be measured'}. The pages below could not be captured; fix that (is the site up? is the store password right?) and run the check again. Do not change the theme because of this report.`, '');
  }
  lines.push(
    `**Composite score: ${(score * 100).toFixed(1)}%** (threshold ${(input.scoreThreshold * 100).toFixed(0)}%)`,
    `Subscores — section presence: ${pct(subscores.presence)} · text match: ${pct(subscores.text)} · interactions: ${pct(subscores.interaction)}`,
    '',
  );
  if (handlesMissing) {
    lines.push('> **WARNING:** `qa/state/handles.json` missing — falling back to heuristic route mapping; scores may be unreliable.', '');
  }
  if (capture?.problems.length) {
    lines.push(`## Capture problems (excluded from score) (${capture.problems.length})`, '');
    capture.problems.slice(0, 30).forEach((problem) => lines.push(`- \`${problem.route}\` (${problem.site}): ${problem.problem}`));
    lines.push('');
  }
  if (fixedKeys.length) {
    lines.push(`## Fixed since last iteration (${fixedKeys.length})`, '');
    fixedKeys.forEach((key) => lines.push(`- ~~${key.split('|').slice(1).join(' — ')}~~`));
    lines.push('');
  }
  if (unreachable.length) {
    lines.push('## Unreachable routes (excluded from score)', '');
    unreachable.forEach((route) => lines.push(`- ${route}`));
    lines.push('');
  }
  lines.push(`## FIX THESE (${issues.length}, in priority order)`, '');
  if (!issues.length) lines.push('Nothing — all checks passed.');
  [...issues].sort((a, b) => (ISSUE_PRIORITY[a.kind] ?? 9) - (ISSUE_PRIORITY[b.kind] ?? 9)).forEach((issue, index) => {
    lines.push(`${index + 1}. **[${issue.kind}]** \`${issue.page}\` — ${issue.title}${issue.detail ? `\n   ${issue.detail.replace(/\n/g, '\n   ')}` : ''}`);
  });
  lines.push('', '## Detail reports', '', `- Sections: \`qa/reports/factory/sections-${iteration}.md\``, `- Interactions: \`qa/reports/factory/interactions-${iteration}.md\``, `- Screenshots: \`qa/screenshots/factory/${iteration}/\``, '');
  return lines.join('\n');
}

/** Merges the sections + interactions capture status into one (failed if either failed). */
export function mergeCapture(...statuses: Array<CaptureStatus | null | undefined>): CaptureStatus | null {
  const present = statuses.filter((status): status is CaptureStatus => Boolean(status));
  if (!present.length) return null;
  const failed = present.filter((status) => status.failed);
  const problems: CaptureProblem[] = [];
  const seen = new Set<string>();
  for (const status of present) {
    for (const problem of status.problems) {
      const key = `${problem.route}|${problem.site}|${problem.problem}`;
      if (!seen.has(key)) { seen.add(key); problems.push(problem); }
    }
  }
  return { failed: failed.length > 0, ...(failed.length ? { reason: failed.map((status) => status.reason).filter(Boolean).join('; ') } : {}), problems };
}

export interface SummaryInput extends Omit<SummaryRequest, 'prevIssues'> {
  /** Issue keys of iteration N-1, or null when unknown (no delta is shown). */
  previousKeys: string[] | null;
  deltaSource: SummaryResponse['deltaSource'];
}

export function buildSummary(input: SummaryInput): SummaryResponse {
  const { sections, interactions, iter } = input;
  const subscores: QaSubscores = {
    presence: sections?.presence ?? null,
    text: sections?.text ?? null,
    interaction: interactions?.interaction ?? null,
  };
  const score = compositeScore(subscores, input.weights ?? DEFAULT_SCORE_WEIGHTS);
  const issues = [...(sections?.issues ?? []), ...(interactions?.issues ?? [])];

  // Delta vs previous iteration: which issue keys disappeared?
  let fixedKeys: string[] = [];
  if (iter > 1 && input.previousKeys) {
    const currentKeys = new Set(issues.map(issueKey));
    fixedKeys = [...new Set(input.previousKeys)].filter((key) => !currentKeys.has(key));
  }

  const unreachable = (sections?.pages ?? []).filter((page) => page.status === 'unreachable').map((page) => page.route);
  const capture = mergeCapture(sections?.capture, interactions?.capture);
  const handlesMissing = Boolean(input.handlesMissing);
  const summaryMarkdown = renderSummary({ jobName: input.jobName, iteration: iter, score, scoreThreshold: input.scoreThreshold, subscores, issues, fixedKeys, unreachable, handlesMissing, capture });
  return {
    score,
    subscores,
    // subscores ride inside breakdown so they persist per-iteration in factory_iterations
    // and surface through GET /jobs/:id for the UI to chart presence/text/interaction.
    breakdown: { issues: issues.length, fixed: fixedKeys.length, unreachable: unreachable.length, pages: sections?.pages?.length ?? 0, subscores, handlesMissing, ...(capture ? { capture } : {}) },
    summaryMarkdown,
    issueCount: issues.length,
    captureFailed: Boolean(capture?.failed),
    captureProblems: capture?.problems ?? [],
    deltaSource: input.deltaSource,
  };
}
