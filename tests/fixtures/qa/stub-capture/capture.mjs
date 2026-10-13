// Browser-free stand-in for templates/factory/qa-capture/capture.mjs, for the adapter tests. It
// writes the canned capture of the fixture sites (tests/fixtures/qa/canned, made by
// regenerate-canned.ts) where the real capture would, so the whole desktop → Cloud → reports path
// runs in milliseconds.
//
// Scenario (optional) comes from <cwd>/qa/stub-scenario.json:
//   { "reactBlank": true }   every React page rendered blank (capture failure)
//   { "failFirst": "sections" }   the first sections run crashes (retry path)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const canned = path.join(import.meta.dirname, '..', 'canned');
const [mode, arg] = process.argv.slice(2);
const cwd = process.cwd();
const scenarioFile = path.join(cwd, 'qa', 'stub-scenario.json');
const scenario = existsSync(scenarioFile) ? JSON.parse(readFileSync(scenarioFile, 'utf8')) : {};
const iter = Number(arg || process.env.ITER || '1');
const dir = path.join(cwd, 'qa', 'capture', 'factory', String(iter));
mkdirSync(dir, { recursive: true });
const read = (name) => JSON.parse(readFileSync(path.join(canned, name), 'utf8'));

if (scenario.failFirst === mode) {
  const marker = path.join(cwd, 'qa', `stub-failed-${mode}`);
  if (!existsSync(marker)) { writeFileSync(marker, '1'); console.error(`stub: ${mode} crashes once`); process.exit(3); }
}

if (mode === 'sections' || mode === 'inventory') {
  const capture = read(`capture-${mode}.json`);
  capture.reactBase = process.env.REACT_BASE ?? capture.reactBase;
  capture.shopifyBase = process.env.SHOPIFY_BASE ?? capture.shopifyBase;
  if (scenario.reactBlank) {
    for (const route of capture.routes) {
      if (route.react?.health) Object.assign(route.react.health, { textLength: 0, mediaCount: 0, elementCount: 2 });
    }
  }
  writeFileSync(path.join(dir, `${mode}.json`), JSON.stringify(capture));
  console.log(`stub: ${mode} capture written`);
} else if (mode === 'clicks') {
  const plan = JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  const effects = read('capture-effects.json');
  const byIndex = new Map(effects.effects.map((entry) => [entry.i, entry]));
  writeFileSync(path.join(dir, 'effects.json'), JSON.stringify({ kind: 'effects', iter, effects: plan.clicks.map((click) => byIndex.get(click.i)).filter(Boolean) }));
  console.log(`stub: ${plan.clicks.length} click effect(s) written`);
} else if (mode === 'calibrate') {
  // Five full-width 260px bands, as the real fixture renders at 1440px.
  const words = ['crystal jewelry studio', 'spring collection arrived', 'customers say rated', 'care and repair for life', 'studio newsletter notes'];
  const blocks = words.map((text, index) => ({ id: index, parent: -1, tag: 'SECTION', x: 0, y: index * 357, w: 1440, h: 357, childCount: 3, headings: [text], text: `${text} ${text} body copy for calibration`, imgCount: 0, imgAlts: [], linkCount: 1, shapeHash: 'abc' }));
  const page = { health: { status: null, navError: null, finalPath: '/', passwordGate: false, textLength: 900, elementCount: 20, mediaCount: 0, bodyHeight: 1785, title: 'QA calibration fixture' }, layout: { viewportWidth: 1440, root: 'main', blocks } };
  writeFileSync(arg, JSON.stringify({ reference: page, candidate: page, mode: 'fixture' }));
  console.log('stub: calibration capture written');
} else {
  console.error(`stub: unknown mode ${mode}`);
  process.exit(2);
}
