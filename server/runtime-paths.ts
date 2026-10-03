// Where ThemeBot finds its bundled resources and keeps its own data.
//
// Run from the repo (dev, tests): resources sit next to server/, data lives in ~/.themebot.
// Run from the desktop app: the Electron host sets THEMEBOT_RESOURCES to the app's resources
// folder (templates/, migrations/, dist/, node_modules/ for Playwright) and THEMEBOT_DATA_DIR
// to the per-user app-data folder. Nothing here may depend on process.cwd() — a packaged app
// can be launched from anywhere (Finder starts it in "/").
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));

export const desktop = process.env.THEMEBOT_DESKTOP === '1';

export const resourceRoot = process.env.THEMEBOT_RESOURCES?.trim()
  ? path.resolve(process.env.THEMEBOT_RESOURCES.trim())
  : path.resolve(serverDir, '..');

export const dataRoot = process.env.THEMEBOT_DATA_DIR?.trim()
  ? path.resolve(process.env.THEMEBOT_DATA_DIR.trim())
  : path.join(homedir(), '.themebot');

export function resourcePath(...parts: string[]) {
  return path.join(resourceRoot, ...parts);
}

/** Settings the desktop app keeps outside the builds folder (the builds folder itself lives here). */
export const desktopSettingsFile = path.join(dataRoot, 'desktop-settings.json');

export interface DesktopSettings { workspaceRoot?: string }

export function readDesktopSettings(): DesktopSettings {
  try {
    if (!existsSync(desktopSettingsFile)) return {};
    const parsed = JSON.parse(readFileSync(desktopSettingsFile, 'utf8')) as DesktopSettings;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
