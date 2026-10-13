// Segmentation and capture health, applied in the Cloud to the raw layout dump the desktop
// capture uploads. The capture only walks the page body (main || body, minus header/footer/nav
// and non-content tags) and descends single-child wrapper chains; every rule that decides what
// a "section" is lives here.
import type { LayoutBlock, LayoutDump, Section, SiteHealth } from './types';

export const SEGMENT_RULES = {
  /** Bands shorter than this are decoration (spacers, dividers), not sections. */
  minHeight: 120,
  /** Bands narrower than this share of the viewport are columns/cards, not sections. */
  minWidthRatio: 0.6,
  /**
   * Loop bound for unwrapping a lone page wrapper (as in the local script). A lone wrapper is
   * replaced by its children when it has two or more; a lone wrapper with a single child is kept.
   */
  unwrapDepth: 4,
} as const;

/** The page's sections — identical to what the old in-page segmentSections() returned. */
export function segmentLayout(layout: LayoutDump | null | undefined): Section[] {
  if (!layout) return [];
  const byParent = new Map<number, LayoutBlock[]>();
  for (const block of layout.blocks) {
    const siblings = byParent.get(block.parent);
    if (siblings) siblings.push(block); else byParent.set(block.parent, [block]);
  }
  let candidates = byParent.get(-1) ?? [];
  // unwrap single-child wrappers (page containers)
  for (let depth = 0; depth < SEGMENT_RULES.unwrapDepth && candidates.length === 1; depth++) {
    const children = byParent.get(candidates[0].id) ?? [];
    if (children.length <= 1) break;
    candidates = children;
  }
  const sections: Section[] = [];
  for (const block of candidates) {
    if (block.h < SEGMENT_RULES.minHeight || block.w < layout.viewportWidth * SEGMENT_RULES.minWidthRatio) continue;
    sections.push({
      headings: block.headings,
      text: block.text.slice(0, 4000),
      imgCount: block.imgCount,
      imgAlts: block.imgAlts,
      linkCount: block.linkCount,
      shapeHash: block.shapeHash,
      childCount: block.childCount,
      bbox: { y: Math.round(block.y), height: Math.round(block.h) },
    });
  }
  return sections;
}

/** Fewer visible characters than this (and no media) = the page rendered blank. */
const BLANK_TEXT = 25;

export function isBlank(health: SiteHealth): boolean {
  return health.textLength < BLANK_TEXT && health.mediaCount === 0;
}

/**
 * Why a captured page can't be trusted, in plain words (empty = fine). A blank *React* page means
 * the source of truth didn't render; a blank *Shopify* page is a real clone defect and is scored.
 */
export function siteProblems(health: SiteHealth | null | undefined, site: 'react' | 'shopify'): string[] {
  if (!health) return [];
  const problems: string[] = [];
  if (health.status == null && health.navError) problems.push(`page did not load (${health.navError})`);
  if (health.passwordGate) problems.push('the storefront password page is still showing — check the store password');
  if (site === 'react' && health.status != null && isBlank(health)) problems.push('page rendered blank (no visible text or media) — is the React site running?');
  return problems;
}
