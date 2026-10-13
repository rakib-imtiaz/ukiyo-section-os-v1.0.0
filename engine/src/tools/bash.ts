// Bash — runs one command line in the project folder, after the permission check in permissions.ts.
// Commands run under bash (Git Bash on Windows, like Claude Code) with an environment that never
// carries the Anthropic key, are stopped (whole process tree) when they pass their timeout, and their
// combined output is capped.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { killTree, ownProcessGroup } from '../../../server/platform/proc';
import { checkCommand } from '../permissions';
import { fail, ok, type ToolDef } from './types';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT = 30_000;

/** bash for the Bash tool: CLAUDE_CODE_GIT_BASH_PATH / Git for Windows on Windows, /bin/bash elsewhere. */
export function findBash(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = process.platform === 'win32'
    ? [env.THEMEBOT_ENGINE_BASH, env.CLAUDE_CODE_GIT_BASH_PATH,
      path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : undefined]
    : [env.THEMEBOT_ENGINE_BASH, '/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/bin/sh'];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

/** The environment commands get: the engine's own minus the key and the engine's settings. */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value == null || /^(ANTHROPIC_|THEMEBOT_ENGINE)/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Keeps the start and the end of long output (errors usually sit at the end). */
export function capOutput(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[… ${text.length - max} characters cut …]\n\n${text.slice(-tail)}`;
}

const bashSchema = z.object({
  command: z.string().describe('The command line to run (bash syntax).'),
  timeout: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe(`Milliseconds before the command is stopped (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
  description: z.string().optional().describe('A few words on what the command does (shown in the build log).'),
  run_in_background: z.boolean().optional().describe('Not supported here — commands always run in the foreground.'),
});

export const bashTool: ToolDef<typeof bashSchema> = {
  name: 'Bash',
  description: `Runs a command line in the project folder with bash and returns its combined output and exit code. Only the commands this project allows can run (the error names them); chain with &&, ||, ; or pipes. Not allowed: command substitution $(…)/backticks, subshells, heredocs, background jobs, cd or redirects outside the project. Use Read/Write/Edit/Glob/Grep for files rather than cat/sed/find. Default timeout ${DEFAULT_TIMEOUT_MS / 1000}s, max ${MAX_TIMEOUT_MS / 1000}s.`,
  schema: bashSchema,
  parallelSafe: false,
  async run(input, context) {
    if (input.run_in_background) return fail('Background commands are not supported. Run the command in the foreground (raise timeout up to 600000 ms for long ones).');
    const check = checkCommand(context.permissions, input.command, context.workspace);
    if (!check.ok) return fail(`Not run: ${check.reason}`);
    if (!context.bashPath) return fail('No bash was found on this computer (on Windows, install Git for Windows). The command was not run.');
    const timeout = Math.min(MAX_TIMEOUT_MS, input.timeout ?? DEFAULT_TIMEOUT_MS);
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let timedOut = false;
      const child = spawn(context.bashPath!, ['-c', input.command], { cwd: context.workspace, env: context.commandEnv, shell: false, windowsHide: true, detached: ownProcessGroup });
      const collect = (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > MAX_OUTPUT * 4) output = capOutput(output, MAX_OUTPUT * 2); };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.stdin?.end();
      const stop = () => { void killTree(child); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
      const onAbort = () => stop();
      context.signal.addEventListener('abort', onAbort, { once: true });
      const finish = (code: number | null, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal.removeEventListener('abort', onAbort);
        const text = capOutput(output.trim());
        if (error) { resolve(fail(`Could not start bash: ${error.message}`)); return; }
        if (timedOut) { resolve(fail(`${text}\n\n[stopped after ${timeout / 1000}s — raise timeout (max 600000 ms) or split the work]`.trim())); return; }
        const body = text || '(no output)';
        resolve(code === 0 ? ok(body) : fail(`${body}\n\n[exit code ${code ?? 'n/a'}]`));
      };
      child.on('error', (error) => finish(null, error));
      child.on('close', (code) => finish(code));
    });
  },
};
