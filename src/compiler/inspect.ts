/**
 * ISSUE LOCATION HELPER — maps a validation-issue path to a line/column in the
 * raw JSON text the user is editing, so the frontend contract editor can show
 * inline errors exactly where they occur.
 *
 * The frontend imports EXACTLY `locateIssue` from `src/compiler/inspect.ts` —
 * keep the export name and path stable.
 *
 * Implementation: a small position-aware JSON scanner (no dependencies). It
 * walks the text along the requested path only — objects are scanned key by
 * key, arrays element by element, and every non-matching value is skipped with
 * full string-escape awareness — so it never materializes the parsed document.
 *
 * Path syntax is dot notation as emitted by validateManifest (zod's
 * `path.join('.')` and the hand-rolled passes): `settings.3.type`,
 * `blocks.0.settings.1.id`, `source.liquid`. Bracket indices (`settings[3]`)
 * are tolerated and normalized. The root sentinel `manifest` (and the empty
 * path) resolve to the first character of the document.
 *
 * Returned positions are 1-indexed. For an object property the position is the
 * property KEY (the opening quote); for an array element it is the start of the
 * element's value. Malformed JSON and unresolvable paths return null.
 */

export function locateIssue(jsonText: string, path: string): { line: number; column: number } | null {
  if (typeof jsonText !== 'string' || jsonText.trim().length === 0) return null;
  const segments = normalizePath(path);
  try {
    const offset = new Scanner(jsonText).locate(segments);
    if (offset === null) return null;
    return toLineColumn(jsonText, offset);
  } catch {
    // Malformed JSON (or text the scanner cannot walk) — no position.
    return null;
  }
}

/** `blocks[0].settings[1].id` → ['blocks','0','settings','1','id']; '' / 'manifest' → root. */
function normalizePath(path: string): string[] {
  if (typeof path !== 'string') return [];
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === 'manifest') return [];
  return trimmed
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function toLineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

class Scanner {
  private index = 0;

  constructor(private readonly text: string) {}

  /** Offset of the path target, or null when the path does not resolve. Throws on malformed JSON. */
  locate(segments: string[]): number | null {
    this.skipWhitespace();
    if (segments.length === 0) return this.index < this.text.length ? this.index : null;
    return this.descend(segments);
  }

  private fail(): never {
    throw new Error(`Unexpected token at offset ${this.index}`);
  }

  private peek(): string {
    if (this.index >= this.text.length) this.fail();
    return this.text[this.index];
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && /[ \t\r\n]/.test(this.text[this.index])) this.index += 1;
  }

  /** The value at the cursor must be a container holding segments[0]; walk into it. */
  private descend(segments: string[]): number | null {
    this.skipWhitespace();
    const segment = segments[0];
    const rest = segments.slice(1);
    const char = this.peek();

    if (char === '{') {
      this.index += 1; // consume '{'
      this.skipWhitespace();
      if (this.peek() === '}') return null; // empty object — key not present
      for (;;) {
        this.skipWhitespace();
        const keyStart = this.index;
        if (this.peek() !== '"') this.fail();
        const key = this.readString();
        this.skipWhitespace();
        if (this.peek() !== ':') this.fail();
        this.index += 1; // consume ':'
        this.skipWhitespace();
        if (key === segment) {
          // Target property: the key position is the anchor; deeper paths
          // continue into this property's value.
          return rest.length === 0 ? keyStart : this.descend(rest);
        }
        this.skipValue();
        this.skipWhitespace();
        const next = this.peek();
        if (next === ',') {
          this.index += 1;
          continue;
        }
        if (next === '}') return null; // object exhausted — key not present
        this.fail();
      }
    }

    if (char === '[') {
      const target = /^\d+$/.test(segment) ? Number(segment) : null;
      if (target === null) return null; // non-numeric segment cannot index an array
      this.index += 1; // consume '['
      this.skipWhitespace();
      if (this.peek() === ']') return null; // empty array — index out of range
      let elementIndex = 0;
      for (;;) {
        this.skipWhitespace();
        if (elementIndex === target) {
          // Array elements have no key token; anchor on the value itself.
          return rest.length === 0 ? this.index : this.descend(rest);
        }
        this.skipValue();
        this.skipWhitespace();
        const next = this.peek();
        if (next === ',') {
          this.index += 1;
          elementIndex += 1;
          continue;
        }
        if (next === ']') return null; // index out of range
        this.fail();
      }
    }

    // A primitive cannot contain further path segments.
    return null;
  }

  /** Reads a JSON string at the cursor and returns its decoded value. */
  private readString(): string {
    if (this.peek() !== '"') this.fail();
    this.index += 1; // consume opening quote
    let value = '';
    for (;;) {
      const char = this.peek();
      if (char === '"') {
        this.index += 1;
        return value;
      }
      if (char === '\\') {
        this.index += 1;
        const escape = this.peek();
        this.index += 1;
        switch (escape) {
          case '"': value += '"'; break;
          case '\\': value += '\\'; break;
          case '/': value += '/'; break;
          case 'b': value += '\b'; break;
          case 'f': value += '\f'; break;
          case 'n': value += '\n'; break;
          case 'r': value += '\r'; break;
          case 't': value += '\t'; break;
          case 'u': {
            const hex = this.text.slice(this.index, this.index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail();
            value += String.fromCharCode(parseInt(hex, 16));
            this.index += 4;
            break;
          }
          default:
            this.fail();
        }
        continue;
      }
      value += char;
      this.index += 1;
    }
  }

  /** Advances past any complete JSON value (string, number, literal, object, array). */
  private skipValue(): void {
    this.skipWhitespace();
    const char = this.peek();
    if (char === '"') {
      this.readString();
      return;
    }
    if (char === '{') {
      this.index += 1;
      this.skipWhitespace();
      if (this.peek() === '}') {
        this.index += 1;
        return;
      }
      for (;;) {
        this.skipWhitespace();
        if (this.peek() !== '"') this.fail();
        this.readString();
        this.skipWhitespace();
        if (this.peek() !== ':') this.fail();
        this.index += 1;
        this.skipValue();
        this.skipWhitespace();
        const next = this.peek();
        if (next === ',') {
          this.index += 1;
          continue;
        }
        if (next === '}') {
          this.index += 1;
          return;
        }
        this.fail();
      }
    }
    if (char === '[') {
      this.index += 1;
      this.skipWhitespace();
      if (this.peek() === ']') {
        this.index += 1;
        return;
      }
      for (;;) {
        this.skipValue();
        this.skipWhitespace();
        const next = this.peek();
        if (next === ',') {
          this.index += 1;
          continue;
        }
        if (next === ']') {
          this.index += 1;
          return;
        }
        this.fail();
      }
    }
    // Number or literal (true/false/null): run to the next structural boundary.
    const start = this.index;
    while (this.index < this.text.length && !/[\s,\]}]/.test(this.text[this.index])) this.index += 1;
    if (this.index === start) this.fail();
  }
}
