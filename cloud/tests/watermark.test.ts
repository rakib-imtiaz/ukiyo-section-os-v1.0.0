import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudDb } from '../src/db';
import type { PromptDecorator } from '../src/steps';
import {
  analyzeLeak, applyWatermark, canonicalWords, createPromptDecorator, decodeZeroWidth, decoratePrompt,
  identifyLeak, stripZeroWidth, watermarkPrompt, watermarkPromptDetailed,
} from '../src/watermark';

// A step prompt shaped like the real recipe. "fixed" segments are not prose (code, tables,
// headings, HTML, JSON, indented code, blank lines) and must come out byte-identical; "prose"
// segments may carry wording marks. § stands for a backtick.
type Segment = ['prose' | 'fixed', string];
const SEGMENTS: Segment[] = [
  ['fixed', '# Step 4 — Build one page'],
  ['fixed', ''],
  ['prose', 'You are converting one React page into Shopify sections. Do not touch other pages — the orchestrator owns them.  Make sure that every section you write is editable in the theme editor, and keep the visual output identical to the React source.'],
  ['fixed', ''],
  ['fixed', '## Inputs'],
  ['fixed', ''],
  ['prose', '- Read §qa/state/inventory.json§ for this page; it lists the sections, images, and links.'],
  ['prose', '- The image map in §qa/state/images.json§ gives the CDN URL for every React asset.'],
  ['prose', '- Handles come from §qa/state/handles.json§ — never invent a handle.'],
  ['prose', '- If a file is missing, stop and report it. Do not guess what it should contain.'],
  ['fixed', ''],
  ['prose', '**Section naming:** every section file is called §sections/<prefix>-<name>.liquid§ and the schema name is the human label, e.g. "Hero banner" (not "hero-banner").'],
  ['fixed', ''],
  ['fixed', '```liquid'],
  ['fixed', '{% comment %} do not edit — for example, the orchestrator rewrites this {% endcomment %}'],
  ['fixed', '<section class="full-width {{ section.settings.prefix }}-hero">'],
  ['fixed', '  {{ section.settings.heading | escape }}'],
  ['fixed', '</section>'],
  ['fixed', '```'],
  ['fixed', ''],
  ['fixed', '## Rules'],
  ['fixed', ''],
  ['prose', '1. Every text the merchant can see must be a setting, and every image must be an image_picker with the React image as its default.'],
  ['prose', '2. Links use §shopify://pages/<handle>§; a raw URL like https://example.com/about is a bug.'],
  ['prose', '3. Do not hardcode colors — read them from the design tokens in §seed/CONVENTIONS.md§.'],
  ['prose', '4. Animations need a visible default, so content is never stuck at §opacity: 0§.'],
  ['prose', '5. Keep the markup flat → one wrapper, one grid, no extra containers.'],
  ['fixed', ''],
  ['prose', 'If a section has more than four blocks, split it. The theme editor is not designed for long block lists, and merchants cannot reorder nested blocks.  For each repeated card, use a block type instead of a hardcoded loop.'],
  ['fixed', ''],
  ['fixed', '| Setting type | Use for | Example |'],
  ['fixed', '|---|---|---|'],
  ['fixed', '| text | short labels | "Shop now" |'],
  ['fixed', '| richtext | paragraphs | "<p>Do not edit</p>" |'],
  ['fixed', ''],
  ['prose', 'When the React page uses a modal, build it as a §<dialog>§ element. Do not use a third-party library — the theme must stay dependency-free. Make sure the close button is reachable by keyboard, and make sure focus returns to the trigger afterwards.'],
  ['fixed', ''],
  ['fixed', '```json'],
  ['fixed', '{'],
  ['fixed', '  "type": "image_picker",'],
  ['fixed', '  "id": "hero_image",'],
  ['fixed', '  "label": "Do not remove — for example, the hero image"'],
  ['fixed', '}'],
  ['fixed', '```'],
  ['fixed', ''],
  ['prose', '**Check before you push.** Run the page check and look for example files the scaffold left behind; delete them before pushing.'],
  ['fixed', ''],
  ['fixed', '    node qa/check-page.mjs --page about --strict'],
  ['fixed', ''],
  ['prose', '- The check compares sections one by one. It does not judge taste.'],
  ['prose', '- A section that is missing scores zero, and a section that is out of order loses half.'],
  ['prose', '- Fix the worst section first, then re-run the check.'],
  ['prose', '- Stop after three rounds and write what is still wrong to the report.'],
  ['fixed', ''],
  ['fixed', '<!-- internal: do not ship, for example the staging notes'],
  ['fixed', 'are kept here and never sent — make sure they stay -->'],
  ['fixed', ''],
  ['prose', 'Shopify does not allow Liquid output tags to compare values, so §{{ a == b }}§ renders §a§. Use an §{% if %}§ tag with §assign§ instead.  The section will not render otherwise, and the error is silent.'],
  ['fixed', ''],
  ['prose', 'Some React pages load data at runtime. You cannot fetch it from Liquid — copy the values into settings, or seed them as metafields. When the data is large, ask the orchestrator; it will not mind.'],
  ['fixed', ''],
  ['prose', '- **Header and footer:** never edit them here. They belong to the bootstrap step.'],
  ['prose', '- **Images:** always use §image_url§ with a width; never link the React URL.'],
  ['prose', '- **Fonts:** load them once in §layout/theme.liquid§ and nowhere else.'],
  ['prose', '- **Forms:** newsletter forms post to §/contact#contact_form§, and contact forms use the §contact§ form tag.'],
  ['fixed', ''],
  ['prose', 'Finish by writing §qa/reports/page-<name>.md§ with the score, the open issues, and the files you changed. The orchestrator reads it to decide the next step — do not skip it, even when the page scored well.'],
];
const md = (text: string) => text.replace(/§/g, '`');
const STEP = SEGMENTS.map(([, text]) => md(text)).join('\n');
const OTHER_STEP = md([
  '# Step 6 — Final report',
  '',
  'Collect every page report into §qa/reports/final.md§. Do not rerun checks here — the page steps already did. List the pages that are still below target, and say why in one line each.',
  '',
  '- Pages above target are listed first.',
  '- Pages below target are listed with their worst section.',
  '- If a page failed to build, say so and link its log.',
].join('\n'));

const ACCOUNT_COUNT = 8;
let db: CloudDb;
let accounts: string[];
const SECRET = 'test-pepper';

beforeEach(() => {
  db = new CloudDb(':memory:');
  accounts = Array.from({ length: ACCOUNT_COUNT }, (_, index) => db.createAccount(`owner${index}@example.com`, {}, 1_000).id);
});
afterEach(() => { db.close(); });

const mark = (accountId: string, stepId = 'page:about', text = STEP) =>
  watermarkPromptDetailed(text, { accountId, buildId: `bld_${accountId}`, stepId, db, secret: SECRET, now: 2_000 });

/** Undo every allowed wording choice, so a watermarked text must equal its original. */
function normalized(text: string): string {
  const pairs: Array<[RegExp, string]> = [
    [/\bdon['’]t\b/g, 'do not'], [/\bDon['’]t\b/g, 'Do not'], [/\bdoesn['’]t\b/g, 'does not'], [/\bisn['’]t\b/g, 'is not'],
    [/\baren['’]t\b/g, 'are not'], [/\bwon['’]t\b/g, 'will not'], [/\bcan['’]t\b/g, 'cannot'], [/\bCan['’]t\b/g, 'Cannot'],
    [/\bdidn['’]t\b/g, 'did not'], [/\bwasn['’]t\b/g, 'was not'], [/\bhasn['’]t\b/g, 'has not'], [/\bhaven['’]t\b/g, 'have not'],
    [/\bwouldn['’]t\b/g, 'would not'], [/\bshouldn['’]t\b/g, 'should not'], [/\bcouldn['’]t\b/g, 'could not'], [/\bweren['’]t\b/g, 'were not'],
    [/\bfor example\b/g, 'e.g.'], [/\bFor example\b/g, 'E.g.'], [/\bensure\b/g, 'make sure'], [/\bEnsure\b/g, 'Make sure'],
    [/\bfor every\b/g, 'for each'], [/\bFor every\b/g, 'For each'], [/\btoward\b/g, 'towards'], [/\bafterward\b/g, 'afterwards'],
    [/__/g, '**'], [/ -- /g, ' — '], [/ -> /g, ' → '], [/^(\s*)\* /gm, '$1- '], [/^(\s*\d+)\) /gm, '$1. '],
    [/([.!?])  (?=[A-Z])/g, '$1 '], [/, (and|or|but) /g, ' $1 '], [/\.$/gm, ''],
  ];
  let out = stripZeroWidth(text);
  for (const [pattern, replacement] of pairs) out = out.replace(pattern, replacement);
  return out;
}

describe('watermarkPrompt', () => {
  it('keeps the line count and every non-prose line byte-identical', () => {
    for (const accountId of accounts.slice(0, 4)) {
      const lines = mark(accountId).text.split('\n');
      expect(lines).toHaveLength(SEGMENTS.length);
      SEGMENTS.forEach(([kind, text], index) => { if (kind === 'fixed') expect(lines[index]).toBe(md(text)); });
    }
  });

  it('never alters inline code, URLs, quoted strings or the zero-width-free text of code', () => {
    const original = STEP;
    const out = mark(accounts[0]).text;
    for (const pattern of [/`[^`\n]+`/g, /https?:\/\/\S+/g, /"[^"\n]*"/g]) {
      const before = original.match(pattern) ?? [];
      const after = out.match(pattern) ?? [];
      expect(after).toEqual(before);
    }
    for (const span of out.match(/`[^`\n]+`/g) ?? []) expect(span).not.toMatch(/[\u200B\u200C\u200D\u2060]/);
    // "look for example files" is not an aside — it must stay.
    expect(out).toContain('look for example files');
  });

  it('changes wording only through the allowed variants (meaning preserved)', () => {
    for (const accountId of accounts) {
      const out = mark(accountId).text;
      expect(out).not.toBe(STEP);
      expect(normalized(out)).toBe(normalized(STEP));
      expect(canonicalWords(out)).toEqual(canonicalWords(STEP));
    }
  });

  it('is deterministic and differs per account and per step', () => {
    const first = mark(accounts[0]);
    const again = mark(accounts[0]);
    expect(again.text).toBe(first.text);
    expect(again.mark).toBe(first.mark);
    expect(mark(accounts[1]).text).not.toBe(first.text);
    const otherStep = mark(accounts[0], 'page:contact');
    expect(otherStep.mark).not.toBe(first.mark);
    expect(otherStep.text).not.toBe(first.text);
    expect(applyWatermark(STEP, first.mark).text).toBe(first.text); // pure given the mark
  });

  it('spells the mark in zero-width characters between sentences of prose only', () => {
    const result = mark(accounts[2]);
    expect(result.zeroWidthCopies).toBe(4);
    expect(result.slots).toBeGreaterThan(50);
    expect(decodeZeroWidth(result.text)).toEqual([result.mark]);
    result.text.split('\n').forEach((line, index) => {
      if (/[\u200B\u200C\u200D\u2060]/.test(line)) {
        expect(SEGMENTS[index][0]).toBe('prose');
        expect(line).toMatch(/[a-z][.!?][\u200B\u200C\u200D\u2060]{28}(?: |$)/);
      }
    });
    // A damaged payload is ignored rather than misread.
    expect(decodeZeroWidth(result.text.replace(/[\u200B\u200C\u200D\u2060]{28}/, (run) => run.slice(0, 27)))).toEqual([result.mark]);
    expect(decodeZeroWidth(stripZeroWidth(result.text))).toEqual([]);
  });

  it('logs what was sent: mark, account, build, step, hash and fingerprint n-grams', () => {
    const result = mark(accounts[3]);
    const owner = db.sql.prepare('SELECT account_id, build_id FROM watermarks WHERE mark = ?').get(result.mark) as { account_id: string; build_id: string };
    expect(owner).toEqual({ account_id: accounts[3], build_id: `bld_${accounts[3]}` });
    const send = db.sql.prepare('SELECT * FROM watermark_sends WHERE mark = ?').get(result.mark) as Record<string, any>;
    expect(send).toMatchObject({ account_id: accounts[3], step_id: 'page:about', chars: result.text.length, zw_copies: 4, sent_at: 2_000 });
    expect(send.text_hash).toBe(createHash('sha256').update(result.text).digest('hex'));
    const grams = JSON.parse(send.fingerprints) as string[];
    expect(grams.length).toBe(5);
    for (const gram of grams) expect(gram.split(' ')).toHaveLength(5);
    // Re-sending the same step reuses the mark and adds a send row.
    mark(accounts[3]);
    expect((db.sql.prepare('SELECT COUNT(*) AS n FROM watermark_sends WHERE mark = ?').get(result.mark) as { n: number }).n).toBe(2);
    expect((db.sql.prepare('SELECT COUNT(*) AS n FROM watermarks WHERE mark = ?').get(result.mark) as { n: number }).n).toBe(1);
  });

  it('works inside a caller transaction and is fast on a recipe-sized prompt', () => {
    const inside = db.transaction(() => watermarkPrompt(STEP, { accountId: accounts[0], buildId: 'b', stepId: 's', db, secret: SECRET }));
    expect(decodeZeroWidth(inside)).toHaveLength(1);
    const big = Array.from({ length: 9 }, (_, index) => STEP.replace(/Step 4/g, `Step ${index}`).replace(/one React page/g, `React page ${index}`)).join('\n\n');
    expect(big.length).toBeGreaterThan(30_000);
    const started = performance.now();
    const out = watermarkPrompt(big, { accountId: accounts[1], buildId: 'b', stepId: 'big', db, secret: SECRET });
    const watermarkMs = performance.now() - started;
    const identifyStarted = performance.now();
    const found = identifyLeak(stripZeroWidth(out), db);
    const identifyMs = performance.now() - identifyStarted;
    expect(found[0].accountId).toBe(accounts[1]);
    expect(watermarkMs).toBeLessThan(1500);
    expect(identifyMs).toBeLessThan(1500);
  });
});

describe('decoratePrompt (step engine hook)', () => {
  it('plugs into the step engine as its PromptDecorator, and logs device and recipe version', () => {
    // Typed as the step engine's hook: this line fails to compile if the two drift apart.
    const decorate: PromptDecorator = createPromptDecorator(db, { secret: SECRET, now: () => 3_000 });
    const context = { accountId: accounts[4], deviceId: 'dev_x', buildId: 'bld_x', stepId: 'inventory', kind: 'inventory', attempt: 1, recipeVersion: '2026.10.1' };
    const out = decorate(STEP, context);
    expect(decorate(STEP, { ...context, attempt: 2 })).toBe(out); // a retried step keeps its mark
    const [found] = decodeZeroWidth(out);
    expect(found).toBeTruthy();
    expect((db.sql.prepare('SELECT step_id, device_id, recipe_version, sent_at FROM watermark_sends WHERE mark = ? LIMIT 1').get(found) as Record<string, unknown>))
      .toEqual({ step_id: 'inventory', device_id: 'dev_x', recipe_version: '2026.10.1', sent_at: 3_000 });
    expect(identifyLeak(out, db)[0]).toMatchObject({ accountId: accounts[4], best: { deviceId: 'dev_x', buildId: 'bld_x' } });
  });

  it('never blocks a build: without a working database it still returns a watermarked prompt', () => {
    const warnings: string[] = [];
    const unlogged = decoratePrompt(STEP, { accountId: 'acc_x', buildId: 'b', stepId: 's', secret: SECRET });
    expect(decodeZeroWidth(unlogged)).toHaveLength(1);
    const broken = new CloudDb(':memory:');
    broken.close();
    const fallback = decoratePrompt(STEP, { accountId: 'acc_x', buildId: 'b', stepId: 's', secret: SECRET, db: broken, log: { warn: (message) => { warnings.push(message); } } });
    expect(fallback).toBe(unlogged);
    expect(warnings).toHaveLength(1);
  });
});

describe('identifyLeak', () => {
  const sendAll = () => Object.fromEntries(accounts.map((accountId) => {
    mark(accountId, 'page:final', OTHER_STEP);
    return [accountId, mark(accountId).text];
  })) as Record<string, string>;
  const excerpt = (text: string, at: number, share = 0.3) => {
    const length = Math.floor(text.length * share);
    const start = Math.floor((text.length - length) * at);
    return text.slice(start, start + length);
  };

  it('(i) names the account from the intact text, zero-width marks included', () => {
    const sent = sendAll();
    for (const accountId of accounts) {
      const report = analyzeLeak(sent[accountId], db);
      expect(report.candidates[0]).toMatchObject({ accountId, zeroWidth: true, best: { stepId: 'page:about', buildId: `bld_${accountId}` } });
      expect(report.candidates[0].confidence).toBeGreaterThan(0.999);
      expect(report.candidates[0].email).toMatch(/@example\.com$/);
      expect(report.zeroWidthMarks).toHaveLength(1);
    }
  });

  it('(ii) names the account from the wording alone once zero-width characters are stripped', () => {
    const sent = sendAll();
    for (const accountId of accounts) {
      const [top, second] = identifyLeak(stripZeroWidth(sent[accountId]), db);
      expect(top).toMatchObject({ accountId, zeroWidth: false });
      expect(top.confidence).toBeGreaterThan(0.999);
      expect(top.wording.disagree).toBe(0);
      expect(top.wording.agree).toBeGreaterThan(40);
      expect(second?.confidence ?? 0).toBeLessThan(0.001);
    }
  });

  it('(iii) names the account from a ~30% excerpt anywhere in the step', () => {
    const sent = sendAll();
    let total = 0;
    let lowest = 1;
    for (const accountId of accounts) {
      for (const at of [0, 0.25, 0.5, 0.75, 1]) {
        const [top] = identifyLeak(excerpt(stripZeroWidth(sent[accountId]), at), db);
        expect(top?.accountId).toBe(accountId);
        total += 1;
        lowest = Math.min(lowest, top.confidence);
      }
    }
    expect(total).toBe(ACCOUNT_COUNT * 5);
    expect(lowest).toBeGreaterThan(0.9);
  });

  it('survives re-typing: squashed whitespace, straight quotes, expanded contractions', () => {
    const sent = sendAll();
    for (const accountId of accounts) {
      const retyped = stripZeroWidth(sent[accountId])
        .replace(/[’]/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\b(\w+)n't\b/g, (_, verb: string) => (verb === 'ca' ? 'cannot' : verb === 'wo' ? 'will not' : `${verb} not`));
      const [top] = identifyLeak(retyped, db);
      expect(top.accountId).toBe(accountId);
      expect(top.confidence).toBeGreaterThan(0.99);
    }
  });

  it('finds nothing in unrelated text or in the unmarked original', () => {
    sendAll();
    expect(identifyLeak('The quick brown fox jumps over the lazy dog. It does not stop — ever.\n'.repeat(40), db)).toEqual([]);
    const report = analyzeLeak(STEP, db);
    expect(report.contentsMatched).toBe(1);
    expect(report.candidates.every((candidate) => candidate.confidence < 0.01)).toBe(true);
  });

  it('keeps steps apart: an excerpt of one step is matched to that step', () => {
    const sent = sendAll();
    void sent;
    const final = watermarkPromptDetailed(OTHER_STEP, { accountId: accounts[5], buildId: `bld_${accounts[5]}`, stepId: 'page:final', db, secret: SECRET, now: 2_000 });
    const [top] = identifyLeak(final.text, db);
    expect(top).toMatchObject({ accountId: accounts[5], best: { stepId: 'page:final' } });
  });
});
