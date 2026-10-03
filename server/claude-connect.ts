// Claude connection service — LOCAL OPERATOR TOOL.
// Detects / establishes the app's connection to Claude, mirroring the CLI's own auth:
//   · OAuth via the CLI ("claude login" spawned under a PTY, browser flow), or
//   · an API key, stored AES-256-GCM-encrypted in app_settings (write-only, never echoed).
// "Logout" is APP-SCOPED: it deletes our stored key / sets a disconnected flag so the app
// ignores the CLI's credentials — it NEVER deletes ~/.claude/.credentials.json (that would
// sign the user out of Claude Code globally, in every terminal).
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { IPty } from 'node-pty';
import { loadPty } from './platform/pty';
import { claudeInstallCommand, findClaudePath } from './platform/claude-path';
import { config } from './config';
import { db } from './db';
import { encrypt, decrypt } from './security';
import { scrubSecrets } from './factory/runner';
import { trustWorkspace } from './factory/scaffolder';
import { installPtyCrashGuard } from './terminal';
import { addProgress, beginTask } from './progress';
import { killTree, ownProcessGroup } from './platform/proc';

const KEY_SETTING = 'claude_api_key_cipher';
// Explicit opt-in to use the CLI's OAuth sign-in. CLI credentials are NEVER adopted
// automatically — the user must choose "Use my CLI login" (or complete an in-app login).
const CLI_ENABLED_SETTING = 'claude_cli_enabled';
const STATUS_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 90_000;

export interface ClaudeStatus {
  connected: boolean;
  method: 'api-key' | 'oauth-cli' | null;
  cliPresent: boolean;
  /** CLI OAuth credentials exist on disk — the app can adopt them via an explicit "Use my CLI login". */
  cliCredentialsPresent: boolean;
  claudePath: string;
  loginActive: boolean;
  reason?: string;
}

export interface QuickRunResult { ok: boolean; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }


/** Spawn the Claude CLI headlessly, capture output, enforce a hard timeout. */
export function runQuickClaude(options: { args: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<QuickRunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(config.factory.claudePath, options.args, {
        cwd: options.cwd ?? tmpdir(), shell: false, windowsHide: true, detached: ownProcessGroup,
        env: { ...process.env, ...options.env },
      });
    } catch (error) {
      resolve({ ok: false, exitCode: null, stdout: '', stderr: error instanceof Error ? error.message : 'spawn failed', timedOut: false });
      return;
    }
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, options.timeoutMs ?? PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > 200_000) stdout = stdout.slice(-100_000); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); if (stderr.length > 50_000) stderr = stderr.slice(-25_000); });
    const clean = (text: string) => scrubSecrets(text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '').replace(/[\x00-\x08\x0b-\x1f]/g, ''));
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, exitCode: null, stdout: clean(stdout), stderr: clean(`${stderr}\n${error.message}`), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0 && !timedOut, exitCode: code, stdout: clean(stdout), stderr: clean(stderr), timedOut }); });
  });
}

/** A trusted scratch directory for probes (headless `claude -p` refuses untrusted folders). */
let probeDirReady: Promise<string> | null = null;
function probeDir(): Promise<string> {
  if (!probeDirReady) {
    probeDirReady = (async () => {
      const dir = path.join(tmpdir(), 'sectionos-probe');
      await mkdir(dir, { recursive: true });
      await trustWorkspace(dir).catch(() => { /* probe may still work if already trusted */ });
      return dir;
    })();
  }
  return probeDirReady;
}

/** Re-checks for Claude Code when it isn't where we last looked (e.g. installed after launch). */
function refreshClaudePath() {
  if (!fs.existsSync(config.factory.claudePath)) config.factory.claudePath = findClaudePath();
}

function credentialsFileExists(): boolean {
  // macOS keeps the CLI's sign-in in the Keychain, not in a file — there the connection probe
  // is the only real test, so treat the sign-in as "maybe present".
  if (process.platform === 'darwin') return true;
  try { const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), '.credentials.json'); return fs.existsSync(file) && fs.statSync(file).size > 2; } catch { return false; }
}

async function probe(env?: Record<string, string>): Promise<{ ok: boolean; detail: string }> {
  const cwd = await probeDir();
  const result = await runQuickClaude({ args: ['-p', 'Reply with exactly: pong', '--model', 'haiku', '--output-format', 'json'], cwd, env, timeoutMs: PROBE_TIMEOUT_MS });
  if (result.ok) return { ok: true, detail: 'ok' };
  const detail = (result.stderr || result.stdout || '').split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);
  return { ok: false, detail: result.timedOut ? 'The connection check timed out.' : detail || `exit ${result.exitCode}` };
}

// ---- status (cached) ----
let cached: { at: number; status: ClaudeStatus } | null = null;
let loginChild: IPty | null = null;

export function invalidateClaudeStatus() { cached = null; }

async function storedKey(): Promise<string | null> {
  const cipher = await db.getSetting(KEY_SETTING);
  if (typeof cipher !== 'string' || !cipher) return null;
  try { return decrypt(cipher); } catch { return null; }
}

/** Env for ANY app-spawned claude process so it honors the app's connection method. */
export async function claudeEnv(): Promise<Record<string, string>> {
  const key = await storedKey();
  return key ? { ANTHROPIC_API_KEY: key } : {};
}

/**
 * Fast, probe-free status for hot paths (/api/session): trusts the last probed result when
 * fresh; otherwise a heuristic (CLI present + credentials/stored key + not app-disconnected)
 * and kicks a background probe so the next call is authoritative.
 */
export async function getClaudeStatusQuick(): Promise<ClaudeStatus> {
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return { ...cached.status, loginActive: !!loginChild };
  refreshClaudePath();
  const cliPresent = fs.existsSync(config.factory.claudePath);
  const cliCredentialsPresent = credentialsFileExists();
  const key = await storedKey();
  const cliEnabled = (await db.getSetting(CLI_ENABLED_SETTING)) === '1';
  const likely = cliPresent && !!(key || (cliEnabled && cliCredentialsPresent));
  void getClaudeStatus(true).catch(() => {}); // refresh authoritatively in the background
  return { connected: likely, method: key ? 'api-key' : likely ? 'oauth-cli' : null, cliPresent, cliCredentialsPresent, claudePath: config.factory.claudePath, loginActive: !!loginChild, reason: likely ? undefined : 'Not connected yet.' };
}

let statusInFlight: Promise<ClaudeStatus> | null = null;
export async function getClaudeStatus(force = false): Promise<ClaudeStatus> {
  if (!force && cached && Date.now() - cached.at < STATUS_TTL_MS) return { ...cached.status, loginActive: !!loginChild };
  if (statusInFlight) return statusInFlight;
  statusInFlight = computeClaudeStatus().finally(() => { statusInFlight = null; });
  return statusInFlight;
}

async function computeClaudeStatus(): Promise<ClaudeStatus> {
  refreshClaudePath();
  const cliPresent = fs.existsSync(config.factory.claudePath);
  const cliCredentialsPresent = credentialsFileExists();
  const base = { cliPresent, cliCredentialsPresent, claudePath: config.factory.claudePath, loginActive: !!loginChild };
  let status: ClaudeStatus;
  const key = await storedKey();
  const cliEnabled = (await db.getSetting(CLI_ENABLED_SETTING)) === '1';
  if (!cliPresent) {
    status = { ...base, connected: false, method: null, reason: `Claude Code isn't installed yet. Install it with: ${claudeInstallCommand()}` };
  } else if (key) {
    // An app-stored API key is an explicit choice — use it.
    const result = await probe({ ANTHROPIC_API_KEY: key });
    status = result.ok
      ? { ...base, connected: true, method: 'api-key' }
      : { ...base, connected: false, method: null, reason: `The stored API key no longer works: ${result.detail}` };
  } else if (cliEnabled && cliCredentialsPresent) {
    // CLI OAuth is used only after the user explicitly opted in ("Use my CLI login").
    const result = await probe();
    status = result.ok
      ? { ...base, connected: true, method: 'oauth-cli' }
      : { ...base, connected: false, method: null, reason: `Your Claude CLI sign-in stopped working (expired?): ${result.detail}` };
  } else {
    // Credentials may exist on disk, but we do NOT adopt them automatically.
    status = { ...base, connected: false, method: null, reason: cliCredentialsPresent ? 'Choose how to connect Claude to this app.' : 'Not signed in to Claude yet.' };
  }
  cached = { at: Date.now(), status };
  return status;
}

// ---- login (OAuth via the CLI, under a PTY) ----
export async function startLogin(): Promise<{ started: boolean; error?: string }> {
  if (loginChild) return { started: true };
  refreshClaudePath();
  if (!fs.existsSync(config.factory.claudePath)) return { started: false, error: `Claude Code isn't installed yet. Install it with: ${claudeInstallCommand()}` };
  installPtyCrashGuard();
  const done = beginTask();
  try {
    addProgress('Starting Claude sign-in — a browser window will open…');
    const cwd = await probeDir();
    loginChild = (await loadPty()).spawn(config.factory.claudePath, ['login'], { name: 'xterm-256color', cols: 120, rows: 30, cwd, env: { ...process.env } as Record<string, string> });
  } catch (error) {
    done(); loginChild = null;
    return { started: false, error: error instanceof Error ? error.message : 'Could not start claude login.' };
  }
  let buffer = '';
  loginChild.onData((data) => {
    buffer += data;
    const parts = buffer.split(/\r?\n/); buffer = parts.pop() ?? '';
    for (const raw of parts) {
      // Strip ANSI CSI/OSC control sequences so progress lines are readable.
      const line = scrubSecrets(raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '').replace(/[\x00-\x08\x0b-\x1f]/g, '')).trim();
      if (line) addProgress(`[claude login] ${line}`);
    }
  });
  loginChild.onExit(({ exitCode }) => {
    loginChild = null;
    done();
    addProgress(exitCode === 0 ? 'Claude sign-in finished — verifying…' : `Claude sign-in exited with code ${exitCode}.`);
    void (async () => {
      if (exitCode === 0) await db.setSetting(CLI_ENABLED_SETTING, '1'); // in-app login is an explicit opt-in
      invalidateClaudeStatus();
      const status = await getClaudeStatus(true);
      addProgress(status.connected ? '✓ Connected to Claude.' : `Still not connected: ${status.reason ?? 'unknown'}`);
    })();
  });
  return { started: true };
}

// ---- API key ----
export async function setApiKey(key: string): Promise<{ connected: boolean; error?: string }> {
  const trimmed = key.trim();
  if (!/^sk-ant-[\w-]{8,}$/.test(trimmed)) return { connected: false, error: 'That does not look like an Anthropic API key (expected sk-ant-…).' };
  const done = beginTask();
  try {
    addProgress('Verifying API key with a quick Haiku call…');
    const result = await probe({ ANTHROPIC_API_KEY: trimmed });
    if (!result.ok) { addProgress('API key check failed.'); return { connected: false, error: `The key did not work: ${result.detail}` }; }
    await db.setSetting(KEY_SETTING, encrypt(trimmed));
    invalidateClaudeStatus();
    await db.audit(null, 'claude.connect', 'app', { method: 'api-key' });
    addProgress('✓ Connected to Claude with an API key.');
    return { connected: true };
  } finally { done(); }
}

/** Explicitly adopt the CLI's existing sign-in ("Use my CLI login"). Only enables the app
 *  connection if the credentials actually work — never silent. */
export async function reconnectCli(): Promise<ClaudeStatus> {
  if (!credentialsFileExists()) { addProgress('No Claude CLI sign-in found. Run `claude login` or use an API key.'); return getClaudeStatus(true); }
  addProgress('Checking your Claude CLI sign-in…');
  const result = await probe();
  if (!result.ok) { invalidateClaudeStatus(); const status = await getClaudeStatus(true); addProgress(`Your CLI sign-in did not work: ${result.detail}`); return status; }
  await db.setSetting(CLI_ENABLED_SETTING, '1');
  invalidateClaudeStatus();
  const status = await getClaudeStatus(true);
  if (status.connected) { await db.audit(null, 'claude.connect', 'app', { method: 'oauth-cli' }); addProgress('✓ Connected using your existing Claude CLI sign-in.'); }
  return status;
}

// ---- app-scoped disconnect (never touches the CLI's global credentials) ----
export async function disconnectClaude(): Promise<void> {
  await db.setSetting(KEY_SETTING, '');
  await db.setSetting(CLI_ENABLED_SETTING, '0');
  invalidateClaudeStatus();
  await db.audit(null, 'claude.disconnect', 'app', {});
  addProgress('Disconnected Claude from this app (your CLI sign-in is untouched).');
}
