// The engine's one door to the model: a request goes in, the complete message comes out.
//
// AnthropicModelClient streams every request (`client.beta.messages.stream` + `finalMessage()`): builds
// ask for up to 64K output tokens and long turns, which would hit HTTP timeouts without streaming.
// ScriptedModelClient is the fake the tests (and the runner's integration test) use — it never
// touches the network.
import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaMessage, BetaMessageStreamParams, BetaStopReason, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';

export interface SendHooks {
  signal: AbortSignal;
  /** Called on every stream event (`chars` = generated characters in a delta, 0 for other events). */
  onActivity?: (chars: number) => void;
}

export interface ModelClient {
  send(params: BetaMessageStreamParams, hooks: SendHooks): Promise<BetaMessage>;
}

export class AnthropicModelClient implements ModelClient {
  constructor(private readonly client: Anthropic) {}

  async send(params: BetaMessageStreamParams, hooks: SendHooks): Promise<BetaMessage> {
    const stream = this.client.beta.messages.stream(params, { signal: hooks.signal });
    stream.on('streamEvent', (event) => {
      if (event.type !== 'content_block_delta') { hooks.onActivity?.(0); return; }
      const delta = event.delta;
      const chars = delta.type === 'text_delta' ? delta.text.length
        : delta.type === 'input_json_delta' ? delta.partial_json.length
          : delta.type === 'thinking_delta' ? delta.thinking.length : 0;
      hooks.onActivity?.(chars);
    });
    return stream.finalMessage();
  }
}

/** One API key, generous retries (the SDK backs off on 429/5xx itself), a long per-request timeout. */
export function createAnthropicClient(apiKey: string): AnthropicModelClient {
  return new AnthropicModelClient(new Anthropic({ apiKey, maxRetries: 4, timeout: 15 * 60_000 }));
}

// ---- the fake ------------------------------------------------------------------------------------

export interface ScriptedTurn {
  content: Array<Record<string, unknown>>;
  stop_reason?: BetaStopReason;
  usage?: Partial<BetaUsage> & Record<string, unknown>;
  /** Defaults to the requested model. */
  model?: string;
  stop_details?: Record<string, unknown> | null;
  delayMs?: number;
}
export type ScriptHandler = (params: BetaMessageStreamParams, call: number) => ScriptedTurn | Promise<ScriptedTurn>;

let fakeIds = 0;
/** A complete BetaMessage from a scripted turn (fills the fields a real response always carries). */
export function fakeMessage(turn: ScriptedTurn, requestedModel: string): BetaMessage {
  const usage = {
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null,
    fallback_credit: null, inference_geo: null, iterations: null, output_tokens_details: null, server_tool_use: null,
    service_tier: 'standard', speed: 'standard', ...turn.usage,
  };
  const content = turn.content as unknown as BetaContentBlock[];
  return {
    id: `msg_fake_${++fakeIds}`, type: 'message', role: 'assistant', model: turn.model ?? requestedModel,
    content, stop_reason: turn.stop_reason ?? (content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null, stop_details: (turn.stop_details ?? null) as BetaMessage['stop_details'],
    container: null, context_management: null, diagnostics: null, usage: usage as BetaUsage,
  } as BetaMessage;
}

/** Plays back a list of turns (in order, across every agent of the session) or asks a handler. */
export class ScriptedModelClient implements ModelClient {
  readonly requests: BetaMessageStreamParams[] = [];
  private call = 0;
  constructor(private readonly script: ScriptedTurn[] | ScriptHandler) {}

  async send(params: BetaMessageStreamParams, hooks: SendHooks): Promise<BetaMessage> {
    // A deep copy: the engine keeps appending to the same messages array afterwards.
    this.requests.push(JSON.parse(JSON.stringify(params)) as BetaMessageStreamParams);
    const index = this.call++;
    const turn = typeof this.script === 'function'
      ? await this.script(params, index)
      : this.script[index] ?? { content: [{ type: 'text', text: '(script finished)' }], stop_reason: 'end_turn' };
    if (turn.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, turn.delayMs);
        hooks.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Anthropic.APIUserAbortError()); }, { once: true });
      });
    }
    if (hooks.signal.aborted) throw new Anthropic.APIUserAbortError();
    hooks.onActivity?.(JSON.stringify(turn.content).length);
    return fakeMessage(turn, params.model);
  }
}
