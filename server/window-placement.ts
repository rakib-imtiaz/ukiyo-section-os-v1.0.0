// Where ThemeBot's own Chrome windows open: centred on the main screen instead of wherever Chrome
// last left them. Read once per server run (the screen rarely changes mid-session).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let area: { x: number; y: number; width: number; height: number } | null | undefined;

function workArea() {
  if (area !== undefined) return area;
  area = null;
  if (process.platform !== 'win32') return area;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $w=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; "$($w.X) $($w.Y) $($w.Width) $($w.Height)"'],
    { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const [x, y, width, height] = out.trim().split(/\s+/).map(Number);
    if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) area = { x, y, width, height };
  } catch { /* leave it to Chrome */ }
  return area;
}

/** Chrome flags that open a window of this size in the middle of the main screen
 *  (clamped to the screen). Empty when the screen size can't be read. */
export function centeredWindowArgs(width = 1300, height = 1000): string[] {
  const screen = workArea();
  if (!screen) return [];
  const w = Math.min(width, screen.width - 40);
  const h = Math.min(height, screen.height - 40);
  const left = screen.x + Math.round((screen.width - w) / 2);
  const top = screen.y + Math.round((screen.height - h) / 2);
  return [`--window-position=${left},${top}`, `--window-size=${w},${h}`];
}

/** Make ThemeBot's own Chrome profile open a clean window: no tabs brought back from last time
 *  (a force-closed or crashed window otherwise restores them). Skipped while that Chrome is
 *  running — it holds its lockfile, and a new window then joins the running instance anyway. */
export function prepareFreshWindow(userDataDir: string): void {
  try {
    if (existsSync(path.join(userDataDir, 'lockfile'))) rmSync(path.join(userDataDir, 'lockfile'));   // throws while Chrome runs
  } catch { return; }
  let profiles = ['Default'];
  try {
    const state = JSON.parse(readFileSync(path.join(userDataDir, 'Local State'), 'utf8')) as { profile?: { info_cache?: Record<string, unknown> } };
    profiles = Object.keys(state.profile?.info_cache ?? {}).concat('Default');
  } catch { /* first run */ }
  for (const profile of new Set(profiles)) {
    const dir = path.join(userDataDir, profile);
    if (!existsSync(dir)) continue;
    try { rmSync(path.join(dir, 'Sessions'), { recursive: true, force: true }); } catch { /* in use */ }
    try {
      const file = path.join(dir, 'Preferences');
      const prefs = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
      prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 5 };   // 5 = open the New Tab page
      prefs.profile = { ...(prefs.profile ?? {}), exit_type: 'Normal', exited_cleanly: true };
      writeFileSync(file, JSON.stringify(prefs));
    } catch { /* no prefs yet */ }
  }
}
