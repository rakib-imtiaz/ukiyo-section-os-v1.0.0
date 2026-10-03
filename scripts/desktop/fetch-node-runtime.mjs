// Downloads the official Node.js build (node + npm) that the desktop app bundles, so customers
// never need Node installed: the server, the QA scripts, `npm install` for intake and the AI's
// `node push.mjs` all run on it. Cached in build/runtime/<os>-<arch>/.
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const NODE_OS = { win32: 'win', darwin: 'darwin', linux: 'linux' };

export async function fetchNodeRuntime({ root, version, platform = process.platform, arch = process.arch }) {
  const os = NODE_OS[platform];
  if (!os) throw new Error(`No Node.js runtime for platform ${platform}.`);
  const target = path.join(root, 'build/runtime', `${platform}-${arch}`);
  const marker = path.join(target, `.node-v${version}`);
  if (existsSync(marker)) { console.log(`  Node v${version} already in ${path.relative(root, target)}`); return target; }

  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  const name = `node-v${version}-${os}-${arch}`;
  const url = `https://nodejs.org/dist/v${version}/${name}.${ext}`;
  const cache = path.join(root, 'build/runtime/.cache');
  await mkdir(cache, { recursive: true });
  const archive = path.join(cache, `${name}.${ext}`);
  if (!existsSync(archive)) {
    console.log(`  Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${archive}.part`));
    await rename(`${archive}.part`, archive);
  }

  await rm(target, { recursive: true, force: true });
  const scratch = path.join(cache, `${name}-extract`);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  // Windows 10+ ships bsdtar, which reads .zip (call it by full path: Git Bash's GNU tar can't);
  // macOS/Linux tar reads .tar.gz.
  const tar = platform === 'win32' && process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  execFileSync(tar, ['-xf', archive, '-C', scratch], { stdio: 'inherit' });
  const [inner] = await readdir(scratch);
  await rename(path.join(scratch, inner), target);
  await rm(scratch, { recursive: true, force: true });
  // Docs and headers aren't needed at runtime.
  for (const extra of ['include', 'share', 'README.md', 'CHANGELOG.md', 'install_tools.bat', 'nodevars.bat']) await rm(path.join(target, extra), { recursive: true, force: true });
  await writeFile(marker, url);
  console.log(`  Node v${version} → ${path.relative(root, target)}`);
  return target;
}
