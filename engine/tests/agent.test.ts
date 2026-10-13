// The agent loop against a scripted fake model (no network): what each request looks like per tier,
// the append-only history, sub-agents (tier, cap, running side by side), the budget, and every stop.
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session, echoable, estimateTokens } from '../src/agent';
import { ScriptedModelClient, type ScriptHandler, type ScriptedTurn } from '../src/client';
import { CostMeter } from '../src/cost';
import { Emitter } from '../src/events';
import { DEFAULT_ALLOW, DEFAULT_DENY, permissionsFrom } from '../src/permissions';
import { commandEnv, findBash } from '../src/tools/bash';
import type { Tier } from '../src/models';

let tmp: string;
let workspace: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'tb-engine-agent-'));
  workspace = path.join(tmp, 'ws');
  await mkdir(workspace, { recursive: true });
});
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

function setup(script: ScriptedTurn[] | ScriptHandler, options: { tier?: Tier; cap?: number | null; ledger?: string; signal?: AbortSignal } = {}) {
  const client = new ScriptedModelClient(script);
  const lines: Array<Record<string, any>> = [];
  const emitter = new Emitter((line) => { lines.push(JSON.parse(line)); }, 'sess-test');
  const meter = new CostMeter({ capUsd: options.cap ?? null, ledgerPath: options.ledger ?? null, sessionId: 'sess-test' });
  const session = new Session({
    client, workspace, tier: options.tier ?? 'sonnet', meter, emitter, permissions: permissionsFrom(DEFAULT_ALLOW, DEFAULT_DENY),
    bashPath: findBash(), commandEnv: commandEnv(), signal: options.signal ?? new AbortController().signal, env: {}, date: '2026-10-14',
  });
  return { client, lines, meter, session };
}
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const say = (text: string) => ({ type: 'text', text });
const systemText = (params: BetaMessageStreamParams) => (Array.isArray(params.system) ? params.system.map((block) => block.text).join('') : String(params.system ?? ''));

describe('what the engine sends', () => {
  it('Sonnet/Opus: adaptive thinking with progress notes, explicit effort, fallbacks, compaction, caching, eager tools', async () => {
    const { client, session } = setup([{ content: [say('ok')] }], { tier: 'sonnet' });
    await session.run('Say ok.');
    const [params] = client.requests;
    expect(params).toMatchObject({
      model: 'claude-sonnet-5-5', max_tokens: 64_000, thinking: { type: 'adaptive', display: 'updates' }, output_config: { effort: 'medium' },
      fallbacks: 'default', cache_control: { type: 'ephemeral' },
      context_management: { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 150_000 } }] },
    });
    expect(params.betas?.sort()).toEqual(['compact-2026-01-12', 'server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18']);
    expect((params.system as Array<{ cache_control?: unknown }>)[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(params.tools?.every((entry) => (entry as { eager_input_streaming?: boolean }).eager_input_streaming)).toBe(true);
    expect(params).not.toHaveProperty('tool_choice'); // forced tool choice 400s on the 5.5 models
    expect(params).not.toHaveProperty('temperature');

    const opus = setup([{ content: [say('ok')] }], { tier: 'opus' });
    await opus.session.run('Say ok.');
    expect(opus.client.requests[0]).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'high' } });
  });

  it('Haiku 4.5: no thinking, no effort, no betas', async () => {
    const { client, session } = setup([{ content: [say('ok')] }], { tier: 'haiku' });
    await session.run('Say ok.');
    const [params] = client.requests;
    expect(params.model).toBe('claude-haiku-4-5-20251001');
    expect(params.max_tokens).toBe(32_000);
    for (const field of ['thinking', 'output_config', 'betas', 'fallbacks', 'context_management']) expect(params, field).not.toHaveProperty(field);
  });

  it('keeps the history append-only: every request starts with the previous one, system and tools byte-identical', async () => {
    const { client, session, lines } = setup([
      { content: [say('Writing it.'), tool('t1', 'Write', { file_path: 'notes/a.txt', content: 'hello\n' })], usage: { input_tokens: 900, output_tokens: 120 } },
      { content: [{ type: 'thinking', thinking: 'Checking the file I wrote.', signature: 'sig-1' }, tool('t2', 'Read', { file_path: 'notes/a.txt' })], usage: { input_tokens: 50, output_tokens: 40, cache_read_input_tokens: 1000 } },
      { content: [say('All done.')], usage: { input_tokens: 60, output_tokens: 10, cache_read_input_tokens: 1100 } },
    ]);
    const outcome = await session.run('Write notes/a.txt, then read it back.');
    expect(outcome).toMatchObject({ status: 'done', text: 'All done.', turns: 3 });
    expect(await readFile(path.join(workspace, 'notes', 'a.txt'), 'utf8')).toBe('hello\n');
    for (let index = 1; index < client.requests.length; index++) {
      const before = client.requests[index - 1];
      const after = client.requests[index];
      expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
      expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
      expect(JSON.stringify(after.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages));
    }
    // Thinking blocks go back unchanged (signature included).
    expect(JSON.stringify(client.requests[2].messages)).toContain('"signature":"sig-1"');
    // The progress note reached the build log.
    expect(lines.some((line) => line.subtype === 'themebot_progress' && line.text === 'Checking the file I wrote.')).toBe(true);
  });
});

describe('sub-agents', () => {
  it('run on the tier asked for, never above the session\'s, side by side, and report back', async () => {
    const spans: Record<string, [number, number]> = {};
    const handler: ScriptHandler = async (params) => {
      if (systemText(params).includes('sub-agent of ThemeBot Engine')) {
        const started = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 300));
        spans[params.model] = [started, Date.now()];
        return { content: [say(`report from ${params.model}`)], usage: { input_tokens: 100, output_tokens: 20 } };
      }
      const last = params.messages[params.messages.length - 1];
      if (typeof last.content === 'string') return { content: [tool('a1', 'Agent', { description: 'store setup', prompt: 'Create the pages.', model: 'haiku' }), tool('a2', 'Agent', { description: 'fixer', prompt: 'Fix it.', model: 'opus' })] };
      return { content: [say('Both helpers reported.')] };
    };
    const { client, session, lines } = setup(handler, { tier: 'sonnet' });
    const outcome = await session.run('Delegate.');
    expect(outcome.status).toBe('done');
    const subs = client.requests.filter((params) => systemText(params).includes('sub-agent of ThemeBot Engine'));
    expect(subs.map((params) => params.model).sort()).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-5-5']); // opus capped to sonnet
    expect(subs.every((params) => !params.tools?.some((entry) => (entry as { name: string }).name === 'Agent'))).toBe(true);
    const [haiku, sonnet] = [spans['claude-haiku-4-5-20251001'], spans['claude-sonnet-5-5']];
    expect(haiku[0] < sonnet[1] && sonnet[0] < haiku[1]).toBe(true); // overlapping: they ran at the same time
    const results = JSON.stringify(client.requests.at(-1)!.messages.at(-1));
    expect(results).toContain('report from claude-haiku-4-5-20251001');
    expect(results).toContain("asked for opus; sub-agents never run above this session's sonnet tier");
    // Their replies are tagged with the Agent call they belong to (the runner counts their tokens per model).
    expect(lines.filter((line) => line.type === 'assistant' && line.parent_tool_use_id).map((line) => line.parent_tool_use_id).sort()).toEqual(['a1', 'a2']);
  });
});

describe('the budget', () => {
  it('sizes max_tokens to what is left of the cap', async () => {
    const { client, session } = setup([{ content: [say('ok')] }], { tier: 'sonnet', cap: 0.5 });
    await session.run('Say ok.');
    expect(client.requests[0].max_tokens).toBeLessThan(64_000);
    expect(client.requests[0].max_tokens).toBeGreaterThan(40_000);
  });

  it('sends nothing when the cap cannot cover a minimal request', async () => {
    const { client, session } = setup([{ content: [say('ok')] }], { tier: 'opus', cap: 0.03 });
    const outcome = await session.run('Say ok.');
    expect(outcome.status).toBe('budget');
    expect(outcome.detail).toMatch(/Build budget reached/);
    expect(client.requests).toHaveLength(0);
  });

  it('stops at the next request once the build has spent its cap, across sessions sharing the ledger', async () => {
    const ledger = path.join(tmp, 'budget-ledger.jsonl');
    // An earlier session of this build already spent $0.60.
    const earlier = new CostMeter({ capUsd: 1, ledgerPath: ledger, sessionId: 'earlier' });
    await earlier.settle(null, [{ kind: 'message', model: 'claude-sonnet-5-5', input: 0, output: 60_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }]);
    const { client, session } = setup([
      { content: [tool('t1', 'Write', { file_path: 'b.txt', content: 'x' })], usage: { input_tokens: 2000, output_tokens: 36_000 } }, // $0.364 → $0.964 total
      { content: [say('never sent')] },
    ], { tier: 'sonnet', cap: 1, ledger });
    const outcome = await session.run('Go.');
    expect(outcome.status).toBe('budget');
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0].max_tokens).toBeLessThan(40_000);
    expect(existsSync(path.join(workspace, 'b.txt'))).toBe(true); // the paid-for tool call still ran
  });
});

describe('stops and recoveries', () => {
  it('never runs a tool call cut off by max_tokens, and answers it so the model can retry', async () => {
    const { client, session } = setup([
      { content: [tool('t1', 'Write', { file_path: 'cut.txt', content: 'half a fi' })], stop_reason: 'max_tokens' },
      { content: [say('Retrying in parts later.')] },
    ]);
    const outcome = await session.run('Write a big file.');
    expect(outcome.status).toBe('done');
    expect(existsSync(path.join(workspace, 'cut.txt'))).toBe(false);
    const answer = client.requests[1].messages.at(-1)!.content as unknown as Array<Record<string, unknown>>;
    expect(answer[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true, content: expect.stringMatching(/output limit/) });
  });

  it('stops on a refusal without keeping or running the refused turn', async () => {
    const { session } = setup([{ content: [tool('t1', 'Write', { file_path: 'refused.txt', content: 'x' })], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined.' } }]);
    const outcome = await session.run('Something.');
    expect(outcome).toMatchObject({ status: 'refusal', detail: expect.stringMatching(/declined this request \(cyber\)/) });
    expect(existsSync(path.join(workspace, 'refused.txt'))).toBe(false);
  });

  it('after a mid-output fallback, sends back only what the fallback model saw and runs only its tool calls', async () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig-declined' },
      tool('t-before', 'Write', { file_path: 'before.txt', content: 'x' }),
      { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' }, trigger: { type: 'refusal' } },
      say('Continuing on the fallback model.'),
      tool('t-after', 'Write', { file_path: 'after.txt', content: 'y' }),
    ];
    const { client, session, lines } = setup([{ content, model: 'claude-sonnet-5' }, { content: [say('done')], model: 'claude-sonnet-5' }]);
    expect((await session.run('Go.')).status).toBe('done');
    expect(existsSync(path.join(workspace, 'before.txt'))).toBe(false);
    expect(existsSync(path.join(workspace, 'after.txt'))).toBe(true);
    const echoed = client.requests[1].messages[1].content as Array<{ type: string; id?: string }>;
    expect(echoed.map((block) => block.id ?? block.type)).toEqual(['fallback', 'text', 't-after']);
    expect(lines.some((line) => line.subtype === 'themebot_progress' && /claude-sonnet-5-5 declined/.test(line.text))).toBe(true);
    expect(echoable(content as never)).toHaveLength(3);
  });

  it('reports API errors with their type (the runner recognises rate limits by it)', async () => {
    const { session } = setup(() => { throw Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your rate limit.' } }, undefined, new Headers()); });
    const outcome = await session.run('Go.');
    expect(outcome).toMatchObject({ status: 'error', detail: expect.stringMatching(/^rate_limit_error \(HTTP 429\)/) });
  });

  it('re-issues a turn whose streamed tool input could not be parsed at all', async () => {
    let calls = 0;
    const { client, session } = setup(() => {
      if (calls++ === 0) throw new Error('Unable to parse tool parameter JSON from model.');
      return { content: [say('ok')] };
    });
    expect((await session.run('Go.')).status).toBe('done');
    expect(client.requests).toHaveLength(2);
  });

  it('stops when the runner kills the session', async () => {
    const abort = new AbortController();
    const { session } = setup([{ content: [say('slow')], delayMs: 5000 }], { signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    expect((await session.run('Go.')).status).toBe('aborted');
  });

  it('counts images flat when estimating input, not by their base64 size', () => {
    const big = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1_000_000) } };
    expect(estimateTokens([big])).toBeLessThan(6000);
  });
});
