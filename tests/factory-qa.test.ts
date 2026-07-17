import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS workspace template, imported directly for unit testing
import { diceSimilarity, alignSections, pairScore, textDiffSamples, computeShopifyPath, parseHandles, sectionTitle, tokenize, effectsEquivalent, linkTargetMatches, effectSummary } from '../templates/factory/qa/qa-shared.mjs';
import { compositeScore } from '../server/factory/qa';

const section = (text: string, headings: string[] = []) => ({ text, headings, imgCount: 0, imgAlts: [], linkCount: 0, shapeHash: 'x', childCount: 1, bbox: { y: 0, height: 200 } });

describe('similarity', () => {
  it('scores identical, disjoint, and partial text sensibly', () => {
    expect(diceSimilarity('Fresh roasted coffee beans', 'Fresh roasted coffee beans')).toBe(1);
    expect(diceSimilarity('Fresh roasted coffee beans', 'quantum flux capacitor engaged')).toBe(0);
    const partial = diceSimilarity('Fresh roasted coffee beans delivered monthly', 'Fresh roasted coffee beans');
    expect(partial).toBeGreaterThan(0.6);
    expect(partial).toBeLessThan(1);
  });
  it('boosts pair score on identical headings even when body text differs', () => {
    const a = section('completely different body copy here', ['Our Story']);
    const b = section('nothing shared with the other side at all', ['Our Story']);
    expect(pairScore(a, b)).toBeGreaterThanOrEqual(0.7);
  });
  it('tokenizes robustly', () => {
    expect(tokenize('Hello, WORLD! 42 a')).toEqual(['hello', 'world', '42']);
  });
});

describe('alignSections', () => {
  const hero = section('Welcome to Wild Sacred handcrafted botanical rituals for modern life', ['Wild & Sacred']);
  const features = section('Small batch organic ethically sourced ingredients from trusted farms', ['Why choose us']);
  const cta = section('Join the circle subscribe for seasonal ritual guides and offers', ['Join the circle']);
  const testimonials = section('Customers love the calming rituals five stars across the board', ['Loved by many']);

  it('aligns identical ordered lists fully', () => {
    const result = alignSections([hero, features, cta], [hero, features, cta]);
    expect(result.pairs).toHaveLength(3);
    expect(result.missing).toHaveLength(0);
    expect(result.extra).toHaveLength(0);
  });
  it('detects a dropped middle band as missing while keeping order', () => {
    const result = alignSections([hero, features, testimonials, cta], [hero, testimonials, cta]);
    expect(result.pairs.map((pair: { a: number }) => pair.a)).toEqual([0, 2, 3]);
    expect(result.missing).toEqual([1]);
    expect(result.extra).toHaveLength(0);
  });
  it('flags clone-only bands as extra', () => {
    const bonus = section('Totally invented promotional banner not present in the original design', ['Flash sale']);
    const result = alignSections([hero, cta], [hero, bonus, cta]);
    expect(result.extra).toEqual([1]);
  });
  it('does not force-match dissimilar sections', () => {
    const result = alignSections([hero], [section('unrelated legal disclaimer text about cookies and privacy policies', ['Legal'])]);
    expect(result.pairs).toHaveLength(0);
    expect(result.missing).toEqual([0]);
    expect(result.extra).toEqual([0]);
  });
});

describe('textDiffSamples + sectionTitle', () => {
  it('returns the React strings absent from the clone', () => {
    const a = section('Free shipping over $50. Handmade in Oregon. Est. 2019.');
    const b = section('Free shipping over $50. Est. 2019.');
    const samples = textDiffSamples(a, b);
    expect(samples.join(' ')).toContain('Handmade in Oregon');
  });
  it('falls back to leading words when a section has no heading', () => {
    expect(sectionTitle(section('some plain band of text without any heading present here'))).toContain('some plain band');
    expect(sectionTitle(section('body', ['Actual Heading']))).toBe('Actual Heading');
  });
});

describe('route mapping', () => {
  it('maps routes with heuristics and handle overrides', () => {
    expect(computeShopifyPath('/')).toBe('/');
    expect(computeShopifyPath('/about')).toBe('/pages/about');
    expect(computeShopifyPath('/membership/guardian-circle')).toBe('/pages/membership-guardian-circle');
    expect(computeShopifyPath('/blog')).toBeNull();
    expect(computeShopifyPath('/blog', { '/blog': '/blogs/journal' })).toBe('/blogs/journal');
  });
  it('parses multiple handles.json shapes tolerantly', () => {
    expect(parseHandles([{ route: '/about', handle: 'about' }])).toEqual({ '/about': '/pages/about' });
    expect(parseHandles([{ route: '/team', shopify_path: '/pages/our-team' }])).toEqual({ '/team': '/pages/our-team' });
    expect(parseHandles({ '/faq': 'faq' })).toEqual({ '/faq': '/pages/faq' });
    expect(parseHandles(null)).toEqual({});
  });
});

describe('interaction diff classification', () => {
  const nav = { navigatedTo: '/about', overlayAppeared: false, ariaFlipped: false, domDelta: 0, noop: false };
  const modal = { navigatedTo: null, overlayAppeared: true, ariaFlipped: false, domDelta: 40, noop: false };
  const toggle = { navigatedTo: null, overlayAppeared: false, ariaFlipped: true, domDelta: 2, noop: false };
  const noop = { navigatedTo: null, overlayAppeared: false, ariaFlipped: false, domDelta: 0, noop: true };

  it('treats same-class outcomes as equivalent', () => {
    expect(effectsEquivalent(nav, { ...nav, navigatedTo: '/pages/about' })).toBe(true);
    expect(effectsEquivalent(modal, modal)).toBe(true);
    expect(effectsEquivalent(toggle, toggle)).toBe(true);
    expect(effectsEquivalent(noop, noop)).toBe(true);
  });
  it('flags a dead clone control (React does something, Shopify nothing)', () => {
    expect(effectsEquivalent(modal, noop)).toBe(false);
    expect(effectsEquivalent(nav, noop)).toBe(false);
    expect(effectsEquivalent(modal, { ...noop, error: 'timeout' })).toBe(false);
  });
  it('summarizes effects readably', () => {
    expect(effectSummary(nav)).toBe('navigates to /about');
    expect(effectSummary(modal)).toBe('opens overlay/modal');
    expect(effectSummary(noop)).toBe('no visible effect');
  });
  it('matches link targets through the route mapping', () => {
    expect(linkTargetMatches('/about', '/pages/about')).toBe(true);
    expect(linkTargetMatches('/about', '/pages/contact')).toBe(false);
    expect(linkTargetMatches('/about/', '/about')).toBe(true);
    expect(linkTargetMatches('https://x.com/a', 'https://x.com/a')).toBe(true);
    expect(linkTargetMatches('mailto:hi@x.com', 'mailto:other@x.com')).toBe(false);
    expect(linkTargetMatches('/blog', '/blogs/journal', { '/blog': '/blogs/journal' })).toBe(true);
  });
});

describe('compositeScore', () => {
  it('applies default weights', () => {
    expect(compositeScore({ presence: 1, text: 1, interaction: 1 })).toBe(1);
    expect(compositeScore({ presence: 0.8, text: 0.6, interaction: 0.5 })).toBeCloseTo(0.5 * 0.8 + 0.3 * 0.6 + 0.2 * 0.5, 6);
  });
  it('renormalizes when a subscore is absent (qa_mode)', () => {
    expect(compositeScore({ presence: 0.8, text: 0.6, interaction: null })).toBeCloseTo((0.5 * 0.8 + 0.3 * 0.6) / 0.8, 6);
    expect(compositeScore({ presence: null, text: null, interaction: 0.7 })).toBeCloseTo(0.7, 6);
    expect(compositeScore({ presence: null, text: null, interaction: null })).toBe(0);
  });
});
