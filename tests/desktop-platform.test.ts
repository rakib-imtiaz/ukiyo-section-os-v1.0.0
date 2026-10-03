import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeInstallCommand, defaultClaudePath, findClaudePath } from '../server/platform/claude-path';
import { killTree, ownProcessGroup } from '../server/platform/proc';
import { chromeProfileInUse } from '../server/window-placement';

describe('desktop platform helpers', () => {
  const saved = process.env.FACTORY_CLAUDE_PATH;
  afterEach(() => { if (saved === undefined) delete process.env.FACTORY_CLAUDE_PATH; else process.env.FACTORY_CLAUDE_PATH = saved; });

  it('an explicit FACTORY_CLAUDE_PATH always wins', () => {
    process.env.FACTORY_CLAUDE_PATH = '/custom/claude';
    expect(findClaudePath()).toBe('/custom/claude');
  });

  it('falls back to the native installer location with the right file name per OS', () => {
    expect(defaultClaudePath).toMatch(process.platform === 'win32' ? /\.local[\\/]bin[\\/]claude\.exe$/ : /\.local\/bin\/claude$/);
    expect(claudeInstallCommand()).toMatch(process.platform === 'win32' ? /install\.ps1/ : /install\.sh/);
  });

  it('a Chrome profile folder without a lock is not in use', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tb-profile-'));
    try {
      expect(chromeProfileInUse(dir)).toBe(false);
      if (process.platform === 'win32') {
        writeFileSync(path.join(dir, 'lockfile'), ''); // stale lock left by a crash: cleared, not "in use"
        expect(chromeProfileInUse(dir)).toBe(false);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('killTree stops a running child and ignores one that already exited', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: ownProcessGroup, stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 200));
    killTree(child);
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(() => killTree(child)).not.toThrow();
  });
});
