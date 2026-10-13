import type { BetaImageBlockParam, BetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { z } from 'zod';
import type { Permissions } from '../permissions';

export type ToolContent = string | Array<BetaTextBlockParam | BetaImageBlockParam>;
export interface ToolResult { content: ToolContent; isError?: boolean }

export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

export interface AgentRequest { description: string; prompt: string; subagentType: string; model: string | null; toolUseId?: string }

export interface ToolContext {
  /** Absolute, real path of the project folder. Every file tool is confined to it. */
  workspace: string;
  permissions: Permissions;
  /** Files this agent has read or written → their mtime then (for read-before-write and staleness checks). */
  readState: Map<string, number>;
  signal: AbortSignal;
  /** Environment for commands the Bash tool starts (never holds the API key). */
  commandEnv: NodeJS.ProcessEnv;
  /** bash to run commands with (Git Bash on Windows); null when none was found. */
  bashPath: string | null;
  todos: Todo[];
  /** Runs a sub-agent and returns its final report (absent inside sub-agents: no nesting). */
  runAgent?: (request: AgentRequest) => Promise<ToolResult>;
  /** Answers a prompt over a long fetched page with a small model (WebFetch). */
  summarize?: (text: string, prompt: string, url: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

export interface ToolDef<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: Schema;
  /** Safe to run at the same time as other parallel-safe calls from the same response. */
  parallelSafe: boolean;
  run(input: z.infer<Schema>, context: ToolContext): Promise<ToolResult>;
}

export const ok = (content: ToolContent): ToolResult => ({ content });
export const fail = (message: string): ToolResult => ({ content: message, isError: true });
