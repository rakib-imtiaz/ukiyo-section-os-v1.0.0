// Finds the Claude Code CLI on Windows, macOS and Linux.
//
// Claude Code's own installer puts the binary in ~/.local/bin (claude.exe on Windows). People who
// installed it another way (Homebrew, a package manager, an older npm install) have it elsewhere
// on PATH. An explicit FACTORY_CLAUDE_PATH always wins.
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';

function runnable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function onPath(): string | null {
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (runnable(candidate)) return candidate;
  }
  return null;
}

/** Where ThemeBot expects Claude Code when nothing is installed yet (shown in "not found" messages). */
export const defaultClaudePath = path.join(homedir(), '.local', 'bin', exe);

export function findClaudePath(): string {
  const explicit = process.env.FACTORY_CLAUDE_PATH?.trim();
  if (explicit) return explicit;
  const candidates = [
    defaultClaudePath,
    path.join(homedir(), '.claude', 'local', exe), // older "local" installs
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'] : []),
    ...(process.platform === 'linux' ? ['/usr/local/bin/claude', '/usr/bin/claude'] : []),
  ];
  for (const candidate of candidates) if (runnable(candidate)) return candidate;
  return onPath() ?? defaultClaudePath;
}

/** The official one-line installer for this OS (shown when Claude Code is missing). */
export function claudeInstallCommand(): string {
  return process.platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash';
}
