// AI engines: which AI does the building, which accounts are connected, and how much ThemeBot has
// used. Today only Claude (the Claude Code CLI) can build; other engines are listed so they can be
// plugged in later — each one only needs to start a session, stream what it is doing, and report
// tokens/cost when it finishes (see runner.ts: the command comes from engineCommand()).
//
// Usage is ThemeBot's OWN usage, read from each session's final "result" message (tokens + cost)
// and appended to <workspace>/.factory/usage.jsonl. The Claude plan's remaining allowance is not
// available to other apps, so we record when a limit was hit and the reset time Claude printed.
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config';
import { db } from '../db';
import { decrypt, encrypt } from '../security';

export type EngineId = 'claude' | 'openrouter' | 'openai' | 'gemini' | 'kimi' | 'glm' | 'meta' | 'deepseek' | 'qwen' | 'mistral';

export interface EngineInfo {
  id: EngineId;
  name: string;
  maker: string;
  available: boolean;      // can build today
  note?: string;           // shown when not available
  connected: boolean;
  account: string | null;  // email / account label
  plan: string | null;     // e.g. "Max (20×)"
}

const ACTIVE_KEY = 'factory_engine';
const LIMIT_KEY = 'factory_engine_last_limit';
const usagePath = () => path.join(config.factory.workspaceRoot, '.factory', 'usage.jsonl');

// ---- which engine builds ----
export async function activeEngine(): Promise<EngineId> {
  const saved = await db.getSetting(ACTIVE_KEY).catch(() => null);
  return saved === 'claude' || !saved ? 'claude' : (saved as EngineId);
}
export async function setActiveEngine(id: EngineId): Promise<void> {
  const engines = await listEngines();
  const target = engines.find((engine) => engine.id === id);
  if (!target?.available) throw new Error(`${target?.name ?? id} can't build yet.`);
  await db.setSetting(ACTIVE_KEY, id);
}
/** The executable the runner starts for a build/fix session. Only Claude today. */
export function engineCommand(_id: EngineId = 'claude'): string {
  return config.factory.claudePath;
}

// ---- API keys for any provider ----
// Each key is checked with the provider (a cheap "list models" call), then stored encrypted.
// 401/403 → rejected. Any other failure (provider down, unknown endpoint) → saved as "not checked".
export type KeyProvider = 'anthropic' | 'openrouter' | 'openai' | 'gemini' | 'kimi' | 'glm' | 'deepseek' | 'qwen' | 'mistral';
interface KeySpec { name: string; engine: EngineId; prefix?: RegExp; hint: string; check?: (key: string) => Promise<Response> }
const bearer = (url: string) => (key: string) => fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
export const KEY_SPECS: Record<KeyProvider, KeySpec> = {
  anthropic: { name: 'Anthropic (Claude)', engine: 'claude', prefix: /^sk-ant-/, hint: 'console.anthropic.com → API keys', check: (key) => fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10_000) }) },
  openrouter: { name: 'OpenRouter', engine: 'openrouter', prefix: /^sk-or-/, hint: 'openrouter.ai → Keys', check: bearer('https://openrouter.ai/api/v1/key') },
  openai: { name: 'OpenAI (ChatGPT)', engine: 'openai', prefix: /^sk-/, hint: 'platform.openai.com → API keys', check: bearer('https://api.openai.com/v1/models') },
  gemini: { name: 'Google Gemini', engine: 'gemini', hint: 'aistudio.google.com → Get API key', check: (key) => fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10_000) }) },
  kimi: { name: 'Kimi (Moonshot)', engine: 'kimi', prefix: /^sk-/, hint: 'platform.moonshot.ai → API keys', check: bearer('https://api.moonshot.ai/v1/models') },
  glm: { name: 'GLM (Zhipu / Z.ai)', engine: 'glm', hint: 'z.ai → API keys', check: bearer('https://api.z.ai/api/paas/v4/models') },
  deepseek: { name: 'DeepSeek', engine: 'deepseek', prefix: /^sk-/, hint: 'platform.deepseek.com → API keys', check: bearer('https://api.deepseek.com/models') },
  qwen: { name: 'Qwen (Alibaba)', engine: 'qwen', prefix: /^sk-/, hint: 'Alibaba Cloud Model Studio → API keys', check: bearer('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models') },
  mistral: { name: 'Mistral', engine: 'mistral', hint: 'console.mistral.ai → API keys', check: bearer('https://api.mistral.ai/v1/models') },
};
export interface KeyStatus { provider: KeyProvider; name: string; engine: EngineId; hint: string; hasKey: boolean; last4: string | null; verified: boolean | null; note: string | null; usageUsd?: number | null; limitUsd?: number | null; freeTier?: boolean | null }
const keySetting = (provider: KeyProvider) => `factory_key_${provider}`;
const keyCache = new Map<KeyProvider, { at: number; status: KeyStatus }>();

async function storedKey(provider: KeyProvider): Promise<string | null> {
  // OpenRouter keys saved by the earlier single-key form live under the old name.
  const saved = await db.getSetting(keySetting(provider)).catch(() => null) || (provider === 'openrouter' ? await db.getSetting('factory_openrouter_key').catch(() => null) : null);
  if (!saved) return null;
  try { return decrypt(String(saved)); } catch { return null; }
}

async function checkKey(provider: KeyProvider, key: string): Promise<Pick<KeyStatus, 'verified' | 'note' | 'usageUsd' | 'limitUsd' | 'freeTier'>> {
  const spec = KEY_SPECS[provider];
  if (!spec.check) return { verified: null, note: 'Saved (not checked)' };
  let response: Response;
  try { response = await spec.check(key); } catch { return { verified: null, note: 'Saved — could not reach the provider to check it' }; }
  if (response.status === 401 || response.status === 403) throw new Error(`${spec.name} did not accept this key.`);
  if (!response.ok) return { verified: null, note: `Saved — ${spec.name} answered ${response.status} when checking` };
  if (provider === 'openrouter') {
    const data = ((await response.json().catch(() => ({}))) as { data?: Record<string, unknown> }).data ?? {};
    const num = (value: unknown) => (typeof value === 'number' ? value : null);
    return { verified: true, note: null, usageUsd: num(data.usage), limitUsd: num(data.limit), freeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null };
  }
  return { verified: true, note: null };
}

export async function setProviderKey(provider: KeyProvider, key: string) {
  const spec = KEY_SPECS[provider];
  if (!spec) throw new Error('Unknown provider.');
  const trimmed = key.trim();
  if (trimmed.length < 12 || /\s/.test(trimmed)) throw new Error('That key looks incomplete.');
  if (spec.prefix && !spec.prefix.test(trimmed)) throw new Error(`That does not look like a ${spec.name} key.`);
  const checked = await checkKey(provider, trimmed);
  await db.setSetting(keySetting(provider), encrypt(trimmed));
  keyCache.set(provider, { at: Date.now(), status: { provider, name: spec.name, engine: spec.engine, hint: spec.hint, hasKey: true, last4: trimmed.slice(-4), ...checked } });
}
export async function removeProviderKey(provider: KeyProvider) {
  await db.setSetting(keySetting(provider), '').catch(() => {});
  if (provider === 'openrouter') await db.setSetting('factory_openrouter_key', '').catch(() => {});
  keyCache.delete(provider);
}
export async function keyStatuses(): Promise<KeyStatus[]> {
  return Promise.all((Object.keys(KEY_SPECS) as KeyProvider[]).map(async (provider) => {
    const spec = KEY_SPECS[provider];
    const base = { provider, name: spec.name, engine: spec.engine, hint: spec.hint };
    const key = await storedKey(provider);
    if (!key) return { ...base, hasKey: false, last4: null, verified: null, note: null };
    const cached = keyCache.get(provider);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.status;
    let status: KeyStatus;
    try { status = { ...base, hasKey: true, last4: key.slice(-4), ...(await checkKey(provider, key)) }; }
    catch (error) { status = { ...base, hasKey: true, last4: key.slice(-4), verified: false, note: error instanceof Error ? error.message : 'Key rejected' }; }
    keyCache.set(provider, { at: Date.now(), status });
    return status;
  }));
}

// ---- accounts: sign-ins that already exist on this computer ----
// ThemeBot never reads tokens — it only notices that a provider's own app is signed in, and lets
// the user link that sign-in with one click. Claude signs in through ThemeBot's own login.
export type AccountProvider = 'claude' | 'openai' | 'gemini' | 'kimi';
export interface AccountStatus { provider: AccountProvider; name: string; via: string; detected: boolean; linked: boolean; account: string | null; plan: string | null; signInHelp: string }
const linkSetting = (provider: AccountProvider) => `factory_link_${provider}`;
const home = os.homedir();
async function nonEmptyDir(dir: string) { try { return (await readdir(dir)).length > 0; } catch { return false; } }
async function exists(file: string) { try { await stat(file); return true; } catch { return false; } }

export async function accountStatuses(): Promise<AccountStatus[]> {
  const claude = await claudeAccount();
  const codexSigned = await exists(path.join(home, '.codex', 'auth.json'));
  const codexInstalled = await exists(path.join(home, '.codex'));
  const geminiSigned = await exists(path.join(home, '.gemini', 'oauth_creds.json'));
  let geminiEmail: string | null = null;
  try { const accounts = JSON.parse(await readFile(path.join(home, '.gemini', 'google_accounts.json'), 'utf8')) as { active?: string }; geminiEmail = accounts.active ?? null; } catch { /* none */ }
  const kimiSigned = (await nonEmptyDir(path.join(home, '.kimi', 'credentials'))) || (await nonEmptyDir(path.join(home, '.kimi-code', 'credentials')));
  const linked = async (provider: AccountProvider) => (await db.getSetting(linkSetting(provider)).catch(() => null)) === '1';
  return [
    { provider: 'claude', name: 'Claude', via: 'Claude Code', detected: claude.connected, linked: claude.connected, account: claude.account, plan: claude.plan, signInHelp: 'Sign in with your Claude account' },
    { provider: 'openai', name: 'ChatGPT', via: 'Codex', detected: codexSigned, linked: codexSigned && await linked('openai'), account: null, plan: null, signInHelp: codexInstalled ? 'Codex is installed but not signed in — run: codex login' : 'Install OpenAI Codex, then run: codex login' },
    { provider: 'gemini', name: 'Gemini', via: 'Gemini CLI', detected: geminiSigned, linked: geminiSigned && await linked('gemini'), account: geminiEmail, plan: null, signInHelp: 'Install the Gemini CLI, then run: gemini (and pick "Login with Google")' },
    { provider: 'kimi', name: 'Kimi', via: 'Kimi Code', detected: kimiSigned, linked: kimiSigned && await linked('kimi'), account: null, plan: null, signInHelp: 'Install Kimi Code, then run: kimi login' },
  ];
}
export async function linkAccount(provider: AccountProvider, on: boolean) {
  if (provider === 'claude') throw new Error('Claude is linked through its own sign-in.');
  const status = (await accountStatuses()).find((entry) => entry.provider === provider);
  if (on && !status?.detected) throw new Error(`${status?.name ?? provider} is not signed in on this computer yet.`);
  await db.setSetting(linkSetting(provider), on ? '1' : '');
}

// ---- accounts ----
async function claudeAccount(): Promise<{ account: string | null; plan: string | null; connected: boolean }> {
  try {
    const raw = JSON.parse(await readFile(path.join(os.homedir(), '.claude.json'), 'utf8')) as { oauthAccount?: Record<string, unknown> };
    const account = raw.oauthAccount;
    if (!account) return { account: null, plan: null, connected: false };
    const type = String(account.organizationType ?? '');
    const tier = String(account.organizationRateLimitTier ?? '');
    const multiplier = tier.match(/(\d+)x/)?.[1];
    const plan = type.includes('max') ? `Max${multiplier ? ` (${multiplier}×)` : ''}` : type.includes('pro') ? 'Pro' : type.includes('team') ? 'Team' : type.includes('enterprise') ? 'Enterprise' : type ? type.replace(/_/g, ' ') : null;
    return { account: account.emailAddress ? String(account.emailAddress) : null, plan, connected: true };
  } catch { return { account: null, plan: null, connected: false }; }
}

export async function listEngines(): Promise<EngineInfo[]> {
  const claude = await claudeAccount();
  const soon = (id: EngineId, name: string, maker: string, note = 'Coming soon'): EngineInfo => ({ id, name, maker, available: false, note, connected: false, account: null, plan: null });
  const keys = await keyStatuses();
  const accounts = await accountStatuses();
  const list: EngineInfo[] = [
    { id: 'claude', name: 'Claude', maker: 'Anthropic', available: true, ...claude },
    { id: 'openrouter', name: 'OpenRouter', maker: 'Many models, one key', available: false, note: 'Building with it — coming soon', connected: false, account: null, plan: null },
    soon('openai', 'ChatGPT', 'OpenAI'),
    soon('gemini', 'Gemini', 'Google'),
    soon('kimi', 'Kimi', 'Moonshot AI'),
    soon('glm', 'GLM', 'Zhipu AI', 'Coming soon · open source'),
    soon('meta', 'Muse', 'Meta'),
    soon('deepseek', 'DeepSeek', 'DeepSeek', 'Coming soon · open source'),
    soon('qwen', 'Qwen', 'Alibaba', 'Coming soon · open source'),
    soon('mistral', 'Mistral', 'Mistral AI', 'Coming soon · open source'),
  ];
  // An engine counts as connected when it has a working key or a linked sign-in.
  return list.map((engine) => {
    if (engine.id === 'claude') return engine;
    const key = keys.find((entry) => entry.engine === engine.id && entry.hasKey && entry.verified !== false);
    const account = accounts.find((entry) => entry.provider === engine.id && entry.linked);
    if (!key && !account) return engine;
    return { ...engine, connected: true, account: account ? `Signed in with ${account.via}${account.account ? ` · ${account.account}` : ''}` : `API key ••••${key!.last4}` };
  });
}

// ---- usage ----
// One JSON line per event in <workspace>/.factory/usage.jsonl — the raw feed for dashboards.
//   type 'session': one AI session (build, fix round, store setup). Tokens split by kind, per model.
//   type 'stage':   a timed step with no AI tokens (the QA check), with its score.
//   type 'build':   a whole build finishing: wall-clock time, rounds, final score, status.
export interface ModelTokens { input: number; output: number; cacheRead: number; cacheWrite: number; reportedUsd: number | null; estUsd: number | null }
export interface SessionEntry {
  v: 2; type: 'session'; at: number; engine: EngineId; kind: string; modelSetting: string | null;
  jobId: string | null; jobName: string | null; sessionId: string | null;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  models: Record<string, ModelTokens>;          // exact model ids used (the main model + any helpers)
  costUsd: number | null;                         // what Claude reported for the session
  estUsd: number | null;                          // our estimate at API list prices (see PRICES)
  durationMs: number | null; apiMs: number | null; turns: number | null; isError: boolean;
}
export interface StageEntry { v: 2; type: 'stage'; at: number; kind: string; jobId: string | null; jobName: string | null; durationMs: number; score: number | null; ok: boolean }
export interface BuildEntry { v: 2; type: 'build'; at: number; jobId: string; jobName: string; status: string; startedAt: string | null; finishedAt: string; wallMs: number | null; rounds: number; score: number | null; threshold: number | null; model: string | null }
export type UsageEntry = SessionEntry | StageEntry | BuildEntry;
/** Older lines written before v2 (flat token counts, no type). */
interface LegacyEntry { at: number; kind: string; jobId: string | null; jobName: string | null; model: string | null; inputTokens: number; outputTokens: number; cacheTokens: number; costUsd: number | null; durationMs: number | null }

/** API list prices, USD per million tokens (input, output, cache read, cache write 5-min).
 *  Matched by model-id prefix, longest first. An estimate — subscription plans are not billed per token. */
const PRICES: Array<[string, number, number, number, number]> = [
  ['claude-fable-5-1', 10, 50, 0.25, 12.5],
  ['claude-mythos-5-1', 10, 50, 0.25, 12.5],
  ['claude-fable-5', 10, 50, 1, 12.5],
  ['claude-opus-5-5', 4, 20, 0.2, 5],
  ['claude-opus-5', 5, 25, 0.5, 6.25],
  ['claude-opus-4-8', 5, 25, 0.5, 6.25], ['claude-opus-4-7', 5, 25, 0.5, 6.25], ['claude-opus-4-6', 5, 25, 0.5, 6.25], ['claude-opus-4-5', 5, 25, 0.5, 6.25],
  ['claude-opus-4', 15, 75, 1.5, 18.75],
  ['claude-sonnet-5', 2, 10, 0.2, 2.5],
  ['claude-sonnet-4', 3, 15, 0.3, 3.75],
  ['claude-haiku-4-5', 1, 5, 0.1, 1.25],
  ['claude-3-5-haiku', 0.8, 4, 0.08, 1],
];
function priceFor(model: string) {
  const id = model.toLowerCase();
  return PRICES.filter(([prefix]) => id.startsWith(prefix)).sort((x, y) => y[0].length - x[0].length)[0] ?? null;
}
export function estimateUsd(model: string, t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const [, input, output, read, write] = price;
  return (t.input * input + t.output * output + t.cacheRead * read + t.cacheWrite * write) / 1e6;
}

async function append(entry: UsageEntry) {
  await mkdir(path.dirname(usagePath()), { recursive: true }).catch(() => {});
  await appendFile(usagePath(), JSON.stringify(entry) + '\n').catch(() => {});
}

/** Called by the runner (and the store-setup bot) with a session's final stream-json "result" message. */
export async function recordUsage(message: Record<string, unknown>, tag: { jobId?: string; jobName?: string; kind?: string; model?: string }) {
  const usage = (message.usage ?? {}) as Record<string, number>;
  // A session that finished fine proves the limit is over — stop showing "paused".
  if (!message.is_error) void clearLimit();
  const perModel = (message.modelUsage ?? {}) as Record<string, Record<string, number>>;
  const models: Record<string, ModelTokens> = {};
  for (const [id, m] of Object.entries(perModel)) {
    const tokens = { input: Number(m.inputTokens ?? 0), output: Number(m.outputTokens ?? 0), cacheRead: Number(m.cacheReadInputTokens ?? 0), cacheWrite: Number(m.cacheCreationInputTokens ?? 0) };
    models[id] = { ...tokens, reportedUsd: typeof m.costUSD === 'number' ? m.costUSD : null, estUsd: estimateUsd(id, tokens) };
  }
  const totals = { input: Number(usage.input_tokens ?? 0), output: Number(usage.output_tokens ?? 0), cacheRead: Number(usage.cache_read_input_tokens ?? 0), cacheWrite: Number(usage.cache_creation_input_tokens ?? 0) };
  // Per-model numbers cover helper models too, so prefer their sum when present.
  const modelList = Object.values(models);
  const sumOf = (key: keyof ModelTokens) => modelList.reduce((total, m) => total + Number(m[key] ?? 0), 0);
  const tokens = modelList.length ? { input: sumOf('input'), output: sumOf('output'), cacheRead: sumOf('cacheRead'), cacheWrite: sumOf('cacheWrite') } : totals;
  const estimates = modelList.map((m) => m.estUsd).filter((value): value is number => value != null);
  await append({
    v: 2, type: 'session', at: Date.now(), engine: 'claude', kind: tag.kind ?? 'session', modelSetting: tag.model ?? null,
    jobId: tag.jobId ?? null, jobName: tag.jobName ?? null, sessionId: typeof message.session_id === 'string' ? message.session_id : null,
    inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cacheRead, cacheWriteTokens: tokens.cacheWrite,
    models,
    costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null,
    estUsd: estimates.length ? estimates.reduce((x, y) => x + y, 0) : null,
    durationMs: typeof message.duration_ms === 'number' ? message.duration_ms : null,
    apiMs: typeof message.duration_api_ms === 'number' ? message.duration_api_ms : null,
    turns: typeof message.num_turns === 'number' ? message.num_turns : null,
    isError: message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success'),
    // A running total saved mid-session (see runner.ts) — several can belong to one session.
    ...(message.partial === true ? { partial: true } : {}),
  });
}

export async function recordStage(entry: Omit<StageEntry, 'v' | 'type' | 'at'>) { await append({ v: 2, type: 'stage', at: Date.now(), ...entry }); }

export async function recordBuild(job: { id: string; name: string; status: string; started_at: string | null; created_at: string; finished_at: string | null; iteration: number; last_score: number | null; score_threshold: number | null }, model: string | null) {
  const finishedAt = job.finished_at ?? new Date().toISOString();
  const start = job.started_at ?? job.created_at;
  await append({ v: 2, type: 'build', at: Date.now(), jobId: job.id, jobName: job.name, status: job.status, startedAt: start, finishedAt,
    wallMs: start ? new Date(finishedAt).getTime() - new Date(start).getTime() : null, rounds: job.iteration, score: job.last_score, threshold: job.score_threshold, model });
}

/** Called when a session's output says a usage limit was hit. Keeps Claude's own reset wording. */
export async function clearLimit() {
  await db.setSetting(LIMIT_KEY, '').catch(() => {});
}

export async function recordLimit(text: string) {
  const reset = text.match(/resets?\s+(?:at\s+)?([^\n.|]{2,40})/i)?.[1]?.trim() ?? null;
  await db.setSetting(LIMIT_KEY, JSON.stringify({ at: Date.now(), reset })).catch(() => {});
}

async function readRaw(): Promise<Array<UsageEntry | LegacyEntry>> {
  try {
    return (await readFile(usagePath(), 'utf8')).split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line) as UsageEntry | LegacyEntry; } catch { return null; } })
      .filter((entry): entry is UsageEntry | LegacyEntry => entry != null);
  } catch { return []; }
}
export async function readUsage(): Promise<UsageEntry[]> {
  return (await readRaw()).map((entry): UsageEntry => {
    if ('v' in entry) return entry;
    const legacy = entry as LegacyEntry;
    return { v: 2, type: 'session', at: legacy.at, engine: 'claude', kind: legacy.kind, modelSetting: legacy.model, jobId: legacy.jobId, jobName: legacy.jobName, sessionId: null,
      inputTokens: legacy.inputTokens, outputTokens: legacy.outputTokens, cacheReadTokens: legacy.cacheTokens, cacheWriteTokens: 0, models: {},
      costUsd: legacy.costUsd, estUsd: null, durationMs: legacy.durationMs, apiMs: null, turns: null, isError: false };
  });
}

const sessionsOf = (entries: UsageEntry[]) => entries.filter((entry): entry is SessionEntry => entry.type === 'session');
const sum = (entries: SessionEntry[]) => ({
  // One session can be saved in several parts (running totals), so count distinct sessions.
  sessions: new Set(entries.map((entry) => entry.sessionId ?? `at-${entry.at}`)).size,
  tokens: entries.reduce((total, entry) => total + entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens, 0),
  inputTokens: entries.reduce((total, entry) => total + entry.inputTokens, 0),
  outputTokens: entries.reduce((total, entry) => total + entry.outputTokens, 0),
  cacheReadTokens: entries.reduce((total, entry) => total + entry.cacheReadTokens, 0),
  cacheWriteTokens: entries.reduce((total, entry) => total + entry.cacheWriteTokens, 0),
  costUsd: entries.reduce((total, entry) => total + (entry.costUsd ?? 0), 0),
  estUsd: entries.reduce((total, entry) => total + (entry.estUsd ?? 0), 0),
  minutes: Math.round(entries.reduce((total, entry) => total + (entry.durationMs ?? 0), 0) / 60000),
  turns: entries.reduce((total, entry) => total + (entry.turns ?? 0), 0),
});

export async function usageSummary() {
  const all = await readUsage();
  const sessions = sessionsOf(all);
  const now = Date.now();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const today = sessions.filter((entry) => entry.at >= startOfDay.getTime());
  const week = sessions.filter((entry) => entry.at >= now - 7 * 86_400_000);
  const days = Array.from({ length: 7 }, (_, index) => {
    const start = new Date(startOfDay.getTime() - (6 - index) * 86_400_000);
    const end = start.getTime() + 86_400_000;
    return { day: start.toISOString().slice(0, 10), ...sum(week.filter((entry) => entry.at >= start.getTime() && entry.at < end)) };
  });
  const byModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; estUsd: number }> = {};
  for (const entry of week) for (const [id, m] of Object.entries(entry.models)) {
    const row = (byModel[id] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estUsd: 0 });
    row.input += m.input; row.output += m.output; row.cacheRead += m.cacheRead; row.cacheWrite += m.cacheWrite; row.estUsd += m.estUsd ?? 0;
  }
  const finished = all.filter((entry): entry is BuildEntry => entry.type === 'build');
  const byJob = new Map<string, SessionEntry[]>();
  for (const entry of week) if (entry.jobId) byJob.set(entry.jobId, [...(byJob.get(entry.jobId) ?? []), entry]);
  const builds = [...byJob.entries()].map(([jobId, entries]) => {
    const done = [...finished].reverse().find((entry) => entry.jobId === jobId);
    return { jobId, jobName: entries[0].jobName, lastAt: Math.max(...entries.map((entry) => entry.at)), wallMs: done?.wallMs ?? null, status: done?.status ?? null, score: done?.score ?? null, ...sum(entries) };
  }).sort((a, b) => b.lastAt - a.lastAt).slice(0, 6);
  let lastLimit: { at: number; reset: string | null } | null = null;
  try { const raw = await db.getSetting(LIMIT_KEY); if (raw) lastLimit = JSON.parse(String(raw)); } catch { /* none */ }
  return { today: sum(today), week: sum(week), days, byModel, builds, lastLimit, trackedSince: all[0]?.at ?? null };
}
