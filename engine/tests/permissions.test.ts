// The Bash tool's sandbox: the same .claude/settings.json rules Claude Code obeys, checked per simple
// command, and a parser that refuses what it cannot fully model.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ALLOW, DEFAULT_DENY, checkCommand, hostAllowed, loadPermissions, permissionsFrom } from '../src/permissions';
import { parseShell } from '../src/shell';

let tmp: string;
let workspace: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'tb-engine-perm-'));
  workspace = path.join(tmp, 'ws');
  await mkdir(path.join(workspace, '.claude'), { recursive: true });
  // The settings file the scaffolder writes for every build.
  const template = await readFile(path.resolve('templates/factory/workspace/.claude/settings.json.tpl'), 'utf8');
  await writeFile(path.join(workspace, '.claude', 'settings.json'), template.replaceAll('{{REACT_HOST}}', 'react.example.com').replaceAll('{{SHOP_HOST}}', 'shop.myshopify.com'));
});
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('parsing a command line', () => {
  it('splits simple commands and keeps assignments, words and redirects apart', () => {
    const parsed = parseShell('ONLY=sections/a.liquid,sections/b.liquid node push.mjs && node qa/x.mjs "two words" 2>&1 | tail -n 20; ls > out.txt');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments.map((segment) => segment.words)).toEqual([['node', 'push.mjs'], ['node', 'qa/x.mjs', 'two words'], ['tail', '-n', '20'], ['ls']]);
    expect(parsed.segments[0].assignments).toEqual([{ name: 'ONLY', value: 'sections/a.liquid,sections/b.liquid' }]);
    expect(parsed.segments[1].redirects).toEqual([{ op: '>&', fd: 2, target: null }]);
    expect(parsed.segments[3].redirects).toEqual([{ op: '>', fd: null, target: 'out.txt' }]);
  });

  it('treats quoted text as one word, keeps $VAR literally and drops comments', () => {
    const parsed = parseShell(`node -e 'console.log("a && b; c")' "$HOME/x" # a comment && rm -rf /`);
    expect(parsed.ok && parsed.segments).toEqual([{ assignments: [], words: ['node', '-e', 'console.log("a && b; c")', '$HOME/x'], redirects: [] }]);
  });

  it.each([
    ['node $(cat x)', /Command substitution/],
    ['node `cat x`', /Backtick/],
    ['echo "$(whoami)"', /Command substitution/],
    ['(cd .. && ls)', /Subshells/],
    ['cat <<EOF\nhi\nEOF', /Heredocs/],
    ['node server.mjs &', /Background/],
    ['diff <(ls a) <(ls b)', /Process substitution/],
    ["echo $'\\x41'", /ANSI-C/],
    ['echo "open', /Unclosed double quote/],
    ['ls &&', /ends with "&&"/],
    ['&& ls', /missing a command/],
  ])('refuses %s', (command, reason) => {
    const parsed = parseShell(command);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(reason);
  });
});

describe('what may run', () => {
  it('allows the recipe\'s own commands and the scaffold\'s prefixes', async () => {
    const permissions = await loadPermissions(workspace);
    for (const command of ['node push.mjs', 'ONLY=sections/hero.liquid node push.mjs', 'npm run build', 'npx playwright --version', 'ls -la sections', 'pwd', 'node qa/a.mjs && node qa/b.mjs || echo failed', 'cd qa && node lib.mjs', 'node x.mjs > qa/reports/out.txt 2>&1', 'node x.mjs 2>/dev/null', 'curl -s https://shop.myshopify.com/'])
      expect(checkCommand(permissions, command, workspace), command).toMatchObject({ ok: true });
  });

  it('refuses commands outside the allowlist, deny rules, and anything that leaves the project', async () => {
    const permissions = await loadPermissions(workspace);
    const cases: Array<[string, RegExp]> = [
      ['rm -rf sections', /blocked in this project/],
      ['git push origin main', /blocked in this project/],
      ['python script.py', /not an allowed command/],
      ['node a.mjs && bash -c "rm x"', /not an allowed command/],
      ['cd .. && ls', /cd outside the project/],
      ['cd ~', /literal folder/],
      ['node x.mjs > ../outside.txt', /Redirects outside/],
      ['node x.mjs > $HOME/x', /literal file paths/],
      ['PATH=/tmp node x.mjs', /Setting PATH is not allowed/],
      ['NODE_OPTIONS=--require=evil.js node x.mjs', /Setting NODE_OPTIONS/],
      ['ANTHROPIC_BASE_URL=http://evil node x.mjs', /Setting ANTHROPIC_BASE_URL/],
      ['FOO=1', /only variable assignments/],
      ['pwd -P', /not an allowed command/], // "Bash(pwd)" is exact, not a prefix
    ];
    for (const [command, reason] of cases) {
      const check = checkCommand(permissions, command, workspace);
      expect(check.ok, command).toBe(false);
      expect(check.reason, command).toMatch(reason);
    }
  });

  it('turns Bash off when the project does not allow it at all', () => {
    const permissions = permissionsFrom(['Read', 'Write'], []);
    expect(checkCommand(permissions, 'ls', workspace)).toMatchObject({ ok: false, reason: expect.stringMatching(/not allowed in this project/) });
  });

  it('reads WebFetch hosts from the rules (subdomains included, template placeholders ignored)', async () => {
    const permissions = await loadPermissions(workspace);
    expect(permissions.webHosts.sort()).toEqual(['cdn.shopify.com', 'react.example.com', 'shop.myshopify.com']);
    expect(hostAllowed(permissions, 'CDN.Shopify.com')).toBe(true);
    expect(hostAllowed(permissions, 'img.react.example.com')).toBe(true);
    expect(hostAllowed(permissions, 'evil-shopify.com')).toBe(false);
    expect(permissionsFrom(['WebFetch(domain:{{REACT_HOST}})'], []).webHosts).toEqual([]);
  });

  it('falls back to the scaffolder\'s defaults when a workspace has no settings file', async () => {
    const bare = path.join(tmp, 'bare');
    await mkdir(bare, { recursive: true });
    const permissions = await loadPermissions(bare);
    expect(permissions).toEqual(permissionsFrom(DEFAULT_ALLOW, DEFAULT_DENY));
    expect(permissions.tools.has('Agent')).toBe(true);
  });
});
