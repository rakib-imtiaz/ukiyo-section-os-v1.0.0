// What the engine tells the model about itself, its tools and its environment — the part Claude
// Code's own system prompt used to supply. The build recipe (the user turn) carries the actual task.
// Everything here is fixed for a session, so it sits in the cached prefix.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Permissions } from './permissions';

export interface PromptEnv {
  workspace: string;
  permissions: Permissions;
  bashAvailable: boolean;
  toolNames: string[];
  /** Day only (a timestamp would change the prompt and defeat the cache within no time). */
  date: string;
  platform: NodeJS.Platform;
}

function commandsLine(permissions: Permissions): string {
  const commands = permissions.bashAllow.map((rule) => (rule.prefix ? `${rule.text} …` : rule.text));
  return commands.length ? commands.join(', ') : 'none';
}

function environment(env: PromptEnv): string {
  return [
    '# Environment',
    `- Project folder (working directory): ${env.workspace}`,
    `- Platform: ${env.platform}${env.platform === 'win32' ? ' (commands run in Git Bash: use forward slashes and POSIX syntax)' : ''}`,
    `- Today: ${env.date}`,
    `- Tools: ${env.toolNames.join(', ')}`,
    env.toolNames.includes('Bash')
      ? `- Commands the Bash tool may run here: ${commandsLine(env.permissions)} (plus cd/echo/printf inside the project).${env.bashAvailable ? '' : ' NOTE: no bash was found on this computer, so Bash calls will fail — work with the file tools.'}`
      : '- No shell commands in this session.',
    env.toolNames.includes('WebFetch') ? `- Hosts WebFetch may read: ${env.permissions.webHosts.join(', ') || 'none'}` : '',
  ].filter(Boolean).join('\n');
}

export function systemPrompt(env: PromptEnv): string {
  return `You are ThemeBot Engine, the autonomous build agent inside ThemeBot, which turns React sites into Shopify themes. You work alone in one project folder: there is no person at the keyboard during this session, so never ask questions or wait for confirmation. When the task describes what to do if you are blocked (for example writing a BLOCKED.md file), do exactly that; otherwise make the most reasonable choice and note it in your final report.

# How to work
- The user message is your complete task, written by ThemeBot. Follow it to the letter, including the files it says to write when you finish: ThemeBot only knows a step is done when that completion file exists.
- Use the dedicated tools for files: Read to look at a file (or a screenshot image), Edit for changes to part of a file, Write for new files or full rewrites, Glob to find files by name, Grep to search contents. Read a file before you Edit or overwrite it. Paths are relative to the project folder; nothing outside it can be read or written.
- Use Bash to run the project's own scripts (node …, npm run …, npx …) and quick checks. Run independent commands one by one rather than building long chains; check exit codes and read errors before going on.
- When you need several independent things (reading a few files, searching), request them together in one response so they run at the same time.
- Use TodoWrite to keep a short task list for multi-step work; it is the progress the operator sees.
- Before a group of tool calls, write one short line saying what you are about to do. Keep it plain.
- Verify your work the way the task says (run its scripts, look at its screenshots) before reporting it done. A change you could not check is reported as unchecked, not as done.
- Never print, copy or store access tokens, API keys or passwords in files, reports or command output.
- Finish with a brief plain-language report: what you did, what you checked, anything left undone and why.

# Sub-agents
The Agent tool starts a sub-agent with its own context. It sees only the prompt you give it, so include the whole task: file paths, formats, rules that apply, how to get credentials, and exactly what to report back. Set its model to the cheapest tier that can do the job (haiku for mechanical HTTP calls and text diffs, sonnet for moderate reasoning and image checks, opus only for the hardest judgment). To run sub-agents at the same time, call Agent several times in one response.

${environment(env)}`;
}

export function subAgentPrompt(env: PromptEnv, description: string): string {
  return `You are a sub-agent of ThemeBot Engine, working alone in one project folder on a single task ("${description}") given to you by the main agent. There is no person to ask: never ask questions or wait for confirmation; make the most reasonable choice and say so in your report.

# How to work
- Do exactly the task in the user message. Use Read, Edit, Write, Glob and Grep for files (Read before you Edit or overwrite), and Bash only for running scripts and quick checks. Request independent reads and searches together in one response.
- Paths are relative to the project folder; nothing outside it can be read or written.
- Never print, copy or store access tokens, API keys or passwords.
- Your final message is the only thing the main agent receives: make it a complete, self-contained report of what you did and found (file paths, results, failures), in plain language.

${environment(env)}`;
}

/**
 * `-p /clone-theme args` → the content of <workspace>/.claude/commands/clone-theme.md, as Claude Code
 * expands a project slash command (front matter dropped, $ARGUMENTS filled in). Anything else is the prompt.
 */
export async function expandSlashCommand(prompt: string, workspace: string): Promise<{ text: string; command: string | null }> {
  const match = /^\/([A-Za-z0-9][\w:-]{0,60})(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (!match) return { text: prompt, command: null };
  const [, name, args = ''] = match;
  const file = path.join(workspace, '.claude', 'commands', `${name.replace(/:/g, path.sep)}.md`);
  if (!existsSync(file)) return { text: prompt, command: null };
  let body = await readFile(file, 'utf8');
  body = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  body = body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', args.trim()) : (args.trim() ? `${body}\n\nARGUMENTS: ${args.trim()}` : body);
  return { text: body, command: name };
}
