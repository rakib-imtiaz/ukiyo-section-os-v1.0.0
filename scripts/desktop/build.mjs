// Builds everything the ThemeBot desktop app ships, into build/:
//   build/desktop-app/     Electron main + preload (bundled) and a tiny package.json — becomes app.asar
//   build/resources/       server/server.mjs (bundled API), node_modules/ (Playwright, node-pty),
//                          dist/ (UI), templates/, migrations/ — copied next to app.asar
//   build/runtime/<os>-<arch>/  the official Node.js + npm the server and build tools run on
//
// Usage: node scripts/desktop/build.mjs [--skip-ui] [--skip-runtime]
// electron-builder then packages these (see electron-builder.yml).
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { fetchNodeRuntime } from './fetch-node-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// THEMEBOT_BUILD_DIR: stage somewhere else (a dry run that must not touch build/). pack.mjs reads build/.
const out = path.resolve(process.env.THEMEBOT_BUILD_DIR?.trim() || path.join(root, 'build'));
const args = new Set(process.argv.slice(2));
const step = (message) => console.log(`\n▸ ${message}`);
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

// ThemeBot Cloud: with an address, the app requires signing in to a ThemeBot account and only builds
// with a valid pass. The pass-signing public key is pinned here (the Cloud prints it at startup and
// serves it at /v1/public-key). Unset = no account needed (dev, internal builds). Checked first, so
// a bad value fails before anything is built.
const cloudUrl = (process.env.THEMEBOT_CLOUD_URL || '').trim().replace(/\/+$/, '');
const cloudKey = (process.env.THEMEBOT_CLOUD_PUBKEY || '').trim();
if (cloudUrl) {
  const { protocol, hostname } = new URL(cloudUrl);
  const local = hostname === '127.0.0.1' || hostname === 'localhost';
  if (protocol !== 'https:' && !(protocol === 'http:' && local)) throw new Error('THEMEBOT_CLOUD_URL must use https:// (http:// only for 127.0.0.1/localhost).');
  if (Buffer.from(cloudKey, 'base64').length !== 32) throw new Error('THEMEBOT_CLOUD_PUBKEY must be the Cloud\'s Ed25519 public key (base64, 32 bytes) — see GET <cloud>/v1/public-key.');
} else if (cloudKey) {
  throw new Error('THEMEBOT_CLOUD_PUBKEY is set without THEMEBOT_CLOUD_URL.');
}

// 1. UI ----------------------------------------------------------------------------------------
if (!args.has('--skip-ui')) {
  step('Building the UI (vite build)');
  execFileSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root, stdio: 'inherit' });
}

// 2. Server bundle -------------------------------------------------------------------------------
step('Bundling the server');
const resources = path.join(out, 'resources');
await rm(resources, { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, 'server/index.ts')],
  outfile: path.join(resources, 'server/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Native / self-locating packages stay real files in resources/node_modules; optional
  // accelerators that aren't installed stay unresolved (their callers try/catch the require).
  external: ['playwright', 'playwright-core', 'node-pty', 'pg-native', 'bufferutil', 'utf-8-validate', 'fsevents'],
  // Bundled CommonJS packages call require(); give the ESM bundle a real one.
  banner: { js: "import { createRequire as __tbCreateRequire } from 'node:module'; const require = __tbCreateRequire(import.meta.url);" },
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});

// ThemeBot Engine (engine/): its own process, started by the runner when a build opts into it
// (server/factory/runner.ts engineLaunch looks for resources/engine/engine.mjs).
step('Bundling ThemeBot Engine');
await build({
  entryPoints: [path.join(root, 'engine/src/cli.ts')],
  outfile: path.join(resources, 'engine/engine.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import { createRequire as __tbCreateRequire } from 'node:module'; const require = __tbCreateRequire(import.meta.url);" },
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});

// 3. Resources the server reads at runtime -----------------------------------------------------
step('Staging resources');
await cp(path.join(root, 'dist'), path.join(resources, 'dist'), { recursive: true });
// With ThemeBot Cloud the build recipe and the QA scoring live in the Cloud and are served one step
// at a time — they must not ship: the /clone-theme command, the fix-session prompt, the builder
// conventions and the local QA scoring scripts. Kept: the generic workspace plumbing
// (templates/factory/workspace/*) and the QA capture scripts (templates/factory/qa-capture/**).
// Internal / no-Cloud builds keep everything (they run the local recipe).
const RECIPE_ONLY = ['factory/commands', 'factory/prompts', 'factory/workspace/seed/CONVENTIONS.md', 'factory/qa'];
const isRecipe = (relative) => RECIPE_ONLY.some((entry) => relative === entry || relative.startsWith(`${entry}/`));
const templatesSrc = path.join(root, 'templates');
await cp(templatesSrc, path.join(resources, 'templates'), {
  recursive: true,
  filter: (source) => !cloudUrl || !isRecipe(path.relative(templatesSrc, source).split(path.sep).join('/')),
});
if (cloudUrl) console.log(`  recipe left out (served by ThemeBot Cloud): ${RECIPE_ONLY.map((entry) => `templates/${entry}`).join(', ')}`);
await cp(path.join(root, 'migrations'), path.join(resources, 'migrations'), { recursive: true });
const video = path.join(root, 'video/setup-guide/out/setup-guide.mp4');
if (existsSync(video)) await cp(video, path.join(resources, 'video/setup-guide/out/setup-guide.mp4'));

const modules = path.join(resources, 'node_modules');
for (const name of ['playwright', 'playwright-core']) {
  await cp(path.join(root, 'node_modules', name), path.join(modules, name), { recursive: true });
}
// node-pty: only what loads at runtime — JS, package.json and this platform's native binaries.
const ptySrc = path.join(root, 'node_modules/node-pty');
const ptyDst = path.join(modules, 'node-pty');
await cp(path.join(ptySrc, 'package.json'), path.join(ptyDst, 'package.json'));
await cp(path.join(ptySrc, 'lib'), path.join(ptyDst, 'lib'), { recursive: true });
const prebuild = path.join(ptySrc, 'prebuilds', `${process.platform}-${process.arch}`);
const noDebugSymbols = (file) => !file.endsWith('.pdb');
if (existsSync(prebuild)) {
  await cp(prebuild, path.join(ptyDst, 'prebuilds', `${process.platform}-${process.arch}`), { recursive: true, filter: noDebugSymbols });
} else if (existsSync(path.join(ptySrc, 'build/Release'))) {
  // Linux has no prebuild — npm compiled one into build/Release on this machine.
  await cp(path.join(ptySrc, 'build/Release'), path.join(ptyDst, 'build/Release'), { recursive: true, filter: noDebugSymbols });
} else {
  console.warn(`  ! node-pty has no native binary for ${process.platform}-${process.arch}; the terminal will be unavailable.`);
}

// 4. Electron main + preload ---------------------------------------------------------------------
step('Bundling the Electron main process');
const appDir = path.join(out, 'desktop-app');
await rm(appDir, { recursive: true, force: true });
const electronCommon = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'warning', legalComments: 'none' };
await build({ ...electronCommon, entryPoints: [path.join(root, 'desktop/main.ts')], outfile: path.join(appDir, 'main.cjs') });
await build({ ...electronCommon, entryPoints: [path.join(root, 'desktop/preload.ts')], outfile: path.join(appDir, 'preload.cjs') });
await cp(path.join(root, 'desktop/loading.html'), path.join(appDir, 'loading.html'));
await cp(path.join(root, 'desktop/signin.html'), path.join(appDir, 'signin.html'));
await writeFile(path.join(appDir, 'package.json'), JSON.stringify({
  name: 'themebot-desktop',
  productName: 'ThemeBot',
  version: pkg.version,
  description: 'ThemeBot — websites to Shopify themes',
  author: pkg.author || 'ThemeBot',
  main: 'main.cjs',
  themebot: {
    edition: process.env.THEMEBOT_EDITION === 'internal' ? 'internal' : 'customer',
    ...(cloudUrl ? { cloud: { url: cloudUrl, publicKey: cloudKey } } : {}),
    ...(process.env.THEMEBOT_UPDATE_URL ? { updateUrl: process.env.THEMEBOT_UPDATE_URL.trim() } : {}),
  },
}, null, 2));

// 5. Node.js runtime ------------------------------------------------------------------------------
if (!args.has('--skip-runtime')) {
  step('Fetching the Node.js runtime');
  await fetchNodeRuntime({ root, version: process.env.THEMEBOT_NODE_VERSION || process.versions.node });
}

// 6. Cloud builds: prove the recipe stayed out (template files, and nothing of cloud/recipe or the
//    Cloud's step engine bundled into the server by an accidental import).
if (cloudUrl) {
  const leaked = RECIPE_ONLY.filter((entry) => existsSync(path.join(resources, 'templates', ...entry.split('/'))));
  const bundle = await readFile(path.join(resources, 'server/server.mjs'), 'utf8');
  if (/tbr-canary-[0-9a-f]{12}/.test(bundle) || bundle.includes('INTO recipe_versions')) leaked.push('server/server.mjs (Cloud recipe or step engine bundled)');
  // …nor the Cloud's QA scoring, watermarking or security code (types-only imports are fine).
  for (const [marker, what] of [['qa-plan:v1:', 'QA click-plan signing'], ['CREATE TABLE IF NOT EXISTS qa_rounds', 'QA scoring store'], ['watermark_sends', 'prompt watermarks'], ['security_events', 'security events']]) {
    if (bundle.includes(marker)) leaked.push(`server/server.mjs (Cloud ${what} bundled)`);
  }
  if (leaked.length) throw new Error(`The build recipe must not ship with a Cloud build, but these are in build/resources: ${leaked.join(', ')}`);
}

const listed = readdirSync(resources);
console.log(`\n✓ Desktop build ready in ${path.relative(root, out) || '.'}/ (resources: ${listed.join(', ')})`);
