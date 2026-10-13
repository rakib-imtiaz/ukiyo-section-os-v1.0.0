// The only bridge between the ThemeBot window and the desktop app. The page runs sandboxed with
// no Node access; it can ask for these few native things and nothing else.
import { contextBridge, ipcRenderer } from 'electron';

/** What the sign-in calls resolve to; on failure `message` is ready to show as-is. */
type SigninResult = { ok: true } | { ok: false; code: string; message: string; devices?: Array<{ name: string; platform: string; lastSeen: string | null }> };

contextBridge.exposeInMainWorld('themebotDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: (): Promise<string> => ipcRenderer.invoke('themebot:version'),
  /** Native folder picker; resolves to the chosen absolute path or null. */
  pickFolder: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('themebot:pick-folder', defaultPath),
  /** Opens a folder in Explorer / Finder / the Linux file manager. */
  openPath: (target: string): Promise<string> => ipcRenderer.invoke('themebot:open-path', target),
  /** Sign-in screen: emails a 6-digit sign-in code. */
  signinStart: (email: string): Promise<SigninResult> => ipcRenderer.invoke('themebot:signin-start', email),
  /** Sign-in screen: checks the code; on success the window moves on to ThemeBot by itself. */
  signinVerify: (email: string, code: string): Promise<SigninResult> => ipcRenderer.invoke('themebot:signin-verify', email, code),
  /** Sign-in / update screens: try opening ThemeBot again (signed out elsewhere, renewed, updated). */
  signinRetry: (): Promise<void> => ipcRenderer.invoke('themebot:signin-retry'),
  /** Update screen: starts downloading the latest version; false when this build can't self-update. */
  checkForUpdates: (): Promise<boolean> => ipcRenderer.invoke('themebot:check-updates'),
});
