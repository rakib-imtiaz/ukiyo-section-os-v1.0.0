import { spawn, type ChildProcess } from 'node:child_process';
import { engineCommand, recordLimit, recordUsage } from './engines';
import { createWriteStream, type WriteStream } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { config } from '../config';
import type { FactoryJobRecord } from '../db';
import type { BotModel, RunResult } from './types';

const SECRET_PATTERNS = [/shpat_[a-zA-Z0-9]+/g, /shpss_[a-zA-Z0-9]+/g, /shpca_[a-zA-Z0-9]+/g, /vso_live_[a-zA-Z0-9]+/g, /sk-ant-[\w-]+/g];
// Narrowly scoped so ordinary prose like "respects rate limits" does not false-positive:
// require an explicit limit/quota-exceeded phrasing or a 429 status token.
const USAGE_LIMIT_PATTERNS = [/usage limit (reached|exceeded|hit)/i, /\blimit reached\b/i, /rate[_ ]limit(_error| reached| exceeded| hit)/i, /too many requests/i, /overloaded_error/i, /quota exceeded/i];

/** Only the AI program's OWN errors count as a usage limit — never the pages, files and command
 *  output the build reads (those are full of "429"s and the word "limit"). In stream-json that means
 *  error results and top-level error fields; plain (non-JSON) lines are the program's own messages. */
function limitMessage(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let candidate: string | null = null;
  if (trimmed.startsWith('{')) {
    try {
      const message = JSON.parse(trimmed) as { type?: string; is_error?: boolean; result?: unknown; error?: unknown };
      if (message.type === 'result' && message.is_error) candidate = String(message.result ?? '');
      else if (typeof message.error === 'string') candidate = message.error;
      else if (message.error && typeof message.error === 'object') candidate = JSON.stringify(message.error);
    } catch { candidate = null; }   // a JSON line split across chunks — ignored, the next full line decides
  } else {
    candidate = trimmed;
  }
  return candidate && USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(candidate!)) ? candidate : null;
}

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
  /** Stream-json runs: readable activity events are appended here (one JSON object per line). */
  eventsPath?: string;
  /** Who this session belongs to, for the usage tracker. */
  usageTag?: { jobId: string; jobName: string; kind: string; model: string };
}

// --- Live activity -----------------------------------------------------------------------------
// Builds run with --output-format stream-json so (a) the build panel can show what the session is
// doing right now, and (b) the inactivity watchdog sees real progress — plain `-p` prints nothing
// until the very end, which made long builds look "stalled".
export type BuildEventKind = 'step' | 'cmd' | 'net' | 'out' | 'ok' | 'err' | 'info';
export interface BuildEvent { at: number; kind: BuildEventKind; text: string }
const STREAM_ARGS = ['--output-format', 'stream-json', '--verbose'];

const shortPath = (value: unknown, cwd: string) => {
  const text = String(value ?? '');
  const rel = text.replace(/\\/g, '/').replace(cwd.replace(/\\/g, '/').replace(/\/$/, '') + '/', '');
  return rel.length > 90 ? `…${rel.slice(-88)}` : rel;
};

/** Turn one stream-json object into zero or more readable events (never the raw payloads). */
export function describeStreamEvent(message: Record<string, unknown>, cwd: string): Array<Omit<BuildEvent, 'at'>> {
  const out: Array<Omit<BuildEvent, 'at'>> = [];
  const type = message.type;
  if (type === 'system' && message.subtype === 'init') out.push({ kind: 'step', text: `Session started (${String(message.model ?? 'claude')})` });
  if (type === 'assistant') {
    const content = ((message.message as { content?: unknown[] } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ kind: 'info', text: block.text.trim().replace(/\s+/g, ' ').slice(0, 220) });
      } else if (block.type === 'tool_use') {
        const name = String(block.name ?? 'tool');
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (name === 'Write') out.push({ kind: 'cmd', text: `Writing ${shortPath(input.file_path, cwd)}` });
        else if (name === 'Edit' || name === 'MultiEdit') out.push({ kind: 'cmd', text: `Editing ${shortPath(input.file_path, cwd)}` });
        else if (name === 'Read') out.push({ kind: 'cmd', text: `Reading ${shortPath(input.file_path, cwd)}` });
        else if (name === 'Bash') out.push({ kind: 'cmd', text: `$ ${String(input.command ?? '').replace(/\s+/g, ' ').slice(0, 160)}` });
        else if (name === 'Glob' || name === 'Grep') out.push({ kind: 'cmd', text: `Searching ${String(input.pattern ?? '').slice(0, 80)}` });
        else if (name === 'TodoWrite') {
          const todos = (input.todos ?? []) as Array<{ content?: string; status?: string }>;
          const active = todos.find((todo) => todo.status === 'in_progress');
          const done = todos.filter((todo) => todo.status === 'completed').length;
          if (active?.content) out.push({ kind: 'step', text: `${active.content} (${done}/${todos.length} done)` });
        } else if (name === 'WebFetch') out.push({ kind: 'net', text: `Fetching ${String(input.url ?? '').slice(0, 120)}` });
        else if (name === 'Task' || name === 'Agent') out.push({ kind: 'step', text: `Helper started: ${String(input.description ?? '').slice(0, 100)}` });
        else if (/navigate/i.test(name)) out.push({ kind: 'net', text: `Browser → ${String(input.url ?? '').slice(0, 120)}` });
        else out.push({ kind: 'cmd', text: name.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ') });
      }
    }
  }
  if (type === 'user') {
    const content = ((message.message as { content?: unknown[] } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
    for (const block of content) if (block.type === 'tool_result' && block.is_error) {
      const text = Array.isArray(block.content) ? (block.content as Array<{ text?: string }>).map((part) => part.text ?? '').join(' ') : String(block.content ?? '');
      out.push({ kind: 'err', text: text.replace(/\s+/g, ' ').slice(0, 200) || 'A step failed' });
    }
  }
  if (type === 'result') out.push({ kind: message.is_error ? 'err' : 'ok', text: message.is_error ? 'Session ended with an error' : 'Session finished' });
  return out;
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
      child = spawn(engineCommand('claude'), spec.args, { cwd: spec.cwd, shell: false, windowsHide: true, env: buildSpawnEnv({ CLAUDE_FACTORY_JOB: '1' }) });
    } catch (error) {
      logClosed = true; log.end();
      return { outcome: 'spawn_error', exitCode: null, detail: error instanceof Error ? error.message : 'spawn failed' };
    }

    let lastActivity = Date.now();
    // Checked line by line (chunks can end mid-line), per stream.
    const pending: Record<'out' | 'err', string> = { out: '', err: '' };
    const onData = (stream: 'out' | 'err') => (chunk: Buffer) => {
      lastActivity = Date.now();
      const text = chunk.toString('utf8');
      const lines = (pending[stream] + text).split('\n');
      pending[stream] = lines.pop() ?? '';
      if (!usageLimitSeen) {
        for (const line of lines) {
          const hit = limitMessage(line);
          if (hit) { void recordLimit(hit); usageLimitSeen = true; break; }
        }
      }
      writeLog(spec.scrub ? scrubSecrets(text) : text);
    };
    child.stdout?.on('data', onData('out'));
    child.stderr?.on('data', onData('err'));

    // Live usage. Every AI reply carries its token counts, so keep a running total per model and
    // save what's new every 2 minutes and when the session ends. A paused, cancelled or restarted
    // session then still counts; the final "result" message only adds whatever is left over.
    type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
    const replyUsage = new Map<string, { model: string } & Tokens>();   // latest usage per reply id
    const savedByModel = new Map<string, Tokens>();
    let sessionId: string | null = null;
    let resultSeen = false;
    const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const saveUsage = (current: Map<string, Tokens>, extra: Record<string, unknown> = {}) => {
      if (!spec.usageTag) return;
      const modelUsage: Record<string, Record<string, number>> = {};
      const sum = zero();
      for (const [model, total] of current) {
        const before = savedByModel.get(model) ?? zero();
        const delta = { input: Math.max(0, total.input - before.input), output: Math.max(0, total.output - before.output), cacheRead: Math.max(0, total.cacheRead - before.cacheRead), cacheWrite: Math.max(0, total.cacheWrite - before.cacheWrite) };
        if (!delta.input && !delta.output && !delta.cacheRead && !delta.cacheWrite) continue;
        modelUsage[model] = { inputTokens: delta.input, outputTokens: delta.output, cacheReadInputTokens: delta.cacheRead, cacheCreationInputTokens: delta.cacheWrite };
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) sum[key] += delta[key];
        savedByModel.set(model, { ...total });
      }
      if (!Object.keys(modelUsage).length && !extra.duration_ms) return;
      void recordUsage({
        session_id: sessionId, modelUsage,
        usage: { input_tokens: sum.input, output_tokens: sum.output, cache_read_input_tokens: sum.cacheRead, cache_creation_input_tokens: sum.cacheWrite },
        ...extra,
      }, spec.usageTag);
    };
    const replyTotals = () => {
      const byModel = new Map<string, Tokens>();
      for (const reply of replyUsage.values()) {
        const total = byModel.get(reply.model) ?? zero();
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) total[key] += reply[key];
        byModel.set(reply.model, total);
      }
      return byModel;
    };
    const usageTimer = setInterval(() => { if (!resultSeen) saveUsage(replyTotals(), { partial: true }); }, 120_000);
    child.on('close', () => { clearInterval(usageTimer); if (!resultSeen) saveUsage(replyTotals(), { partial: true, is_error: true }); });

    // Stream-json → readable events file (line-buffered; bad lines are skipped, never fatal).
    if (spec.eventsPath) {
      const events = createWriteStream(spec.eventsPath, { flags: 'a' });
      events.on('error', () => {});
      let buffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
          if (!line.startsWith('{')) continue;
          try {
            const message = JSON.parse(line) as Record<string, unknown>;
            if (typeof message.session_id === 'string') sessionId = message.session_id;
            if (message.type === 'assistant') {
              const reply = message.message as { id?: string; model?: string; usage?: Record<string, number>; content?: unknown[] } | undefined;
              if (reply?.id && reply.usage) {
                // Streamed replies arrive one content block at a time and only carry a starting output
                // count (the real total comes with "result"), so estimate output from what was written
                // (~4 characters per token) and keep whichever is larger.
                const previous = replyUsage.get(reply.id);
                const written = Math.round(JSON.stringify(reply.content ?? []).length / 4);
                const output = Math.max(Number(reply.usage.output_tokens ?? 0), (previous?.output ?? 0) + written);
                replyUsage.set(reply.id, { model: reply.model ?? 'unknown', input: Number(reply.usage.input_tokens ?? 0), output, cacheRead: Number(reply.usage.cache_read_input_tokens ?? 0), cacheWrite: Number(reply.usage.cache_creation_input_tokens ?? 0) });
              }
            }
            if (message.type === 'result' && spec.usageTag) {
              // The result's per-model totals are the truth; save only what the running totals missed.
              resultSeen = true;
              const final = new Map<string, Tokens>();
              for (const [model, m] of Object.entries((message.modelUsage ?? {}) as Record<string, Record<string, number>>)) {
                final.set(model, { input: Number(m.inputTokens ?? 0), output: Number(m.outputTokens ?? 0), cacheRead: Number(m.cacheReadInputTokens ?? 0), cacheWrite: Number(m.cacheCreationInputTokens ?? 0) });
              }
              const nothingSavedYet = savedByModel.size === 0;
              saveUsage(final.size ? final : replyTotals(), {
                duration_ms: message.duration_ms, duration_api_ms: message.duration_api_ms, num_turns: message.num_turns,
                is_error: message.is_error, subtype: message.subtype,
                // The reported cost covers the whole session — only usable when nothing was saved before.
                ...(nothingSavedYet ? { total_cost_usd: message.total_cost_usd } : {}),
              });
            }
            for (const entry of describeStreamEvent(message, spec.cwd)) {
              const text = spec.scrub ? scrubSecrets(entry.text) : entry.text;
              try { events.write(JSON.stringify({ at: Date.now(), kind: entry.kind, text }) + '\n'); } catch { /* ended */ }
            }
          } catch { /* partial / non-JSON line */ }
        }
      });
      child.on('close', () => { try { events.end(); } catch { /* already ended */ } });
    }

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
/** A Rebuild leaves qa/state/already-built.json: tell the session to verify those pages, not rewrite
 *  them, so a rebuild only spends AI time on what is actually missing. */
function rebuildNote(job: FactoryJobRecord): string[] {
  const file = path.join(job.workspace_path, 'qa', 'state', 'already-built.json');
  if (!existsSync(file)) return [];
  return ['--append-system-prompt', `THIS IS A REBUILD. Before building anything, read ${file}. Every page under "pages" already has its template and all planned sections on disk from an earlier run: do not rewrite those files. Check each of them quickly (renders, no missing section, pushed to the dev theme) and fix only real problems. Spend your effort on "still_to_build" and on anything the checks find broken. Reuse existing snippets, assets and settings instead of recreating them.`];
}

export function spawnClone(job: FactoryJobRecord, scrub = true, timeouts: RunTimeouts = {}, model: BotModel = 'opus'): RunHandle {
  const reports = path.join(job.workspace_path, 'qa', 'reports');
  return run({
    cwd: job.workspace_path,
    // qa_engine 'chrome': give the session the Claude-in-Chrome tools so it can verify its work
    // in the user's own, already-signed-in Chrome (the one-time extension setup in the wizard).
    args: ['-p', '/clone-theme', '--model', model, ...(job.qa_engine === 'chrome' ? ['--chrome'] : []), ...rebuildNote(job), ...STREAM_ARGS],
    logPath: path.join(job.workspace_path, 'factory', 'logs', 'clone-0.log'),
    eventsPath: path.join(job.workspace_path, 'factory', 'logs', 'clone-0.events.jsonl'),
    usageTag: { jobId: job.id, jobName: job.name, kind: 'build', model },
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
export function spawnFix(job: FactoryJobRecord, iteration: number, scrub = true, timeouts: RunTimeouts = {}, model: BotModel = 'opus'): RunHandle {
  const promptPath = path.join(job.workspace_path, 'factory', `fix-prompt-${iteration}.md`);
  return run({
    cwd: job.workspace_path,
    args: ['-p', `You are an autonomous fix session. Read the file at ${promptPath} and execute it exactly. Never wait for user input.`, '--model', model, ...(job.qa_engine === 'chrome' ? ['--chrome'] : []), ...STREAM_ARGS],
    logPath: path.join(job.workspace_path, 'factory', 'logs', `fix-${iteration}.log`),
    eventsPath: path.join(job.workspace_path, 'factory', 'logs', `fix-${iteration}.events.jsonl`),
    usageTag: { jobId: job.id, jobName: job.name, kind: `fix ${iteration}`, model },
    signals: { [path.join(job.workspace_path, 'qa', 'reports', `fix-complete-${iteration}.md`)]: 'sentinel' },
    inactivityMs: timeouts.inactivityMs ?? config.factory.inactivityTimeoutMin * 60_000,
    wallClockMs: timeouts.wallClockMs ?? config.factory.fixTimeoutMin * 60_000,
    scrub,
  });
}
