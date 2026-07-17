// Integrated PTY terminal over WebSocket — LOCAL OPERATOR TOOL.
// Spawns a real system shell (ConPTY on Windows) in the project directory and
// bridges it to an xterm.js client. This is a full shell: it can run any command
// on this machine. Therefore it is:
//   1. Disabled in production (config.terminal.enabled defaults off when NODE_ENV=production).
//   2. Localhost-only — connections whose Host/Origin isn't a loopback address are rejected.
// Never expose the server port publicly with this enabled.
import os from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import pty from 'node-pty';
import { config } from './config';
import { addWsRoute } from './ws-hub';

// Client → server control messages.
type ClientMessage =
  | { type: 'in'; data: string }
  | { type: 'resize'; cols: number; rows: number };

function defaultShell(): { file: string; args: string[] } {
  if (config.terminal.shell) return { file: config.terminal.shell, args: [] };
  if (process.platform === 'win32') return { file: process.env.COMSPEC?.includes('powershell') ? process.env.COMSPEC : 'powershell.exe', args: ['-NoLogo'] };
  return { file: process.env.SHELL || 'bash', args: [] };
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

  wss.on('connection', (socket: WebSocket) => {
    const { file, args } = defaultShell();
    let term: pty.IPty;
    try {
      term = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: config.terminal.cwd,
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

    socket.send(`\x1b[90mConnected · ${file} · ${config.terminal.cwd}\x1b[0m\r\n`);
  });

  wss.on('error', () => { /* keep the http server alive if the ws layer errors */ });
  console.log(`Integrated terminal enabled at ws://localhost:${config.port}/terminal (${os.platform()}, localhost-only)`);
}
