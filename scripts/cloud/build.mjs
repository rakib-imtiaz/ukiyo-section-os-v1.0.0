// Builds ThemeBot Cloud for production into one small folder (default build/cloud/):
//   cloud.mjs      the whole server (cloud/src + Express) bundled by esbuild; runs on plain `node` (24+)
//   recipe/        a copy of cloud/recipe, read once at start
//   release.json   app version, git commit, recipe version, build time
//
// The bundle has no runtime dependencies (node:sqlite and node:crypto are built into Node 24), so the
// folder is the whole release: copy it to a server and run `node cloud.mjs`. The recipe is read from
// CLOUD_RECIPE_DIR when set, otherwise from the recipe/ folder next to cloud.mjs.
//
// Usage: node scripts/cloud/build.mjs [--out <dir>] [--smoke]
//   --out <dir>  stage somewhere else (also THEMEBOT_CLOUD_BUILD_DIR)
//   --smoke      afterwards, start the bundle with NODE_ENV=production and throwaway secrets on
//                127.0.0.1, check /v1/health and /v1/public-key, and check that it refuses to start
//                when a required production setting is missing. Nothing is sent anywhere (no sign-in
//                route is called, so no mail goes out). deploy/deploy.sh runs this before uploading.
import { execFileSync, spawn } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const out = path.resolve(option('--out') || process.env.THEMEBOT_CLOUD_BUILD_DIR?.trim() || path.join(root, 'build', 'cloud'));
const step = (message) => console.log(`\n▸ ${message}`);

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const recipeSrc = path.join(root, 'cloud/recipe');

function git(...args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

// 1. Bundle ---------------------------------------------------------------------------------------
step(`Bundling ThemeBot Cloud into ${path.relative(root, out) || '.'}`);
await rm(out, { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, 'cloud/src/index.ts')],
  outfile: path.join(out, 'cloud.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: {
    js: [
      // Bundled CommonJS packages (Express and friends) call require(); give the ESM bundle a real one.
      "import { createRequire as __tbCreateRequire } from 'node:module';",
      "import { fileURLToPath as __tbFileURLToPath } from 'node:url';",
      'const require = __tbCreateRequire(import.meta.url);',
      // cloud/src/steps/recipe.ts looks for ../../recipe relative to its own source file, which means
      // nothing inside a bundle. Point it at the recipe/ folder shipped next to cloud.mjs unless the
      // operator chose another one.
      "if (!process.env.CLOUD_RECIPE_DIR?.trim()) process.env.CLOUD_RECIPE_DIR = __tbFileURLToPath(new URL('./recipe/', import.meta.url));",
    ].join('\n'),
  },
  // Readable stack traces in the server logs matter more than a few hundred kB.
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
});

// 2. Recipe + release info ------------------------------------------------------------------------
// Always a fresh copy of cloud/recipe (the whole output folder was deleted above), then proven
// identical to the source: a stale or half-copied recipe must never ship.
step('Copying the recipe and writing release.json');
const recipeOut = path.join(out, 'recipe');
await cp(recipeSrc, recipeOut, { recursive: true });
const recipeVersion = async (dir) => JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')).recipe_version;
const sourceVersion = await recipeVersion(recipeSrc);
const bundledVersion = await recipeVersion(recipeOut);
if (!sourceVersion) throw new Error('cloud/recipe/manifest.json has no recipe_version.');
if (bundledVersion !== sourceVersion) {
  throw new Error(`Bundled recipe version ${bundledVersion} differs from cloud/recipe/manifest.json (${sourceVersion}). Build again.`);
}
async function listFiles(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(path.join(dir, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}
const sourceFiles = await listFiles(recipeSrc);
const bundledFiles = await listFiles(recipeOut);
const differing = sourceFiles.join('\n') !== bundledFiles.join('\n')
  ? ['(the file list)']
  : (await Promise.all(sourceFiles.map(async (file) => (
    (await readFile(path.join(recipeSrc, file))).equals(await readFile(path.join(recipeOut, file))) ? null : file
  )))).filter(Boolean);
if (differing.length) throw new Error(`The bundled recipe differs from cloud/recipe in ${differing.join(', ')} (it changed during the build?). Build again.`);
console.log(`  recipe ${sourceVersion}: ${sourceFiles.length} files, identical to cloud/recipe`);

const commit = git('rev-parse', '--short=12', 'HEAD');
const release = {
  name: 'themebot-cloud',
  version: pkg.version,
  recipeVersion: sourceVersion,
  commit: commit || null,
  // Uncommitted changes under cloud/ (the commit alone does not describe this build).
  dirty: commit ? git('status', '--porcelain', '--', 'cloud', 'scripts/cloud').length > 0 : null,
  builtAt: new Date().toISOString(),
  node: '>=24',
};
await writeFile(path.join(out, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);

async function folderSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await folderSize(full) : (await stat(full)).size;
  }
  return total;
}
const size = await folderSize(out);
console.log(`\n✓ ThemeBot Cloud ${release.version} (recipe ${release.recipeVersion}${release.commit ? `, ${release.commit}${release.dirty ? '+changes' : ''}` : ''}) built in ${path.relative(root, out) || '.'}/ — ${(size / 1024).toFixed(0)} kB`);
console.log('  Run it: NODE_ENV=production node cloud.mjs (with the settings in deploy/cloud.env.example)');

if (flag('--smoke')) await smoke(out);

// 3. Smoke test -----------------------------------------------------------------------------------
async function smoke(dir) {
  step('Smoke test: the bundle in production mode on 127.0.0.1 with throwaway secrets');
  const bundle = path.join(dir, 'cloud.mjs');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'themebot-cloud-smoke-'));
  const failures = [];
  const check = (ok, what) => { console.log(`  ${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };
  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().trim();
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    const expectedPublicKey = Buffer.from(jwk.x, 'base64url').toString('base64');
    const port = await freePort();

    // A clean environment: nothing from this shell's Cloud settings (or a CLOUD_RECIPE_DIR) leaks in.
    const base = { ...process.env };
    for (const name of Object.keys(base)) {
      if (/^(CLOUD_|RESEND_|MAIL_|LEMONSQUEEZY_|ADMIN_TOKEN|MIN_APP_VERSION|NODE_OPTIONS|NODE_ENV)/.test(name)) delete base[name];
    }
    const production = {
      ...base,
      NODE_ENV: 'production',
      CLOUD_HOST: '127.0.0.1',
      CLOUD_PORT: String(port),
      CLOUD_DATA_DIR: path.join(tmp, 'data'),
      // As written in cloud.env: one line, "\n" escapes.
      CLOUD_SIGNING_KEY: pem.replace(/\n/g, '\\n'),
      CLOUD_PEPPER: randomBytes(32).toString('base64url'),
      RESEND_API_KEY: 're_smoke_test_not_a_real_key',
      MAIL_FROM: 'ThemeBot <login@smoke-test.invalid>',
      ADMIN_TOKEN: `tba_${randomBytes(32).toString('base64url')}`,
      LEMONSQUEEZY_WEBHOOK_SECRET: randomBytes(16).toString('hex'),
      CLOUD_TRUST_PROXY: '1',
    };

    // (a) It starts and answers.
    const server = run(bundle, production, tmp);
    const base_url = `http://127.0.0.1:${port}`;
    let health = null;
    for (let attempt = 0; attempt < 60 && !health && !exited(server); attempt += 1) {
      health = await fetch(`${base_url}/v1/health`).then((response) => (response.ok ? response : null)).catch(() => null);
      if (!health) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    check(Boolean(health), `GET /v1/health answers 200 (pid ${server.pid})`);
    if (health) {
      const body = await health.json();
      check(body.ok === true && body.name === 'ThemeBot Cloud', `/v1/health body: ${JSON.stringify(body)}`);
      check(/max-age=\d+/.test(health.headers.get('strict-transport-security') || ''), 'production sends Strict-Transport-Security');
      const keyResponse = await fetch(`${base_url}/v1/public-key`);
      const key = await keyResponse.json().catch(() => ({}));
      check(keyResponse.ok && key.publicKey === expectedPublicKey && Buffer.from(key.publicKey, 'base64').length === 32,
        `GET /v1/public-key returns the throwaway key's public half (${key.publicKey})`);
      const missing = await fetch(`${base_url}/nope`);
      check(missing.status === 404, `unknown route answers 404 (${missing.status})`);
      const admin = await fetch(`${base_url}/v1/admin/accounts`);
      check(admin.status === 401 || admin.status === 403, `admin API without the token is refused (${admin.status})`);
    }
    await stop(server);
    const logs = server.output();
    check(/"level":"info"/.test(logs) && /ThemeBot Cloud listening/.test(logs), 'production logs are JSON lines');
    check(!logs.includes(production.ADMIN_TOKEN) && !logs.includes(production.CLOUD_PEPPER), 'the admin token and pepper never appear in the logs');
    if (failures.length) console.log(`\n--- server output ---\n${logs.trim()}\n---------------------`);

    // (b) It refuses to start without each required production setting.
    const refusals = [
      ['without CLOUD_SIGNING_KEY', { CLOUD_SIGNING_KEY: '' }, /CLOUD_SIGNING_KEY is required in production/],
      ['with a signing key that is not Ed25519', { CLOUD_SIGNING_KEY: generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }, /must be an Ed25519 private key/],
      ['without RESEND_API_KEY', { RESEND_API_KEY: '' }, /RESEND_API_KEY and MAIL_FROM are required/],
      ['without MAIL_FROM', { MAIL_FROM: '' }, /RESEND_API_KEY and MAIL_FROM are required/],
      ['with an ADMIN_TOKEN under 24 characters', { ADMIN_TOKEN: 'too-short' }, /ADMIN_TOKEN must be at least 24 characters/],
      // Proves the recipe really is read at start (here: from an empty folder), so (a) loaded the shipped one.
      ['without a recipe', { CLOUD_RECIPE_DIR: path.join(tmp, 'no-recipe') }, /manifest\.json/],
    ];
    for (const [what, override, expected] of refusals) {
      // A fresh data folder each time: a signing-key.pem left there would be used instead.
      const env = { ...production, ...override, CLOUD_DATA_DIR: await mkdtemp(path.join(tmp, 'refuse-')) };
      const child = run(bundle, env, tmp);
      const code = await waitExit(child, 15_000);
      check(code !== null && code !== 0 && expected.test(child.output()), `refuses to start ${what} (exit ${code})`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  if (failures.length) {
    console.error(`\n✗ Smoke test failed: ${failures.length} check(s).`);
    process.exit(1);
  }
  console.log('\n✓ Smoke test passed (temp data removed).');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function run(bundle, env, cwd) {
  const child = spawn(process.execPath, [bundle], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.output = () => output;
  return child;
}

function exited(child) { return child.exitCode !== null || child.signalCode !== null; }

/** The exit code; null when it was killed by a signal or did not exit in time (then it is killed). */
function waitExit(child, timeoutMs) {
  if (exited(child)) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function stop(child) {
  if (exited(child)) return;
  child.kill('SIGTERM'); // a graceful shutdown on Linux/macOS; Windows has no signals and ends it at once
  await waitExit(child, 12_000);
}
