// Stopping a child process AND everything it started (Claude's tool commands, npm → vite, the
// Chromium a QA script launched), on every OS.
//
// Windows: `taskkill /T` walks the tree.
// macOS/Linux: a plain kill only reaches the direct child and orphans the rest (still holding
// ports and CPU). Children that must be stoppable are started as the leader of their own process
// group (`detached: ownProcessGroup`), so the whole group can be signalled at once: SIGTERM first
// so they can save state, SIGKILL for anything still alive a few seconds later.
import { spawn, type ChildProcess } from 'node:child_process';

/** Spread into spawn options for any child that killTree may need to stop. */
export const ownProcessGroup = process.platform !== 'win32';

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-pid, signal); return true; } catch { return false; }
}

export function killTree(child: ChildProcess | null | undefined) {
  if (!child || child.pid == null || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true });
    return;
  }
  if (!signalGroup(pid, 'SIGTERM')) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
  // The leader may exit at once while its descendants linger — always sweep the group.
  setTimeout(() => {
    if (!signalGroup(pid, 'SIGKILL') && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }, 3000).unref();
}
