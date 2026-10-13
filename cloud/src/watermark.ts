// Prompt watermarks: every step prompt the Cloud hands out is marked for the account, build and
// step it was sent for, so a leaked excerpt of the recipe can be traced back to an account.
//
// Each (account, build, step) gets a 48-bit mark (a hash of the three, keyed with a secret). The
// mark is written into the prompt through two independent channels:
//
//   1. Invisible: zero-width characters spelling the mark plus a check byte (28 characters), put
//      between sentences of prose at up to four spread-out spots. Survives copy/paste intact; dies
//      to anyone who strips zero-width characters.
//   2. Wording: meaning-preserving choices made at every eligible spot in prose — "do not" or
//      "don't", "e.g." or "for example", "make sure" or "ensure", "for each" or "for every",
//      "**bold**" or "__bold__", "-" or "*" list markers, "1." or "1)", a closing period on list
//      items or none, "—" or "--", "→" or "->", a comma before and/or/but or none. Each choice is a
//      bit drawn from the mark and the spot's surrounding words, so it survives zero-width
//      stripping, re-typing, rewrapping and excerpting.
//      (Real recipe: ~1 spot per 100 characters of prose.)
//
// Never touched: code fences and everything in them, inline `code`, URLs, link targets, paths,
// identifiers, quoted strings, HTML, Liquid, headings, tables, indented code and code-looking
// lines. The line count never changes, and every non-prose line comes out byte-identical.
//
// What was sent is logged (`watermarks`: mark → account/build; `watermark_sends`: step, hashes and
// a few fingerprint n-grams; `watermark_contents` + `watermark_shingles`: the variant-neutral text's
// eligible spots and a sampled 5-gram index). identifyLeak() finds the texts a leak overlaps, reads
// the zero-width marks and the wording bits, and ranks the accounts that received them.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { newId } from './crypto';
import type { CloudDb } from './db';

export type WatermarkDb = CloudDb | DatabaseSync;

const sqlOf = (db: WatermarkDb): DatabaseSync => ('sql' in db ? db.sql : db);

// ---- schema -------------------------------------------------------------------------------------
const ensured = new WeakSet<DatabaseSync>();

/**
 * Creates the watermark log tables (idempotent). `watermarks` already exists in a CloudDb (Phase 1
 * migration); it is created here only for a bare database (no foreign key there).
 */
export function ensureWatermarkSchema(db: WatermarkDb) {
  const sql = sqlOf(db);
  if (ensured.has(sql)) return;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS watermarks (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      build_id TEXT,
      mark TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    -- One row per prompt sent: which mark, for whom, and enough to recognise the text again.
    CREATE TABLE IF NOT EXISTS watermark_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mark TEXT NOT NULL,
      account_id TEXT NOT NULL,
      build_id TEXT,
      step_id TEXT NOT NULL,
      device_id TEXT,
      recipe_version TEXT,
      content_id TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      chars INTEGER NOT NULL,
      slots INTEGER NOT NULL,
      zw_copies INTEGER NOT NULL,
      fingerprints TEXT NOT NULL,
      sent_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS watermark_sends_mark ON watermark_sends (mark);
    CREATE INDEX IF NOT EXISTS watermark_sends_content ON watermark_sends (content_id, sent_at);
    CREATE INDEX IF NOT EXISTS watermark_sends_account ON watermark_sends (account_id, sent_at);
    -- A variant-neutral prompt text (shared by every account it was sent to): its eligible spots.
    CREATE TABLE IF NOT EXISTS watermark_contents (
      id TEXT PRIMARY KEY,
      words INTEGER NOT NULL,
      slot_keys TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    -- Sampled word 5-gram hashes of each content: finds the texts a leaked excerpt came from.
    CREATE TABLE IF NOT EXISTS watermark_shingles (
      shingle INTEGER NOT NULL,
      content_id TEXT NOT NULL,
      PRIMARY KEY (shingle, content_id)
    ) WITHOUT ROWID;
  `);
  // Columns added after the table first shipped (a database created by an earlier build of this module).
  const columns = new Set((sql.prepare('PRAGMA table_info(watermark_sends)').all() as unknown as Array<{ name: string }>).map((column) => column.name));
  for (const column of ['device_id', 'recipe_version']) if (!columns.has(column)) sql.exec(`ALTER TABLE watermark_sends ADD COLUMN ${column} TEXT`);
  ensured.add(sql);
}

// ---- hashing ------------------------------------------------------------------------------------
const MARK_BYTES = 6; // 48-bit marks: collisions stay unlikely into the millions of sends
const ZW = ['\u200B', '\u200C', '\u200D', '\u2060'] as const; // ZWSP, ZWNJ, ZWJ, WORD JOINER — 2 bits each
const ZW_RUN = /[\u200B\u200C\u200D\u2060]+/g;
const PAYLOAD_LENGTH = (MARK_BYTES + 1) * 4; // mark + check byte = 28 characters
const ZW_COPIES = 4;

const sha256 = (text: string) => createHash('sha256').update(text).digest();

function deriveMark(secret: string, accountId: string, buildId: string, stepId: string, salt: number): string {
  return sha256(`themebot-wm1\u0000${secret}\u0000${accountId}\u0000${buildId}\u0000${stepId}\u0000${salt}`).subarray(0, MARK_BYTES).toString('hex');
}
const checkByte = (mark: string) => sha256(`check\u0000${mark}`)[0];
const markSeed = (mark: string) => sha256(`seed\u0000${mark}`).readUInt32BE(0);

/** FNV-1a, 32-bit: keys for spots and shingles (not security relevant). */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** One wording bit for a spot: MurmurHash3 (x86_32) of the spot key, seeded by the mark. */
function chooseBit(seed: number, key: number): 0 | 1 {
  let k = Math.imul(key, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  let h = seed ^ k;
  h = (h << 13) | (h >>> 19);
  h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  h ^= 4;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 31) as 0 | 1;
}

// ---- zero-width channel -------------------------------------------------------------------------
export function encodeZeroWidth(mark: string): string {
  let out = '';
  for (const byte of [...Buffer.from(mark, 'hex'), checkByte(mark)]) {
    for (let shift = 6; shift >= 0; shift -= 2) out += ZW[(byte >> shift) & 3];
  }
  return out;
}

/** Marks spelled by intact zero-width payloads in `text` (bad check byte = ignored). */
export function decodeZeroWidth(text: string): string[] {
  const marks = new Set<string>();
  for (const run of text.match(ZW_RUN) ?? []) {
    if (run.length !== PAYLOAD_LENGTH) continue;
    const bytes: number[] = [];
    for (let index = 0; index < run.length; index += 4) {
      let byte = 0;
      for (let offset = 0; offset < 4; offset += 1) byte = (byte << 2) | (ZW as readonly string[]).indexOf(run[index + offset]);
      bytes.push(byte);
    }
    const mark = Buffer.from(bytes.slice(0, MARK_BYTES)).toString('hex');
    if (checkByte(mark) === bytes[MARK_BYTES]) marks.add(mark);
  }
  return [...marks];
}

export const stripZeroWidth = (text: string) => text.replace(ZW_RUN, '');

// ---- wording channel: interchangeable phrases ---------------------------------------------------
type Family = 'negation' | 'example' | 'ensure' | 'each' | 'direction' | 'bullet' | 'olist' | 'eol' | 'dash' | 'arrow' | 'bold' | 'conj' | 'space';

interface PhrasePair {
  id: string;
  family: Family;
  /** Bit 0 and bit 1 forms, lowercase, straight apostrophes. */
  forms: [string, string];
  /** Per form: what must follow it for the spot to be changed (so both forms read naturally). */
  after?: [RegExp, RegExp];
}

const NEGATIONS: Array<[string, string]> = [
  ['do not', "don't"], ['does not', "doesn't"], ['did not', "didn't"], ['is not', "isn't"], ['are not', "aren't"],
  ['was not', "wasn't"], ['were not', "weren't"], ['has not', "hasn't"], ['have not', "haven't"], ['will not', "won't"],
  ['would not', "wouldn't"], ['should not', "shouldn't"], ['could not', "couldn't"], ['cannot', "can't"],
];

const PAIRS: PhrasePair[] = [
  ...NEGATIONS.map(([full, short]): PhrasePair => ({ id: short.replace("'", ''), family: 'negation', forms: [full, short] })),
  // "for example" only as an aside ("For example, …") — never "look for example files".
  { id: 'eg', family: 'example', forms: ['for example', 'e.g.'], after: [/^[,:]/, /^(?:[\s,:]|$)/] },
  { id: 'ensure', family: 'ensure', forms: ['make sure', 'ensure'] },
  // Not "for each other", "for each of …", "for every one".
  { id: 'each', family: 'each', forms: ['for each', 'for every'], after: [/^ (?!other\b|of\b|one\b)[a-z]/, /^ (?!other\b|of\b|one\b)[a-z]/] },
  { id: 'toward', family: 'direction', forms: ['towards', 'toward'] },
  { id: 'afterward', family: 'direction', forms: ['afterwards', 'afterward'] },
];
/** "make sure"/"ensure" only before these words, where both read the same. */
const ENSURE_NEXT = new Set(['that', 'you', 'the', 'all', 'every', 'each', 'it', 'there', 'no', 'your', 'nothing', 'everything', 'this', 'these', 'those']);

interface FormPattern { pair: number; form: 0 | 1; words: string[]; separators: RegExp[] }
const FORM_PATTERNS = new Map<string, FormPattern[]>(); // first word → patterns, longest first
for (const [pairIndex, pair] of PAIRS.entries()) {
  pair.forms.forEach((literal, form) => {
    const words: string[] = literal.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const separators = (literal.match(/[^a-z0-9]+(?=[a-z0-9])/g) ?? []).map((separator) =>
      /^\s+$/.test(separator) ? /^\s+$/ : separator === "'" ? /^['’`´]$/ : /^\.\s?$/);
    const list = FORM_PATTERNS.get(words[0]) ?? [];
    list.push({ pair: pairIndex, form: form as 0 | 1, words, separators });
    list.sort((left, right) => right.words.length - left.words.length);
    FORM_PATTERNS.set(words[0], list);
  });
}

/** A canonical token: a lowercase word, or one interchangeable phrase (whichever form was used). */
interface Token { word: string; start: number; end: number; pair?: number; form?: 0 | 1 }

/** Words of `text`, with every interchangeable phrase folded to one variant-neutral token. */
function tokenize(text: string): Token[] {
  const raw: Token[] = [];
  for (const match of text.matchAll(/[A-Za-z0-9]+/g)) raw.push({ word: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length });
  const tokens: Token[] = [];
  for (let index = 0; index < raw.length;) {
    let matched: FormPattern | null = null;
    for (const pattern of FORM_PATTERNS.get(raw[index].word) ?? []) {
      const length = pattern.words.length;
      if (index + length > raw.length) continue;
      let ok = true;
      for (let offset = 0; offset < length && ok; offset += 1) {
        ok = raw[index + offset].word === pattern.words[offset]
          && (offset === 0 || pattern.separators[offset - 1].test(text.slice(raw[index + offset - 1].end, raw[index + offset].start)));
      }
      if (ok && PAIRS[pattern.pair].id === 'ensure') {
        const next = raw[index + length];
        ok = next != null && ENSURE_NEXT.has(next.word) && /^\s+$/.test(text.slice(raw[index + length - 1].end, next.start));
      }
      if (ok) { matched = pattern; break; }
    }
    if (matched) {
      const last = raw[index + matched.words.length - 1];
      tokens.push({ word: `~${PAIRS[matched.pair].id}`, start: raw[index].start, end: last.end, pair: matched.pair, form: matched.form });
      index += matched.words.length;
    } else {
      tokens.push(raw[index]);
      index += 1;
    }
  }
  return tokens;
}

/** Variant-neutral word stream of a text (zero-width removed, every phrase pair folded). */
export function canonicalWords(text: string): string[] {
  return tokenize(stripZeroWidth(text)).map((token) => token.word);
}

const firstTokenAt = (tokens: Token[], position: number) => {
  let low = 0;
  let high = tokens.length;
  while (low < high) { const middle = (low + high) >> 1; if (tokens[middle].start < position) low = middle + 1; else high = middle; }
  return low;
};
const words = (tokens: Token[], from: number, to: number) => tokens.slice(Math.max(0, from), Math.max(0, to)).map((token) => token.word).join(' ');

// Spot keys: the spot's kind plus the canonical words around it, so they survive reflowing,
// punctuation changes and excerpting (only spots at the very edge of an excerpt are lost).
const phraseKey = (tokens: Token[], index: number) => fnv1a(`${PAIRS[tokens[index].pair as number].id}|${words(tokens, index - 3, index)}|${words(tokens, index + 1, index + 4)}`);
const afterKey = (kind: Family, tokens: Token[], position: number) => { const at = firstTokenAt(tokens, position); return fnv1a(`${kind}|${words(tokens, at, at + 4)}`); };
const eolKey = (tokens: Token[], position: number) => { const at = firstTokenAt(tokens, position); return fnv1a(`eol|${words(tokens, at - 4, at)}`); };
const aroundKey = (kind: Family, tokens: Token[], position: number) => { const at = firstTokenAt(tokens, position); return fnv1a(`${kind}|${words(tokens, at - 3, at)}|${words(tokens, at, at + 3)}`); };

/** **bold** / __bold__ on one line, not inside a word. */
const BOLD = /(\*\*|__)(?=[^\s*_])([^*_\n]+?)(?<=[^\s*_])\1/g;

// ---- what counts as prose -----------------------------------------------------------------------
type LineKind = 'code' | 'other' | 'prose';
interface Line {
  start: number;
  text: string;
  kind: LineKind;
  /** Where the line's own words begin (after indentation, ">" quote markers and a list marker). */
  contentStart: number;
  list?: { markerStart: number; markerEnd: number; marker: string };
}

const LIST_ITEM = /^(\s*(?:>\s?)*)([-*+]|\d{1,3}[.)])([ \t]+)/;
const QUOTE_PREFIX = /^(\s*(?:>\s?)+)/;
const URL = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)\S+/gi;
const ABBREVIATION = /^(?:e\.g|i\.e|etc|vs|a\.m|p\.m)\.?$/i;
const PLAIN_WORD = /^[("'“‘*_]*[A-Za-z][a-z]*(?:['’][a-z]+)?[)"'”’*_.,;:!?]*$/;

const coreOf = (token: string) => token.replace(/^[(["'“‘*_~]+/, '').replace(/[)\]"'”’*_~.,;:!?]+$/, '');

/** Identifiers, paths, file names, flags, versions, template tags… */
function codeLike(token: string): boolean {
  const core = coreOf(token);
  if (!core || ABBREVIATION.test(core)) return false;
  return /[\\/_=<>{}[\]$@#%^|~`]/.test(core)
    || /[A-Za-z0-9]\.[A-Za-z0-9]/.test(core)
    || /[a-z][A-Z]/.test(core)
    || (/\d/.test(core) && /[A-Za-z]/.test(core))
    || /^-/.test(core)
    || /[A-Za-z0-9]:[A-Za-z0-9]/.test(core);
}

function withoutInlineCode(text: string): string {
  return text.replace(/(`+)[\s\S]*?\1/g, ' ').replace(/`.*$/, ' ');
}

function looksLikeProse(content: string): boolean {
  const text = withoutInlineCode(content.replace(/\r$/, '')).replace(URL, ' ').trim();
  if (!text) return false;
  if (/^[|<{}[\]$]|^\/\/|^\/\*|^#!/.test(text) && !/^\[[^\]]*\]\(/.test(text) && !/^\[[ xX]\]\s/.test(text)) return false;
  if (/\{\{|\{%|%\}|\}\}|<\/?[A-Za-z][^>]*>|<!--|-->/.test(text)) return false;
  if ((text.match(/\|/g) ?? []).length >= 2) return false;
  if (/[;{[(]$|=>$/.test(text)) return false;
  if (/^(?:npm|npx|node|git|cd|curl|shopify|pnpm|yarn|import|export|const|let|var|function|return|class|def|echo|sudo)\s.*[=(){}'"`;]/.test(text)) return false;
  if (/^[\w.-]+\s*[:=]\s*(?:\S+|["'{[].*)$/.test(text)) return false;
  const symbols = (text.match(/[{}[\]()<>=;$\\|]/g) ?? []).length;
  if (symbols / text.length > 0.08) return false;
  const pieces = text.split(/\s+/).filter(Boolean);
  const plain = pieces.filter((piece) => PLAIN_WORD.test(piece)).length;
  return plain >= 3 && plain / pieces.length >= 0.3;
}

function classifyLines(text: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  let inComment = false;
  for (const lineText of text.split('\n')) {
    const line: Line = { start: offset, text: lineText, kind: 'other', contentStart: 0 };
    offset += lineText.length + 1;
    lines.push(line);
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(lineText);
    if (fence) {
      line.kind = 'code';
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && lineText.trim() === fenceMatch[1]) fence = null;
      continue;
    }
    if (fenceMatch) { fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }; line.kind = 'code'; continue; }
    if (inComment) { if (lineText.includes('-->')) inComment = false; continue; }
    if (lineText.includes('<!--')) { inComment = !lineText.slice(lineText.indexOf('<!--')).includes('-->'); continue; }
    if (/^\s*#{1,6}(\s|$)/.test(lineText)) continue; // headings stay as they are
    const item = LIST_ITEM.exec(lineText);
    const indent = (/^[ \t]*/.exec(lineText)?.[0] ?? '').replace(/\t/g, '    ').length;
    if (!item && indent >= 4) continue; // indented code
    if (item) {
      line.contentStart = item[0].length;
      line.list = { markerStart: item[1].length, markerEnd: item[1].length + item[2].length, marker: item[2] };
    } else {
      line.contentStart = QUOTE_PREFIX.exec(lineText)?.[0].length ?? 0;
    }
    if (looksLikeProse(lineText.slice(line.contentStart))) line.kind = 'prose';
  }
  return lines;
}

/** Spans of a prose line that are never changed or written into. */
function protectedRanges(text: string, contentStart: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [[0, contentStart]];
  // Inline code: a run of N backticks up to the next run of exactly N (unclosed = rest of line).
  for (let index = contentStart; index < text.length;) {
    if (text[index] !== '`') { index += 1; continue; }
    let length = 0;
    while (text[index + length] === '`') length += 1;
    let close = -1;
    for (let from = index + length; from < text.length;) {
      const at = text.indexOf('`', from);
      if (at < 0) break;
      let run = 0;
      while (text[at + run] === '`') run += 1;
      if (run === length) { close = at; break; }
      from = at + run;
    }
    if (close < 0) { ranges.push([index, text.length]); break; }
    ranges.push([index, close + length]);
    index = close + length;
  }
  const add = (pattern: RegExp) => { for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]); };
  add(URL);
  add(/\]\([^)]*\)/g); // link targets
  add(/<\/?[A-Za-z!][^>]*>/g);
  add(/\{\{.*?\}\}|\{%.*?%\}/g);
  add(/"[^"\n]*"/g);
  add(/“[^”\n]*”/g);
  add(/‘.*?’(?![A-Za-z])/g);
  for (const match of text.matchAll(/(^|[\s(\[{:;,])('.*?')(?![A-Za-z])/g)) {
    const start = match.index + match[1].length;
    ranges.push([start, start + match[2].length]);
  }
  for (const match of text.matchAll(/\S+/g)) if (codeLike(match[0])) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}

const isFree = (ranges: Array<[number, number]>, start: number, end: number) => !ranges.some(([from, to]) => from < end && start < to);

// ---- applying a mark ----------------------------------------------------------------------------
interface Edit { start: number; end: number; text: string }

/** The form `literal` (lowercase) as written at `span`: first letter may be capitalised, either apostrophe. */
function sameForm(span: string, literal: string): boolean {
  if (span.length !== literal.length) return false;
  if (span[0] !== literal[0] && span[0] !== literal[0].toUpperCase()) return false;
  return span.slice(1).replace(/’/g, "'") === literal.slice(1);
}

function styled(target: string, original: string, apostrophe: string): string {
  let out = target.replace(/'/g, original.includes('’') ? '’' : apostrophe);
  if (/[A-Z]/.test(original[0])) out = out[0].toUpperCase() + out.slice(1);
  return out;
}

interface Applied { text: string; slotKeys: number[]; tokens: Token[]; zeroWidthCopies: number }

/** Writes `mark` into `text` (pure: same text + mark → same output). */
export function applyWatermark(text: string, mark: string): Applied {
  const seed = markSeed(mark);
  const tokens = tokenize(text);
  const lines = classifyLines(text);
  const apostrophe = (text.match(/’/g) ?? []).length > (text.match(/'/g) ?? []).length ? '’' : "'";
  const slotKeys: number[] = [];
  let tokenIndex = 0;

  const edited = lines.map((line, lineIndex) => {
    const lineEnd = line.start + line.text.length;
    const firstToken = tokenIndex;
    while (tokenIndex < tokens.length && tokens[tokenIndex].start < lineEnd) tokenIndex += 1;
    if (line.kind !== 'prose') return line.text;
    const ranges = protectedRanges(line.text, line.contentStart);
    const edits: Edit[] = [];

    // Interchangeable phrases.
    for (let index = firstToken; index < tokenIndex; index += 1) {
      const token = tokens[index];
      if (token.pair == null || token.form == null) continue;
      const pair = PAIRS[token.pair];
      const local = token.start - line.start;
      const literal = pair.forms[token.form];
      const end = local + literal.length;
      if (!sameForm(line.text.slice(local, end), literal)) continue;
      if (/[A-Za-z0-9]/.test(line.text[end] ?? '') || !isFree(ranges, local, end)) continue;
      if (pair.after && !pair.after[token.form].test(line.text.slice(end))) continue;
      const key = phraseKey(tokens, index);
      slotKeys.push(key);
      const bit = chooseBit(seed, key);
      if (bit !== token.form) edits.push({ start: local, end, text: styled(pair.forms[bit], line.text.slice(local, end), apostrophe) });
    }

    // List markers, and the closing period of list items.
    if (line.list) {
      const { markerStart, markerEnd, marker } = line.list;
      if (marker === '-' || marker === '*') {
        const key = afterKey('bullet', tokens, line.start + markerEnd);
        slotKeys.push(key);
        const want = chooseBit(seed, key) ? '*' : '-';
        if (want !== marker) edits.push({ start: markerStart, end: markerEnd, text: want });
      } else if (/^\d+[.)]$/.test(marker)) {
        const key = afterKey('olist', tokens, line.start + markerEnd);
        slotKeys.push(key);
        const want = chooseBit(seed, key) ? ')' : '.';
        if (want !== marker.slice(-1)) edits.push({ start: markerEnd - 1, end: markerEnd, text: want });
      }
      // Only where the item really ends here: not on the first line of a soft-wrapped item.
      const next = lines[lineIndex + 1];
      const itemEnds = !next || next.kind === 'code' || !next.text.trim() || LIST_ITEM.test(next.text) || /^\s*(?:#{1,6}\s|\||<)/.test(next.text);
      const trimmedEnd = line.text.replace(/\s+$/, '').length;
      const lastWord = /\S+$/.exec(line.text.slice(line.contentStart, trimmedEnd))?.[0] ?? '';
      if (itemEnds && trimmedEnd > line.contentStart && isFree(ranges, trimmedEnd - 1, trimmedEnd) && PLAIN_WORD.test(lastWord) && !ABBREVIATION.test(coreOf(lastWord))) {
        const before = line.text.slice(0, trimmedEnd);
        const hasPeriod = /[a-z]{2}\.$/.test(before);
        if (hasPeriod || /[a-z]$/.test(before)) {
          const key = eolKey(tokens, line.start + trimmedEnd);
          slotKeys.push(key);
          const bit = chooseBit(seed, key);
          if (bit === 1 && !hasPeriod) edits.push({ start: trimmedEnd, end: trimmedEnd, text: '.' });
          if (bit === 0 && hasPeriod) edits.push({ start: trimmedEnd - 1, end: trimmedEnd, text: '' });
        }
      }
    }

    // Spaced em dashes and arrows (only the typographic originals are changed: "--" and "->"
    // in a source text may be command-line or code).
    for (const [pattern, family, replacement] of [[/ — /g, 'dash', '--'], [/ → /g, 'arrow', '->']] as const) {
      for (const match of line.text.matchAll(pattern)) {
        const at = match.index + 1;
        if (at < line.contentStart || !isFree(ranges, at, at + 1)) continue;
        const key = aroundKey(family, tokens, line.start + at);
        slotKeys.push(key);
        if (chooseBit(seed, key)) edits.push({ start: at, end: at + 1, text: replacement });
      }
    }

    // **bold** or __bold__.
    for (const match of line.text.matchAll(BOLD)) {
      const open = match.index;
      const close = open + 2 + match[2].length;
      if (open < line.contentStart || /[A-Za-z0-9]/.test(line.text[open - 1] ?? '') || /[A-Za-z0-9]/.test(line.text[close + 2] ?? '')) continue;
      if (!isFree(ranges, open, open + 2) || !isFree(ranges, close, close + 2)) continue;
      const key = afterKey('bold', tokens, line.start + open + 2);
      slotKeys.push(key);
      const want = chooseBit(seed, key) ? '__' : '**';
      if (want !== match[1]) edits.push({ start: open, end: open + 2, text: want }, { start: close, end: close + 2, text: want });
    }

    // One or two spaces between sentences (invisible once rendered; lost if whitespace is squashed).
    for (const match of line.text.matchAll(/[a-z][.!?]( {1,2})(?=[A-Z])/g)) {
      const spaces = match.index + 2;
      const nextWord = spaces + match[1].length;
      if (spaces < line.contentStart || !isFree(ranges, spaces - 1, nextWord + 1)) continue;
      const key = aroundKey('space', tokens, line.start + nextWord);
      slotKeys.push(key);
      const want = chooseBit(seed, key) ? '  ' : ' ';
      if (want !== match[1]) edits.push({ start: spaces, end: nextWord, text: want });
    }

    // The optional comma before and/or/but ("A, B, and C" → "A, B and C").
    for (const match of line.text.matchAll(/[A-Za-z)`'"*], (and|or|but) (?=[A-Za-z`"'(*])/g)) {
      const comma = match.index + 1;
      const conjunction = comma + 2;
      if (comma < line.contentStart || !isFree(ranges, comma, comma + 1) || !isFree(ranges, conjunction, conjunction + match[1].length)) continue;
      const key = aroundKey('conj', tokens, line.start + conjunction);
      slotKeys.push(key);
      if (!chooseBit(seed, key)) edits.push({ start: comma, end: comma + 1, text: '' });
    }

    let out = line.text;
    for (const edit of edits.sort((left, right) => right.start - left.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    return out;
  });

  // Zero-width copies: between sentences (or at a line's end) in prose, spread across the text.
  const spots: Array<{ line: number; at: number }> = [];
  edited.forEach((lineText, index) => {
    const line = lines[index];
    if (line.kind !== 'prose') return;
    const ranges = protectedRanges(lineText, line.contentStart);
    const trimmedEnd = lineText.replace(/\s+$/, '').length;
    for (let at = line.contentStart + 2; at <= trimmedEnd; at += 1) {
      if (!/[.!?]/.test(lineText[at - 1]) || !/[a-z]/.test(lineText[at - 2])) continue;
      if (at < trimmedEnd && lineText[at] !== ' ') continue;
      if (!isFree(ranges, at - 2, at)) continue;
      const lastWord = /\S+$/.exec(lineText.slice(line.contentStart, at))?.[0] ?? '';
      if (ABBREVIATION.test(coreOf(lastWord)) || codeLike(lastWord)) continue;
      spots.push({ line: index, at });
    }
  });
  const chosen = spots.length <= ZW_COPIES ? spots : Array.from({ length: ZW_COPIES }, (_, index) => spots[Math.floor(((2 * index + 1) * spots.length) / (2 * ZW_COPIES))]);
  const payload = encodeZeroWidth(mark);
  for (const spot of [...chosen].sort((left, right) => right.line - left.line || right.at - left.at)) {
    const lineText = edited[spot.line];
    edited[spot.line] = lineText.slice(0, spot.at) + payload + lineText.slice(spot.at);
  }

  return { text: edited.join('\n'), slotKeys, tokens, zeroWidthCopies: chosen.length };
}

// ---- logging ------------------------------------------------------------------------------------
const SHINGLE = 5;
const MAX_SHINGLES_PER_CONTENT = 4000;

function sampledShingles(wordList: string[]): number[] {
  const out = new Set<number>();
  for (let index = 0; index + SHINGLE <= wordList.length; index += 1) {
    const hash = fnv1a(wordList.slice(index, index + SHINGLE).join(' '));
    if (hash % 4 === 0) out.add(hash); // every excerpt samples the same shingles the full text did
  }
  return [...out];
}

function fingerprintSamples(wordList: string[], count = 5): string[] {
  if (wordList.length < SHINGLE) return wordList.length ? [wordList.join(' ')] : [];
  const step = Math.max(1, Math.floor((wordList.length - SHINGLE) / Math.max(1, count - 1)));
  const out: string[] = [];
  for (let index = 0; index + SHINGLE <= wordList.length && out.length < count; index += step) out.push(wordList.slice(index, index + SHINGLE).join(' '));
  return out;
}

export interface WatermarkOptions {
  accountId: string;
  buildId?: string | null;
  stepId: string;
  /** Logged with the send (the computer the step went to). */
  deviceId?: string | null;
  /** Logged with the send (which recipe version the text came from). */
  recipeVersion?: string | null;
  db: WatermarkDb;
  /** Keys the mark derivation; pass the Cloud pepper so marks can't be predicted from ids. */
  secret?: string;
  /** Unix ms for the log row (default Date.now()). */
  now?: number | (() => number);
}

export interface WatermarkResult {
  text: string;
  mark: string;
  /** Wording spots carrying a bit. */
  slots: number;
  zeroWidthCopies: number;
}

/** A mark unique in the log for this (account, build, step); the same triple always gets the same one. */
function allocateMark(sql: DatabaseSync, secret: string, accountId: string, buildId: string, stepId: string): string {
  for (let salt = 0; salt < 16; salt += 1) {
    const mark = deriveMark(secret, accountId, buildId, stepId, salt);
    const owner = sql.prepare('SELECT account_id, build_id FROM watermarks WHERE mark = ?').get(mark) as { account_id: string; build_id: string | null } | undefined;
    if (!owner) return mark;
    const step = sql.prepare('SELECT step_id FROM watermark_sends WHERE mark = ? LIMIT 1').get(mark) as { step_id: string } | undefined;
    if (owner.account_id === accountId && (owner.build_id ?? '') === buildId && (!step || step.step_id === stepId)) return mark;
  }
  throw new Error('Could not allocate a unique watermark.');
}

/** Watermarks a prompt for one account/build/step and logs what was sent. Throws on database errors. */
export function watermarkPromptDetailed(text: string, options: WatermarkOptions): WatermarkResult {
  const sql = sqlOf(options.db);
  ensureWatermarkSchema(options.db);
  const sentAt = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
  const buildId = options.buildId ?? '';
  // SAVEPOINT (not BEGIN) so this also works inside a caller's transaction.
  sql.exec('SAVEPOINT watermark');
  try {
    const mark = allocateMark(sql, options.secret ?? '', options.accountId, buildId, options.stepId);
    const applied = applyWatermark(text, mark);
    const wordList = applied.tokens.map((token) => token.word);
    const slotKeys = [...new Set(applied.slotKeys)].sort((left, right) => left - right);
    const contentId = createHash('sha256').update(`${wordList.join(' ')}|${slotKeys.join(',')}`).digest('hex');
    const content = sql.prepare('INSERT OR IGNORE INTO watermark_contents (id, words, slot_keys, created_at) VALUES (?, ?, ?, ?)').run(contentId, wordList.length, JSON.stringify(slotKeys), sentAt);
    if (Number(content.changes) > 0) {
      const insertShingle = sql.prepare('INSERT OR IGNORE INTO watermark_shingles (shingle, content_id) VALUES (?, ?)');
      for (const shingle of sampledShingles(wordList).slice(0, MAX_SHINGLES_PER_CONTENT)) insertShingle.run(shingle, contentId);
    }
    sql.prepare('INSERT OR IGNORE INTO watermarks (id, account_id, build_id, mark, created_at) VALUES (?, ?, ?, ?, ?)').run(newId('wm'), options.accountId, options.buildId ?? null, mark, sentAt);
    sql.prepare('INSERT INTO watermark_sends (mark, account_id, build_id, step_id, device_id, recipe_version, content_id, text_hash, chars, slots, zw_copies, fingerprints, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(mark, options.accountId, options.buildId ?? null, options.stepId, options.deviceId ?? null, options.recipeVersion ?? null, contentId, createHash('sha256').update(applied.text).digest('hex'), applied.text.length, applied.slotKeys.length, applied.zeroWidthCopies, JSON.stringify(fingerprintSamples(wordList)), sentAt);
    sql.exec('RELEASE watermark');
    return { text: applied.text, mark, slots: applied.slotKeys.length, zeroWidthCopies: applied.zeroWidthCopies };
  } catch (error) {
    sql.exec('ROLLBACK TO watermark');
    sql.exec('RELEASE watermark');
    throw error;
  }
}

/** Returns `text` watermarked for this account/build/step (and logs it). */
export function watermarkPrompt(text: string, options: WatermarkOptions): string {
  return watermarkPromptDetailed(text, options).text;
}

// ---- step engine hook ---------------------------------------------------------------------------
/**
 * What the step engine passes with each prompt (cloud/src/steps PromptContext). The mark depends on
 * account, build and step only — a retried step gets the same mark; device and recipe version are
 * logged with the send.
 */
export interface PromptContext {
  accountId: string;
  buildId?: string | null;
  stepId: string;
  deviceId?: string | null;
  kind?: string;
  attempt?: number;
  recipeVersion?: string | null;
}

export interface DecorateOptions {
  db?: WatermarkDb;
  secret?: string;
  now?: () => number;
  log?: { warn(message: string, fields?: Record<string, unknown>): void };
}

/**
 * The step engine's `decoratePrompt(prompt, ctx)` hook. Never blocks a build: if logging fails
 * (or no database is given) the prompt still goes out watermarked with the derived mark, which
 * can be recomputed later from the account, build and step ids.
 */
export function decoratePrompt(prompt: string, ctx: PromptContext & DecorateOptions): string {
  if (ctx.db) {
    try {
      return watermarkPrompt(prompt, { accountId: ctx.accountId, buildId: ctx.buildId, stepId: ctx.stepId, deviceId: ctx.deviceId, recipeVersion: ctx.recipeVersion, db: ctx.db, secret: ctx.secret, now: ctx.now });
    } catch (error) {
      ctx.log?.warn('watermark log failed; sending the prompt unlogged', { account: ctx.accountId, step: ctx.stepId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return applyWatermark(prompt, deriveMark(ctx.secret ?? '', ctx.accountId, ctx.buildId ?? '', ctx.stepId, 0)).text;
}

/**
 * decoratePrompt bound to the Cloud's database and secret — the step engine's hook:
 * `(prompt, { accountId, deviceId, buildId, stepId, kind, attempt, recipeVersion }) => string`.
 */
export function createPromptDecorator(db: WatermarkDb, options: Omit<DecorateOptions, 'db'> = {}) {
  return (prompt: string, ctx: PromptContext) => decoratePrompt(prompt, { ...options, ...ctx, db });
}

// ---- finding the source of a leak ---------------------------------------------------------------
interface Observation { family: Family; key: number; bit: 0 | 1 }

/** Every wording choice visible in `text` (zero-width already removed). */
function observe(text: string, tokens: Token[]): Observation[] {
  const observations: Observation[] = [];
  tokens.forEach((token, index) => {
    if (token.pair != null && token.form != null) observations.push({ family: PAIRS[token.pair].family, key: phraseKey(tokens, index), bit: token.form });
  });
  let offset = 0;
  for (const line of text.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    const bullet = /^(\s*(?:>\s?)*)([-*])[ \t]+\S/.exec(line);
    if (bullet) observations.push({ family: 'bullet', key: afterKey('bullet', tokens, start + bullet[1].length + 1), bit: bullet[2] === '*' ? 1 : 0 });
    const ordered = /^(\s*(?:>\s?)*)(\d{1,3})([.)])[ \t]+\S/.exec(line);
    if (ordered) observations.push({ family: 'olist', key: afterKey('olist', tokens, start + ordered[1].length + ordered[2].length + 1), bit: ordered[3] === ')' ? 1 : 0 });
    const trimmed = line.replace(/\s+$/, '');
    if (/[a-z]{2}\.$/.test(trimmed)) observations.push({ family: 'eol', key: eolKey(tokens, start + trimmed.length), bit: 1 });
    else if (/[a-z]$/.test(trimmed)) observations.push({ family: 'eol', key: eolKey(tokens, start + trimmed.length), bit: 0 });
    for (const match of line.matchAll(/ (—|--) /g)) observations.push({ family: 'dash', key: aroundKey('dash', tokens, start + match.index + 1), bit: match[1] === '--' ? 1 : 0 });
    for (const match of line.matchAll(/ (→|->) /g)) observations.push({ family: 'arrow', key: aroundKey('arrow', tokens, start + match.index + 1), bit: match[1] === '->' ? 1 : 0 });
    for (const match of line.matchAll(BOLD)) observations.push({ family: 'bold', key: afterKey('bold', tokens, start + match.index + 2), bit: match[1] === '__' ? 1 : 0 });
    for (const match of line.matchAll(/[a-z][.!?]( {1,2})(?=[A-Z])/g)) observations.push({ family: 'space', key: aroundKey('space', tokens, start + match.index + 2 + match[1].length), bit: match[1].length === 2 ? 1 : 0 });
    for (const match of line.matchAll(/(,?) (and|or|but) /g)) observations.push({ family: 'conj', key: aroundKey('conj', tokens, start + match.index + match[1].length + 1), bit: match[1] ? 1 : 0 });
  }
  return observations;
}

/** Per wording spot: how much a match (or a mismatch) says, allowing ~3% edits by the leaker. */
const NOISE = 0.03;
const AGREE = Math.log(2 * (1 - NOISE));
const DISAGREE = Math.log(2 * NOISE);
/** An intact zero-width payload with a valid check byte: near-certain. */
const ZERO_WIDTH_EVIDENCE = 25;
/** A family showing one form at this many spots or more was probably normalised by the leaker. */
const UNIFORM_FAMILY = 5;

export interface LeakCandidate {
  accountId: string;
  email: string | null;
  /** Posterior probability that this account received the leaked text (0..1). */
  confidence: number;
  /** Log-likelihood ratio of the best-matching send, in nats (> 0 = evidence for). */
  score: number;
  zeroWidth: boolean;
  wording: { agree: number; disagree: number; spots: number };
  /** Share of the leak's sampled 5-grams found in the matched prompt (0..1). */
  overlap: number;
  best: { mark: string; buildId: string | null; stepId: string; deviceId: string | null; sentAt: string };
}

export interface LeakReport {
  candidates: LeakCandidate[];
  /** Intact zero-width marks found in the text, and those we have no record of. */
  zeroWidthMarks: string[];
  unknownMarks: string[];
  /** Logged prompts the text overlaps. */
  contentsMatched: number;
  /** Wording spots read from the text (before matching them to a prompt). */
  spotsSeen: number;
  chars: number;
}

export interface LeakOptions {
  /** Most candidates returned (default 10). */
  limit?: number;
  /** Newest sends considered per matched prompt (default 20 000). */
  maxSendsPerContent?: number;
}

interface SendRow { mark: string; account_id: string; build_id: string | null; step_id: string; device_id: string | null; sent_at: number }

/** Full analysis of a leaked text: candidates plus what was found. */
export function analyzeLeak(text: string, db: WatermarkDb, options: LeakOptions = {}): LeakReport {
  const sql = sqlOf(db);
  ensureWatermarkSchema(db);
  const limit = options.limit ?? 10;
  const maxSends = options.maxSendsPerContent ?? 20_000;
  const zeroWidthMarks = decodeZeroWidth(text);
  const zeroWidthSet = new Set(zeroWidthMarks);
  const stripped = stripZeroWidth(text);
  const tokens = tokenize(stripped);
  const observations = observe(stripped, tokens);

  // 1. Which logged prompts does the text come from? Sampled 5-grams, plus the zero-width marks.
  const leakShingles = sampledShingles(tokens.map((token) => token.word));
  const hits = new Map<string, number>();
  for (let index = 0; index < leakShingles.length; index += 400) {
    const chunk = leakShingles.slice(index, index + 400);
    const rows = sql.prepare(`SELECT content_id, COUNT(*) AS hits FROM watermark_shingles WHERE shingle IN (${chunk.map(() => '?').join(',')}) GROUP BY content_id`).all(...chunk) as unknown as Array<{ content_id: string; hits: number }>;
    for (const row of rows) hits.set(row.content_id, (hits.get(row.content_id) ?? 0) + Number(row.hits));
  }
  const minHits = Math.max(2, Math.ceil(leakShingles.length * 0.1));
  const contents = new Set([...hits].filter(([, count]) => count >= minHits).map(([id]) => id));
  const unknownMarks: string[] = [];
  for (const mark of zeroWidthMarks) {
    const rows = sql.prepare('SELECT DISTINCT content_id FROM watermark_sends WHERE mark = ?').all(mark) as unknown as Array<{ content_id: string }>;
    if (!rows.length) unknownMarks.push(mark);
    for (const row of rows) contents.add(row.content_id);
  }

  // 2. For each prompt: score every mark it was sent with against the wording seen in the text.
  interface Scored { accountId: string; confidence: number; score: number; zeroWidth: boolean; agree: number; disagree: number; spots: number; overlap: number; send: SendRow }
  const best = new Map<string, Scored>();
  for (const contentId of contents) {
    const content = sql.prepare('SELECT slot_keys FROM watermark_contents WHERE id = ?').get(contentId) as { slot_keys: string } | undefined;
    if (!content) continue;
    const eligible = new Set(JSON.parse(content.slot_keys) as number[]);
    let relevant = observations.filter((observation) => eligible.has(observation.key));
    const families = new Map<Family, Set<number>>();
    const counts = new Map<Family, number>();
    for (const observation of relevant) {
      families.set(observation.family, (families.get(observation.family) ?? new Set()).add(observation.bit));
      counts.set(observation.family, (counts.get(observation.family) ?? 0) + 1);
    }
    relevant = relevant.filter((observation) => (counts.get(observation.family) ?? 0) < UNIFORM_FAMILY || (families.get(observation.family)?.size ?? 0) > 1);

    const sends = sql.prepare('SELECT mark, account_id, build_id, step_id, device_id, sent_at FROM watermark_sends WHERE content_id = ? ORDER BY sent_at DESC LIMIT ?').all(contentId, maxSends) as unknown as SendRow[];
    const byMark = new Map<string, SendRow>();
    for (const send of sends) if (!byMark.has(send.mark)) byMark.set(send.mark, send);
    const overlap = leakShingles.length ? Math.min(1, (hits.get(contentId) ?? 0) / leakShingles.length) : 0;

    const scored = [...byMark.values()].map((send) => {
      const seed = markSeed(send.mark);
      let agree = 0;
      for (const observation of relevant) if (chooseBit(seed, observation.key) === observation.bit) agree += 1;
      const disagree = relevant.length - agree;
      const zeroWidth = zeroWidthSet.has(send.mark);
      return { send, agree, disagree, zeroWidth, score: agree * AGREE + disagree * DISAGREE + (zeroWidth ? ZERO_WIDTH_EVIDENCE : 0) };
    });
    // Posterior over the sends of this prompt, with a "none of them" alternative of weight 1.
    const top = scored.reduce((max, entry) => Math.max(max, entry.score), 0);
    const denominator = Math.exp(-top) + scored.reduce((sum, entry) => sum + Math.exp(entry.score - top), 0);
    const perAccount = new Map<string, { confidence: number; best: (typeof scored)[number] }>();
    for (const entry of scored) {
      const posterior = Math.exp(entry.score - top) / denominator;
      const current = perAccount.get(entry.send.account_id);
      if (!current) perAccount.set(entry.send.account_id, { confidence: posterior, best: entry });
      else { current.confidence += posterior; if (entry.score > current.best.score) current.best = entry; }
    }
    for (const [accountId, { confidence, best: entry }] of perAccount) {
      const previous = best.get(accountId);
      if (previous && previous.confidence >= confidence) continue;
      best.set(accountId, { accountId, confidence, score: entry.score, zeroWidth: entry.zeroWidth, agree: entry.agree, disagree: entry.disagree, spots: relevant.length, overlap, send: entry.send });
    }
  }
  // A zero-width mark logged in `watermarks` but without a send row (e.g. a partial log).
  for (const mark of [...unknownMarks]) {
    const owner = sql.prepare('SELECT account_id, build_id, created_at FROM watermarks WHERE mark = ?').get(mark) as { account_id: string; build_id: string | null; created_at: number } | undefined;
    if (!owner || best.has(owner.account_id)) continue;
    best.set(owner.account_id, { accountId: owner.account_id, confidence: 1 / (1 + Math.exp(-ZERO_WIDTH_EVIDENCE)), score: ZERO_WIDTH_EVIDENCE, zeroWidth: true, agree: 0, disagree: 0, spots: 0, overlap: 0, send: { mark, account_id: owner.account_id, build_id: owner.build_id, step_id: '', device_id: null, sent_at: owner.created_at } });
    unknownMarks.splice(unknownMarks.indexOf(mark), 1);
  }

  const emailOf = (accountId: string) => {
    try { return (sql.prepare('SELECT email FROM accounts WHERE id = ?').get(accountId) as { email: string } | undefined)?.email ?? null; } catch { return null; }
  };
  const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
  const candidates = [...best.values()]
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.confidence - left.confidence || right.score - left.score || left.accountId.localeCompare(right.accountId))
    .slice(0, limit)
    .map((entry): LeakCandidate => ({
      accountId: entry.accountId,
      email: emailOf(entry.accountId),
      confidence: round(entry.confidence, 4),
      score: round(entry.score, 2),
      zeroWidth: entry.zeroWidth,
      wording: { agree: entry.agree, disagree: entry.disagree, spots: entry.spots },
      overlap: round(entry.overlap, 3),
      best: { mark: entry.send.mark, buildId: entry.send.build_id, stepId: entry.send.step_id, deviceId: entry.send.device_id, sentAt: new Date(entry.send.sent_at).toISOString() },
    }));
  return { candidates, zeroWidthMarks, unknownMarks, contentsMatched: contents.size, spotsSeen: observations.length, chars: text.length };
}

/** Ranked candidate accounts for a leaked text (most likely first), with confidence. */
export function identifyLeak(text: string, db: WatermarkDb, options: LeakOptions = {}): LeakCandidate[] {
  return analyzeLeak(text, db, options).candidates;
}
