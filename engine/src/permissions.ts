// What a session may do — read from the SAME file Claude Code obeys: <workspace>/.claude/settings.json
// (the scaffolder writes it for every build: `permissions.allow` / `permissions.deny`).
//
//   "Read", "Edit", "Agent", …        a tool may be used at all
//   "Bash(node:*)", "Bash(pwd)"       a command prefix (`:*`) or an exact command may run
//   "WebFetch(domain:cdn.shopify.com)" a host (and its subdomains) may be fetched
// Deny rules win over allow rules. A workspace without the file gets the scaffolder's defaults.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseShell, type ShellSegment } from './shell';

export interface Permissions {
  tools: Set<string>;
  bashAllow: BashRule[];
  bashDeny: BashRule[];
  webHosts: string[];
}
interface BashRule { text: string; prefix: boolean }

/** Same allowlist the scaffolder's settings template grants (minus the per-job WebFetch hosts). */
export const DEFAULT_ALLOW = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(node:*)', 'Bash(npm run:*)', 'Bash(npm install:*)', 'Bash(npx:*)', 'Bash(dir:*)', 'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(copy:*)', 'Bash(cp:*)', 'Bash(type:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(pwd)', 'Bash(curl:*)', 'WebFetch(domain:cdn.shopify.com)', 'Agent', 'TodoWrite'];
export const DEFAULT_DENY = ['Bash(git push:*)', 'Bash(rd:*)', 'Bash(rmdir:*)', 'Bash(del:*)', 'Bash(rm -rf:*)', 'Bash(rm -r:*)', 'Bash(rm -fr:*)', 'Bash(rm -R:*)'];

/** Shell builtins the engine also allows: harmless on their own (`cd` and redirects are confined to the workspace). */
const BUILTINS = new Set(['cd', 'echo', 'printf', 'true', 'false']);

function bashRule(inner: string): BashRule {
  const trimmed = inner.trim();
  return trimmed.endsWith(':*') ? { text: trimmed.slice(0, -2).trim(), prefix: true } : { text: trimmed, prefix: false };
}

export function permissionsFrom(allow: string[], deny: string[]): Permissions {
  const result: Permissions = { tools: new Set(), bashAllow: [], bashDeny: [], webHosts: [] };
  for (const raw of allow) {
    const rule = String(raw).trim();
    const match = /^(\w+)\((.*)\)$/s.exec(rule);
    if (!match) { result.tools.add(rule); continue; }
    const [, tool, inner] = match;
    result.tools.add(tool);
    if (tool === 'Bash') result.bashAllow.push(bashRule(inner));
    else if (tool === 'WebFetch' && inner.startsWith('domain:')) {
      const host = inner.slice('domain:'.length).trim().toLowerCase();
      if (host && !host.includes('{{')) result.webHosts.push(host);
    }
  }
  for (const raw of deny) {
    const match = /^Bash\((.*)\)$/s.exec(String(raw).trim());
    if (match) result.bashDeny.push(bashRule(match[1]));
    else result.tools.delete(String(raw).trim());   // a plain tool name in deny switches it off
  }
  return result;
}

export async function loadPermissions(workspace: string): Promise<Permissions> {
  try {
    const parsed = JSON.parse(await readFile(path.join(workspace, '.claude', 'settings.json'), 'utf8')) as { permissions?: { allow?: unknown; deny?: unknown } };
    const allow = Array.isArray(parsed.permissions?.allow) ? (parsed.permissions!.allow as unknown[]).map(String) : DEFAULT_ALLOW;
    const deny = Array.isArray(parsed.permissions?.deny) ? (parsed.permissions!.deny as unknown[]).map(String) : DEFAULT_DENY;
    return permissionsFrom(allow, deny);
  } catch {
    return permissionsFrom(DEFAULT_ALLOW, DEFAULT_DENY);
  }
}

function matches(rule: BashRule, command: string): boolean {
  if (!rule.prefix) return command === rule.text;
  return command === rule.text || command.startsWith(`${rule.text} `);
}

export function hostAllowed(permissions: Permissions, host: string): boolean {
  const target = host.toLowerCase().replace(/\.$/, '');
  return permissions.webHosts.some((allowed) => target === allowed || target.endsWith(`.${allowed}`));
}

/** Env names a command may not set (they change what runs or how the shell starts). */
const FORBIDDEN_ENV = /^(PATH|PATHEXT|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PS4|IFS|PROMPT_COMMAND|COMSPEC|LD_.*|DYLD_.*|ANTHROPIC_.*|THEMEBOT_.*)$/i;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface CommandCheck { ok: boolean; reason?: string; segments?: ShellSegment[] }

/**
 * Whether a Bash command may run in `workspace`. Every simple command in it must match an allow rule
 * (or be a harmless builtin) and no deny rule; `cd` and file redirects must stay inside the workspace;
 * anything the parser does not fully understand (command substitution, subshells, heredocs,
 * background jobs) is refused rather than guessed at.
 */
export function checkCommand(permissions: Permissions, command: string, workspace: string): CommandCheck {
  if (!permissions.tools.has('Bash')) return { ok: false, reason: 'The Bash tool is not allowed in this project.' };
  const parsed = parseShell(command);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (!parsed.segments.length) return { ok: false, reason: 'Empty command.' };
  const root = path.resolve(workspace);
  let cwd = root;
  for (const segment of parsed.segments) {
    for (const assignment of segment.assignments) {
      if (FORBIDDEN_ENV.test(assignment.name)) return { ok: false, reason: `Setting ${assignment.name} is not allowed.` };
    }
    if (!segment.words.length) return { ok: false, reason: 'A command with only variable assignments is not allowed.' };
    const text = segment.words.join(' ');
    for (const rule of permissions.bashDeny) if (matches(rule, text)) return { ok: false, reason: `"${text.slice(0, 80)}" is blocked in this project (deny rule "${rule.text}${rule.prefix ? ':*' : ''}").` };
    const name = segment.words[0];
    if (name === 'cd') {
      const target = segment.words[1];
      if (!target || segment.words.length > 2 || /[$~`*?]/.test(target)) return { ok: false, reason: 'cd needs one literal folder inside the project.' };
      const next = path.resolve(cwd, target);
      if (!inside(root, next)) return { ok: false, reason: 'cd outside the project folder is not allowed.' };
      cwd = next;
    } else if (!BUILTINS.has(name) && !permissions.bashAllow.some((rule) => matches(rule, text))) {
      const allowed = permissions.bashAllow.map((rule) => (rule.prefix ? `${rule.text} …` : rule.text)).join(', ');
      return { ok: false, reason: `"${text.slice(0, 80)}" is not an allowed command in this project. Allowed: ${allowed}.` };
    }
    for (const redirect of segment.redirects) {
      if (redirect.target === null) continue;   // fd duplication like 2>&1
      const target = redirect.target;
      if (/^(\/dev\/null|nul)$/i.test(target)) continue;
      if (/[$~`*?]/.test(target)) return { ok: false, reason: 'Redirect targets must be literal file paths.' };
      if (!inside(root, path.resolve(cwd, target))) return { ok: false, reason: 'Redirects outside the project folder are not allowed.' };
    }
  }
  return { ok: true, segments: parsed.segments };
}
