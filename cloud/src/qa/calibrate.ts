// Calibration rubric: proves the capture + scoring pipeline works BEFORE job scores are trusted.
// The desktop captures a known-good fixture pair; a healthy pipeline scores ~1.0 on it. Ported
// from templates/factory/qa/calibrate.mjs (threshold, minimum sections, composite).
import { isBlank, segmentLayout } from './segment';
import { compositeScore, DEFAULT_SCORE_WEIGHTS } from './summary';
import { alignSections, diceSimilarity } from './text';
import type { CalibrateRequest, CalibrateResponse, QaSubscores } from './types';

export const CALIBRATION_RULES = { threshold: 0.95, minSections: 3 } as const;

const pct = (value: number | null) => value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;

export function calibrate(input: CalibrateRequest): CalibrateResponse {
  const mode = input.mode || 'fixture';
  const { threshold, minSections } = CALIBRATION_RULES;
  const reference = input.reference;
  const candidate = input.candidate ?? input.reference;
  for (const [label, page] of [['reference', reference], ['candidate', candidate]] as const) {
    if (page.health && (page.health.navError || isBlank(page.health))) {
      return { ok: false, score: null, subscores: null, threshold, mode, error: `the ${label} page did not render (${page.health.navError ?? 'blank page'}) — Playwright/Chromium may be broken on this machine.` };
    }
  }
  const sectionsA = segmentLayout(reference.layout);
  const sectionsB = segmentLayout(candidate.layout);
  const alignment = alignSections(sectionsA, sectionsB);
  const presence = sectionsA.length ? alignment.pairs.length / sectionsA.length : 0;
  const textScores = alignment.pairs.map((pair) => diceSimilarity(sectionsA[pair.a].text, sectionsB[pair.b].text));
  const text = textScores.length ? textScores.reduce((sum, score) => sum + score, 0) / textScores.length : 0;
  const subscores: QaSubscores = {
    presence: Number(presence.toFixed(4)),
    text: Number(text.toFixed(4)),
    interaction: null, // not exercised by calibration; composite renormalizes without it
  };
  const score = Number(compositeScore(subscores, DEFAULT_SCORE_WEIGHTS).toFixed(4));
  let error: string | undefined;
  if (sectionsA.length < minSections) {
    error = `segmentation found only ${sectionsA.length} section(s) (expected >= ${minSections}) — the page did not render or the segmenter is broken.`;
  } else if (score < threshold) {
    error = `composite ${pct(score)} fell below the ${pct(threshold)} calibration threshold on a known-good pair — do not trust job scores until this is fixed.`;
  }
  return {
    ok: !error, score, subscores, threshold, mode,
    sections: { reference: sectionsA.length, candidate: sectionsB.length, matched: alignment.pairs.length },
    ...(error ? { error } : {}),
  };
}
