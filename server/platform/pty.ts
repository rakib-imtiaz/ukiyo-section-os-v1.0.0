// node-pty is a native module. It is loaded on first use (terminal session, in-app `claude login`)
// instead of at startup, so a machine without a working binary for it still runs ThemeBot —
// only those two features report an error.
import type * as NodePty from 'node-pty';

let loaded: typeof NodePty | null = null;

export async function loadPty(): Promise<typeof NodePty> {
  if (loaded) return loaded;
  const mod = (await import('node-pty')) as typeof NodePty & { default?: typeof NodePty };
  loaded = mod.default ?? mod;
  return loaded;
}
