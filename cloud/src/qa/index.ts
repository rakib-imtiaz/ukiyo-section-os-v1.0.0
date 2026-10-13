// ThemeBot Cloud QA scoring (phase 3). The desktop captures evidence; this module scores it.
// Wiring (cloud/src/app.ts, before the 16 kB JSON parser):  registerQaRoutes(app, ctx);
export { registerQaRoutes, qaRouter, signPlan, QA_BODY_LIMIT } from './routes';
export { ensureQaSchema, pruneQaRounds, previousRoundKeys } from './store';
export { scoreSections, SECTION_RULES } from './sections';
export { planInteractions, scoreInteractions, effectSummary, effectsEquivalent, isDenylistedClick, COMMERCE_CLICK_DENYLIST, INTERACTION_RULES } from './interactions';
export { segmentLayout, siteProblems, SEGMENT_RULES } from './segment';
export { compositeScore, buildSummary, renderSummary, issueKey, DEFAULT_SCORE_WEIGHTS } from './summary';
export { calibrate, CALIBRATION_RULES } from './calibrate';
export { tokenize, diceSimilarity, headingsMatch, pairScore, alignSections, textDiffSamples, sectionTitle } from './text';
export { computeShopifyPath, isCatalogPath, parseHandles, linkTargetMatches } from './routing';
export type * from './types';
