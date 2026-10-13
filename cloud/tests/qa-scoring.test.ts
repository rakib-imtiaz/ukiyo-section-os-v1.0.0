// The Cloud QA rubric must score exactly like the local scripts it replaces. Three layers:
//   1. tests/factory-qa.test.ts's cases, ported to the Cloud functions;
//   2. a seeded random corpus run through BOTH the old templates/factory/qa/qa-shared.mjs and the
//      Cloud functions (identical outputs);
//   3. golden files: a real capture of the fixture sites scored by the Cloud == the reports the old
//      scripts wrote for the same sites (tests/fixtures/qa/canned, see regenerate-canned.ts).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS workspace template, imported directly for parity checks
import * as old from '../../templates/factory/qa/qa-shared.mjs';
import { compositeScore as oldComposite } from '../../server/factory/qa';
import {
  alignSections, buildSummary, calibrate, compositeScore, computeShopifyPath, diceSimilarity, effectsEquivalent, effectSummary,
  headingsMatch, isDenylistedClick, linkTargetMatches, pairScore, parseHandles, planInteractions, renderSummary, scoreInteractions,
  scoreSections, sectionTitle, segmentLayout, textDiffSamples, tokenize,
} from '../src/qa';
import * as clean from '../src/qa/sanitize';
import { preparedDice, prepareText, textPreparer } from '../src/qa/text';
import type { ClickEffects, InteractionsCaptureRoute, InventoryItem, LayoutBlock, LayoutDump, SectionsCaptureRoute, SiteHealth } from '../src/qa';

const section = (text: string, headings: string[] = []) => ({ text, headings, imgCount: 0, imgAlts: [], linkCount: 0, shapeHash: 'x', childCount: 1, bbox: { y: 0, height: 200 } });

describe('ported: similarity', () => {
  it('scores identical, disjoint, and partial text sensibly', () => {
    expect(diceSimilarity('Fresh roasted coffee beans', 'Fresh roasted coffee beans')).toBe(1);
    expect(diceSimilarity('Fresh roasted coffee beans', 'quantum flux capacitor engaged')).toBe(0);
    const partial = diceSimilarity('Fresh roasted coffee beans delivered monthly', 'Fresh roasted coffee beans');
    expect(partial).toBeGreaterThan(0.6);
    expect(partial).toBeLessThan(1);
  });
  it('boosts pair score on identical headings even when body text differs', () => {
    expect(pairScore(section('completely different body copy here', ['Our Story']), section('nothing shared with the other side at all', ['Our Story']))).toBeGreaterThanOrEqual(0.7);
  });
  it('tokenizes robustly', () => {
    expect(tokenize('Hello, WORLD! 42 a')).toEqual(['hello', 'world', '42']);
  });
});

describe('ported: alignSections', () => {
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
    expect(result.pairs.map((pair) => pair.a)).toEqual([0, 2, 3]);
    expect(result.missing).toEqual([1]);
    expect(result.extra).toHaveLength(0);
  });
  it('flags clone-only bands as extra', () => {
    const bonus = section('Totally invented promotional banner not present in the original design', ['Flash sale']);
    expect(alignSections([hero, cta], [hero, bonus, cta]).extra).toEqual([1]);
  });
  it('does not force-match dissimilar sections', () => {
    const result = alignSections([hero], [section('unrelated legal disclaimer text about cookies and privacy policies', ['Legal'])]);
    expect(result.pairs).toHaveLength(0);
    expect(result.missing).toEqual([0]);
    expect(result.extra).toEqual([0]);
  });
});

describe('ported: textDiffSamples + sectionTitle', () => {
  it('returns the React strings absent from the clone', () => {
    expect(textDiffSamples(section('Free shipping over $50. Handmade in Oregon. Est. 2019.'), section('Free shipping over $50. Est. 2019.')).join(' ')).toContain('Handmade in Oregon');
  });
  it('falls back to leading words when a section has no heading', () => {
    expect(sectionTitle(section('some plain band of text without any heading present here'))).toContain('some plain band');
    expect(sectionTitle(section('body', ['Actual Heading']))).toBe('Actual Heading');
  });
});

describe('ported: route mapping', () => {
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

describe('ported: interaction diff classification', () => {
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

describe('ported: compositeScore', () => {
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

// ---------- old vs new on a seeded random corpus ----------

function rng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
const WORDS = ['ritual', 'botanical', 'tea', 'Oregon', 'small', 'batch', 'organic', 'jar', 'hand', 'poured', 'five', 'stars', 'shop', 'now', 'free', 'shipping', 'over', '$50.', 'Est.', '2019!', 'care', 'repair', 'a', '✕', '+', 'Our', 'Story', 'join', 'the', 'circle'];

function corpus(seed: number, count: number) {
  const random = rng(seed);
  const pick = () => WORDS[Math.floor(random() * WORDS.length)];
  const sentence = (length: number) => Array.from({ length }, pick).join(random() < 0.3 ? '. ' : ' ');
  return Array.from({ length: count }, () => ({
    text: sentence(Math.floor(random() * 14)),
    headings: random() < 0.6 ? [sentence(1 + Math.floor(random() * 3))] : [],
    imgCount: 0, imgAlts: [], linkCount: 0, shapeHash: random() < 0.5 ? 'a' : 'b', childCount: 1, bbox: { y: 0, height: 200 },
  }));
}

describe('parity with templates/factory/qa/qa-shared.mjs', () => {
  it('gives identical similarity, headings, pair scores, titles and diff samples', () => {
    const items = corpus(7, 120);
    for (let index = 0; index < items.length - 1; index++) {
      const a = items[index]; const b = items[index + 1];
      expect(tokenize(a.text)).toEqual(old.tokenize(a.text));
      expect(diceSimilarity(a.text, b.text)).toBe(old.diceSimilarity(a.text, b.text));
      expect(headingsMatch(a, b)).toBe(old.headingsMatch(a, b));
      expect(pairScore(a, b)).toBe(old.pairScore(a, b));
      expect(sectionTitle(a)).toBe(old.sectionTitle(a));
      expect(textDiffSamples(a, b)).toEqual(old.textDiffSamples(a, b));
    }
  });

  it('aligns identically, including near-duplicate and shuffled lists', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = rng(seed * 31);
      const listA = corpus(seed, 1 + Math.floor(random() * 9));
      const listB = [...listA].filter(() => random() < 0.75).map((entry) => (random() < 0.3 ? { ...entry, text: `${entry.text} extra words here` } : entry));
      if (random() < 0.5) listB.splice(Math.floor(random() * (listB.length + 1)), 0, ...corpus(seed + 1000, 2));
      expect(alignSections(listA, listB)).toEqual(old.alignSections(listA, listB));
    }
  });

  it('prepared comparisons (tokenized once) give exactly the old numbers, on long lists too', () => {
    const items = [...corpus(11, 80), section(''), section('✕'), section(' ✕ '), section('+'), section('a b c')];
    const prepare = textPreparer();
    for (const a of items) for (const b of items) expect(preparedDice(prepare(a.text), prepareText(b.text))).toBe(old.diceSimilarity(a.text, b.text));
    for (let seed = 1; seed <= 4; seed++) {
      const listA = corpus(seed * 97, 60);
      const listB = [...corpus(seed * 97 + 1, 20), ...listA.slice(10, 50), ...corpus(seed * 97 + 2, 15)];
      expect(alignSections(listA, listB)).toEqual(old.alignSections(listA, listB));
    }
  });

  it('maps routes and links identically', () => {
    const handles = { '/blog': '/blogs/journal', '/team': '/pages/our-team' };
    const routes = ['/', '/about', '/about/', '/team', '/blog', '/journal', '/products/tea', '/collections/all', '/blogs/news/a', '/a/b/c', '/x?y=1#z'];
    for (const route of routes) {
      expect(computeShopifyPath(route, handles)).toBe(old.computeShopifyPath(route, handles));
      for (const target of [...routes, '/pages/about', '/pages/a-b-c', 'https://x.com', 'mailto:a@b.c', null]) {
        expect(linkTargetMatches(route, target, handles)).toBe(old.linkTargetMatches(route, target, handles));
      }
    }
    for (const raw of [[{ route: '/a', handle: 'a' }], { '/f': 'faq', bogus: 'x' }, [{ route: '/t', shopify_path: 'team' }], 'junk', null]) {
      expect(parseHandles(raw)).toEqual(old.parseHandles(raw));
    }
  });

  it('classifies click effects and the commerce denylist identically', () => {
    const effects = [
      null, { error: 'timeout' }, { navigatedTo: '/about' }, { navigatedTo: '/pages/about' }, { navigatedTo: '/x' },
      { overlayAppeared: true, noop: false }, { ariaFlipped: true, noop: false }, { domDelta: 12, noop: false }, { domDelta: -4, noop: false }, { noop: true, domDelta: 0 },
    ];
    for (const a of effects) {
      expect(effectSummary(a)).toBe(old.effectSummary(a));
      for (const b of effects) expect(effectsEquivalent(a, b)).toBe(old.effectsEquivalent(a, b));
    }
    for (const item of [{ name: 'Add to Cart' }, { name: 'Buy now' }, { name: 'Open menu' }, { name: 'x', idClass: 'newsletter-form' }, { name: 'Go', isSubmit: true }, null]) {
      expect(isDenylistedClick(item)).toBe(old.isDenylistedClick(item));
    }
  });

  it('computes the composite exactly like server/factory/qa.ts', () => {
    const random = rng(99);
    for (let index = 0; index < 50; index++) {
      const value = () => (random() < 0.2 ? null : random());
      const subscores = { presence: value(), text: value(), interaction: value() };
      const weights = { presence: random(), text: random(), interaction: random() };
      expect(compositeScore(subscores, weights)).toBe(oldComposite(subscores, weights));
      expect(compositeScore(subscores)).toBe(oldComposite(subscores));
    }
  });
});

// ---------- golden: a real capture scored here == what the old scripts reported ----------

const canned = path.resolve(import.meta.dirname, '../../tests/fixtures/qa/canned');
const json = (name: string) => JSON.parse(readFileSync(path.join(canned, name), 'utf8'));
const text = (name: string) => readFileSync(path.join(canned, name), 'utf8');

describe('golden parity on the fixture sites', () => {
  it('sections: Cloud report and markdown equal the old section-compare output', () => {
    const capture = json('capture-sections.json');
    const { report, markdown } = scoreSections({ iter: 1, reactBase: capture.reactBase, shopifyBase: capture.shopifyBase, routes: clean.sectionsRoutes(capture.routes) });
    expect(report).toEqual(json('golden-sections-1.json'));
    expect(markdown).toBe(text('golden-sections-1.md'));
  });

  it('interactions: plan + effects scored by the Cloud equal the old interaction-verify output', () => {
    const inventory = json('capture-inventory.json');
    // through the same request validation as the route (it rebuilds the inventory keys the capture leaves out)
    const plan = planInteractions({ iter: 1, handles: clean.handles(inventory.handles), routes: clean.interactionRoutes(inventory.routes) });
    expect(plan.clicks.map((click) => `${click.route} ${click.react.name}`)).toEqual(['/ Show ingredients', '/ Open gallery', '/about Read more']);
    const { report, markdown } = scoreInteractions({ plan, effects: clean.effects(json('capture-effects.json').effects), reactBase: inventory.reactBase, shopifyBase: inventory.shopifyBase });
    expect(report).toEqual(json('golden-interactions-1.json'));
    expect(markdown).toBe(text('golden-interactions-1.md'));
  });
});

// ---------- segmentation from the raw dump ----------

let nextId = 0;
const blockOf = (parent: number, h: number, w = 1440, text = `block ${nextId}`): LayoutBlock => ({
  id: nextId++, parent, tag: 'SECTION', x: 0, y: nextId * 100, w, h, childCount: 2, headings: [text], text, imgCount: 1, imgAlts: [], linkCount: 0, shapeHash: 'h',
});
const dumpOf = (blocks: LayoutBlock[]): LayoutDump => ({ viewportWidth: 1440, root: 'body', blocks });

describe('segmentLayout', () => {
  it('keeps full-width bands of 120px or more and drops short or narrow ones', () => {
    const blocks = [blockOf(-1, 300), blockOf(-1, 119.9), blockOf(-1, 120), blockOf(-1, 400, 863.9), blockOf(-1, 400, 864)];
    expect(segmentLayout(dumpOf(blocks)).map((entry) => entry.text)).toEqual([blocks[0].text, blocks[2].text, blocks[4].text]);
  });

  it('unwraps a single page wrapper into its bands, but stops at a single-child wrapper (old rule)', () => {
    const wrapper = blockOf(-1, 2000);
    const bands = [blockOf(wrapper.id, 300), blockOf(wrapper.id, 300), blockOf(wrapper.id, 60)];
    expect(segmentLayout(dumpOf([wrapper, ...bands])).map((entry) => entry.text)).toEqual([bands[0].text, bands[1].text]);
    const lone = blockOf(-1, 900); const onlyChild = blockOf(lone.id, 900); const grandchildren = [blockOf(onlyChild.id, 300), blockOf(onlyChild.id, 300)];
    expect(segmentLayout(dumpOf([lone, onlyChild, ...grandchildren])).map((entry) => entry.text)).toEqual([lone.text]);
  });

  it('returns the old section shape (rounded bbox, 4000-char text)', () => {
    const block = { ...blockOf(-1, 250.6), y: 99.5, text: 'x'.repeat(5000) };
    const [result] = segmentLayout(dumpOf([block]));
    expect(result).toEqual({ headings: block.headings, text: 'x'.repeat(4000), imgCount: 1, imgAlts: [], linkCount: 0, shapeHash: 'h', childCount: 2, bbox: { y: 100, height: 251 } });
    expect(segmentLayout(null)).toEqual([]);
  });
});

// ---------- capture health ----------

const healthy = (overrides: Partial<SiteHealth> = {}): SiteHealth => ({ status: 200, finalPath: '/', navError: null, passwordGate: false, textLength: 900, elementCount: 120, mediaCount: 4, bodyHeight: 2400, title: 'Shop', ...overrides });
const band = (text: string) => blockOf(-1, 300, 1440, text);
const page = (texts: string[]) => dumpOf(texts.map(band));

function capturedRoute(route: string, overrides: Partial<SectionsCaptureRoute> = {}): SectionsCaptureRoute {
  return {
    route, shopifyPath: route === '/' ? '/' : `/pages${route}`,
    react: { ok: true, status: 200, health: healthy(), layout: page(['Welcome to the shop of handmade tea', 'Our story began in a barn']) },
    shopify: { status: 200, health: healthy(), layout: page(['Welcome to the shop of handmade tea', 'Our story began in a barn']) },
    ...overrides,
  };
}

describe('capture health in section scoring', () => {
  it('scores a healthy capture as before (no capture block in the report)', () => {
    const { report } = scoreSections({ iter: 2, reactBase: 'r', shopifyBase: 's', routes: [capturedRoute('/')] });
    expect(report.presence).toBe(1);
    expect(report.capture).toBeUndefined();
  });

  it('excludes a page whose capture failed, instead of scoring it 0%', () => {
    const routes = [
      capturedRoute('/'),
      capturedRoute('/about', { shopify: { status: 200, health: healthy({ passwordGate: true, finalPath: '/password' }), layout: page(['Enter store using password']) } }),
    ];
    const { report, markdown } = scoreSections({ iter: 1, reactBase: 'r', shopifyBase: 's', routes });
    expect(report.pages.map((entry) => entry.status)).toEqual(['ok', 'capture_failed']);
    expect(report.presence).toBe(1);
    expect(report.capture).toMatchObject({ failed: false, problems: [{ route: '/about', site: 'shopify' }] });
    expect(markdown).toContain('Capture problems');
  });

  it('reports capture failed when the React site rendered blank everywhere', () => {
    const blank = { ok: true, status: 200, health: healthy({ textLength: 3, mediaCount: 0 }), layout: dumpOf([]) };
    const { report } = scoreSections({ iter: 1, reactBase: 'r', shopifyBase: 's', routes: [capturedRoute('/', { react: blank }), capturedRoute('/about', { react: blank })] });
    expect(report.capture?.failed).toBe(true);
    expect(report.capture?.reason).toMatch(/no page could be captured/);
    expect(report.issues).toEqual([]);
  });

  it('treats a Shopify load error as a capture problem, a 404 as a missing page, and a blank clone as a real defect', () => {
    const routes = [
      capturedRoute('/a', { shopify: { status: null, health: healthy({ status: null, navError: 'net::ERR_CONNECTION_REFUSED', textLength: 0 }) } }),
      capturedRoute('/b', { shopify: { status: 404 } }),
      capturedRoute('/products/tea', { shopifyPath: '/products/tea', shopify: { status: 404 } }),
      capturedRoute('/c', { shopify: { status: 200, health: healthy({ textLength: 0, mediaCount: 0 }), layout: dumpOf([]) } }),
    ];
    const { report } = scoreSections({ iter: 1, reactBase: 'r', shopifyBase: 's', routes });
    expect(report.pages.map((entry) => entry.status)).toEqual(['capture_failed', 'missing_page', 'catalog_unseeded', 'ok']);
    expect(report.issues.map((issue) => issue.kind)).toEqual(['missing_page', 'catalog_unseeded', 'missing_section', 'missing_section']);
    expect(report.catalogUnseeded).toEqual(['/products/tea']);
    expect(report.presence).toBe(0);
    expect(report.capture?.failed).toBe(false);
  });

  it('keeps the old statuses for unreachable and unmapped routes', () => {
    const routes: SectionsCaptureRoute[] = [
      { route: '/blog', shopifyPath: null },
      capturedRoute('/gone', { react: { ok: false, status: 404 } }),
      capturedRoute('/boom', { error: 'Target closed' }),
      capturedRoute('/'),
    ];
    const { report } = scoreSections({ iter: 1, reactBase: 'r', shopifyBase: 's', routes });
    expect(report.pages.map((entry) => [entry.status, entry.reason])).toEqual([
      ['skipped', 'no shopify mapping (blog base?)'], ['unreachable', 'react route HTTP 404'], ['unreachable', 'Target closed'], ['ok', undefined],
    ]);
    expect(report.capture).toBeUndefined();
  });
});

// ---------- click planning ----------

const item = (name: string, overrides: Partial<InventoryItem> = {}): InventoryItem => ({
  key: `button|${name.toLowerCase()}|1`, tag: 'button', name, ordinal: 1, kind: 'action', href: null, visible: true, region: 'main', ariaExpanded: null, idClass: '', isSubmit: false, ...overrides,
});
const link = (name: string, href: string) => item(name, { key: `a|${name.toLowerCase()}|1`, tag: 'a', kind: 'link', href });
const routeOf = (reactItems: InventoryItem[], shopifyItems: InventoryItem[], route = '/'): InteractionsCaptureRoute => ({
  route, shopifyPath: route === '/' ? '/' : `/pages${route}`,
  react: { ok: true, status: 200, health: healthy(), items: reactItems },
  shopify: { status: 200, health: healthy(), items: shopifyItems },
});
const sameEffect = { navigatedTo: null, overlayAppeared: true, ariaFlipped: false, domDelta: 20, noop: false, consoleErrors: [], networkCalls: [] };

describe('click planning and scoring', () => {
  it('clicks at most 15 elements per route, never commerce controls, and reports the overflow', () => {
    const buttons = Array.from({ length: 18 }, (_, index) => item(`Panel ${index + 1}`));
    const commerce = [item('Add to cart'), item('Notify me', { idClass: 'newsletter' }), item('Send', { isSubmit: true })];
    const plan = planInteractions({ iter: 3, handles: {}, routes: [routeOf([...commerce, ...buttons], [...commerce, ...buttons])] });
    expect(plan.clicks).toHaveLength(15);
    expect(plan.clicks.some((click) => /cart|notify|send/i.test(click.react.name))).toBe(false);
    expect(plan.routes[0].page).toMatchObject({ elements: 21, tested: 18, verifiedStatic: 3, same: 3, clicked: 15, untested: 3, skippedClicks: 3 });
    const effects: ClickEffects[] = plan.clicks.map((click) => ({ i: click.i, react: sameEffect, shopify: sameEffect }));
    const { report } = scoreInteractions({ plan, effects, reactBase: 'r', shopifyBase: 's' });
    expect(report).toMatchObject({ interaction: 1, tested: 18, same: 18, untested: 3, issues: [] });
    expect(report.informational.map((issue) => [issue.id, issue.kind])).toEqual([['i3-1', 'coverage_gap']]);
  });

  it('matches fuzzily, scores links statically and keeps the old issue order and ids', () => {
    const react = [link('About', '/about'), item('Open menu'), item('Show more'), link('Journal', '/journal'), item('Gone button')];
    const shopify = [link('About', '/pages/about'), item('Open the menu'), item('Show more'), link('Journal', '/blogs/news'), link('Search', '/search')];
    const plan = planInteractions({ iter: 4, handles: { '/journal': '/blogs/journal' }, routes: [routeOf(react, shopify)] });
    expect(plan.clicks.map((click) => [click.react.name, click.shopify.name])).toEqual([['Open menu', 'Open the menu'], ['Show more', 'Show more']]);
    const noop = { ...sameEffect, overlayAppeared: false, domDelta: 0, noop: true, consoleErrors: ['TypeError: x is undefined'] };
    const effects: ClickEffects[] = [{ i: 0, react: sameEffect, shopify: sameEffect }, { i: 1, react: sameEffect, shopify: noop }];
    const { report } = scoreInteractions({ plan, effects, reactBase: 'r', shopifyBase: 's' });
    expect(report.issues.map((issue) => [issue.id, issue.kind, issue.title])).toEqual([
      ['i4-1', 'interaction_noop', '"Show more" behaves differently'],
      ['i4-2', 'interaction_target', 'Link "Journal" points to the wrong place'],
      ['i4-3', 'missing_interaction', 'Missing on Shopify: button "Gone button" (main)'],
    ]);
    expect(report.issues[0].detail).toBe('React: opens overlay/modal · Shopify: no visible effect\nShopify console errors: TypeError: x is undefined');
    expect(report.issues[1].detail).toBe('React -> /journal · Shopify -> /blogs/news (expected /blogs/journal)');
    expect(report.informational.map((issue) => [issue.id, issue.kind, issue.title])).toEqual([['i4-4', 'extra_interaction', 'Extra on Shopify: a "Search"']]);
    expect(report.pages[0]).toMatchObject({ elements: 5, tested: 5, same: 2, different: 2, missing: 1, clicked: 2 });
    expect(report.interaction).toBe(0.4);
  });

  it('counts a click the capture safety net refused as verified statically, and a missing effect as a failure', () => {
    const plan = planInteractions({ iter: 1, handles: {}, routes: [routeOf([item('Alpha'), item('Beta')], [item('Alpha'), item('Beta')])] });
    const { report } = scoreInteractions({ plan, effects: [{ i: 0, react: { refused: true }, shopify: null }], reactBase: 'r', shopifyBase: 's' });
    expect(report.pages[0]).toMatchObject({ tested: 2, same: 1, different: 1, clicked: 1, verifiedStatic: 1 });
    expect(report.issues[0].detail).toBe('React: error: click not captured · Shopify: error: click not captured');
  });

  it('marks pages the capture could not load, and fails the round when none loaded', () => {
    const down = { status: null, health: healthy({ status: null, navError: 'net::ERR_NAME_NOT_RESOLVED' }) };
    const plan = planInteractions({ iter: 1, handles: {}, routes: [{ ...routeOf([], []), shopify: down }, { ...routeOf([], [], '/about'), shopify: down }, { route: '/blog', shopifyPath: null }] });
    expect(plan.routes.map((entry) => entry.page.status)).toEqual(['capture_failed', 'capture_failed']);
    expect(plan.capture).toMatchObject({ failed: true });
    const { report, markdown } = scoreInteractions({ plan, effects: [], reactBase: 'r', shopifyBase: 's' });
    expect(report.capture?.failed).toBe(true);
    expect(markdown).toContain('CAPTURE FAILED');
  });
});

// ---------- summary + calibration ----------

describe('summary', () => {
  const sections = { presence: 0.75, text: 0.9, pages: [{ route: '/', status: 'ok' }, { route: '/x', status: 'unreachable' }], issues: [
    { id: 's2-1', kind: 'text_drift', page: '/', title: '"Hero" text drifts', detail: 'line one\nline two' },
    { id: 's2-2', kind: 'missing_section', page: '/', title: 'Missing section: "Reviews"' },
  ] };
  const interactions = { interaction: 0.5, issues: [{ id: 'i2-1', kind: 'interaction_noop', page: '/', title: '"Menu" behaves differently' }] };

  it('builds the old summary: weights, priority order, fixed delta, unreachable routes', () => {
    const previousKeys = ['missing_section|/|Missing section: "Reviews"', 'missing_page|/old|Shopify page /pages/old does not exist (HTTP 404)'];
    const summary = buildSummary({ iter: 2, jobName: 'Tea shop', scoreThreshold: 0.92, sections, interactions, weights: { presence: 1, text: 0, interaction: 1 }, handlesMissing: true, previousKeys, deltaSource: 'client' });
    expect(summary.score).toBe(compositeScore({ presence: 0.75, text: 0.9, interaction: 0.5 }, { presence: 1, text: 0, interaction: 1 }));
    expect(summary.breakdown).toEqual({ issues: 3, fixed: 1, unreachable: 1, pages: 2, subscores: { presence: 0.75, text: 0.9, interaction: 0.5 }, handlesMissing: true });
    expect(summary.captureFailed).toBe(false);
    const md = summary.summaryMarkdown;
    expect(md.startsWith('# QA summary — iteration 2 for Tea shop\n\n**Composite score: 62.5%** (threshold 92%)')).toBe(true);
    expect(md).toContain('Subscores — section presence: 75% · text match: 90% · interactions: 50%');
    expect(md).toContain('`qa/state/handles.json` missing');
    expect(md).toContain('## Fixed since last iteration (1)\n\n- ~~/old — Shopify page /pages/old does not exist (HTTP 404)~~');
    expect(md).toContain('## Unreachable routes (excluded from score)\n\n- /x');
    expect(md).toContain('## FIX THESE (3, in priority order)\n\n1. **[missing_section]** `/` — Missing section: "Reviews"\n2. **[text_drift]** `/` — "Hero" text drifts\n   line one\n   line two\n3. **[interaction_noop]**');
    expect(md.endsWith('- Screenshots: `qa/screenshots/factory/2/`\n')).toBe(true);
  });

  it('shows no delta on iteration 1 or without a previous round, and says when all checks passed', () => {
    const summary = buildSummary({ iter: 1, jobName: 'x', scoreThreshold: 0.9, sections: { ...sections, issues: [] }, interactions: null, previousKeys: ['a|b|c'], deltaSource: 'client' });
    expect(summary.breakdown.fixed).toBe(0);
    expect(summary.subscores.interaction).toBeNull();
    expect(summary.summaryMarkdown).toContain('Nothing — all checks passed.');
  });

  it('puts a capture-failed banner on top and flags the round', () => {
    const failed = { failed: true, reason: 'no page could be captured (2 of 2 failed)', problems: [{ route: '/', site: 'shopify' as const, problem: 'page did not load (timeout)' }] };
    const summary = buildSummary({ iter: 3, jobName: 'x', scoreThreshold: 0.9, sections: { presence: 0, text: 0, pages: [], issues: [], capture: failed }, interactions: null, previousKeys: null, deltaSource: 'none' });
    expect(summary.captureFailed).toBe(true);
    expect(summary.captureProblems).toHaveLength(1);
    expect(summary.summaryMarkdown).toContain('CAPTURE FAILED — no score this round.');
    expect(summary.summaryMarkdown).toContain('## Capture problems (excluded from score) (1)');
  });

  it('renders exactly like server/factory/qa.ts when capture was healthy', () => {
    const md = renderSummary({ jobName: 'Job', iteration: 1, score: 0.5, scoreThreshold: 0.9, subscores: { presence: 0.5, text: null, interaction: null }, issues: [], fixedKeys: [], unreachable: [], handlesMissing: false });
    expect(md).toBe([
      '# QA summary — iteration 1 for Job', '', '**Composite score: 50.0%** (threshold 90%)', 'Subscores — section presence: 50% · text match: n/a · interactions: n/a', '',
      '## FIX THESE (0, in priority order)', '', 'Nothing — all checks passed.', '', '## Detail reports', '',
      '- Sections: `qa/reports/factory/sections-1.md`', '- Interactions: `qa/reports/factory/interactions-1.md`', '- Screenshots: `qa/screenshots/factory/1/`', '',
    ].join('\n'));
  });
});

describe('calibration rubric', () => {
  const fixture = () => ({ health: healthy({ status: null }), layout: page(['Handcrafted crystal jewelry studio', 'The spring collection has arrived', 'What our customers say', 'Care and repair for life', 'Join the studio newsletter']) });

  it('passes a known-good pair with a perfect score', () => {
    expect(calibrate({ reference: fixture(), candidate: fixture(), mode: 'fixture' })).toEqual({
      ok: true, score: 1, subscores: { presence: 1, text: 1, interaction: null }, threshold: 0.95, mode: 'fixture', sections: { reference: 5, candidate: 5, matched: 5 },
    });
  });

  it('fails when segmentation finds too little, the score is low, or the page did not render', () => {
    expect(calibrate({ reference: { layout: page(['One band only here']) } }).error).toMatch(/only 1 section/);
    const broken = { layout: page(['totally', 'different', 'words', 'on', 'this', 'page']) };
    expect(calibrate({ reference: fixture(), candidate: broken }).ok).toBe(false);
    expect(calibrate({ reference: { health: healthy({ textLength: 0, mediaCount: 0 }), layout: dumpOf([]) } }).error).toMatch(/did not render/);
  });
});
