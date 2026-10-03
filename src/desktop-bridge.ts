// The desktop app (Electron) exposes a few native helpers to the page through its preload script
// (desktop/preload.ts). In a normal browser this is null and the UI falls back to its web versions.
export interface ThemebotDesktop {
  isDesktop: true;
  platform: string;
  version(): Promise<string>;
  /** Native folder picker; resolves to the chosen absolute path or null when cancelled. */
  pickFolder(defaultPath?: string): Promise<string | null>;
  /** Opens a folder in Explorer / Finder / the file manager; resolves to '' on success. */
  openPath(target: string): Promise<string>;
}

export const desktopBridge: ThemebotDesktop | null =
  typeof window !== 'undefined' ? (window as unknown as { themebotDesktop?: ThemebotDesktop }).themebotDesktop ?? null : null;
