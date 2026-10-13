// Automatic updates for the installed app (electron-updater).
//
// New versions are downloaded quietly in the background and installed on the next restart; the
// user can restart right away from a prompt. Running builds are paused by the normal quit flow
// and carry on after the restart. Only active when the build was given an update address
// (THEMEBOT_UPDATE_URL at build time) — dev runs and unconfigured builds never check.
import { app, dialog, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

let configured = false;
let logLine: (line: string) => void = () => {};

export function startAutoUpdates(feedUrl: string | undefined, window: () => BrowserWindow | null, log: (line: string) => void) {
  if (!feedUrl || !app.isPackaged) return;
  configured = true;
  logLine = log;
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m: unknown) => log(`[update] ${String(m)}`), warn: (m: unknown) => log(`[update] ${String(m)}`), error: (m: unknown) => log(`[update] ${String(m)}`), debug: () => {} };

  let prompted = false;
  autoUpdater.on('update-downloaded', async (info) => {
    if (prompted) return;
    prompted = true;
    const options = {
      type: 'info' as const, buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Update ready', message: `ThemeBot ${info.version} is ready to install.`,
      detail: 'Restart to finish updating. Running builds pause and pick up again after the restart. If you choose Later, it installs the next time ThemeBot closes.',
    };
    const win = window();
    const choice = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (choice.response === 0) autoUpdater.quitAndInstall();
  });

  const check = () => { autoUpdater.checkForUpdates().catch((error: unknown) => log(`[update] check failed: ${String(error)}`)); };
  setTimeout(check, 30_000).unref(); // after startup settles
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

/**
 * Checks for an update right away (the "Update required" screen). The download and the restart
 * prompt follow the normal flow above. False when this build has no update address.
 */
export function checkForUpdatesNow(): boolean {
  if (!configured) return false;
  autoUpdater.checkForUpdates().catch((error: unknown) => logLine(`[update] check failed: ${String(error)}`));
  return true;
}
