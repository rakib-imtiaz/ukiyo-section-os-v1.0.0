// A deliberately small, conservative bash parser for the Bash tool's permission check.
//
// It splits a command into simple commands (`&&`, `||`, `;`, `|`, newlines), each with its leading
// `NAME=value` assignments, its words and its redirects — and REFUSES what it does not fully model,
// so that what bash runs is exactly the sequence of simple commands that was checked:
// command substitution ($(…), `…`), arithmetic $((…)), process substitution <(…) >(…), subshells
// and grouping parentheses, heredocs/herestrings (<<, <<<), ANSI-C quoting $'…', background jobs (&).

export interface ShellRedirect { op: string; fd: number | null; target: string | null }
export interface ShellSegment { assignments: Array<{ name: string; value: string }>; words: string[]; redirects: ShellRedirect[] }
export type ShellParse = { ok: true; segments: ShellSegment[] } | { ok: false; reason: string };

type Token = { kind: 'word'; value: string; assignName: string | null } | { kind: 'op'; value: string } | { kind: 'redirect'; op: string; fd: number | null };

const refuse = (reason: string): ShellParse => ({ ok: false, reason });

export function parseShell(input: string): ShellParse {
  const tokens: Token[] = [];
  let i = 0;
  let word: string | null = null;    // current word's value (null = no word in progress)
  let quotedAt = -1;                  // index in `word` where the first quoted/escaped char landed
  const startWord = () => { if (word === null) { word = ''; quotedAt = -1; } };
  const markQuoted = () => { startWord(); if (quotedAt < 0) quotedAt = (word ?? '').length; };
  const append = (text: string) => { startWord(); word = (word ?? '') + text; };
  const endWord = () => {
    if (word === null) return;
    const value = word;
    const eq = value.indexOf('=');
    const name = eq > 0 ? value.slice(0, eq) : '';
    const assignName = eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && (quotedAt < 0 || quotedAt > eq) ? name : null;
    tokens.push({ kind: 'word', value, assignName });
    word = null;
  };

  // Reads a $… expansion starting at input[i] === '$'; appends it literally. Returns an error or null.
  const readDollar = (): string | null => {
    const next = input[i + 1];
    if (next === '(') return 'Command substitution $(…) is not allowed — run each command on its own.';
    if (next === "'") return "ANSI-C quoting $'…' is not allowed.";
    if (next === '{') {
      const close = input.indexOf('}', i + 2);
      if (close < 0) return 'Unclosed ${…}.';
      const body = input.slice(i, close + 1);
      if (/\$\(|`/.test(body.slice(2))) return 'Command substitution inside ${…} is not allowed.';
      append(body); i = close + 1; return null;
    }
    append('$'); i += 1; return null;
  };

  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') { endWord(); i++; continue; }
    if (ch === '\n') { endWord(); tokens.push({ kind: 'op', value: ';' }); i++; continue; }
    if (ch === '#' && word === null) { while (i < input.length && input[i] !== '\n') i++; continue; }
    if (ch === '\\') {
      if (input[i + 1] === '\n') { i += 2; continue; }   // line continuation
      if (i + 1 >= input.length) return refuse('Command ends with a lone backslash.');
      markQuoted(); append(input[i + 1]); i += 2; continue;
    }
    if (ch === "'") {
      const close = input.indexOf("'", i + 1);
      if (close < 0) return refuse('Unclosed single quote.');
      markQuoted(); append(input.slice(i + 1, close)); i = close + 1; continue;
    }
    if (ch === '"') {
      markQuoted();
      i++;
      let closed = false;
      while (i < input.length) {
        const c = input[i];
        if (c === '"') { closed = true; i++; break; }
        if (c === '`') return refuse('Backtick command substitution is not allowed.');
        if (c === '\\' && i + 1 < input.length && '$`"\\\n'.includes(input[i + 1])) { if (input[i + 1] !== '\n') append(input[i + 1]); i += 2; continue; }
        if (c === '$') { const error = readDollar(); if (error) return refuse(error); continue; }
        append(c); i++;
      }
      if (!closed) return refuse('Unclosed double quote.');
      continue;
    }
    if (ch === '`') return refuse('Backtick command substitution is not allowed.');
    if (ch === '$') { const error = readDollar(); if (error) return refuse(error); continue; }
    if (ch === '(' || ch === ')') return refuse('Subshells and grouping parentheses are not allowed — run the commands one after another.');
    if (ch === '&') {
      if (input[i + 1] === '&') { endWord(); tokens.push({ kind: 'op', value: '&&' }); i += 2; continue; }
      if (input[i + 1] === '>') { endWord(); const append = input[i + 2] === '>'; tokens.push({ kind: 'redirect', op: append ? '&>>' : '&>', fd: null }); i += append ? 3 : 2; continue; }
      return refuse('Background jobs (&) are not allowed.');
    }
    if (ch === '|') {
      endWord();
      if (input[i + 1] === '|') { tokens.push({ kind: 'op', value: '||' }); i += 2; continue; }
      tokens.push({ kind: 'op', value: '|' }); i += input[i + 1] === '&' ? 2 : 1; continue;
    }
    if (ch === ';') {
      if (input[i + 1] === ';') return refuse('";;" is not allowed.');
      endWord(); tokens.push({ kind: 'op', value: ';' }); i++; continue;
    }
    if (ch === '<' || ch === '>') {
      // A word made only of digits right before the operator is the file descriptor (2>file).
      let fd: number | null = null;
      if (word !== null && quotedAt < 0 && /^\d+$/.test(word)) { fd = Number(word); word = null; }
      else endWord();
      const next = input[i + 1];
      if (next === '(') return refuse('Process substitution is not allowed.');
      if (ch === '<') {
        if (next === '<') return refuse('Heredocs and herestrings (<<) are not allowed — write the file first, then run it.');
        if (next === '&') { tokens.push({ kind: 'redirect', op: '<&', fd }); i += 2; continue; }
        tokens.push({ kind: 'redirect', op: '<', fd }); i++; continue;
      }
      if (next === '>') { tokens.push({ kind: 'redirect', op: '>>', fd }); i += 2; continue; }
      if (next === '&') { tokens.push({ kind: 'redirect', op: '>&', fd }); i += 2; continue; }
      if (next === '|') { tokens.push({ kind: 'redirect', op: '>', fd }); i += 2; continue; }
      tokens.push({ kind: 'redirect', op: '>', fd }); i++; continue;
    }
    append(ch); i++;
  }
  endWord();

  // Tokens → simple commands.
  const segments: ShellSegment[] = [];
  let current: ShellSegment = { assignments: [], words: [], redirects: [] };
  const flush = (requireNonEmpty: boolean): string | null => {
    const empty = !current.words.length && !current.assignments.length && !current.redirects.length;
    if (empty) return requireNonEmpty ? 'An operator is missing a command on one side.' : null;
    segments.push(current);
    current = { assignments: [], words: [], redirects: [] };
    return null;
  };
  let lastOp: string | null = null;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'op') {
      const error = flush(token.value !== ';');
      if (error) return refuse(error);
      lastOp = token.value;
      continue;
    }
    lastOp = null;
    if (token.kind === 'redirect') {
      if (token.op === '>&' || token.op === '<&') {
        const target = tokens[index + 1];
        if (target?.kind === 'word' && /^(\d+|-)$/.test(target.value)) { current.redirects.push({ op: token.op, fd: token.fd, target: null }); index++; continue; }
        if (target?.kind === 'word' && token.op === '>&') { current.redirects.push({ op: '>', fd: token.fd, target: target.value }); index++; continue; }
        return refuse('Unsupported file-descriptor redirect.');
      }
      const target = tokens[index + 1];
      if (target?.kind !== 'word') return refuse(`Redirect ${token.op} needs a file name.`);
      current.redirects.push({ op: token.op, fd: token.fd, target: target.value });
      index++;
      continue;
    }
    if (!current.words.length && token.assignName) current.assignments.push({ name: token.assignName, value: token.value.slice(token.assignName.length + 1) });
    else current.words.push(token.value);
  }
  if (lastOp && lastOp !== ';') return refuse(`The command ends with "${lastOp}".`);
  const error = flush(false);
  if (error) return refuse(error);
  return { ok: true, segments };
}
