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
const out = path.join(root, 'build');
const args = new Set(process.argv.slice(2));
const step = (message) => console.log(`\n▸ ${message}`);
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

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

// 3. Resources the server reads at runtime -----------------------------------------------------
step('Staging resources');
await cp(path.join(root, 'dist'), path.join(resources, 'dist'), { recursive: true });
await cp(path.join(root, 'templates'), path.join(resources, 'templates'), { recursive: true });
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
await cp(path.join(root, 'desktop/licence.html'), path.join(appDir, 'licence.html'));
// Licence keys (Lemon Squeezy): which store/products may unlock this build. Unset = no licence needed.
const storeId = Number(process.env.THEMEBOT_LS_STORE_ID) || undefined;
const productIds = (process.env.THEMEBOT_LS_PRODUCT_IDS || '').split(',').map(Number).filter(Boolean);
await writeFile(path.join(appDir, 'package.json'), JSON.stringify({
  name: 'themebot-desktop',
  productName: 'ThemeBot',
  version: pkg.version,
  description: 'ThemeBot — websites to Shopify themes',
  author: pkg.author || 'ThemeBot',
  main: 'main.cjs',
  themebot: {
    edition: process.env.THEMEBOT_EDITION === 'internal' ? 'internal' : 'customer',
    ...(storeId ? { licence: { storeId, productIds } } : {}),
    ...(process.env.THEMEBOT_UPDATE_URL ? { updateUrl: process.env.THEMEBOT_UPDATE_URL.trim() } : {}),
  },
}, null, 2));

// 5. Node.js runtime ------------------------------------------------------------------------------
if (!args.has('--skip-runtime')) {
  step('Fetching the Node.js runtime');
  await fetchNodeRuntime({ root, version: process.env.THEMEBOT_NODE_VERSION || process.versions.node });
}

const listed = readdirSync(resources);
console.log(`\n✓ Desktop build ready in build/ (resources: ${listed.join(', ')})`);
