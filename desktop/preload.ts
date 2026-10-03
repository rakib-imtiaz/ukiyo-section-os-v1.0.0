// The only bridge between the ThemeBot window and the desktop app. The page runs sandboxed with
// no Node access; it can ask for these few native things and nothing else.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('themebotDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: (): Promise<string> => ipcRenderer.invoke('themebot:version'),
  /** Native folder picker; resolves to the chosen absolute path or null. */
  pickFolder: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('themebot:pick-folder', defaultPath),
  /** Opens a folder in Explorer / Finder / the Linux file manager. */
  openPath: (target: string): Promise<string> => ipcRenderer.invoke('themebot:open-path', target),
  /** Licence screen: activates a key on this computer. */
  activateLicence: (key: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('themebot:activate-licence', key),
});
