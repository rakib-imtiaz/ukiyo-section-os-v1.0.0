// Packages build/ into installers for the current OS with electron-builder (see electron-builder.yml).
// When THEMEBOT_UPDATE_URL is set, the installers also get update metadata (latest*.yml) pointing
// at that address. Nothing is ever uploaded from here: publishing a release is a separate step.
// Electron fuses are flipped by electron-builder (electronFuses in the yml); afterwards this script
// reads them back from the packaged executable and fails if any is not as required.
// Usage: node scripts/desktop/pack.mjs [--dir]   (--dir: unpacked app only, no installer)
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { build, Platform } from 'electron-builder';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const updateUrl = process.env.THEMEBOT_UPDATE_URL?.trim();
const release = path.join(root, 'release');

await build({
  projectDir: root,
  publish: 'never',
  config: {
    extends: path.join(root, 'electron-builder.yml'),
    ...(updateUrl ? { publish: [{ provider: 'generic', url: updateUrl }] } : {}),
  },
  ...(process.argv.includes('--dir') ? { targets: Platform.current().createTarget('dir') } : {}),
});

// ---- fuse check ------------------------------------------------------------------------------
const ENABLE = 49; // '1' in the fuse wire
const DISABLE = 48; // '0'
const REQUIRED = {
  [FuseV1Options.RunAsNode]: DISABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: DISABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: ENABLE,
  [FuseV1Options.OnlyLoadAppFromAsar]: ENABLE,
};

/** The packaged executables electron-builder just produced (unpacked dirs only). */
function packagedExecutables() {
  const found = [];
  if (!existsSync(release)) return found;
  for (const entry of readdirSync(release, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(release, entry.name);
    if (/^win.*-unpacked$/.test(entry.name)) found.push(path.join(dir, 'ThemeBot.exe'));
    else if (/^mac/.test(entry.name)) found.push(...readdirSync(dir).filter((name) => name.endsWith('.app')).map((name) => path.join(dir, name)));
    else if (/^linux.*-unpacked$/.test(entry.name)) found.push(...readdirSync(dir).filter((name) => /^themebot(-desktop)?$/i.test(name)).map((name) => path.join(dir, name)));
  }
  return found.filter((file) => existsSync(file));
}

const executables = packagedExecutables();
if (!executables.length) throw new Error('Fuse check: no packaged ThemeBot executable found under release/.');
for (const executable of executables) {
  const wire = await getCurrentFuseWire(executable);
  const wrong = Object.entries(REQUIRED).filter(([fuse, want]) => wire[fuse] !== want).map(([fuse]) => FuseV1Options[fuse]);
  if (wrong.length) throw new Error(`Fuse check failed for ${path.relative(root, executable)}: ${wrong.join(', ')} not set as required.`);
  console.log(`✓ Fuses locked in ${path.relative(root, executable)} (RunAsNode, NODE_OPTIONS, --inspect off; asar-only with integrity check)`);
}
console.log(`\n✓ Installers in release/${updateUrl ? ` (update metadata for ${updateUrl})` : ' (no update address set — auto-update off)'}`);
