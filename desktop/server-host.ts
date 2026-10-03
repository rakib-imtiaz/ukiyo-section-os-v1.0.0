// Starts and supervises the ThemeBot server as a child process on the bundled Node runtime.
// The server is the same code that runs in dev; the host only decides where things live
// (resources, data, builds), which port it listens on, and restarts it if it crashes.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, type WriteStream } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface ServerHostOptions {
  /** Executable + leading args, e.g. [node] in the app or [node, --import, tsx] from the repo. */
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logDir: string;
  preferredPort: number;
  onExit?: (code: number | null) => void;
}

const PORT_IN_USE_EXIT = 98;

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/** The preferred port if free, else the next free one nearby (stable ports keep job files valid). */
export async function pickPort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 40; port += 1) if (await portIsFree(port)) return port;
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as net.AddressInfo).port; probe.close(() => resolve(port)); });
  });
}

function openLog(logDir: string): WriteStream {
  mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'server.log');
  try { if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`); } catch { /* keep logging */ }
  return createWriteStream(file, { flags: 'a' });
}

export class ServerHost {
  private child: ChildProcess | null = null;
  private log: WriteStream;
  private stopping = false;
  port = 0;

  constructor(private readonly options: ServerHostOptions) {
    this.log = openLog(options.logDir);
  }

  get running() { return Boolean(this.child && this.child.exitCode === null); }

  /** Starts the server and resolves with its port once it is listening. */
  async start(): Promise<number> {
    let port = await pickPort(this.options.preferredPort);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const outcome = await this.launch(port);
      if (outcome === 'ready') { this.port = port; return port; }
      if (outcome === 'port-in-use') { port = await pickPort(port + 1); continue; }
      throw new Error(outcome);
    }
    throw new Error('Could not find a free port for the ThemeBot server.');
  }

  private launch(port: number): Promise<'ready' | 'port-in-use' | string> {
    return new Promise((resolve) => {
      this.stopping = false;
      const env = { ...this.options.env, PORT: String(port), HOST: '127.0.0.1', APP_URL: `http://127.0.0.1:${port}` };
      this.log.write(`\n=== ${new Date().toISOString()} starting server on port ${port} ===\n`);
      const child = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd, env, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      this.child = child;
      child.stdout?.pipe(this.log, { end: false });
      child.stderr?.pipe(this.log, { end: false });
      let settled = false;
      const settle = (value: string) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => settle('The ThemeBot server did not start within 90 seconds. See logs/server.log.'), 90_000);
      child.on('message', (message) => { if ((message as { type?: string })?.type === 'ready') settle('ready'); });
      child.on('error', (error) => settle(`The ThemeBot server could not start: ${error.message}`));
      child.on('exit', (code) => {
        this.log.write(`=== server exited with code ${code} ===\n`);
        if (this.child === child) this.child = null;
        if (!settled) { settle(code === PORT_IN_USE_EXIT ? 'port-in-use' : `The ThemeBot server stopped while starting (exit code ${code}). See logs/server.log.`); return; }
        if (!this.stopping) this.options.onExit?.(code);
      });
    });
  }

  /** Asks the server to save state and stop; force-kills after the grace period. */
  async stop(graceMs = 20_000): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, graceMs);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.send({ type: 'shutdown' }); } catch { child.kill(); }
    });
  }
}
