// The engine's tools, run directly: Claude Code's file-tool rules (Read before changing a file,
// stale-file check, exact unique edits), confinement to the project folder, the Bash sandbox and its
// environment, WebFetch's host rules, and input validation.
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsFrom, DEFAULT_ALLOW, DEFAULT_DENY } from '../src/permissions';
import { commandEnv, findBash } from '../src/tools/bash';
import { globToRegExp } from '../src/tools/fs';
import { apiTools, findTool, runTool, toolsFor, ALL_TOOLS } from '../src/tools/index';
import type { ToolContext } from '../src/tools/types';
import { htmlToText } from '../src/tools/web';

let tmp: string;
let workspace: string;
const bash = findBash();

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspace, permissions: permissionsFrom([...DEFAULT_ALLOW, 'WebFetch(domain:react.example.com)'], DEFAULT_DENY), readState: new Map(),
    signal: new AbortController().signal, commandEnv: commandEnv({ ...process.env, ANTHROPIC_API_KEY: 'sk-ant-secret', THEMEBOT_ENGINE_FAKE_SCRIPT: 'x' }),
    bashPath: bash, todos: [], ...overrides,
  };
}
const run = (name: string, input: unknown, ctx = context()) => runTool(ALL_TOOLS, name, input, ctx);
const text = (result: { content: unknown }) => (typeof result.content === 'string' ? result.content : JSON.stringify(result.content));

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'tb-engine-tools-'));
  workspace = path.join(tmp, 'ws');
  await mkdir(path.join(workspace, 'sections'), { recursive: true });
  await mkdir(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(workspace, 'sections', 'hero.liquid'), '<section class="hero">\n  {{ section.settings.title }}\n</section>\n');
  await writeFile(path.join(workspace, 'sections', 'footer.liquid'), '<footer>\r\n  <p>© shop</p>\r\n</footer>\r\n');
  await writeFile(path.join(workspace, 'node_modules', 'pkg', 'index.liquid'), 'hero');
  await writeFile(path.join(tmp, 'outside.txt'), 'secret');
});
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('file tools', () => {
  it('reads with line numbers, pages long files, and shows images as images', async () => {
    const result = await run('Read', { file_path: 'sections/hero.liquid' });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('     2\t  {{ section.settings.title }}');
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n');
    await writeFile(path.join(workspace, 'long.txt'), lines);
    const page = await run('Read', { file_path: 'long.txt', offset: 10, limit: 5 });
    expect(text(page)).toContain('    10\tline 10');
    expect(text(page)).toContain('showing lines 10-14 of 30');
    await writeFile(path.join(workspace, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const image = await run('Read', { file_path: 'shot.png' });
    expect(Array.isArray(image.content) && image.content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
  });

  it('keeps every path inside the project folder', async () => {
    for (const file_path of ['../outside.txt', path.join(tmp, 'outside.txt')]) {
      const result = await run('Read', { file_path });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/outside the project folder/);
    }
    expect((await run('Write', { file_path: '../escape.txt', content: 'x' })).isError).toBe(true);
  });

  it('needs a Read before changing an existing file, and a fresh one after the file changed', async () => {
    const ctx = context();
    const blind = await run('Edit', { file_path: 'sections/hero.liquid', old_string: 'hero', new_string: 'banner' }, ctx);
    expect(text(blind)).toMatch(/Read sections\/hero.liquid before changing it/);
    expect(text(await run('Write', { file_path: 'sections/hero.liquid', content: 'x' }, ctx))).toMatch(/Read .* before changing it/);
    await run('Read', { file_path: 'sections/hero.liquid' }, ctx);
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(workspace, 'sections', 'hero.liquid'), later, later); // someone else changed it
    expect(text(await run('Edit', { file_path: 'sections/hero.liquid', old_string: 'hero', new_string: 'banner' }, ctx))).toMatch(/changed since you last read it/);
    await run('Read', { file_path: 'sections/hero.liquid' }, ctx);
    const edited = await run('Edit', { file_path: 'sections/hero.liquid', old_string: 'class="hero"', new_string: 'class="banner"' }, ctx);
    expect(edited).toMatchObject({ content: 'Edited sections/hero.liquid (1 replacement).' });
    // Its own write keeps the file fresh: a second edit needs no new Read.
    expect((await run('Edit', { file_path: 'sections/hero.liquid', old_string: '</section>', new_string: '</section>\n<!-- end -->' }, ctx)).isError).toBeFalsy();
    expect(await readFile(path.join(workspace, 'sections', 'hero.liquid'), 'utf8')).toContain('class="banner"');
    // New files need no Read.
    expect(await run('Write', { file_path: 'snippets/new/icon.liquid', content: '<svg></svg>\n' }, ctx)).toMatchObject({ content: 'Created snippets/new/icon.liquid (2 lines).' });
  });

  it('edits exactly: unique match or replace_all, and matches CRLF files written with LF', async () => {
    const ctx = context();
    await writeFile(path.join(workspace, 'dup.txt'), 'a\na\n');
    await run('Read', { file_path: 'dup.txt' }, ctx);
    expect(text(await run('Edit', { file_path: 'dup.txt', old_string: 'a', new_string: 'b' }, ctx))).toMatch(/appears 2 times/);
    expect(await run('Edit', { file_path: 'dup.txt', old_string: 'a', new_string: 'b', replace_all: true }, ctx)).toMatchObject({ content: 'Edited dup.txt (2 replacements).' });
    expect(text(await run('Edit', { file_path: 'dup.txt', old_string: 'zzz', new_string: 'y' }, ctx))).toMatch(/was not found/);
    await run('Read', { file_path: 'sections/footer.liquid' }, ctx);
    expect((await run('Edit', { file_path: 'sections/footer.liquid', old_string: '<footer>\n  <p>© shop</p>', new_string: '<footer>\n  <p>© ThemeBot</p>' }, ctx)).isError).toBeFalsy();
    expect(await readFile(path.join(workspace, 'sections', 'footer.liquid'), 'utf8')).toBe('<footer>\r\n  <p>© ThemeBot</p>\r\n</footer>\r\n');
  });

  it('finds files by pattern and contents, skipping node_modules', async () => {
    const found = text(await run('Glob', { pattern: '**/*.liquid' }));
    expect(found).toContain('sections/hero.liquid');
    expect(found).not.toContain('node_modules');
    const matches = text(await run('Grep', { pattern: 'banner|ThemeBot', output_mode: 'content', glob: '*.liquid' }));
    expect(matches).toMatch(/sections\/hero\.liquid:1:<section class="banner">/);
    expect(matches).toMatch(/sections\/footer\.liquid:2:/);
    expect(text(await run('Grep', { pattern: 'banner', output_mode: 'count' }))).toContain('sections/hero.liquid:1');
    expect(text(await run('Grep', { pattern: 'nothing-like-this' }))).toBe('No matches found.');
    expect(globToRegExp('sections/**/*.{liquid,json}').test('sections/a/b.json')).toBe(true);
    expect(globToRegExp('*.liquid').test('a/b.liquid')).toBe(false);
  });
});

describe.runIf(Boolean(bash))('the Bash tool', () => {
  it('runs allowed commands in the project folder, without the API key in their environment', async () => {
    const result = await run('Bash', { command: 'node -e "console.log(process.env.ANTHROPIC_API_KEY ?? \'no key\', process.env.THEMEBOT_ENGINE_FAKE_SCRIPT ?? \'no hook\', process.cwd().endsWith(\'ws\'))"' });
    expect(result).toMatchObject({ content: 'no key no hook true' });
  });

  it('reports a failing exit code, refuses denied commands, and stops a command at its timeout', async () => {
    expect(text(await run('Bash', { command: 'node -e "process.exit(3)"' }))).toMatch(/\[exit code 3\]/);
    const denied = await run('Bash', { command: 'rm -rf sections' });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/^Not run: /);
    const started = Date.now();
    const slow = await run('Bash', { command: 'node -e "setTimeout(() => {}, 60000)"', timeout: 1500 });
    expect(text(slow)).toMatch(/stopped after 1.5s/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});

describe('WebFetch', () => {
  const page = (body: string, init: ResponseInit & { headers?: Record<string, string> } = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

  it('fetches allowed hosts as text and refuses others, including through a redirect', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: URL | string) => {
      const href = String(url);
      calls.push(href);
      if (href.includes('/moved')) return new Response(null, { status: 302, headers: { location: 'https://evil.example.net/steal' } });
      return page('<html><head><style>x{}</style><script>alert(1)</script></head><body><h1>Hello</h1><a href="/about">About us</a></body></html>');
    }) as typeof fetch;
    const ok = await run('WebFetch', { url: 'https://react.example.com/', prompt: 'headline?' }, context({ fetchImpl }));
    expect(text(ok)).toContain('Hello');
    expect(text(ok)).toContain('About us (/about)');
    expect(text(ok)).not.toContain('alert(1)');
    expect(text(await run('WebFetch', { url: 'https://evil.example.net/', prompt: 'x' }, context({ fetchImpl })))).toMatch(/not an allowed host/);
    expect(text(await run('WebFetch', { url: 'https://react.example.com/moved', prompt: 'x' }, context({ fetchImpl })))).toMatch(/evil\.example\.net is not an allowed host/);
    expect(calls).not.toContain('https://evil.example.net/steal');
  });

  it('answers over a long page with the summarizer instead of returning it whole', async () => {
    const long = `<p>${'Lorem ipsum dolor sit amet. '.repeat(2000)}</p>`;
    const fetchImpl = (async () => page(long)) as unknown as typeof fetch;
    let asked = '';
    const result = await run('WebFetch', { url: 'https://react.example.com/blog', prompt: 'What is the title?' }, context({ fetchImpl, summarize: async (_text, prompt) => { asked = prompt; return 'The title is Lorem.'; } }));
    expect(asked).toBe('What is the title?');
    expect(text(result)).toContain('The title is Lorem.');
    expect(htmlToText('<p>a&amp;b</p><br><li>c</li>')).toBe('a&b\n\nc');
  });
});

describe('tool calls', () => {
  it('validates inputs (eager streaming means the API no longer does) and accepts near-miss names', async () => {
    const bad = await run('Write', { file_path: 'x.txt' });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(text(bad))).toMatchObject({ INVALID_INPUT: expect.stringContaining('content') });
    expect(findTool(ALL_TOOLS, 'bash')?.name).toBe('Bash');
    expect(text(await run('Teleport', {}))).toMatch(/There is no tool named "Teleport"/);
  });

  it('describes every tool with a JSON schema, streams inputs eagerly, and keeps the Agent tool out of sub-agents', () => {
    const defs = apiTools(ALL_TOOLS);
    expect(defs.map((tool) => tool.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'TodoWrite', 'Agent']);
    for (const tool of defs) {
      expect(tool.eager_input_streaming).toBe(true);
      expect(tool.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.input_schema).not.toHaveProperty('$schema');
    }
    const allowed = new Set(ALL_TOOLS.map((tool) => tool.name));
    expect(toolsFor(allowed, 'general-purpose').map((tool) => tool.name)).not.toContain('Agent');
    expect(toolsFor(allowed, 'explore').map((tool) => tool.name)).toEqual(['Read', 'Glob', 'Grep', 'WebFetch', 'TodoWrite']);
    expect(toolsFor(new Set(['Read']), 'main').map((tool) => tool.name)).toEqual(['Read']);
  });

  it('keeps the task list for the session', async () => {
    const ctx = context();
    const result = await run('TodoWrite', { todos: [{ content: 'Build header', status: 'completed' }, { content: 'Build footer', status: 'in_progress', activeForm: 'Building footer' }] }, ctx);
    expect(result).toMatchObject({ content: 'Task list updated: 1/2 done.' });
    expect(ctx.todos).toHaveLength(2);
  });
});
