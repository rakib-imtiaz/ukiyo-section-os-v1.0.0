// Regenerates tests/fixtures/qa/canned/ — a real capture of the fixture sites plus the reports the
// OLD local scripts wrote for the same sites (the golden files the Cloud scorer must reproduce).
//
//   npx tsx tests/fixtures/qa/regenerate-canned.ts
//
// Needs Chromium (Playwright from node_modules). Run it after changing fixture-sites.ts or the
// capture format; the default test suite then checks parity without a browser.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startQaCloud } from '../../../cloud/tests/qa-harness';
import { runQaCloudPipeline } from '../../../server/factory/qa-cloud';
import { startFixtureSites } from './fixture-sites';

const repo = path.resolve(import.meta.dirname, '..', '..', '..');
const out = path.join(import.meta.dirname, 'canned');

const run = (script: string, cwd: string, env: Record<string, string>) => new Promise<void>((resolve, reject) => {
  const child = spawn(process.execPath, [script, '1'], { cwd, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
});

const workspace = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(dir, 'qa', 'state'), { recursive: true });
  writeFileSync(path.join(dir, 'qa', 'state', 'handles.json'), JSON.stringify({ '/about': 'about' }));
  return dir;
};

const sites = await startFixtureSites();
const cloud = await startQaCloud();
const oldWs = workspace('tb-qa-canned-old-');
const newWs = workspace('tb-qa-canned-new-');
try {
  const env = { REACT_BASE: sites.reactBase, SHOPIFY_BASE: sites.shopifyBase, ITER: '1', STORE_PASSWORD: '' };
  await run(path.join(repo, 'templates/factory/qa/section-compare.mjs'), oldWs, env);
  await run(path.join(repo, 'templates/factory/qa/interaction-verify.mjs'), oldWs, env);
  const pass = await cloud.pass();
  await runQaCloudPipeline({
    workspace: newWs, reactBase: sites.reactBase, shopifyBase: sites.shopifyBase, storePassword: null, iteration: 1, qaMode: 'both',
    headed: false, weights: { presence: 0.5, text: 0.3, interaction: 0.2 }, jobName: 'Canned fixture', scoreThreshold: 0.9,
    buildRef: 'canned', timeoutMin: 4, captureDir: path.join(repo, 'templates/factory/qa-capture'), playwrightRoot: path.join(repo, 'node_modules'),
    post: async <T>(route: string, body: unknown) => {
      const result = await cloud.qa(route.replace(/^\/v1\/qa/, ''), body, pass);
      if (result.status !== 200) throw new Error(`${route} → ${result.status} ${JSON.stringify(result.body)}`);
      return result.body as T;
    },
  });
  mkdirSync(out, { recursive: true });
  const capture = path.join(newWs, 'qa/capture/factory/1');
  for (const name of ['sections', 'inventory', 'effects']) copyFileSync(path.join(capture, `${name}.json`), path.join(out, `capture-${name}.json`));
  const reports = path.join(oldWs, 'qa/reports/factory');
  for (const name of ['sections-1.json', 'sections-1.md', 'interactions-1.json', 'interactions-1.md']) copyFileSync(path.join(reports, name), path.join(out, `golden-${name}`));
  console.log(`canned fixtures written to ${out}`);
} finally {
  await cloud.close();
  await sites.close();
  rmSync(oldWs, { recursive: true, force: true });
  rmSync(newWs, { recursive: true, force: true });
}
