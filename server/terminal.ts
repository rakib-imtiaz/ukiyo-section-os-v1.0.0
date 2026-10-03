// Integrated PTY terminal over WebSocket — LOCAL OPERATOR TOOL.
// Spawns a real system shell (ConPTY on Windows) in the project directory and
// bridges it to an xterm.js client. This is a full shell: it can run any command
// on this machine. Therefore it is:
//   1. Disabled in production (config.terminal.enabled defaults off when NODE_ENV=production).
//   2. Localhost-only — connections whose Host/Origin isn't a loopback address are rejected.
// Never expose the server port publicly with this enabled.
import { existsSync, statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IPty } from 'node-pty';
import { loadPty } from './platform/pty';
import { config } from './config';
import { addWsRoute } from './ws-hub';

// Client → server control messages.
type ClientMessage =
  | { type: 'in'; data: string }
  | { type: 'resize'; cols: number; rows: number };

function defaultShell(): { file: string; args: string[] } {
  if (config.terminal.shell) return { file: config.terminal.shell, args: [] };
  if (process.platform === 'win32') return { file: process.env.COMSPEC?.includes('powershell') ? process.env.COMSPEC : 'powershell.exe', args: ['-NoLogo'] };
  // macOS/Linux: the user's login shell, started as a login shell so Homebrew/npm/~/.local/bin are on PATH.
  const fallback = process.platform === 'darwin' ? '/bin/zsh' : existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return { file: process.env.SHELL || fallback, args: ['-l'] };
}

/** Only loopback hosts may connect (defence-in-depth on top of the prod gate). */
function isLocalRequest(host: string | undefined, origin: string | undefined): boolean {
  const hostname = (value: string | undefined) => {
    if (!value) return null;
    try { return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase(); } catch { return null; }
  };
  const loop = (name: string | null) => name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]';
  const hostOk = loop(hostname(host));
  // Origin is absent for non-browser clients; when present it must also be loopback.
  const originOk = origin == null || loop(hostname(origin));
  return hostOk && originOk;
}

/**
 * Per-session working directory from the upgrade URL (`/terminal?cwd=<encoded abs path>`).
 * SECURITY: this hands a real shell its starting directory, so the requested path must
 * resolve INSIDE an allowed root — the factory workspace or this project — and must be an
 * existing directory. Anything else silently falls back to the default cwd (never errors
 * the socket): a bad path from the UI should still open a usable terminal.
 * `path.relative` on win32 compares case-insensitively, so drive-letter/case tricks don't escape.
 */
function resolveSessionCwd(requestUrl: string | undefined): string {
  const fallback = config.terminal.cwd;
  if (!requestUrl) return fallback;
  let requested: string | null;
  try { requested = new URL(requestUrl, 'http://localhost').searchParams.get('cwd'); } catch { return fallback; }
  if (!requested || !requested.trim()) return fallback;
  const resolved = path.resolve(requested.trim());
  const allowedRoots = [path.resolve(config.factory.workspaceRoot), path.resolve(config.terminal.cwd)];
  const inside = allowedRoots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!inside) return fallback;
  try { if (!statSync(resolved).isDirectory()) return fallback; } catch { return fallback; }
  return resolved;
}

// node-pty's Windows/ConPTY internals are unstable on a headless server (no attached
// console): they throw "AttachConsole failed" and "Cannot read properties of undefined
// (reading 'forEach')" (windowsPtyAgent, on spawn/exit console-process-list handling).
// The PTY's actual read/write works fine — only these internal bookkeeping paths blow
// up, and they surface as process-level uncaught errors that would kill the whole server.
// Swallow errors that originate inside node-pty; everything else still crashes loudly.
function isNodePtyError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  return /node[-_]pty|windowsPtyAgent|conpty|AttachConsole|GetConsoleProcessList/i.test(text);
}
let ptyGuardInstalled = false;
export function installPtyCrashGuard() {
  if (ptyGuardInstalled) return;
  ptyGuardInstalled = true;
  process.on('uncaughtException', (error: Error) => {
    if (isNodePtyError(error)) { console.warn('[terminal] ignored node-pty internal error:', error.message); return; }
    throw error; // not ours — restore default fatal behaviour
  });
  process.on('unhandledRejection', (reason) => {
    if (isNodePtyError(reason)) { console.warn('[terminal] ignored node-pty internal rejection'); return; }
    throw reason;
  });
}

export function attachTerminal() {
  if (!config.terminal.enabled) return;
  installPtyCrashGuard();
  const wss = new WebSocketServer({
    noServer: true,
    verifyClient: ({ req }, done) => {
      const ok = isLocalRequest(req.headers.host, req.headers.origin);
      done(ok, 403, 'Terminal is available on localhost only.');
    },
  });
  addWsRoute('/terminal', wss);

  wss.on('connection', async (socket: WebSocket, request: IncomingMessage) => {
    const { file, args } = defaultShell();
    const cwd = resolveSessionCwd(request.url);
    let term: IPty;
    try {
      term = (await loadPty()).spawn(file, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      });
    } catch (error) {
      socket.send(`\r\n\x1b[31mFailed to start shell: ${error instanceof Error ? error.message : 'unknown error'}\x1b[0m\r\n`);
      socket.close();
      return;
    }

    // PTY → client. Never touch term.process (its ConPTY console-list agent throws
    // AttachConsole on headless Windows); onData/write/resize are all we need.
    const onData = term.onData((data) => { if (socket.readyState === socket.OPEN) socket.send(data); });
    const onExit = term.onExit(({ exitCode }) => {
      if (socket.readyState === socket.OPEN) { socket.send(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`); socket.close(); }
    });

    socket.on('message', (raw) => {
      let message: ClientMessage;
      try { message = JSON.parse(raw.toString()) as ClientMessage; } catch { return; }
      if (message.type === 'in') { try { term.write(message.data); } catch { /* shell gone */ } }
      else if (message.type === 'resize' && message.cols > 0 && message.rows > 0) {
        try { term.resize(Math.min(500, message.cols | 0), Math.min(300, message.rows | 0)); } catch { /* shell gone */ }
      }
    });

    const cleanup = () => { onData.dispose(); onExit.dispose(); try { term.kill(); } catch { /* already dead */ } };
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    socket.send(`\x1b[90mConnected · ${file} · ${cwd}\x1b[0m\r\n`);
  });

  wss.on('error', () => { /* keep the http server alive if the ws layer errors */ });
  console.log(`Integrated terminal enabled at ws://localhost:${config.port}/terminal (${os.platform()}, localhost-only)`);
}
