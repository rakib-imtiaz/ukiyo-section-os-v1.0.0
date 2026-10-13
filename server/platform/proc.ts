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

/** Resolves once the tree has been told to stop (Windows: when taskkill has finished). */
export function killTree(child: ChildProcess | null | undefined): Promise<void> {
  if (!child || child.pid == null || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const pid = child.pid;
  if (process.platform === 'win32') {
    // stdio 'ignore': taskkill reports each kill on stdout. Piped back to a server that is shutting
    // down, a failed write would end taskkill midway — leaving the dev server and its children alive.
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(resolve, 5000);
      const done = () => { clearTimeout(timer); resolve(); };
      killer.once('exit', done);
      killer.once('error', done);
    });
  }
  if (!signalGroup(pid, 'SIGTERM')) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
  // The leader may exit at once while its descendants linger — always sweep the group.
  setTimeout(() => {
    if (!signalGroup(pid, 'SIGKILL') && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }, 3000).unref();
  return Promise.resolve();
}
