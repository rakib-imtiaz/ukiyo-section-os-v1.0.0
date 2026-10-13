import { spawn, type ChildProcess } from 'node:child_process';
import { engineCommand, providerKey, recordLimit, recordUsage } from './engines';
import { createWriteStream, type WriteStream } from 'node:fs';
import { access, appendFile, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { config } from '../config';
import type { FactoryJobRecord } from '../db';
import { BOT_MODELS, type BotModel, type BuildEngine, type RunResult } from './types';
import { DEFAULT_ENGINE_BUDGET_USD, envBuildEngine, envEngineBudget, getFactorySettings } from './settings';
import { claudeEnv } from '../claude-connect';
import { killTree, ownProcessGroup } from '../platform/proc';
import { resourcePath } from '../runtime-paths';
import { ledgerTotal } from '../../engine/src/cost';

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
// basics a Windows/macOS/Linux CLI needs, plus CLAUDE_*/ANTHROPIC_* so CLI auth/config still works.
const SPAWN_ENV_EXACT = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS', 'OS', 'USERNAME', 'USERDOMAIN',
  // macOS / Linux: temp dir, user, locale, and the display/session a visible browser needs.
  'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'PLAYWRIGHT_BROWSERS_PATH', // non-secret; QA breaks on machines that relocate the browser cache without it
]);
const SPAWN_ENV_PREFIXES = ['PROCESSOR_', 'CLAUDE_', 'ANTHROPIC_', 'LC_', 'XDG_'];
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

export interface RunHandle {
  result: Promise<RunResult>;
  /** Stops the session's process tree; resolves once it has been told to stop (see killTree). A kill
   *  that arrives before the process exists stops it from starting at all. */
  kill: (reason?: string) => Promise<void>;
  logPath: string;
  /** The Claude Code session id, once the stream has reported it (for transcript cleanup). */
  sessionId: () => string | null;
}

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
  /** The prompt, written to the CLI's stdin (`claude -p` with no prompt argument reads stdin). */
  stdin?: string;
  /** false: never write the CLI's raw output to the log (Cloud recipe builds — the raw stream can
   *  quote the prompt). The log then holds only the readable events and the CLI's own errors. */
  rawLog?: boolean;
  /** Prefixed to every readable event (which page a concurrent step is working on). */
  eventPrefix?: string;
}

// TEST HOOK — only for the automated tests' fake Claude CLI (tests/fixtures/fake-claude.mjs).
// Windows can't spawn a .mjs (or a .cmd shim) with shell:false, so when THEMEBOT_FAKE_CLAUDE=1 is
// set AND the configured Claude path is a .mjs file, that script runs on this Node instead.
// Nothing sets this variable outside the test suite.
function claudeLaunch(args: string[]): { command: string; args: string[] } {
  const command = engineCommand('claude');
  if (process.env.THEMEBOT_FAKE_CLAUDE === '1' && /\.mjs$/i.test(command)) return { command: process.execPath, args: [command, ...args] };
  return { command, args };
}

// --- ThemeBot Engine -----------------------------------------------------------------------------
// Opt-in replacement for the Claude Code CLI (factory setting `buildEngine: 'themebot'`, or
// THEMEBOT_BUILD_ENGINE=themebot): our own agent on the Claude API (engine/), paid with ThemeBot's key.
// It takes the same arguments, prints the same stream-json and ends on the same signal files, so
// everything below treats both engines alike. On top: the build's budget cap (--max-budget-usd, shared
// by every session of the build through its ledger) and the 'budget' outcome when it is reached.

/** Which engine runs sessions now, and the per-build cap. Any failure reading settings → Claude Code. */
async function buildEngineSelection(): Promise<{ engine: BuildEngine; budgetUsd: number }> {
  try {
    const settings = await getFactorySettings();
    return { engine: settings.buildEngine, budgetUsd: settings.engineBudgetUsd };
  } catch {
    return { engine: envBuildEngine() ?? 'claude-code', budgetUsd: envEngineBudget() ?? DEFAULT_ENGINE_BUDGET_USD };
  }
}

/** One build's spend ledger. It lives outside the workspace, so nothing a build does to its own
 *  folder (a Rebuild, a cleanup) can reset what the build has spent. */
export function engineLedgerPath(jobId: string): string {
  return path.join(config.factory.workspaceRoot, '.factory', 'engine-ledger', `${jobId.replace(/[^\w-]/g, '_')}.jsonl`);
}

/** How to start ThemeBot Engine: the bundled engine.mjs in the desktop app, else its source via tsx. */
export function engineLaunch(args: string[]): { command: string; args: string[] } {
  const bundled = resourcePath('engine', 'engine.mjs');
  if (existsSync(bundled)) return { command: process.execPath, args: [bundled, ...args] };
  // The session's cwd is the workspace, which has no node_modules: give tsx by absolute URL.
  const loader = pathToFileURL(resourcePath('node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return { command: process.execPath, args: ['--import', loader, resourcePath('engine', 'src', 'cli.ts'), ...args] };
}

/** The Anthropic key the engine bills to: THEMEBOT_ENGINE_API_KEY, else the Anthropic key saved in
 *  Settings → AI engines, else the API key connected for Claude. */
async function engineApiKey(): Promise<string | null> {
  const fromEnv = process.env.THEMEBOT_ENGINE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const saved = await providerKey('anthropic').catch(() => null);
  if (saved) return saved;
  return (await claudeEnv().catch(() => ({} as Record<string, string>))).ANTHROPIC_API_KEY ?? null;
}

/** Engine tuning knobs from the server's env (THEMEBOT_ENGINE_EFFORT_*, _BETAS, _BASH) — never the key. */
function engineEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && /^THEMEBOT_ENGINE_/i.test(key) && !/API_KEY/i.test(key)) out[key] = value;
  }
  return out;
}

const budgetText = (spent: number, cap: number) => `Build budget reached: $${spent.toFixed(2)} of the $${cap.toFixed(2)} cap is spent. Raise "Budget per build" in Settings, then press Resume.`;

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
  if (type === 'system' && message.subtype === 'init') out.push({ kind: 'step', text: message.engine === 'themebot' ? `Session started (ThemeBot Engine · ${String(message.model ?? 'claude')})` : `Session started (${String(message.model ?? 'claude')})` });
  // ThemeBot Engine's own notes (progress between tool calls, helpers starting, budget). Claude Code never sends these.
  if (type === 'system' && message.subtype === 'themebot_progress' && typeof message.text === 'string' && message.text.trim()) {
    const kind = message.kind === 'step' || message.kind === 'err' ? message.kind : 'info';
    out.push({ kind, text: message.text.trim().replace(/\s+/g, ' ').slice(0, 220) });
  }
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


function run(spec: RunSpec): RunHandle {
  let child: ChildProcess;
  let log: WriteStream;
  let killedReason: string | null = null;
  let usageLimitSeen = false;
  let sessionId: string | null = null;
  // ThemeBot Engine sessions only: set from its final result message.
  let useEngine = false;
  let program = config.factory.claudePath;
  let budgetStop: string | null = null;
  let engineError: string | null = null;
  let engineResultSeen = false;
  const rawLog = spec.rawLog !== false;
  const clean = (value: string) => (spec.scrub ? scrubSecrets(value) : value);

  // `child` doesn't exist until the awaits below are done: a kill in that window (pause, cancel, quit
  // right as a session starts) is remembered, and the session then never starts. One sweep of the
  // tree per session, however many callers ask (pause = abort listener + kill hook).
  let killing: Promise<void> | null = null;
  const kill = (reason = 'killed') => {
    killedReason = reason;
    if (!child) return Promise.resolve();
    killing ??= killTree(child);
    return killing;
  };

  const result = (async (): Promise<RunResult> => {
    await mkdir(path.dirname(spec.logPath), { recursive: true });
    log = createWriteStream(spec.logPath, { flags: 'a' });
    // Never let a late write-after-end or disk error become an uncaught exception mid-fleet.
    let logClosed = false;
    log.on('error', () => {});
    const writeLog = (text: string) => { if (!logClosed) { try { log.write(text); } catch { /* stream ended */ } } };
    // Which engine runs this session: Claude Code unless the factory settings opted into ThemeBot Engine.
    const selection = await buildEngineSelection();
    useEngine = selection.engine === 'themebot';
    program = useEngine ? 'ThemeBot Engine' : config.factory.claudePath;
    writeLog(`\n[factory ${new Date().toISOString()}] spawn ${program} ${spec.args.join(' ')}${spec.stdin !== undefined ? ' (prompt on stdin)' : ''}\n`);
    const stopBeforeStart = (outcome: RunResult['outcome'], detail: string): RunResult => {
      writeLog(`[factory ${new Date().toISOString()}] ${detail}\n`);
      logClosed = true; log.end();
      return { outcome, exitCode: null, detail };
    };

    try {
      let env: NodeJS.ProcessEnv;
      let launch: { command: string; args: string[] };
      if (useEngine) {
        const ledger = spec.usageTag ? engineLedgerPath(spec.usageTag.jobId) : null;
        const spent = await ledgerTotal(ledger);
        if (spent >= selection.budgetUsd) return stopBeforeStart('budget', budgetText(spent, selection.budgetUsd));
        // TEST HOOK: a scripted fake model (engine/src/cli.ts) needs no key.
        const scripted = Boolean(process.env.THEMEBOT_ENGINE_FAKE_SCRIPT);
        const key = scripted ? null : await engineApiKey();
        if (!scripted && !key) return stopBeforeStart('spawn_error', 'ThemeBot Engine needs an Anthropic API key: add one in Settings → AI engines (Anthropic), or set THEMEBOT_ENGINE_API_KEY.');
        env = buildSpawnEnv({ ...engineEnv(), ...(key ? { ANTHROPIC_API_KEY: key } : {}), CLAUDE_FACTORY_JOB: '1' });
        launch = engineLaunch([...spec.args, '--max-budget-usd', String(selection.budgetUsd), ...(ledger ? ['--ledger', ledger] : [])]);
      } else {
        // claudeEnv(): an API key the user connected in the app (otherwise the CLI's own sign-in).
        env = buildSpawnEnv({ ...(await claudeEnv()), CLAUDE_FACTORY_JOB: '1' });
        launch = claudeLaunch(spec.args);
      }
      if (killedReason) {
        writeLog(`[factory ${new Date().toISOString()}] stopped before the session started\n`);
        logClosed = true; log.end();
        return { outcome: 'killed', exitCode: null, detail: 'stopped before the session started' };
      }
      child = spawn(launch.command, launch.args, { cwd: spec.cwd, shell: false, windowsHide: true, detached: ownProcessGroup, env });
    } catch (error) {
      logClosed = true; log.end();
      return { outcome: 'spawn_error', exitCode: null, detail: error instanceof Error ? error.message : 'spawn failed' };
    }
    // The prompt goes in on stdin and never touches the disk. (A CLI that dies at once makes the
    // write fail with EPIPE — the 'error'/'exit' handlers below report that run.)
    if (spec.stdin !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(spec.stdin, 'utf8');
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
      if (rawLog) writeLog(clean(text));
      // Summarized log: only the CLI's own error lines here (stdout becomes readable events below).
      else if (stream === 'err') for (const line of lines) if (line.trim()) writeLog(`[cli] ${clean(line.trim()).slice(0, 300)}\n`);
    };
    child.stdout?.on('data', onData('out'));
    child.stderr?.on('data', onData('err'));

    // Live usage. Every AI reply carries its token counts, so keep a running total per model and
    // save what's new every 2 minutes and when the session ends. A paused, cancelled or restarted
    // session then still counts; the final "result" message only adds whatever is left over.
    type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
    const replyUsage = new Map<string, { model: string } & Tokens>();   // latest usage per reply id
    const savedByModel = new Map<string, Tokens>();
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
      }, useEngine ? { ...spec.usageTag, engine: 'themebot' } : spec.usageTag);
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
                // (ThemeBot Engine prints each reply once, complete, with its final count: taken as is.)
                const previous = replyUsage.get(reply.id);
                const written = Math.round(JSON.stringify(reply.content ?? []).length / 4);
                const output = message.themebot_final === true ? Number(reply.usage.output_tokens ?? 0) : Math.max(Number(reply.usage.output_tokens ?? 0), (previous?.output ?? 0) + written);
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
            if (message.type === 'result' && useEngine) {
              engineResultSeen = true;
              const status = (message.themebot as { status?: string } | undefined)?.status;
              if (status === 'budget') budgetStop = clean(String(message.result ?? 'Build budget reached.')).split('\n')[0].slice(0, 300);
              else if (message.is_error) engineError = clean(String(message.result ?? '')).replace(/\s+/g, ' ').trim().slice(0, 300) || null;
            }
            for (const entry of describeStreamEvent(message, spec.cwd)) {
              const text = spec.eventPrefix ? `${spec.eventPrefix} ${clean(entry.text)}` : clean(entry.text);
              try { events.write(JSON.stringify({ at: Date.now(), kind: entry.kind, text }) + '\n'); } catch { /* ended */ }
              if (!rawLog) writeLog(`[${new Date().toISOString().slice(11, 19)}] ${entry.kind.padEnd(4)} ${text}\n`);
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
        if (failedSpawn) settle({ outcome: 'spawn_error', exitCode: null, detail: `Cannot launch ${program}: ${error.message}` });
      });

      const poller = setInterval(() => {
        void (async () => {
          const found = await findSignal();
          if (found) { killTree(child); settle({ outcome: spec.signals[found], exitCode: child.exitCode, signalFile: found }); }
        })();
      }, 5_000);

      // Checked every minute (more often only for limits under 4 minutes — the settings allow none,
      // the tests use them).
      const watchEveryMs = Math.max(250, Math.min(60_000, Math.floor(Math.min(spec.wallClockMs, spec.inactivityMs) / 4)));
      const watchdog = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        if (elapsed > spec.wallClockMs) { kill('timeout'); settle({ outcome: 'timeout', exitCode: child.exitCode, detail: `wall-clock cap ${Math.round(spec.wallClockMs / 60000)}m exceeded` }); return; }
        if (Date.now() - lastActivity > spec.inactivityMs) { kill('inactivity'); settle({ outcome: 'inactivity', exitCode: child.exitCode, detail: `no CLI activity for ${Math.round(spec.inactivityMs / 60000)}m` }); }
      }, watchEveryMs);

      child.on('exit', (code) => {
        void (async () => {
          // Grace window: the CLI may have written the signal file just before exiting. (A run we
          // killed gets one look — it won't write anything more. So does a ThemeBot Engine session that
          // printed its result: its tool calls, signal files included, finished before that.)
          const looks = killedReason || engineResultSeen ? 1 : 4;
          for (let attempt = 0; attempt < looks; attempt++) {
            const found = await findSignal();
            if (found) { settle({ outcome: spec.signals[found], exitCode: code, signalFile: found }); return; }
            if (attempt < looks - 1) await new Promise((wait) => setTimeout(wait, 4_000));
          }
          if (killedReason) { settle({ outcome: killedReason === 'timeout' ? 'timeout' : killedReason === 'inactivity' ? 'inactivity' : 'killed', exitCode: code }); return; }
          if (budgetStop) { settle({ outcome: 'budget', exitCode: code, detail: `${budgetStop} Raise "Budget per build" in Settings, then press Resume.` }); return; }
          if (usageLimitSeen) { settle({ outcome: 'usage_limit', exitCode: code, detail: 'CLI output mentioned a usage/rate limit' }); return; }
          settle({ outcome: 'exit', exitCode: code, ...(engineError ? { detail: `ThemeBot Engine: ${engineError}` } : {}) });
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

  return { result, kill, logPath: spec.logPath, sessionId: () => sessionId };
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

/**
 * Spawn a fix session for one iteration. Completion = fix-complete-<iter>.md sentinel.
 * Without `cloudPrompt` the session reads factory/fix-prompt-<iter>.md (rendered from the local
 * template). With it (ThemeBot Cloud builds) the prompt goes in on stdin and nothing of it touches
 * the disk: no prompt file, no raw log, no saved session.
 */
export function spawnFix(job: FactoryJobRecord, iteration: number, scrub = true, timeouts: RunTimeouts = {}, model: BotModel = 'opus', cloudPrompt?: string): RunHandle {
  const promptPath = path.join(job.workspace_path, 'factory', `fix-prompt-${iteration}.md`);
  const chrome = job.qa_engine === 'chrome' ? ['--chrome'] : [];
  return run({
    cwd: job.workspace_path,
    args: cloudPrompt !== undefined
      ? ['-p', '--model', model, ...chrome, '--no-session-persistence', ...STREAM_ARGS]
      : ['-p', `You are an autonomous fix session. Read the file at ${promptPath} and execute it exactly. Never wait for user input.`, '--model', model, ...chrome, ...STREAM_ARGS],
    ...(cloudPrompt !== undefined ? { stdin: cloudPrompt, rawLog: false } : {}),
    logPath: path.join(job.workspace_path, 'factory', 'logs', `fix-${iteration}.log`),
    eventsPath: path.join(job.workspace_path, 'factory', 'logs', `fix-${iteration}.events.jsonl`),
    usageTag: { jobId: job.id, jobName: job.name, kind: `fix ${iteration}`, model },
    signals: { [path.join(job.workspace_path, 'qa', 'reports', `fix-complete-${iteration}.md`)]: 'sentinel' },
    inactivityMs: timeouts.inactivityMs ?? config.factory.inactivityTimeoutMin * 60_000,
    wallClockMs: timeouts.wallClockMs ?? config.factory.fixTimeoutMin * 60_000,
    scrub,
  });
}

// --- ThemeBot Cloud build steps ------------------------------------------------------------------

/** One step as ThemeBot Cloud hands it out (POST /v1/builds/:id/next). */
export interface CloudStep {
  id: string;
  kind: string;
  title: string;
  prompt: string;
  model: string;
  /** Workspace-relative file the step writes when done (factory/steps/<id>.done). */
  signal: string;
  parallelGroup?: string;
  page?: { route: string; slug: string; name: string };
  attempt?: number;
}

const SIGNAL_PATH = /^(factory\/steps\/[a-z0-9][a-z0-9._-]{0,90}\.done|qa\/reports\/fix-complete-\d{1,4}\.md)$/;

/** The signal file of a Cloud step, inside this workspace — or null when the Cloud sent something odd. */
export function stepSignalPath(workspace: string, signal: string): string | null {
  if (!SIGNAL_PATH.test(signal)) return null;
  return path.join(workspace, ...signal.split('/'));
}

const MODEL_RANK: Record<BotModel, number> = { haiku: 0, sonnet: 1, opus: 2 };
/** The step's model, never above the tier the user picked for builds (their usage, their choice). */
export function effectiveModel(stepModel: unknown, userModel: BotModel): BotModel {
  if (!BOT_MODELS.includes(stepModel as BotModel)) return userModel;
  return MODEL_RANK[stepModel as BotModel] <= MODEL_RANK[userModel] ? stepModel as BotModel : userModel;
}

/**
 * The activity-log line for a step whose model the user's setting lowered (null when it wasn't), e.g.
 * "Using Sonnet for all steps (your setting) — complex pages normally use Opus."
 */
export function modelCapNote(stepModel: unknown, userModel: BotModel, what: string): string | null {
  if (!BOT_MODELS.includes(stepModel as BotModel) || MODEL_RANK[stepModel as BotModel] <= MODEL_RANK[userModel]) return null;
  const name = (model: string) => model.charAt(0).toUpperCase() + model.slice(1);
  return `Using ${name(userModel)} for all steps (your setting) — ${what} normally use ${name(String(stepModel))}.`;
}

/** One line from ThemeBot itself in a session's activity (the build panel) and its readable log
 *  (`log` = 'clone-0' for the build, 'fix-<n>' for a fix round). Never fails the build. */
export async function noteActivity(workspace: string, text: string, log = 'clone-0', kind: BuildEventKind = 'info') {
  const logs = path.join(workspace, 'factory', 'logs');
  const at = Date.now();
  await mkdir(logs, { recursive: true }).catch(() => {});
  await appendFile(path.join(logs, `${log}.events.jsonl`), `${JSON.stringify({ at, kind, text })}\n`).catch(() => {});
  await appendFile(path.join(logs, `${log}.log`), `[${new Date(at).toISOString().slice(11, 19)}] ${kind.padEnd(4)} ${text}\n`).catch(() => {});
}

/**
 * Run one Cloud build step: `claude -p` with the step's prompt on stdin. Completion = the step's
 * signal file, or BLOCKED.md / ABORTED.md. Logs are summarized (clone-0.log + clone-0.events.jsonl,
 * shared by concurrent steps, each line prefixed with the page it is about).
 */
export function spawnStep(job: FactoryJobRecord, step: CloudStep, model: BotModel, scrub = true, timeouts: RunTimeouts = {}): RunHandle {
  const reports = path.join(job.workspace_path, 'qa', 'reports');
  const signal = stepSignalPath(job.workspace_path, step.signal);
  if (!signal) throw new Error(`ThemeBot Cloud sent an invalid signal file for step ${step.id}.`);
  return run({
    cwd: job.workspace_path,
    args: ['-p', '--model', model, ...(job.qa_engine === 'chrome' ? ['--chrome'] : []), '--no-session-persistence', ...STREAM_ARGS],
    stdin: step.prompt,
    rawLog: false,
    eventPrefix: step.page ? `[${step.page.name}]` : undefined,
    logPath: path.join(job.workspace_path, 'factory', 'logs', 'clone-0.log'),
    eventsPath: path.join(job.workspace_path, 'factory', 'logs', 'clone-0.events.jsonl'),
    usageTag: { jobId: job.id, jobName: job.name, kind: `build: ${step.title}`, model },
    signals: {
      [signal]: 'sentinel',
      [path.join(reports, 'BLOCKED.md')]: 'blocked',
      [path.join(reports, 'ABORTED.md')]: 'aborted',
    },
    inactivityMs: timeouts.inactivityMs ?? config.factory.inactivityTimeoutMin * 60_000,
    wallClockMs: timeouts.wallClockMs ?? config.factory.cloneTimeoutMin * 60_000,
    scrub,
  });
}

// --- Claude Code transcripts -------------------------------------------------------------------
// Claude Code keeps each session's transcript (prompt included) under
// <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug>/, where <slug> is the session's working folder
// with every character that isn't a letter or digit replaced by '-' (C:\builds\wild_sacred →
// C--builds-wild-sacred); a slug longer than 200 characters is cut to 200 and given a hash of the
// full path as a suffix. Cloud builds run with --no-session-persistence, and still clean up after
// every step in case a CLI version writes one anyway. Only THIS workspace's folder is ever touched.

/** Where Claude Code keeps transcripts (the same CLAUDE_CONFIG_DIR the CLI inherits from us). */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), '.claude'), 'projects');
}

/** Claude Code's slug for a working folder (before any shortening). */
export function transcriptSlug(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, '-');
}

const MAX_SLUG = 200;
/** The suffix Claude Code gives a shortened slug: the full path's 32-bit "×31" string hash, made
 *  positive, in base 36 (as in the CLI: `(h << 5) - h + charCode | 0`, `Math.abs(h).toString(36)`). */
function slugHash(folder: string): string {
  let hash = 0;
  for (let index = 0; index < folder.length; index += 1) hash = ((hash << 5) - hash + folder.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(36);
}

/** Claude Code's transcript folder name for a working folder, shortened (with its hash) past 200. */
export function transcriptFolderName(folder: string): string {
  const slug = transcriptSlug(folder);
  return slug.length <= MAX_SLUG ? slug : `${slug.slice(0, MAX_SLUG)}-${slugHash(folder)}`;
}

/** The spellings the CLI may have seen this folder under: as given, its real path, and (Windows) either drive-letter case. */
async function folderSpellings(workspace: string): Promise<string[]> {
  const spellings = new Set([path.resolve(workspace)]);
  try { spellings.add(await realpath(workspace)); } catch { /* gone */ }
  if (process.platform === 'win32') {
    for (const spelling of [...spellings]) {
      if (/^[a-zA-Z]:/.test(spelling)) { spellings.add(spelling.charAt(0).toUpperCase() + spelling.slice(1)); spellings.add(spelling.charAt(0).toLowerCase() + spelling.slice(1)); }
    }
  }
  return [...spellings];
}

/**
 * Deletes Claude Code's transcripts for this workspace: just the given sessions' files (while other
 * steps of the same build are still running in it), or the whole folder. Returns what it removed.
 * A shortened (over 200 characters) folder name only counts when its hash is this folder's — never
 * another folder whose path merely starts the same way.
 */
export async function removeWorkspaceTranscripts(workspace: string, options: { sessionIds?: string[]; env?: NodeJS.ProcessEnv } = {}): Promise<string[]> {
  const projects = claudeProjectsDir(options.env);
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const wanted = new Set((await folderSpellings(workspace)).filter((folder) => transcriptSlug(folder).replace(/-/g, '').length >= 3).map((folder) => fold(transcriptFolderName(folder))));
  let names: string[] = [];
  try { names = await readdir(projects); } catch { return []; }
  const removed: string[] = [];
  for (const name of names.filter((entry) => wanted.has(fold(entry)))) {
    const folder = path.join(projects, name);
    if (path.dirname(folder) !== projects) continue;
    const targets = options.sessionIds
      ? options.sessionIds.filter((id) => /^[A-Za-z0-9-]{8,80}$/.test(id)).flatMap((id) => [path.join(folder, `${id}.jsonl`), path.join(folder, id)])
      : [folder];
    for (const target of targets) {
      if (!existsSync(target)) continue;
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).then(() => removed.push(target), () => {});
    }
  }
  return removed;
}
