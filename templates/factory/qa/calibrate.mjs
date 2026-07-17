// QA calibration harness: proves the scoring pipeline actually works BEFORE trusting job scores.
//
// Runs the section-compare scorer (the same qa-shared.mjs primitives the real QA uses:
// Playwright load -> settle -> segmentSections -> alignSections -> diceSimilarity) against a
// KNOWN-GOOD pair and asserts the composite score lands >= 0.95. A healthy pipeline scores
// ~1.0 on an identical pair; anything below the threshold means Playwright, Chromium, or the
// scoring math is broken on this machine — job scores cannot be trusted until this passes.
//
// Usage (standalone, for operators and CI):
//   node calibrate.mjs             # self-contained: writes two identical fixture HTML pages
//                                  # to a temp dir and compares them via file:// URLs
//   node calibrate.mjs --url <u>   # compares a live URL against itself instead
//
// Env: PW_ROOT / FACTORY_PW_ROOT (Playwright resolution, same as the other QA scripts).
// Output: human-readable per-subscore lines, then a machine-readable trailing line:
//   CALIBRATE_RESULT {"ok":true,"score":1,"subscores":{...},...}
// Exit code: 0 iff ok.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPlaywright, settle, segmentSections, alignSections, diceSimilarity } from './qa-shared.mjs';

const THRESHOLD = 0.95;
const MIN_SECTIONS = 3;
// Same defaults as server-side DEFAULT_SCORE_WEIGHTS; interaction is not exercised here, and
// composite() renormalizes over the present subscores exactly like the server's compositeScore.
const WEIGHTS = { presence: 0.5, text: 0.3, interaction: 0.2 };

function composite(subscores) {
  const parts = [];
  if (subscores.presence != null) parts.push([subscores.presence, WEIGHTS.presence]);
  if (subscores.text != null) parts.push([subscores.text, WEIGHTS.text]);
  if (subscores.interaction != null) parts.push([subscores.interaction, WEIGHTS.interaction]);
  const totalWeight = parts.reduce((sum, [, weight]) => sum + weight, 0);
  if (!totalWeight) return 0;
  return parts.reduce((sum, [score, weight]) => sum + score * weight, 0) / totalWeight;
}

// Fixture page: full-width sections tall enough (>=120px) and wide enough (>=60% viewport) to
// pass segmentSections' band filter, with distinct headings + prose so alignment is meaningful.
function fixtureHtml() {
  const section = (heading, body) => `
  <section style="min-height:260px;padding:48px 24px;border-bottom:1px solid #ddd">
    <h2>${heading}</h2>
    <p>${body}</p>
    <a href="/collections/all">Browse the collection</a>
  </section>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>QA calibration fixture</title></head>
<body style="margin:0;font-family:sans-serif">
<main>
  ${section('Handcrafted crystal jewelry', 'Every piece is cut, polished, and set by hand in our studio. Ethically sourced stones with full provenance, shipped worldwide in recycled packaging.')}
  ${section('The spring collection has arrived', 'Fresh amethyst, rose quartz, and citrine designs inspired by first light. Limited runs of forty pieces per design, numbered and signed.')}
  ${section('What our customers say', 'Rated 4.9 out of 5 across two thousand verified reviews. The clasp quality and stone clarity keep people coming back season after season.')}
  ${section('Care and repair for life', 'Free resizing within sixty days and lifetime repair on every chain and setting. Post your piece to us and we return it restored within two weeks.')}
  ${section('Join the studio newsletter', 'Monthly notes from the bench: new stones, restock alerts, and subscriber-only early access to each seasonal drop. No spam, unsubscribe anytime.')}
</main>
</body>
</html>`;
}

const pct = (value) => value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;

async function calibrate(urlA, urlB, mode) {
  let browser = null;
  try {
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    const load = async (url) => {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, { quietMs: 300 });
      return page;
    };
    const pageA = await load(urlA);
    const pageB = await load(urlB);
    const sectionsA = await segmentSections(pageA);
    const sectionsB = await segmentSections(pageB);

    const alignment = alignSections(sectionsA, sectionsB);
    const presence = sectionsA.length ? alignment.pairs.length / sectionsA.length : 0;
    const textScores = alignment.pairs.map((pair) => diceSimilarity(sectionsA[pair.a].text, sectionsB[pair.b].text));
    const text = textScores.length ? textScores.reduce((sum, score) => sum + score, 0) / textScores.length : 0;
    const subscores = {
      presence: Number(presence.toFixed(4)),
      text: Number(text.toFixed(4)),
      interaction: null, // not exercised by calibration; composite renormalizes without it
    };
    const score = Number(composite(subscores).toFixed(4));

    console.log('');
    console.log(`sections: reference=${sectionsA.length} candidate=${sectionsB.length} matched=${alignment.pairs.length} missing=${alignment.missing.length} extra=${alignment.extra.length}`);
    console.log(`subscore presence:    ${pct(subscores.presence)}`);
    console.log(`subscore text:        ${pct(subscores.text)}`);
    console.log(`subscore interaction: n/a (not exercised by calibration)`);
    console.log(`composite score:      ${pct(score)} (threshold ${pct(THRESHOLD)})`);

    let error;
    if (sectionsA.length < MIN_SECTIONS) {
      error = `segmentation found only ${sectionsA.length} section(s) (expected >= ${MIN_SECTIONS}) — the page did not render or the segmenter is broken.`;
    } else if (score < THRESHOLD) {
      error = `composite ${pct(score)} fell below the ${pct(THRESHOLD)} calibration threshold on a known-good pair — do not trust job scores until this is fixed.`;
    }
    if (error) console.error(`CALIBRATION FAILED: ${error}`);
    else console.log('CALIBRATION PASSED: the QA scoring pipeline is healthy.');

    return {
      ok: !error, score, subscores, threshold: THRESHOLD, mode,
      sections: { reference: sectionsA.length, candidate: sectionsB.length, matched: alignment.pairs.length },
      ...(error ? { error } : {}),
    };
  } catch (error) {
    console.error(`CALIBRATION FAILED: ${error?.stack ?? error}`);
    return { ok: false, score: null, subscores: null, threshold: THRESHOLD, mode, error: error?.message ?? String(error) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const urlFlag = process.argv.indexOf('--url');
const targetUrl = urlFlag !== -1 ? process.argv[urlFlag + 1] : null;
let result;
if (urlFlag !== -1 && !targetUrl) {
  console.error('--url requires a value');
  result = { ok: false, score: null, subscores: null, error: '--url requires a value' };
} else if (targetUrl) {
  console.log(`calibrating against live URL (same page twice): ${targetUrl}`);
  result = await calibrate(targetUrl, targetUrl, 'url');
} else {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'qa-calibrate-'));
  try {
    const html = fixtureHtml();
    writeFileSync(path.join(fixtureDir, 'reference.html'), html);
    writeFileSync(path.join(fixtureDir, 'candidate.html'), html);
    console.log(`calibrating against self-written fixture pair in ${fixtureDir}`);
    result = await calibrate(
      pathToFileURL(path.join(fixtureDir, 'reference.html')).href,
      pathToFileURL(path.join(fixtureDir, 'candidate.html')).href,
      'fixture',
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

console.log(`CALIBRATE_RESULT ${JSON.stringify(result)}`);
process.exit(result.ok ? 0 : 1);
