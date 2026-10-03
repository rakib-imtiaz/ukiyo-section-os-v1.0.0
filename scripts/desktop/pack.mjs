// Packages build/ into installers for the current OS with electron-builder (see electron-builder.yml).
// When THEMEBOT_UPDATE_URL is set, the installers also get update metadata (latest*.yml) pointing
// at that address. Nothing is ever uploaded from here: publishing a release is a separate step.
// Usage: node scripts/desktop/pack.mjs [--dir]   (--dir: unpacked app only, no installer)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform } from 'electron-builder';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const updateUrl = process.env.THEMEBOT_UPDATE_URL?.trim();

await build({
  projectDir: root,
  publish: 'never',
  config: {
    extends: path.join(root, 'electron-builder.yml'),
    ...(updateUrl ? { publish: [{ provider: 'generic', url: updateUrl }] } : {}),
  },
  ...(process.argv.includes('--dir') ? { targets: Platform.current().createTarget('dir') } : {}),
});
console.log(`\n✓ Installers in release/${updateUrl ? ` (update metadata for ${updateUrl})` : ' (no update address set — auto-update off)'}`);
