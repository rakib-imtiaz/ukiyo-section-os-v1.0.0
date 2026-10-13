#!/usr/bin/env node
// ThemeBot Engine — entry point. Started by the factory runner in a build's workspace, in place of
// `claude -p`, with the same arguments plus the build's budget (see args.ts). It prints stream-json
// on stdout (events.ts) and exits 0 when the task finished, 1 otherwise.
//
// The Anthropic key arrives in ANTHROPIC_API_KEY. It is read once, removed from this process's
// environment, and never passed to the commands the Bash tool runs.
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Session, type AgentOutcome } from './agent';
import { parseArgs } from './args';
import { ScriptedModelClient, createAnthropicClient, type ModelClient, type ScriptedTurn } from './client';
import { CostMeter } from './cost';
import { Emitter } from './events';
import { MODELS } from './models';
import { loadPermissions } from './permissions';
import { expandSlashCommand } from './prompt';
import { commandEnv, findBash } from './tools/bash';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const SUBTYPE: Record<AgentOutcome['status'], string> = {
  done: 'success', budget: 'error_max_budget_usd', max_turns: 'error_max_turns', refusal: 'error_refusal',
  error: 'error_during_execution', aborted: 'error_during_execution', context: 'error_during_execution',
};

async function main(): Promise<number> {
  const started = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const sessionId = randomUUID();
  const emitter = new Emitter((line) => { process.stdout.write(line); }, sessionId);
  const fail = (text: string) => { emitter.result({ subtype: 'error_during_execution', is_error: true, result: text, duration_ms: Date.now() - started, num_turns: 0, total_cost_usd: 0 }); return 1; };

  if (args.errors.length) return fail(`ThemeBot Engine: ${args.errors.join('; ')}`);
  const workspace = await realpath(process.cwd());
  const raw = args.prompt ?? (await readStdin());
  if (!raw.trim()) return fail('ThemeBot Engine: no task was given (pass it after -p or on stdin).');
  const task = await expandSlashCommand(raw, workspace);

  // TEST HOOK — the automated tests (and nothing else) set THEMEBOT_ENGINE_FAKE_SCRIPT to a JSON list of
  // scripted model turns: the engine then plays those back and never calls the API.
  let client: ModelClient;
  const script = process.env.THEMEBOT_ENGINE_FAKE_SCRIPT;
  if (script) {
    client = new ScriptedModelClient(JSON.parse(readFileSync(script, 'utf8')) as ScriptedTurn[]);
  } else {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key) return fail('authentication_error: ThemeBot Engine has no Anthropic API key (ANTHROPIC_API_KEY is not set).');
    client = createAnthropicClient(key);
  }
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  const abort = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => abort.abort());

  const permissions = await loadPermissions(workspace);
  const meter = new CostMeter({ capUsd: args.budgetUsd, ledgerPath: args.ledger, sessionId });
  const bashPath = findBash();
  const session = new Session({
    client, workspace, tier: args.tier, meter, emitter, permissions, bashPath, commandEnv: commandEnv(process.env), signal: abort.signal,
    appendSystemPrompt: args.appendSystemPrompt ?? undefined, maxTurns: args.maxTurns ?? undefined,
  });
  emitter.init(MODELS[args.tier].id, workspace, session.mainToolNames(), { tier: args.tier, budget_usd: args.budgetUsd, command: task.command });
  if (args.chrome) emitter.progress('Checking in Chrome is not available on ThemeBot Engine yet — verify with the project\'s own scripts and screenshots.');
  if (meter.capUsd != null) emitter.progress(`Build budget: $${(await meter.buildSpentUsd()).toFixed(2)} of $${meter.capUsd.toFixed(2)} used so far.`);

  let outcome: AgentOutcome;
  try {
    outcome = await session.run(task.text);
  } catch (error) {
    outcome = { status: 'error', text: '', turns: 0, detail: error instanceof Error ? error.message : String(error) };
  }

  const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const model of meter.byModel.values()) {
    totals.input_tokens += model.input; totals.output_tokens += model.output; totals.cache_read_input_tokens += model.cacheRead; totals.cache_creation_input_tokens += model.cacheWrite;
  }
  const buildSpent = await meter.buildSpentUsd();
  const done = outcome.status === 'done';
  emitter.result({
    subtype: SUBTYPE[outcome.status],
    is_error: !done,
    result: done ? outcome.text : [outcome.detail, outcome.text].filter(Boolean).join('\n\n'),
    duration_ms: Date.now() - started,
    duration_api_ms: session.apiMs,
    num_turns: outcome.turns,
    total_cost_usd: meter.sessionUsd,
    usage: totals,
    modelUsage: meter.modelUsage(),
    themebot: { status: outcome.status, tier: args.tier, budget_usd: meter.capUsd, build_spent_usd: buildSpent, unpriced_models: [...meter.unpriced] },
  });
  return done ? 0 : 1;
}

main().then(
  (code) => { process.stdout.write('', () => process.exit(code)); },
  (error) => {
    process.stderr.write(`ThemeBot Engine crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  },
);
