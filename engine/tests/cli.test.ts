// The engine as the runner starts it: a real process, the runner's arguments, stream-json out —
// against a scripted model (THEMEBOT_ENGINE_FAKE_SCRIPT), so no API call is ever made.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args';
import type { ScriptedTurn } from '../src/client';
import { expandSlashCommand } from '../src/prompt';
import { findBash } from '../src/tools/bash';

let tmp: string;
let workspace: string;
const CLI = path.resolve('engine/src/cli.ts');
const LOADER = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'tb-engine-cli-'));
  workspace = path.join(tmp, 'ws');
  await mkdir(path.join(workspace, '.claude', 'commands'), { recursive: true });
  await writeFile(path.join(workspace, '.claude', 'commands', 'clone-theme.md'), '---\ndescription: clone\n---\n# Clone the theme\nTarget: $ARGUMENTS\n');
});
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

async function runEngine(args: string[], options: { script?: ScriptedTurn[] | null; stdin?: string; env?: Record<string, string> } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  delete env.THEMEBOT_ENGINE_FAKE_SCRIPT;
  delete env.ANTHROPIC_API_KEY;
  if (options.script !== null) {
    const file = path.join(tmp, `script-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(file, JSON.stringify(options.script ?? [{ content: [{ type: 'text', text: 'ok' }] }]));
    env.THEMEBOT_ENGINE_FAKE_SCRIPT = file;
  }
  Object.assign(env, options.env);
  return new Promise<{ code: number | null; lines: Array<Record<string, any>>; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', LOADER, CLI, ...args], { cwd: workspace, env, windowsHide: true });
    let out = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.stdin.end(options.stdin ?? '');
    child.on('close', (code) => resolve({ code, stderr, lines: out.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)) }));
  });
}

describe('arguments', () => {
  it('accepts exactly what the runner passes to `claude -p` for builds, fix rounds and Cloud steps', () => {
    expect(parseArgs(['-p', '/clone-theme', '--model', 'opus', '--chrome', '--append-system-prompt', 'REBUILD', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', '25', '--ledger', 'l.jsonl']))
      .toMatchObject({ prompt: '/clone-theme', tier: 'opus', chrome: true, appendSystemPrompt: 'REBUILD', budgetUsd: 25, ledger: 'l.jsonl', errors: [] });
    expect(parseArgs(['-p', 'You are an autonomous fix session.', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose'])).toMatchObject({ prompt: 'You are an autonomous fix session.', tier: 'sonnet', errors: [] });
    expect(parseArgs(['-p', '--model', 'haiku', '--no-session-persistence', '--output-format', 'stream-json', '--verbose'])).toMatchObject({ prompt: null, tier: 'haiku', errors: [] });
    expect(parseArgs(['-p', 'x', '--model', 'gpt-5']).errors).toEqual(['unknown model "gpt-5" (use opus, sonnet or haiku)']);
    expect(parseArgs(['-p', 'x', '--max-budget-usd', 'lots']).errors[0]).toMatch(/must be a number/);
  });

  it('expands a project slash command like Claude Code (front matter dropped, $ARGUMENTS filled in)', async () => {
    expect(await expandSlashCommand('/clone-theme https://site.example.com', workspace)).toEqual({ command: 'clone-theme', text: '# Clone the theme\nTarget: https://site.example.com\n' });
    expect(await expandSlashCommand('/not-a-command', workspace)).toEqual({ command: null, text: '/not-a-command' });
    expect(await expandSlashCommand('Build the page.', workspace)).toEqual({ command: null, text: 'Build the page.' });
  });
});

describe('the engine process', () => {
  it('prints Claude Code-shaped stream-json and keeps the API key away from the commands it runs', async () => {
    const script: ScriptedTurn[] = [
      { content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node -e "console.log(process.env.ANTHROPIC_API_KEY ?? \'no key\')"' } }], usage: { input_tokens: 1000, output_tokens: 100 } },
      { content: [{ type: 'text', text: 'Finished.' }], usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000 } },
    ];
    const { code, lines } = await runEngine(['-p', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], { script, stdin: 'Run the check.', env: { ANTHROPIC_API_KEY: 'sk-ant-api03-must-not-leak' } });
    expect(code).toBe(0);
    expect(lines[0]).toMatchObject({ type: 'system', subtype: 'init', engine: 'themebot', model: 'claude-sonnet-5-5', tools: expect.arrayContaining(['Read', 'Bash', 'Agent']) });
    const session = lines[0].session_id;
    expect(lines.every((line) => line.session_id === session)).toBe(true);
    const assistants = lines.filter((line) => line.type === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({ themebot_final: true, message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 100 } } });
    const toolResult = lines.find((line) => line.type === 'user')!.message.content[0];
    if (findBash()) expect(toolResult).toMatchObject({ tool_use_id: 't1', is_error: false, content: 'no key' });
    const result = lines.at(-1)!;
    // $: 1000×2 + 100×10 + 100×2 + 10×10 + 1000×0.2 = 3,500 / 1e6
    expect(result).toMatchObject({ type: 'result', subtype: 'success', is_error: false, result: 'Finished.', num_turns: 2, total_cost_usd: 0.0035, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1100, outputTokens: 110, cacheReadInputTokens: 1000, costUSD: 0.0035 } } });
    expect(JSON.stringify(lines)).not.toContain('must-not-leak');
  }, 60_000);

  it('stops before any request when the build budget is already too small, and says so', async () => {
    const ledger = path.join(tmp, 'spent.jsonl');
    await writeFile(ledger, `${JSON.stringify({ v: 1, usd: 4.99 })}\n`);
    const { code, lines } = await runEngine(['-p', 'Go.', '--model', 'opus', '--max-budget-usd', '5', '--ledger', ledger]);
    expect(code).toBe(1);
    expect(lines.filter((line) => line.type === 'assistant')).toHaveLength(0);
    expect(lines.at(-1)).toMatchObject({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, result: expect.stringMatching(/^Build budget reached: \$4\.99 spent of the \$5\.00 cap/), themebot: { status: 'budget', budget_usd: 5 } });
  }, 60_000);

  it('fails clearly without an API key (and never with a fake one)', async () => {
    const { code, lines } = await runEngine(['-p', 'Go.'], { script: null });
    expect(code).toBe(1);
    expect(lines.at(-1)).toMatchObject({ type: 'result', is_error: true, result: expect.stringMatching(/^authentication_error: ThemeBot Engine has no Anthropic API key/) });
  }, 60_000);

  it('expands /clone-theme from the workspace and names it in the init line', async () => {
    const { lines } = await runEngine(['-p', '/clone-theme https://site.example.com', '--model', 'haiku']);
    expect(lines[0]).toMatchObject({ subtype: 'init', command: 'clone-theme', model: 'claude-haiku-4-5-20251001' });
  }, 60_000);
});
