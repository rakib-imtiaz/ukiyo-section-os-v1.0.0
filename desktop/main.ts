// ThemeBot desktop — Electron main process.
//
// The window is the same React UI as the web build. It is served by the ThemeBot server, which
// runs as a child process on a bundled Node.js runtime (see server-host.ts). This process owns
// only what a desktop app must: one instance, the window, native dialogs, the server's lifetime,
// and where everything lives on disk.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell, type MenuItemConstructorOptions } from 'electron';
import { ServerHost } from './server-host';
import { Licence, licenceConfigFrom } from './licence';
import { startAutoUpdates } from './updater';

const PREFERRED_PORT = 8797; // not 8787: that's the repo dev server's port
const isDev = !app.isPackaged;

// Dev runs keep their own data so they never touch an installed ThemeBot.
if (isDev) app.setPath('userData', path.join(app.getPath('appData'), 'ThemeBot-Dev'));
const userData = app.getPath('userData');
const logDir = path.join(userData, 'logs');

// One ThemeBot per computer: a second launch just focuses the open window (see 'second-instance').
// app.quit() is asynchronous and would let this copy carry on starting, so exit right away.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.exit(0);

// ---- small persisted host settings (port, window size) -------------------------------------------
interface HostSettings { port?: number; bounds?: { width: number; height: number; x?: number; y?: number }; maximized?: boolean }
const hostSettingsFile = path.join(userData, 'desktop-host.json');
function readHostSettings(): HostSettings {
  try { return JSON.parse(readFileSync(hostSettingsFile, 'utf8')) as HostSettings; } catch { return {}; }
}
function writeHostSettings(patch: HostSettings) {
  try { mkdirSync(userData, { recursive: true }); writeFileSync(hostSettingsFile, JSON.stringify({ ...readHostSettings(), ...patch }, null, 2)); } catch { /* not critical */ }
}

// ---- build-time settings (written into the app's package.json by scripts/desktop/build.mjs) ------
interface AppPackage { themebot?: { edition?: string; updateUrl?: string; licence?: { storeId?: number; productIds?: number[] } } }
const appPkg: AppPackage = (() => {
  try { return JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as AppPackage; } catch { return {}; }
})();

// ---- where the server and its runtime live --------------------------------------------------------
function edition(): 'customer' | 'internal' {
  if (process.env.THEMEBOT_EDITION === 'customer' || process.env.THEMEBOT_EDITION === 'internal') return process.env.THEMEBOT_EDITION;
  if (isDev) return 'internal';
  return appPkg.themebot?.edition === 'internal' ? 'internal' : 'customer';
}

const licence = new Licence(userData, licenceConfigFrom(appPkg));

function serverLaunch() {
  if (isDev) {
    // build/desktop-app → repo root. Runs the TypeScript server straight from the repo.
    const repo = path.resolve(app.getAppPath(), '../..');
    return { command: process.env.THEMEBOT_DEV_NODE || 'node', args: ['--import', 'tsx', path.join(repo, 'server/index.ts')], resources: repo, runtimeBin: null as string | null, cwd: repo };
  }
  const resources = process.resourcesPath;
  const runtime = path.join(resources, 'runtime');
  const runtimeBin = process.platform === 'win32' ? runtime : path.join(runtime, 'bin');
  const node = path.join(runtimeBin, process.platform === 'win32' ? 'node.exe' : 'node');
  return { command: node, args: [path.join(resources, 'server', 'server.mjs')], resources, runtimeBin, cwd: userData };
}

/**
 * Apps opened from the Dock/Finder (and some Linux launchers) get a bare PATH without Homebrew,
 * npm or ~/.local/bin — so `claude` and friends wouldn't be found. Ask the user's login shell.
 */
function loginShellPath(): string | null {
  if (process.platform === 'win32') return null;
  const shellBin = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const output = execFileSync(shellBin, ['-ilc', 'printf "__TB__%s__TB__" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return /__TB__(.*)__TB__/s.exec(output)?.[1] || null;
  } catch { return null; }
}

function serverEnv(resources: string, runtimeBin: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_ENV; // desktop mode, not production
  delete env.NODE_OPTIONS; // a user's own Node flags must not change how the bundled server runs
  const shellPath = loginShellPath();
  const basePath = shellPath || env.PATH || env.Path || '';
  const homeBin = path.join(app.getPath('home'), '.local', 'bin'); // where Claude Code's installer puts `claude`
  const parts = [runtimeBin, ...basePath.split(path.delimiter), homeBin].filter((part): part is string => Boolean(part));
  const joined = [...new Set(parts)].join(path.delimiter);
  delete env.Path; env.PATH = joined;
  const area = screen.getPrimaryDisplay().workArea;
  return {
    ...env,
    THEMEBOT_DESKTOP: '1',
    THEMEBOT_EDITION: edition(),
    THEMEBOT_RESOURCES: resources,
    THEMEBOT_DATA_DIR: userData,
    THEMEBOT_SCREEN_WORKAREA: JSON.stringify(area),
  };
}

// ---- window ---------------------------------------------------------------------------------------
let mainWindow: BrowserWindow | null = null;
let host: ServerHost | null = null;
let serverOrigin = '';

const loadingPage = (error?: string) => {
  const file = path.join(app.getAppPath(), 'loading.html');
  return error ? { file, query: { error } } : { file };
};

function createWindow() {
  const saved = readHostSettings();
  const win = new BrowserWindow({
    width: saved.bounds?.width ?? 1440, height: saved.bounds?.height ?? 900,
    x: saved.bounds?.x, y: saved.bounds?.y,
    minWidth: 1024, minHeight: 680,
    show: false, title: 'ThemeBot', autoHideMenuBar: true,
    backgroundColor: '#f4f6fb',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
    },
  });
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // Links to anything but our own server open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (serverOrigin && url.startsWith(serverOrigin)) return;
    if (url.startsWith('file:')) return; // the loading page
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  const remember = () => {
    if (win.isDestroyed()) return;
    writeHostSettings({ maximized: win.isMaximized(), ...(win.isMaximized() || win.isMinimized() ? {} : { bounds: win.getBounds() }) });
  };
  win.on('close', remember);
  // Closing while builds run pauses them (they resume on the next launch) — say so first.
  let closeConfirmed = false;
  win.on('close', (event) => {
    if (closeConfirmed || !serverOrigin || !host?.running) return;
    event.preventDefault();
    void runningBuilds().then(async (count) => {
      if (count > 0) {
        const choice = await dialog.showMessageBox(win, {
          type: 'warning', buttons: ['Keep working', 'Quit and pause'], defaultId: 0, cancelId: 0,
          title: 'Builds are running', message: count === 1 ? 'A build is still running.' : `${count} builds are still running.`,
          detail: 'Quitting pauses them. They pick up where they stopped the next time you open ThemeBot.',
        });
        if (choice.response !== 1) return;
      }
      closeConfirmed = true;
      win.close();
    });
  });
  win.on('closed', () => { mainWindow = null; });

  const page = loadingPage();
  void win.loadFile(page.file);
  return win;
}

function showLicence(reason: string) {
  if (!mainWindow) return;
  void mainWindow.loadFile(path.join(app.getAppPath(), 'licence.html'), { query: { reason } });
}

/** Licence first (when this build requires one), then the server, then the app. */
async function openApp() {
  const state = await licence.check();
  if (!state.ok) { await host?.stop(); showLicence(state.reason); return; }
  if (host?.running) { await mainWindow?.loadURL(`${serverOrigin}/`); return; }
  if (mainWindow) await mainWindow.loadFile(loadingPage().file);
  try { await startServer(); } catch (error) { showError(error instanceof Error ? error.message : String(error)); }
}

function showError(message: string) {
  if (!mainWindow) return;
  const page = loadingPage(message);
  void mainWindow.loadFile(page.file, { query: page.query });
}

// ---- server lifetime ------------------------------------------------------------------------------
/** How many builds the server is running right now (0 if it can't be asked). */
async function runningBuilds(): Promise<number> {
  try {
    const response = await fetch(`${serverOrigin}/api/factory/settings`, { signal: AbortSignal.timeout(3000) });
    const data = await response.json() as { scheduler?: { running?: unknown[] } };
    return Array.isArray(data.scheduler?.running) ? data.scheduler.running.length : 0;
  } catch { return 0; }
}

const crashTimes: number[] = [];

async function startServer() {
  const launch = serverLaunch();
  host = new ServerHost({
    command: launch.command, args: launch.args,
    cwd: launch.cwd, env: serverEnv(launch.resources, launch.runtimeBin),
    logDir, preferredPort: readHostSettings().port ?? PREFERRED_PORT,
    onExit: (code) => void onServerCrash(code),
  });
  const port = await host.start();
  writeHostSettings({ port });
  serverOrigin = `http://127.0.0.1:${port}`;
  await mainWindow?.loadURL(`${serverOrigin}/`);
}

async function onServerCrash(code: number | null) {
  const now = Date.now();
  crashTimes.push(now);
  while (crashTimes.length && now - crashTimes[0] > 120_000) crashTimes.shift();
  if (crashTimes.length > 3) { showError(`ThemeBot's engine stopped repeatedly (exit code ${code}).\nOpen Help → Logs folder and send server.log to support.`); return; }
  showError('ThemeBot\'s engine stopped unexpectedly. Restarting…');
  try { await startServer(); } catch (error) { showError(error instanceof Error ? error.message : String(error)); }
}

// ---- native bridges -------------------------------------------------------------------------------
ipcMain.handle('themebot:version', () => app.getVersion());
ipcMain.handle('themebot:pick-folder', async (_event, defaultPath?: unknown) => {
  const options = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>, defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
});
ipcMain.handle('themebot:activate-licence', async (_event, key: unknown) => {
  const state = await licence.activate(typeof key === 'string' ? key : '');
  if (state.ok) void openApp();
  return state;
});
ipcMain.handle('themebot:open-path', async (_event, target: unknown) => {
  if (typeof target !== 'string' || !path.isAbsolute(target) || !existsSync(target)) return 'That folder does not exist.';
  return shell.openPath(target);
});

async function releaseLicence() {
  const options = { type: 'question' as const, buttons: ['Cancel', 'Deactivate'], defaultId: 0, cancelId: 0, title: 'Move licence', message: 'Deactivate ThemeBot on this computer?', detail: 'This frees the seat so you can activate the same key on another computer. ThemeBot closes its builds here first.' };
  const choice = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  if (choice.response !== 1) return;
  await licence.deactivate();
  await host?.stop();
  showLicence('Licence removed from this computer. Enter a key to use ThemeBot here again.');
}

function buildMenu() {
  const internal = edition() === 'internal';
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ...(internal || isDev ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : []),
    ] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [
      { label: 'Logs folder', click: () => { mkdirSync(logDir, { recursive: true }); void shell.openPath(logDir); } },
      { label: 'Data folder', click: () => void shell.openPath(userData) },
      ...(licence.required ? [{ type: 'separator' as const }, { label: 'Move licence to another computer…', click: () => void releaseLicence() }] : []),
    ] },
  ];
  return Menu.buildFromTemplate(template);
}

// ---- app lifecycle --------------------------------------------------------------------------------
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

if (isPrimaryInstance) app.whenReady().then(async () => {
  // The UI needs no device permissions.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  Menu.setApplicationMenu(buildMenu());
  mainWindow = createWindow();
  await openApp();
  startAutoUpdates(appPkg.themebot?.updateUrl, () => mainWindow, (line) => {
    try { mkdirSync(logDir, { recursive: true }); writeFileSync(path.join(logDir, 'updates.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' }); } catch { /* not critical */ }
  });
  // Long-running sessions re-check the licence once a day (online at most weekly — see licence.ts).
  setInterval(() => { void licence.check().then((state) => { if (!state.ok) void openApp(); }); }, 24 * 60 * 60 * 1000).unref();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length) return;
    mainWindow = createWindow();
    if (serverOrigin) void mainWindow.loadURL(`${serverOrigin}/`);
  });
}).catch((error) => { dialog.showErrorBox('ThemeBot could not start', String(error)); app.exit(1); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Let the server pause running builds and save its state before the app exits.
let serverStopped = false;
app.on('before-quit', (event) => {
  if (serverStopped || !host?.running) return;
  event.preventDefault();
  void host.stop().finally(() => { serverStopped = true; app.quit(); });
});
