// File tools — Read, Write, Edit, Glob, Grep — named and shaped like Claude Code's so the recipe's
// prompts work unchanged. Every path is untrusted model output: it is resolved, real-pathed and
// confined to the project folder before anything touches the disk.
import { existsSync } from 'node:fs';
import { glob, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { fail, ok, type ToolContext, type ToolDef } from './types';

const IMAGE_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_READ_CHARS = 200_000;
const DEFAULT_LINES = 2000;
const MAX_LINE = 2000;
const SKIP_DIRS = new Set(['node_modules', '.git']);

const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(fold(root), fold(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
const rel = (context: ToolContext, target: string) => path.relative(context.workspace, target).split(path.sep).join('/') || '.';

/** Model path → absolute path inside the project, or an error message. */
export async function resolvePath(context: ToolContext, raw: unknown): Promise<{ path: string } | { error: string }> {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'A file path is required.' };
  let value = raw.trim();
  // Git Bash spelling on Windows: /c/Users/... → C:\Users\...
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(value)) value = `${value[1]}:${value.slice(2)}`;
  const target = path.resolve(context.workspace, value);
  if (!isInside(context.workspace, target)) return { error: `${raw} is outside the project folder (${context.workspace}). Only files inside it can be used.` };
  // A symlink inside the project must not lead out of it: check the real path of the nearest existing part.
  let probe = target;
  while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try {
    const real = await realpath(probe);
    if (!isInside(context.workspace, real)) return { error: `${raw} leads outside the project folder.` };
  } catch { /* nothing exists yet on this path */ }
  return { path: target };
}

async function mtime(file: string): Promise<number | null> {
  try { return (await stat(file)).mtimeMs; } catch { return null; }
}

/** Write/Edit on an existing file need a Read of its current version first. */
async function freshness(context: ToolContext, file: string): Promise<string | null> {
  const current = await mtime(file);
  if (current === null) return null;
  const seen = context.readState.get(fold(file));
  if (seen === undefined) return `Read ${rel(context, file)} before changing it (it already exists).`;
  if (Math.abs(seen - current) > 1) return `${rel(context, file)} changed since you last read it. Read it again, then retry.`;
  return null;
}

// ---- Read ---------------------------------------------------------------------------------------
const readSchema = z.object({
  file_path: z.string().describe('Path of the file, relative to the project folder or absolute inside it.'),
  offset: z.number().int().min(1).optional().describe('Line number to start at (1-based). Use for large files.'),
  limit: z.number().int().min(1).optional().describe(`How many lines to read (default ${DEFAULT_LINES}).`),
});
export const readTool: ToolDef<typeof readSchema> = {
  name: 'Read',
  description: `Reads a file from the project. Text comes back with line numbers (cat -n style); images (PNG, JPG, GIF, WebP) come back as the image itself, so use it to look at screenshots. Reads up to ${DEFAULT_LINES} lines by default — use offset/limit for longer files. You must Read a file before you Edit it or overwrite it with Write.`,
  schema: readSchema,
  parallelSafe: true,
  async run(input, context) {
    const resolved = await resolvePath(context, input.file_path);
    if ('error' in resolved) return fail(resolved.error);
    const file = resolved.path;
    let info;
    try { info = await stat(file); } catch { return fail(`${input.file_path} does not exist.`); }
    if (info.isDirectory()) return fail(`${input.file_path} is a folder. Use Glob, or Bash with ls, to list it.`);
    const ext = path.extname(file).toLowerCase();
    if (IMAGE_TYPES[ext]) {
      if (info.size > MAX_IMAGE_BYTES) return fail(`${input.file_path} is ${(info.size / 1048576).toFixed(1)} MB — images over 5 MB cannot be viewed. Save a smaller copy first.`);
      context.readState.set(fold(file), info.mtimeMs);
      return ok([{ type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext], data: (await readFile(file)).toString('base64') } }]);
    }
    if (ext === '.pdf') return fail('PDF files cannot be read with this tool.');
    const buffer = await readFile(file);
    if (buffer.subarray(0, 8192).includes(0)) return fail(`${input.file_path} is a binary file.`);
    context.readState.set(fold(file), info.mtimeMs);
    const text = buffer.toString('utf8');
    if (!text.length) return ok(`(${input.file_path} is empty)`);
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const start = (input.offset ?? 1) - 1;
    if (start >= lines.length) return fail(`${input.file_path} has only ${lines.length} lines.`);
    const end = Math.min(lines.length, start + (input.limit ?? DEFAULT_LINES));
    let out = '';
    let shownUntil = start;
    for (let index = start; index < end; index++) {
      const line = lines[index].length > MAX_LINE ? `${lines[index].slice(0, MAX_LINE)}… [line cut at ${MAX_LINE} characters]` : lines[index];
      const next = `${String(index + 1).padStart(6)}\t${line}\n`;
      if (out.length + next.length > MAX_READ_CHARS) break;
      out += next;
      shownUntil = index + 1;
    }
    if (shownUntil < lines.length) out += `\n[showing lines ${start + 1}-${shownUntil} of ${lines.length} — use offset/limit to read more]`;
    return ok(out);
  },
};

// ---- Write --------------------------------------------------------------------------------------
const writeSchema = z.object({
  file_path: z.string().describe('Path of the file, relative to the project folder or absolute inside it.'),
  content: z.string().describe('The complete new content of the file.'),
});
export const writeTool: ToolDef<typeof writeSchema> = {
  name: 'Write',
  description: 'Creates a file, or replaces an existing one with new content (Read an existing file first). Missing folders are created. Prefer Edit for changing part of an existing file.',
  schema: writeSchema,
  parallelSafe: false,
  async run(input, context) {
    const resolved = await resolvePath(context, input.file_path);
    if ('error' in resolved) return fail(resolved.error);
    const file = resolved.path;
    const stale = await freshness(context, file);
    if (stale) return fail(stale);
    const existed = existsSync(file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, input.content, 'utf8');
    context.readState.set(fold(file), (await mtime(file)) ?? Date.now());
    const lines = input.content ? input.content.split('\n').length : 0;
    return ok(`${existed ? 'Replaced' : 'Created'} ${rel(context, file)} (${lines} lines).`);
  },
};

// ---- Edit ---------------------------------------------------------------------------------------
const editSchema = z.object({
  file_path: z.string().describe('Path of the file to change.'),
  old_string: z.string().describe('The exact text to replace (including indentation). Must appear exactly once unless replace_all is true.'),
  new_string: z.string().describe('The text to put in its place.'),
  replace_all: z.boolean().optional().describe('Replace every occurrence of old_string (default false).'),
});
export const editTool: ToolDef<typeof editSchema> = {
  name: 'Edit',
  description: 'Replaces exact text in a file you have Read. old_string must match the file exactly (whitespace included) and be unique — add surrounding lines to make it unique, or set replace_all to change every occurrence.',
  schema: editSchema,
  parallelSafe: false,
  async run(input, context) {
    const resolved = await resolvePath(context, input.file_path);
    if ('error' in resolved) return fail(resolved.error);
    const file = resolved.path;
    if (!existsSync(file)) return fail(`${input.file_path} does not exist. Use Write to create it.`);
    const stale = await freshness(context, file);
    if (stale) return fail(stale);
    if (input.old_string === input.new_string) return fail('old_string and new_string are the same — nothing to change.');
    if (!input.old_string) return fail('old_string is empty. Use Write to replace a whole file.');
    const text = await readFile(file, 'utf8');
    let oldText = input.old_string;
    let newText = input.new_string;
    // The file uses CRLF but the edit was written with LF: match it in the file's own line endings.
    if (!text.includes(oldText) && text.includes('\r\n') && !oldText.includes('\r\n')) {
      const crlf = oldText.replace(/\n/g, '\r\n');
      if (text.includes(crlf)) { oldText = crlf; newText = newText.replace(/\r?\n/g, '\r\n'); }
    }
    const count = text.split(oldText).length - 1;
    if (count === 0) return fail(`old_string was not found in ${rel(context, file)}. Read the file again and copy the text exactly.`);
    if (count > 1 && !input.replace_all) return fail(`old_string appears ${count} times in ${rel(context, file)}. Include more surrounding text to make it unique, or set replace_all.`);
    const next = input.replace_all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
    await writeFile(file, next, 'utf8');
    context.readState.set(fold(file), (await mtime(file)) ?? Date.now());
    return ok(`Edited ${rel(context, file)} (${input.replace_all ? count : 1} replacement${(input.replace_all ? count : 1) === 1 ? '' : 's'}).`);
  },
};

// ---- Glob ---------------------------------------------------------------------------------------
const globSchema = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "sections/*.liquid" or "react_files/**/*.tsx".'),
  path: z.string().optional().describe('Folder to search in (default: the project folder).'),
});
const MAX_GLOB = 250;
export const globTool: ToolDef<typeof globSchema> = {
  name: 'Glob',
  description: `Finds files by name pattern ("**/*.liquid"). Returns project-relative paths, newest first (at most ${MAX_GLOB}). node_modules and .git are skipped unless the pattern names them.`,
  schema: globSchema,
  parallelSafe: true,
  async run(input, context) {
    const base = await resolvePath(context, input.path ?? '.');
    if ('error' in base) return fail(base.error);
    if (path.isAbsolute(input.pattern) || input.pattern.split(/[\\/]/).includes('..')) return fail('Use a pattern relative to the folder (no absolute paths or "..").');
    const wantsSkipped = /node_modules|\.git/.test(input.pattern);
    const found: Array<{ file: string; at: number }> = [];
    try {
      for await (const entry of glob(input.pattern, { cwd: base.path, exclude: (name: string) => !wantsSkipped && SKIP_DIRS.has(path.basename(String(name))) })) {
        const file = path.resolve(base.path, String(entry));
        if (!isInside(context.workspace, file)) continue;
        const at = await mtime(file);
        if (at !== null) found.push({ file, at });
        if (found.length > 5000) break;
      }
    } catch (error) { return fail(`Glob failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!found.length) return ok('No files found.');
    found.sort((a, b) => b.at - a.at);
    const shown = found.slice(0, MAX_GLOB).map((entry) => rel(context, entry.file));
    return ok(shown.join('\n') + (found.length > MAX_GLOB ? `\n[${found.length - MAX_GLOB} more not shown — narrow the pattern]` : ''));
  },
};

// ---- Grep ---------------------------------------------------------------------------------------
/** A small glob → RegExp for Grep's file filter: *, **, ?, {a,b}. Matches against the base name when the glob has no slash. */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i++; if (pattern[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') { const close = pattern.indexOf('}', i); if (close > i) { out += `(?:${pattern.slice(i + 1, close).split(',').map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`; i = close; } else out += '\\{'; }
    else out += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
}

const grepSchema = z.object({
  pattern: z.string().describe('Regular expression (JavaScript syntax) to search for.'),
  path: z.string().optional().describe('File or folder to search (default: the project folder).'),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.liquid" or "sections/**/*.liquid".'),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().describe('"files_with_matches" (default) lists files; "content" shows matching lines; "count" counts matches per file.'),
  '-i': z.boolean().optional().describe('Case-insensitive.'),
  '-n': z.boolean().optional().describe('Show line numbers (content mode; default true).'),
  '-A': z.number().int().min(0).max(50).optional().describe('Lines of context after each match (content mode).'),
  '-B': z.number().int().min(0).max(50).optional().describe('Lines of context before each match (content mode).'),
  '-C': z.number().int().min(0).max(50).optional().describe('Lines of context around each match (content mode).'),
  head_limit: z.number().int().min(1).optional().describe('Stop after this many output lines/files (default 250).'),
});
const MAX_GREP_FILE = 5 * 1024 * 1024;

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) yield* walk(full); }
    else if (entry.isFile()) yield full;
  }
}

export const grepTool: ToolDef<typeof grepSchema> = {
  name: 'Grep',
  description: 'Searches file contents with a regular expression. Default output lists matching files; output_mode "content" shows matching lines (with -n line numbers and -A/-B/-C context), "count" counts per file. Filter files with glob. node_modules and .git are skipped.',
  schema: grepSchema,
  parallelSafe: true,
  async run(input, context) {
    const base = await resolvePath(context, input.path ?? '.');
    if ('error' in base) return fail(base.error);
    let regex: RegExp;
    try { regex = new RegExp(input.pattern, input['-i'] ? 'i' : ''); } catch (error) { return fail(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`); }
    const filter = input.glob ? globToRegExp(input.glob) : null;
    const mode = input.output_mode ?? 'files_with_matches';
    const limit = input.head_limit ?? 250;
    const before = input['-B'] ?? input['-C'] ?? 0;
    const after = input['-A'] ?? input['-C'] ?? 0;
    const numbers = input['-n'] ?? true;
    let info;
    try { info = await stat(base.path); } catch { return fail(`${input.path} does not exist.`); }
    const files = info.isFile() ? (async function* () { yield base.path; })() : walk(base.path);
    const out: string[] = [];
    let matchedFiles = 0;
    for await (const file of files) {
      if (out.length >= limit) break;
      const relative = rel(context, file);
      if (filter && !filter.test(input.glob!.includes('/') ? relative : path.basename(file))) continue;
      let size;
      try { size = (await stat(file)).size; } catch { continue; }
      if (size > MAX_GREP_FILE) continue;
      const buffer = await readFile(file).catch(() => null);
      if (!buffer || buffer.subarray(0, 8192).includes(0)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      const hits: number[] = [];
      for (let index = 0; index < lines.length; index++) if (regex.test(lines[index])) hits.push(index);
      if (!hits.length) continue;
      matchedFiles++;
      if (mode === 'files_with_matches') { out.push(relative); continue; }
      if (mode === 'count') { out.push(`${relative}:${hits.length}`); continue; }
      const shown = new Set<number>();
      for (const hit of hits) for (let line = Math.max(0, hit - before); line <= Math.min(lines.length - 1, hit + after); line++) shown.add(line);
      let previous = -2;
      for (const line of [...shown].sort((a, b) => a - b)) {
        if (out.length >= limit) break;
        if (previous >= 0 && line > previous + 1) out.push('--');
        const text = lines[line].length > 500 ? `${lines[line].slice(0, 500)}…` : lines[line];
        out.push(numbers ? `${relative}:${line + 1}:${text}` : `${relative}:${text}`);
        previous = line;
      }
    }
    if (!out.length) return ok('No matches found.');
    return ok(out.slice(0, limit).join('\n') + (out.length >= limit ? `\n[output stopped at ${limit} lines — narrow the search or raise head_limit]` : '') + (mode === 'files_with_matches' ? '' : `\n(${matchedFiles} file${matchedFiles === 1 ? '' : 's'})`));
  },
};
