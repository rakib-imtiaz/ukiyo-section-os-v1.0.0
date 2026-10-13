// Text similarity + section alignment. Ported 1:1 from templates/factory/qa/qa-shared.mjs — the
// results must stay identical (cloud/tests/qa-scoring.test.ts checks them against the old file).
import type { Section } from './types';

type Comparable = Pick<Section, 'text' | 'headings'>;

export function tokenize(text: string | null | undefined): string[] {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((token) => token.length > 1);
}

/** Dice coefficient over token sets (order-insensitive, length-robust). */
export function diceSimilarity(textA: string | null | undefined, textB: string | null | undefined): number {
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

export function headingsMatch(sectionA: Partial<Comparable>, sectionB: Partial<Comparable>): boolean {
  const normalize = (heading: string) => heading.toLowerCase().replace(/\s+/g, ' ').trim();
  const headingsA = (sectionA.headings || []).map(normalize); const headingsB = (sectionB.headings || []).map(normalize);
  return headingsA.length > 0 && headingsB.length > 0 && headingsA.some((heading) => headingsB.includes(heading));
}

export function pairScore(sectionA: Partial<Comparable>, sectionB: Partial<Comparable>): number {
  const text = diceSimilarity(sectionA.text, sectionB.text);
  return headingsMatch(sectionA, sectionB) ? Math.max(text, 0.7) : text;
}

// ---- prepared comparisons ------------------------------------------------------------------------
// The scorers compare every item of one list with every item of the other (sections: rows × cols,
// click inventories: react × shopify). Tokenizing both texts again for every pair made a single
// upload of a few hundred kB hold the event loop for seconds, so each text is prepared once. The
// results are identical to diceSimilarity / pairScore (same token sets, same arithmetic).

/** A text tokenized once, for repeated diceSimilarity comparisons. */
export interface PreparedText { tokens: Set<string>; raw: string }

export function prepareText(text: string | null | undefined): PreparedText {
  return { tokens: new Set(tokenize(text)), raw: (text || '').trim().toLowerCase() };
}

/** diceSimilarity over prepared texts. */
export function preparedDice(a: PreparedText, b: PreparedText): number {
  const sizeA = a.tokens.size; const sizeB = b.tokens.size;
  if (!sizeA && !sizeB) return a.raw === b.raw ? 1 : 0;
  if (!sizeA || !sizeB) return 0;
  // Counting over the smaller set gives the same number of shared tokens.
  const [small, large] = sizeA <= sizeB ? [a.tokens, b.tokens] : [b.tokens, a.tokens];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared++;
  return (2 * shared) / (sizeA + sizeB);
}

/** A tokenizer cache keyed by the text itself (inventories repeat the same names a lot). */
export function textPreparer(): (text: string | null | undefined) => PreparedText {
  const cache = new Map<string, PreparedText>();
  return (text) => {
    const key = text || '';
    let prepared = cache.get(key);
    if (!prepared) { prepared = prepareText(text); cache.set(key, prepared); }
    return prepared;
  };
}

interface PreparedSection { text: PreparedText; headings: Set<string> }

function prepareSection(section: Partial<Comparable>): PreparedSection {
  return { text: prepareText(section.text), headings: new Set((section.headings || []).map((heading) => heading.toLowerCase().replace(/\s+/g, ' ').trim())) };
}

/** pairScore over prepared sections. */
function preparedPairScore(a: PreparedSection, b: PreparedSection): number {
  const text = preparedDice(a.text, b.text);
  if (!a.headings.size || !b.headings.size) return text;
  const [small, large] = a.headings.size <= b.headings.size ? [a.headings, b.headings] : [b.headings, a.headings];
  for (const heading of small) if (large.has(heading)) return Math.max(text, 0.7);
  return text;
}

export interface Alignment { pairs: Array<{ a: number; b: number; score: number }>; missing: number[]; extra: number[] }

/** Order-preserving alignment (LCS with similarity weights). */
export function alignSections(listA: Array<Partial<Comparable>>, listB: Array<Partial<Comparable>>, threshold = 0.55): Alignment {
  const rows = listA.length; const cols = listB.length;
  const preparedA = listA.map(prepareSection); const preparedB = listB.map(prepareSection);
  const pairScore = (i: number, j: number) => preparedPairScore(preparedA[i], preparedB[j]);
  const table = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const score = pairScore(i, j);
      const take = score >= threshold ? score + table[i + 1][j + 1] : -Infinity;
      table[i][j] = Math.max(take, table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: Alignment['pairs'] = []; const matchedA = new Set<number>(); const matchedB = new Set<number>();
  let i = 0; let j = 0;
  while (i < rows && j < cols) {
    const score = pairScore(i, j);
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
export function textDiffSamples(sectionA: Partial<Comparable>, sectionB: Partial<Comparable>, limit = 3): string[] {
  const sentences = (text: string | undefined) => (text || '').split(/(?<=[.!?])\s+|\n+/).map((entry) => entry.trim()).filter((entry) => entry.length > 3);
  const fromA = sentences(sectionA.text); const setB = new Set(sentences(sectionB.text).map((entry) => entry.toLowerCase()));
  return fromA.filter((sentence) => !setB.has(sentence.toLowerCase())).slice(0, limit);
}

export function sectionTitle(section: Partial<Comparable>): string {
  return section.headings?.[0] || tokenize(section.text).slice(0, 8).join(' ') || '(unnamed section)';
}
