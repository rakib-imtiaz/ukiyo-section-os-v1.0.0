// The engine's tool set and how a tool call is run.
//
// Tool names and inputs mirror Claude Code's (Read, Write, Edit, Glob, Grep, Bash, WebFetch, Agent,
// TodoWrite) so the build recipe — written for Claude Code — needs no changes. Each tool's zod schema
// is the single source for both the JSON schema sent to the API and the validation of what comes back:
// tools stream their input eagerly (`eager_input_streaming`), so the API no longer validates it and
// the engine must.
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { bashTool } from './bash';
import { editTool, globTool, grepTool, readTool, writeTool } from './fs';
import { fail, ok, type Todo, type ToolContext, type ToolDef, type ToolResult } from './types';
import { webFetchTool } from './web';

const todoSchema = z.object({
  todos: z.array(z.object({
    content: z.string().describe('The task, in the imperative ("Build the header section").'),
    status: z.enum(['pending', 'in_progress', 'completed']),
    activeForm: z.string().optional().describe('The task in present-continuous form ("Building the header section").'),
  })).describe('The whole updated list (replaces the previous one).'),
});
export const todoTool: ToolDef<typeof todoSchema> = {
  name: 'TodoWrite',
  description: 'Keeps your task list for this session (shown to the operator as build progress). Send the whole list each time; keep exactly one task in_progress while you work and mark tasks completed as soon as they are done.',
  schema: todoSchema,
  parallelSafe: true,
  async run(input, context) {
    context.todos.splice(0, context.todos.length, ...(input.todos as Todo[]));
    const done = input.todos.filter((todo) => todo.status === 'completed').length;
    return ok(`Task list updated: ${done}/${input.todos.length} done.`);
  },
};

const agentSchema = z.object({
  description: z.string().describe('A short (3-5 word) label for the task.'),
  prompt: z.string().describe('The complete task for the sub-agent. It sees only this text — include every file path, format, rule and credential step it needs, and what to report back.'),
  subagent_type: z.string().optional().describe('"general-purpose" (default; all tools except Agent) or "Explore" (read-only: Read, Glob, Grep, WebFetch).'),
  model: z.string().optional().describe('"haiku" for mechanical work (HTTP calls, diffs), "sonnet" for moderate reasoning and vision checks, "opus" only for the hardest judgment. Never above this session\'s own tier.'),
  run_in_background: z.boolean().optional().describe('Ignored: to run sub-agents at the same time, call Agent several times in one response.'),
});
export const agentTool: ToolDef<typeof agentSchema> = {
  name: 'Agent',
  description: 'Starts a sub-agent that works on its own task with its own context and returns its final report. Use it for self-contained work (one page, one check, store setup calls) and to keep long reading out of your own context. Several Agent calls in one response run at the same time. Always set model to the cheapest tier that can do the job.',
  schema: agentSchema,
  parallelSafe: true,
  async run(input, context) {
    if (!context.runAgent) return fail('Sub-agents cannot start further sub-agents. Do the work yourself.');
    return context.runAgent({ description: input.description, prompt: input.prompt, subagentType: input.subagent_type ?? 'general-purpose', model: input.model ?? null });
  },
};

export const ALL_TOOLS: ToolDef[] = [readTool, writeTool, editTool, globTool, grepTool, bashTool, webFetchTool, todoTool, agentTool] as ToolDef[];
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'TodoWrite']);

/** The tools an agent gets: what the project's settings allow, minus Agent inside sub-agents. */
export function toolsFor(allowed: Set<string>, kind: 'main' | 'general-purpose' | 'explore'): ToolDef[] {
  return ALL_TOOLS.filter((tool) => {
    if (!allowed.has(tool.name)) return false;
    if (kind === 'main') return true;
    if (tool.name === 'Agent') return false;
    return kind === 'explore' ? READ_ONLY.has(tool.name) : true;
  });
}

/** API tool definitions, in a fixed order (a changing tools list would break the prompt cache). */
export function apiTools(tools: ToolDef[]): BetaTool[] {
  return tools.map((tool) => {
    const schema = zodToJsonSchema(tool.schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>;
    delete schema.$schema;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: schema as BetaTool['input_schema'],
      eager_input_streaming: true,
    };
  });
}

/** Finds the tool a call names — exactly, or by a unique case-insensitive match ("bash" for "Bash"). */
export function findTool(tools: ToolDef[], name: string): ToolDef | null {
  const exact = tools.find((tool) => tool.name === name);
  if (exact) return exact;
  const loose = tools.filter((tool) => tool.name.toLowerCase() === name.toLowerCase());
  return loose.length === 1 ? loose[0] : null;
}

/** Validates the parsed input, then runs the tool. Never throws for tool-level problems. */
export async function runTool(tools: ToolDef[], name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
  const tool = findTool(tools, name);
  if (!tool) return fail(`There is no tool named "${name}". Available tools: ${tools.map((entry) => entry.name).join(', ')}.`);
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    // Eager input streaming hands us whatever was generated: broken JSON comes back as a tool error
    // so the model can retry the call.
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '(input)'}: ${issue.message}`).join('; ');
    return fail(JSON.stringify({ INVALID_INPUT: issues, received: JSON.stringify(input ?? null).slice(0, 2000) }));
  }
  try {
    return await tool.run(parsed.data, context);
  } catch (error) {
    if ((error as Error)?.name === 'BudgetExceeded' || context.signal.aborted) throw error;
    return fail(`${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export { type ToolContext, type ToolDef, type ToolResult } from './types';
