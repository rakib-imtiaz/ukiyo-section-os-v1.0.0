// The agent loop: ThemeBot Engine's replacement for Claude Code's harness.
//
// A manual streaming loop over the Messages API (beta namespace): send the conversation, run the
// tool calls that come back, append everything, repeat until the model ends its turn. Owning the loop
// is what lets the engine check the budget before every request, size max_tokens to what is left,
// stop on the runner's kill, and run sub-agents in-process on their own (cheaper) tier.
//
// The history is append-only — nothing sent is ever edited or removed — which keeps the prompt cache
// warm and keeps preserved thinking blocks valid. Assistant turns go back exactly as received
// (thinking blocks included), apart from the documented rule for a mid-output refusal fallback.
import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaMessageStreamParams, BetaTextBlockParam, BetaToolResultBlockParam, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { randomUUID } from 'node:crypto';
import type { ModelClient } from './client';
import { BudgetExceeded, billableParts, type CostMeter, type Reservation } from './cost';
import type { Emitter } from './events';
import { BETAS, capTier, resolveModel, worstCaseRates, type ModelSpec, type Tier } from './models';
import type { Permissions } from './permissions';
import { subAgentPrompt, systemPrompt, type PromptEnv } from './prompt';
import { apiTools, runTool, toolsFor, type ToolDef } from './tools/index';
import type { AgentRequest, Todo, ToolContext, ToolResult } from './tools/types';

/** Below this many output tokens a request is not worth sending (thinking alone can use more). */
export const MIN_REQUEST_TOKENS = 4096;
const IMAGE_TOKENS = 5000;           // generous: high-resolution vision on the newest models
const CHARS_PER_TOKEN = 3;           // conservative (code and JSON tokenize densely)
const MAX_JSON_RETRIES = 2;
const MAX_CONTINUATIONS = 3;

const COMPACTION_INSTRUCTIONS = 'Summarize for an autonomous build agent that will continue this exact task with no other memory. Keep: the task and every rule it set; the completion/signal files it must write; every file created or changed (paths) and why; what has been verified and how; what is still to do, in order; ids, URLs, handles and theme ids discovered; errors seen and how they were resolved. Omit file contents that can be re-read from disk.';

export type AgentStatus = 'done' | 'budget' | 'refusal' | 'max_turns' | 'error' | 'aborted' | 'context';
export interface AgentOutcome { status: AgentStatus; text: string; turns: number; detail?: string }

export interface SessionOptions {
  client: ModelClient;
  workspace: string;
  tier: Tier;
  meter: CostMeter;
  emitter: Emitter;
  permissions: Permissions;
  bashPath: string | null;
  commandEnv: NodeJS.ProcessEnv;
  signal: AbortSignal;
  appendSystemPrompt?: string;
  /** Per agent. */
  maxTurns?: number;
  subAgentMaxTurns?: number;
  maxConcurrentAgents?: number;
  /** For per-tier overrides (models.ts resolveModel). */
  env?: NodeJS.ProcessEnv;
  date?: string;
  fetchImpl?: typeof fetch;
}

/** Rough upper estimate of tokens in request content (images counted flat, not by their base64). */
export function estimateTokens(value: unknown): number {
  let images = 0;
  const text = JSON.stringify(value, (key, entry) => {
    if (entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'image') { images++; return null; }
    return entry;
  }) ?? '';
  return Math.ceil(text.length / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

/**
 * Assistant content to send back. After a mid-output refusal fallback, the blocks before the last
 * `fallback` boundary that the fallback model never saw as context (thinking, tool calls, unpaired
 * server-tool calls) are left out; text, paired server-tool blocks and everything after it stay.
 */
export function echoable(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const boundary = content.map((block) => block.type).lastIndexOf('fallback');
  const kept = boundary < 0 ? content : content.filter((block, index) => {
    if (index >= boundary) return true;
    if (block.type === 'thinking' || block.type === 'redacted_thinking' || block.type === 'tool_use') return false;
    if (block.type === 'server_tool_use') return content.some((other, at) => at < boundary && 'tool_use_id' in other && (other as { tool_use_id?: string }).tool_use_id === block.id);
    return true;
  });
  return kept as unknown as BetaContentBlockParam[];
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try { return await task(); } finally { this.active--; this.waiting.shift()?.(); }
  }
}

interface AgentSpec {
  kind: 'main' | 'general-purpose' | 'explore';
  tier: Tier;
  prompt: string;
  description: string;
  parentToolUseId: string | null;
  maxTurns: number;
}

const textOf = (content: BetaContentBlock[]) => content.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n').trim();

export class Session {
  readonly sessionId: string;
  readonly todos: Todo[] = [];
  /** Set once anything in the session hits the budget: every loop stops at its next request. */
  budgetHit: BudgetExceeded | null = null;
  apiMs = 0;
  private readonly agents: Semaphore;
  private readonly promptEnv: PromptEnv;

  constructor(private readonly options: SessionOptions) {
    this.sessionId = options.emitter.sessionId;
    this.agents = new Semaphore(Math.max(1, options.maxConcurrentAgents ?? 4));
    this.promptEnv = {
      workspace: options.workspace, permissions: options.permissions, bashAvailable: Boolean(options.bashPath),
      toolNames: [], date: options.date ?? new Date().toISOString().slice(0, 10), platform: process.platform,
    };
  }

  /** The main agent's tool names (for the init line). */
  mainToolNames(): string[] { return toolsFor(this.options.permissions.tools, 'main').map((tool) => tool.name); }

  run(prompt: string): Promise<AgentOutcome> {
    return this.loop({ kind: 'main', tier: this.options.tier, prompt, description: 'main', parentToolUseId: null, maxTurns: this.options.maxTurns ?? 1500 });
  }

  // ---- one request ------------------------------------------------------------------------------

  private params(spec: ModelSpec, system: BetaTextBlockParam[], tools: ReturnType<typeof apiTools>, messages: BetaMessageParam[], maxTokens: number): BetaMessageStreamParams {
    const params: BetaMessageStreamParams = {
      model: spec.id,
      max_tokens: maxTokens,
      system,
      messages,
      // Automatic breakpoint on the growing conversation tail (the system block has its own).
      cache_control: { type: 'ephemeral' },
    };
    if (tools.length) params.tools = tools;
    if (spec.thinking === 'adaptive') params.thinking = spec.progressUpdates ? { type: 'adaptive', display: 'updates' } : { type: 'adaptive' };
    if (spec.effort) params.output_config = { effort: spec.effort };
    const betas: string[] = [];
    if (spec.fallbacks) { params.fallbacks = spec.fallbacks; betas.push(BETAS.fallbacks); }
    if (spec.progressUpdates) betas.push(BETAS.progressUpdates);
    if (spec.compaction) {
      params.context_management = { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: spec.compactionTrigger }, instructions: COMPACTION_INSTRUCTIONS }] };
      betas.push(BETAS.compaction);
    }
    if (betas.length) params.betas = betas;
    return params;
  }

  /**
   * Budget for the next request: input at the worst rate it could be billed (a full cache write, twice
   * when a refusal fallback could re-run it), a compaction pass when one is near, and as much output as
   * the rest allows (capped at the model's request size). Throws BudgetExceeded when too little is left.
   */
  private async plan(spec: ModelSpec, estInput: number): Promise<{ maxTokens: number; reservation: Reservation }> {
    const worst = worstCaseRates(spec);
    const inputUsd = (estInput * Math.max(worst.cacheWrite5m, worst.input) / 1e6) * (spec.fallbacks ? 2 : 1);
    const compactionUsd = spec.compaction && estInput > spec.compactionTrigger * 0.8 ? (estInput * worst.input + 16_000 * worst.output) / 1e6 : 0;
    const fixedUsd = inputUsd + compactionUsd;
    const { reservation, plan } = await this.options.meter.reserveFor((room) => {
      const affordable = Number.isFinite(room) ? Math.floor(((room - fixedUsd) / worst.output) * 1e6) : spec.requestMaxTokens;
      const maxTokens = Math.min(spec.requestMaxTokens, affordable);
      return maxTokens < MIN_REQUEST_TOKENS ? null : { maxTokens, usd: fixedUsd + (maxTokens * worst.output) / 1e6 };
    }, fixedUsd + (MIN_REQUEST_TOKENS * worst.output) / 1e6);
    return { maxTokens: plan.maxTokens, reservation };
  }

  /** One priced request (its budget already reserved). Returns the message, or throws (API errors / abort). */
  private async request(spec: ModelSpec, params: BetaMessageStreamParams, reservation: Reservation, parentToolUseId: string | null): Promise<BetaMessage> {
    const { meter, client, emitter, signal } = this.options;
    const started = Date.now();
    let message: BetaMessage;
    try {
      message = await client.send(params, { signal, onActivity: () => emitter.heartbeat() });
    } catch (error) {
      meter.release(reservation);
      throw error;
    } finally {
      this.apiMs += Date.now() - started;
    }
    const parts = billableParts(message.usage, message.model, spec.id);
    await meter.settle(reservation, parts);
    emitter.assistant(message, parentToolUseId, parts.slice(1));
    for (const block of message.content) {
      if (block.type === 'thinking' && block.thinking.trim()) emitter.progress(block.thinking);
      if (block.type === 'fallback') emitter.progress(`${block.from.model} declined this request; ${block.to.model} continued it.`, 'err');
    }
    return message;
  }

  // ---- the loop ---------------------------------------------------------------------------------

  private async loop(agent: AgentSpec): Promise<AgentOutcome> {
    const { options } = this;
    const spec = resolveModel(agent.tier, options.env);
    const tools: ToolDef[] = toolsFor(options.permissions.tools, agent.kind);
    const toolDefs = apiTools(tools);
    const env = { ...this.promptEnv, toolNames: tools.map((tool) => tool.name) };
    const systemText = agent.kind === 'main'
      ? systemPrompt(env) + (options.appendSystemPrompt ? `\n\n${options.appendSystemPrompt}` : '')
      : subAgentPrompt(env, agent.description);
    const system: BetaTextBlockParam[] = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
    const messages: BetaMessageParam[] = [{ role: 'user', content: agent.prompt }];
    const context: ToolContext = {
      workspace: options.workspace, permissions: options.permissions, readState: new Map(), signal: options.signal,
      commandEnv: options.commandEnv, bashPath: options.bashPath, todos: agent.kind === 'main' ? this.todos : [],
      runAgent: agent.kind === 'main' ? (request) => this.subAgent(request, agent) : undefined,
      summarize: (text, prompt, url) => this.summarize(text, prompt, url, agent.parentToolUseId),
      fetchImpl: options.fetchImpl,
    };

    let turns = 0;
    let jsonRetries = 0;
    let continuations = 0;
    let lastText = '';
    // Next request's input estimate: the last response's prompt + its output + what was appended since.
    let estInput = estimateTokens({ system, tools: toolDefs, messages });

    while (true) {
      if (options.signal.aborted) return { status: 'aborted', text: lastText, turns };
      if (this.budgetHit) return { status: 'budget', text: lastText, turns, detail: this.budgetHit.message };
      if (turns >= agent.maxTurns) return { status: 'max_turns', text: lastText, turns, detail: `stopped after ${turns} turns` };

      let message: BetaMessage;
      let maxTokens: number;
      try {
        const plan = await this.plan(spec, estInput);
        maxTokens = plan.maxTokens;
        message = await this.request(spec, this.params(spec, system, toolDefs, messages, maxTokens), plan.reservation, agent.parentToolUseId);
        jsonRetries = 0;
      } catch (error) {
        if (error instanceof BudgetExceeded) { this.budgetHit ??= error; return { status: 'budget', text: lastText, turns, detail: error.message }; }
        if (options.signal.aborted || error instanceof Anthropic.APIUserAbortError) return { status: 'aborted', text: lastText, turns };
        if (error instanceof Anthropic.APIError) return { status: 'error', text: lastText, turns, detail: apiErrorText(error) };
        // Eager input streaming: a tool input the SDK could not parse at all. The turn never completed
        // (no tool_use id to answer), so re-issue it — a few times at most.
        if (jsonRetries++ < MAX_JSON_RETRIES) { options.emitter.progress('A tool call came back malformed; asking again.', 'err'); continue; }
        return { status: 'error', text: lastText, turns, detail: error instanceof Error ? error.message : String(error) };
      }
      turns++;
      const usage = message.usage;
      const promptTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      const text = textOf(message.content);
      if (text) lastText = text;

      if (message.stop_reason === 'refusal') {
        // Never run (or keep) a refused turn: its content may be cut off mid-way.
        const category = message.stop_details?.category ?? null;
        return { status: 'refusal', text: lastText, turns, detail: `The model declined this request${category ? ` (${category})` : ''}.${message.stop_details?.explanation ? ` ${message.stop_details.explanation}` : ''}` };
      }
      if (message.stop_reason === 'model_context_window_exceeded') return { status: 'context', text: lastText, turns, detail: 'The conversation no longer fits the model\'s context window.' };

      const content = echoable(message.content);
      messages.push({ role: 'assistant', content });
      estInput = promptTokens + (usage.output_tokens ?? 0);
      const toolUses = content.filter((block): block is BetaToolUseBlock & BetaContentBlockParam => block.type === 'tool_use') as unknown as BetaToolUseBlock[];
      const clamped = maxTokens < spec.requestMaxTokens;

      if (message.stop_reason === 'max_tokens') {
        // (When the budget lowered the limit, the next plan() decides whether the build can go on: it
        // waits for parallel requests to settle and stops only when the real spend leaves too little.)
        const limit = clamped ? `the ${maxTokens}-token output limit the remaining build budget allowed` : `the ${maxTokens}-token output limit`;
        if (toolUses.length) {
          // A cut-off tool input must not run; answer each call so the history stays valid.
          const results: BetaToolResultBlockParam[] = toolUses.map((use) => ({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Not run: your response hit ${limit} while writing this call, so its input is incomplete. Send it again in smaller pieces (for example, write a long file in several parts).` }));
          options.emitter.toolResults(results.map((result) => ({ id: result.tool_use_id, content: String(result.content), isError: true })), agent.parentToolUseId);
          messages.push({ role: 'user', content: results });
          estInput += estimateTokens(results);
          continue;
        }
        if (continuations++ < MAX_CONTINUATIONS) {
          messages.push({ role: 'user', content: 'Continue exactly where you stopped.' });
          estInput += 10;
          continue;
        }
        return { status: 'error', text: lastText, turns, detail: 'The model kept hitting the output limit.' };
      }
      if (message.stop_reason === 'pause_turn' || message.stop_reason === 'compaction') continue;
      if (!toolUses.length) return { status: 'done', text: lastText, turns };

      let results: BetaToolResultBlockParam[];
      try {
        results = await this.runTools(tools, toolUses, context);
      } catch (error) {
        if (error instanceof BudgetExceeded) { this.budgetHit ??= error; return { status: 'budget', text: lastText, turns, detail: error.message }; }
        if (options.signal.aborted) return { status: 'aborted', text: lastText, turns };
        throw error;
      }
      options.emitter.toolResults(results.map((result) => ({ id: result.tool_use_id, content: (result.content ?? '') as ToolResult['content'], isError: Boolean(result.is_error) })), agent.parentToolUseId);
      messages.push({ role: 'user', content: results });
      estInput += estimateTokens(results);
    }
  }

  /** Runs one response's tool calls: consecutive parallel-safe calls together, the rest one by one. */
  private async runTools(tools: ToolDef[], uses: BetaToolUseBlock[], context: ToolContext): Promise<BetaToolResultBlockParam[]> {
    const results: BetaToolResultBlockParam[] = new Array(uses.length);
    const safe = (use: BetaToolUseBlock) => tools.find((tool) => tool.name.toLowerCase() === use.name.toLowerCase())?.parallelSafe ?? false;
    const runOne = async (index: number) => {
      const use = uses[index];
      const parentRun = context.runAgent;
      const callContext = parentRun ? { ...context, runAgent: (request: AgentRequest) => parentRun({ ...request, toolUseId: use.id }) } : context;
      const result = await runTool(tools, use.name, use.input, callContext);
      results[index] = { type: 'tool_result', tool_use_id: use.id, content: result.content, ...(result.isError ? { is_error: true } : {}) };
    };
    let index = 0;
    while (index < uses.length) {
      if (!safe(uses[index])) { await runOne(index); index++; continue; }
      const batch: number[] = [];
      while (index < uses.length && safe(uses[index])) batch.push(index++);
      await Promise.all(batch.map(runOne));
    }
    return results;
  }

  // ---- sub-agents -------------------------------------------------------------------------------

  private async subAgent(request: AgentRequest, parent: AgentSpec): Promise<ToolResult> {
    const asked = request.model ? tierFromName(request.model) : null;
    const wanted = asked ?? parent.tier;
    const tier = capTier(wanted, this.options.tier);
    const kind = /explore/i.test(request.subagentType) ? 'explore' : 'general-purpose';
    const note = tier !== wanted ? ` (asked for ${wanted}; sub-agents never run above this session's ${this.options.tier} tier)` : '';
    this.options.emitter.progress(`Helper started: ${request.description} — ${tier}${note}`, 'step');
    const outcome = await this.agents.run(() => this.loop({
      kind, tier, prompt: request.prompt, description: request.description, parentToolUseId: request.toolUseId ?? null,
      maxTurns: this.options.subAgentMaxTurns ?? 400,
    }));
    if (outcome.status === 'budget') throw this.budgetHit ?? new BudgetExceeded(0, this.options.meter.capUsd ?? 0, 0);
    if (outcome.status === 'done') return { content: `${outcome.text || '(the sub-agent finished without a report)'}${note ? `\n\n[ran on ${tier}${note}]` : ''}` };
    return { content: `The sub-agent stopped early (${outcome.status}${outcome.detail ? `: ${outcome.detail}` : ''}).${outcome.text ? `\n\nIts last message:\n${outcome.text}` : ''}`, isError: true };
  }

  /** WebFetch over a long page: one small-model request answering the caller's prompt. */
  private async summarize(text: string, prompt: string, url: string, parentToolUseId: string | null): Promise<string> {
    const spec = resolveModel('haiku', this.options.env);
    const messages: BetaMessageParam[] = [{ role: 'user', content: `<page url="${url}">\n${text}\n</page>\n\nUsing only the page above, answer: ${prompt}\nQuote exact text, links and image URLs where they matter. Say plainly if the page does not contain the answer.` }];
    const system: BetaTextBlockParam[] = [{ type: 'text', text: 'You read one web page and answer a question about it for an automated build agent. Be complete and exact; no preamble.' }];
    const plan = await this.plan({ ...spec, requestMaxTokens: 8000 }, estimateTokens(messages));
    const message = await this.request(spec, this.params({ ...spec, compaction: false }, system, [], messages, plan.maxTokens), plan.reservation, parentToolUseId);
    return textOf(message.content) || '(no answer)';
  }
}

function tierFromName(name: string): Tier | null {
  const value = name.toLowerCase();
  if (value.includes('opus')) return 'opus';
  if (value.includes('sonnet')) return 'sonnet';
  if (value.includes('haiku')) return 'haiku';
  return null;   // "inherit" or unknown → the parent's tier
}

/** An API error as one line that keeps the API's error type (the runner matches rate-limit wording). */
export function apiErrorText(error: InstanceType<typeof Anthropic.APIError>): string {
  const body = (error.error ?? {}) as { error?: { type?: string; message?: string } };
  const type = body.error?.type ?? (error.status === 429 ? 'rate_limit_error' : error.status === 529 ? 'overloaded_error' : 'api_error');
  return `${type} (HTTP ${error.status ?? 'n/a'}): ${body.error?.message ?? error.message}`.slice(0, 500);
}

export const newSessionId = () => randomUUID();
