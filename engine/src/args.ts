// Command line. ThemeBot Engine accepts the flags the factory runner passes to `claude -p` (so the
// runner builds one argument list for either engine), plus its own budget flags.
//
//   -p, --print [prompt]          the task; without a value it is read from stdin
//   --model opus|sonnet|haiku     the session's tier (full ids from models.ts work too)
//   --append-system-prompt <text> extra instructions after the engine's system prompt
//   --max-budget-usd <n>          the WHOLE BUILD's cap in USD (shared through --ledger)
//   --ledger <file>               the build's spend ledger (one JSON line per priced response)
//   --max-turns <n>               turns per agent (safety net; the runner's clock is the real limit)
//   --chrome                      accepted; Chrome checks are not available on the engine yet
//   --output-format, --verbose, --no-session-persistence   accepted and ignored (always stream-json, never persisted)
import { tierOf, type Tier } from './models';

export interface EngineArgs {
  prompt: string | null;
  tier: Tier;
  appendSystemPrompt: string | null;
  budgetUsd: number | null;
  ledger: string | null;
  maxTurns: number | null;
  chrome: boolean;
  ignored: string[];
  errors: string[];
}

const WITH_VALUE_IGNORED = new Set(['--output-format', '--input-format', '--permission-mode', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--session-id', '--settings', '--add-dir', '--mcp-config']);
const FLAGS_IGNORED = new Set(['--verbose', '--no-session-persistence', '--dangerously-skip-permissions', '--include-partial-messages']);

export function parseArgs(argv: string[]): EngineArgs {
  const args: EngineArgs = { prompt: null, tier: 'opus', appendSystemPrompt: null, budgetUsd: null, ledger: null, maxTurns: null, chrome: false, ignored: [], errors: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) { args.errors.push(`${arg} needs a value`); return null; }
      index++;
      return next;
    };
    if (arg === '-p' || arg === '--print') {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) { args.prompt = next; index++; }
    } else if (arg === '--model') {
      const raw = value();
      if (raw !== null) { const tier = tierOf(raw.trim().toLowerCase()); if (tier) args.tier = tier; else args.errors.push(`unknown model "${raw}" (use opus, sonnet or haiku)`); }
    } else if (arg === '--append-system-prompt') {
      const raw = value();
      if (raw !== null) args.appendSystemPrompt = args.appendSystemPrompt ? `${args.appendSystemPrompt}\n\n${raw}` : raw;
    } else if (arg === '--max-budget-usd') {
      const raw = value();
      const amount = raw === null ? NaN : Number(raw);
      if (Number.isFinite(amount) && amount >= 0) args.budgetUsd = amount; else if (raw !== null) args.errors.push(`--max-budget-usd must be a number of dollars, got "${raw}"`);
    } else if (arg === '--ledger') {
      args.ledger = value();
    } else if (arg === '--max-turns') {
      const raw = value();
      const turns = raw === null ? NaN : Number(raw);
      if (Number.isInteger(turns) && turns > 0) args.maxTurns = turns; else if (raw !== null) args.errors.push(`--max-turns must be a positive whole number, got "${raw}"`);
    } else if (arg === '--chrome') {
      args.chrome = true;
    } else if (WITH_VALUE_IGNORED.has(arg)) {
      args.ignored.push(arg); index++;
    } else if (FLAGS_IGNORED.has(arg)) {
      args.ignored.push(arg);
    } else if (arg.startsWith('-')) {
      args.ignored.push(arg);
    } else if (args.prompt === null) {
      args.prompt = arg;
    } else {
      args.ignored.push(arg);
    }
  }
  return args;
}
