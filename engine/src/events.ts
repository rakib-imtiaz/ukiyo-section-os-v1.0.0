// Output: the stream-json lines `claude -p --output-format stream-json` prints, so the factory runner
// (server/factory/runner.ts) reads ThemeBot Engine sessions exactly as it reads Claude Code ones —
// live activity, per-reply token counts, the final result with per-model usage and cost.
//
// Engine-only additions are marked `themebot_*` and are ignored by anything that does not know them:
//   assistant lines carry `themebot_final: true` (their usage is the final count, not a running one);
//   {type:'system', subtype:'themebot_progress', text} is a readable progress note;
//   {type:'system', subtype:'themebot_heartbeat'} shows the model is still generating (long turns).
import type { BetaContentBlock, BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { UsagePart } from './cost';
import type { ToolContent } from './tools/types';

export type Sink = (line: string) => void;

const MAX_RESULT_ECHO = 4000;
const HEARTBEAT_MS = 30_000;

/** Content as it is echoed to the log: signatures and encrypted payloads are opaque, so left out. */
function echoContent(content: BetaContentBlock[]): unknown[] {
  return content.map((block) => {
    const copy = { ...(block as unknown as Record<string, unknown>) };
    if ('signature' in copy) copy.signature = '';
    if ('data' in copy && block.type === 'redacted_thinking') copy.data = '';
    if ('encrypted_content' in copy) copy.encrypted_content = '';
    return copy;
  });
}

function echoResult(content: ToolContent): string {
  const text = typeof content === 'string' ? content : content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
  return text.length > MAX_RESULT_ECHO ? `${text.slice(0, MAX_RESULT_ECHO)}… [${text.length - MAX_RESULT_ECHO} more characters]` : text;
}

export class Emitter {
  private lastBeat = 0;
  constructor(private readonly sink: Sink, readonly sessionId: string) {}

  private write(message: Record<string, unknown>) {
    try { this.sink(`${JSON.stringify({ ...message, session_id: this.sessionId })}\n`); } catch { /* stdout closed */ }
  }

  init(model: string, cwd: string, tools: string[], extra: Record<string, unknown> = {}) {
    this.write({ type: 'system', subtype: 'init', engine: 'themebot', model, cwd, tools, ...extra });
  }

  /** One API response. `extra` = billed parts the top-level usage leaves out (declined attempts, compaction). */
  assistant(message: BetaMessage, parentToolUseId: string | null, extra: UsagePart[] = []) {
    const usage = message.usage;
    this.write({
      type: 'assistant', parent_tool_use_id: parentToolUseId, themebot_final: true,
      message: {
        id: message.id, type: 'message', role: 'assistant', model: message.model, content: echoContent(message.content), stop_reason: message.stop_reason,
        usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0 },
      },
    });
    extra.forEach((part, index) => this.write({
      type: 'assistant', parent_tool_use_id: parentToolUseId, themebot_final: true, themebot_part: part.kind,
      message: { id: `${message.id}#${index + 1}`, type: 'message', role: 'assistant', model: part.model, content: [], usage: { input_tokens: part.input, output_tokens: part.output, cache_read_input_tokens: part.cacheRead, cache_creation_input_tokens: part.cacheWrite5m + part.cacheWrite1h } },
    }));
  }

  toolResults(results: Array<{ id: string; content: ToolContent; isError: boolean }>, parentToolUseId: string | null) {
    this.write({
      type: 'user', parent_tool_use_id: parentToolUseId,
      message: { role: 'user', content: results.map((result) => ({ type: 'tool_result', tool_use_id: result.id, is_error: result.isError, content: echoResult(result.content) })) },
    });
  }

  progress(text: string, kind: 'info' | 'step' | 'err' = 'info') {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean) this.write({ type: 'system', subtype: 'themebot_progress', kind, text: clean.slice(0, 400) });
  }

  /** Throttled "still generating" line — keeps the runner's inactivity watchdog honest on long turns. */
  heartbeat() {
    const now = Date.now();
    if (now - this.lastBeat < HEARTBEAT_MS) return;
    this.lastBeat = now;
    this.write({ type: 'system', subtype: 'themebot_heartbeat' });
  }

  result(message: Record<string, unknown>) { this.write({ type: 'result', ...message }); }
}
