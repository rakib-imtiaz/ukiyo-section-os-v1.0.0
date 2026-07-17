import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import type { FactoryJobRecord } from '../db';
import type { RunResult } from './types';

const SECRET_PATTERNS = [/shpat_[a-zA-Z0-9]+/g, /shpss_[a-zA-Z0-9]+/g, /shpca_[a-zA-Z0-9]+/g, /vso_live_[a-zA-Z0-9]+/g, /sk-ant-[\w-]+/g];
// Narrowly scoped so ordinary prose like "respects rate limits" does not false-positive:
// require an explicit limit/quota-exceeded phrasing or a 429 status token.
const USAGE_LIMIT_PATTERNS = [/usage limit (reached|exceeded|hit)/i, /rate limit (reached|exceeded|hit)/i, /\b(429|too many requests)\b/i, /overloaded_error/i, /quota exceeded/i];

export function scrubSecrets(text: string) {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, (match) => `${match.slice(0, 6)}***`), text);
}

// SECURITY: never spread process.env into spawned child processes. The Claude CLI is an
// LLM-driven process running semi-trusted instructions; inheriting the app's environment
// hands it (and anything it spawns) APP_ENCRYPTION_KEY, SESSION_SECRET, API_KEY_PEPPER,
// DATABASE_URL, and Shopify secrets. Build a minimal allowlisted env instead: the OS/tooling
// basics a Windows/node CLI needs, plus CLAUDE_*/ANTHROPIC_* so CLI auth/config still works.
const SPAWN_ENV_EXACT = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS', 'OS', 'USERNAME', 'USERDOMAIN',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'PLAYWRIGHT_BROWSERS_PATH', // non-secret; QA breaks on machines that relocate the browser cache without it
]);
const SPAWN_ENV_PREFIXES = ['PROCESSOR_', 'CLAUDE_', 'ANTHROPIC_'];
// Defense in depth: even if an allow rule ever matches one of these (e.g. a future
// CLAUDE_-prefixed secret), they must NEVER reach a child process.
const SPAWN_ENV_NEVER = new Set([
  'APP_ENCRYPTION_KEY', 'SESSION_SECRET', 'API_KEY_PEPPER', 'DATABASE_URL',
  'SHOPIFY_API_SECRET', 'SHOPIFY_ADMIN_ACCESS_TOKEN',
]);

/** Minimal allowlisted environment for factory child processes (+ per-spawn extras). */
export function buildSpawnEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    const upper = key.toUpperCase();
    if (SPAWN_ENV_NEVER.has(upper)) continue;
    if (SPAWN_ENV_EXACT.has(upper) || SPAWN_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!SPAWN_ENV_NEVER.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

async function fileExists(target: string) { return access(target).then(() => true, () => false); }

/** Delete stale completion signal files so a re-run isn't instantly re-settled by a prior run's file. */
export async function clearSignalFiles(paths: string[]) {
  await Promise.all(paths.map((target) => rm(target, { force: true }).catch(() => {})));
}

export interface RunTimeouts { inactivityMs?: number; wallClockMs?: number; }

export interface RunHandle { result: Promise<RunResult>; kill: (reason?: string) => void; logPath: string; }

interface RunSpec {
  cwd: string;
  args: string[];
  logPath: string;
  /** Absolute signal-file path -> outcome it maps to. First found wins. */
  signals: Record<string, RunResult['outcome']>;
  inactivityMs: number;
  wallClockMs: number;
  scrub: boolean;
}

function killTree(child: ChildProcess) {
  if (child.pid == null || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, env: buildSpawnEnv() });
  else child.kill('SIGKILL');
}

function run(spec: RunSpec): RunHandle {
  let child: ChildProcess;
  let log: WriteStream;
  let killedReason: string | null = null;
  let usageLimitSeen = false;

  const kill = (reason = 'killed') => { killedReason = reason; if (child) killTree(child); };

  const result = (async (): Promise<RunResult> => {
    await mkdir(path.dirname(spec.logPath), { recursive: true });
    log = createWriteStream(spec.logPath, { flags: 'a' });
    // Never let a late write-after-end or disk error become an uncaught exception mid-fleet.
    let logClosed = false;
    log.on('error', () => {});
    const writeLog = (text: string) => { if (!logClosed) { try { log.write(text); } catch { /* stream ended */ } } };
    writeLog(`\n[factory ${new Date().toISOString()}] spawn ${config.factory.claudePath} ${spec.args.join(' ')}\n`);

    try {
      child = spawn(config.factory.claudePath, spec.args, { cwd: spec.cwd, shell: false, windowsHide: true, env: buildSpawnEnv({ CLAUDE_FACTORY_JOB: '1' }) });
    } catch (error) {
      logClosed = true; log.end();
      return { outcome: 'spawn_error', exitCode: null, detail: error instanceof Error ? error.message : 'spawn failed' };
    }

    let lastActivity = Date.now();
    const onData = (chunk: Buffer) => {
      lastActivity = Date.now();
      const text = chunk.toString('utf8');
      if (USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) usageLimitSeen = true;
      writeLog(spec.scrub ? scrubSecrets(text) : text);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const startedAt = Date.now();
    const signalPaths = Object.keys(spec.signals);

    const findSignal = async () => {
      for (const signalPath of signalPaths) if (await fileExists(signalPath)) return signalPath;
      return null;
    };

    const outcome = await new Promise<RunResult>((resolve) => {
      let settled = false;
      const settle = (value: RunResult) => { if (!settled) { settled = true; clearInterval(poller); clearInterval(watchdog); resolve(value); } };

      // ENOENT / EACCES (e.g. claude.exe missing or moved) arrives as an async 'error'
      // event, NOT a throw and NOT an 'exit' — settle fast with an actionable detail
      // instead of hanging until the inactivity watchdog fires.
      child.on('error', (error) => {
        const failedSpawn = (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'EACCES';
        writeLog(`\n[factory] process error: ${error.message}\n`);
        if (failedSpawn) settle({ outcome: 'spawn_error', exitCode: null, detail: `Cannot launch ${config.factory.claudePath}: ${error.message}` });
      });

      const poller = setInterval(() => {
        void (async () => {
          const found = await findSignal();
          if (found) { killTree(child); settle({ outcome: spec.signals[found], exitCode: child.exitCode, signalFile: found }); }
        })();
      }, 5_000);

      const watchdog = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        if (elapsed > spec.wallClockMs) { kill('timeout'); settle({ outcome: 'timeout', exitCode: child.exitCode, detail: `wall-clock cap ${Math.round(spec.wallClockMs / 60000)}m exceeded` }); return; }
        if (Date.now() - lastActivity > spec.inactivityMs) { kill('inactivity'); settle({ outcome: 'inactivity', exitCode: child.exitCode, detail: `no CLI activity for ${Math.round(spec.inactivityMs / 60000)}m` }); }
      }, 60_000);

      child.on('exit', (code) => {
        void (async () => {
          // Grace window: the CLI may have written the signal file just before exiting.
          for (let attempt = 0; attempt < 4; attempt++) {
            const found = await findSignal();
            if (found) { settle({ outcome: spec.signals[found], exitCode: code, signalFile: found }); return; }
            await new Promise((wait) => setTimeout(wait, 4_000));
          }
          if (killedReason) { settle({ outcome: killedReason === 'timeout' ? 'timeout' : killedReason === 'inactivity' ? 'inactivity' : 'killed', exitCode: code }); return; }
          if (usageLimitSeen) { settle({ outcome: 'usage_limit', exitCode: code, detail: 'CLI output mentioned a usage/rate limit' }); return; }
          settle({ outcome: 'exit', exitCode: code });
        })();
      });
    });

    // Let any final buffered stdout flush, then stop writing before we end the stream.
    await new Promise((wait) => setTimeout(wait, 250));
    writeLog(`\n[factory ${new Date().toISOString()}] outcome=${outcome.outcome} exit=${outcome.exitCode ?? 'n/a'}${outcome.detail ? ` detail=${outcome.detail}` : ''}\n`);
    logClosed = true;
    log.end();
    return outcome;
  })();

  return { result, kill, logPath: spec.logPath };
}

/** Absolute clone signal-file paths (contract blockers to clear before a re-run). */
export function cloneBlockerSignals(job: FactoryJobRecord) {
  const reports = path.join(job.workspace_path, 'qa', 'reports');
  return [path.join(reports, 'BLOCKED.md'), path.join(reports, 'ABORTED.md')];
}

/** Spawn the initial headless clone-theme run. Completion = final.md | BLOCKED.md | ABORTED.md. */
export function spawnClone(job: FactoryJobRecord, scrub = true, timeouts: RunTimeouts = {}): RunHandle {
  const reports = path.join(job.workspace_path, 'qa', 'reports');
  return run({
    cwd: job.workspace_path,
    args: ['-p', '/clone-theme', '--model', 'opus'],
    logPath: path.join(job.workspace_path, 'factory', 'logs', 'clone-0.log'),
    signals: {
      [path.join(reports, 'final.md')]: 'final',
      [path.join(reports, 'BLOCKED.md')]: 'blocked',
      [path.join(reports, 'ABORTED.md')]: 'aborted',
    },
    inactivityMs: timeouts.inactivityMs ?? config.factory.inactivityTimeoutMin * 60_000,
    wallClockMs: timeouts.wallClockMs ?? config.factory.cloneTimeoutMin * 60_000,
    scrub,
  });
}

/** Spawn a fix session for one iteration. Completion = fix-complete-<iter>.md sentinel. */
export function spawnFix(job: FactoryJobRecord, iteration: number, scrub = true, timeouts: RunTimeouts = {}): RunHandle {
  const promptPath = path.join(job.workspace_path, 'factory', `fix-prompt-${iteration}.md`);
  return run({
    cwd: job.workspace_path,
    args: ['-p', `You are an autonomous fix session. Read the file at ${promptPath} and execute it exactly. Never wait for user input.`, '--model', 'opus'],
    logPath: path.join(job.workspace_path, 'factory', 'logs', `fix-${iteration}.log`),
    signals: { [path.join(job.workspace_path, 'qa', 'reports', `fix-complete-${iteration}.md`)]: 'sentinel' },
    inactivityMs: timeouts.inactivityMs ?? config.factory.inactivityTimeoutMin * 60_000,
    wallClockMs: timeouts.wallClockMs ?? config.factory.fixTimeoutMin * 60_000,
    scrub,
  });
}
