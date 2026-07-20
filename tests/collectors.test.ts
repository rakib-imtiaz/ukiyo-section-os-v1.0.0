import { describe, expect, it } from 'vitest';
import { parsePastedKeys, BOOKMARKLET_HREF } from '../src/factory/bookmarklet';

const CLIENT_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 32 hex
const SECRET = 'shpss_ABC123_def-456';

describe('bookmarklet paste parser', () => {
  it('parses the themebot|id|secret payload the bookmarklet writes', () => {
    expect(parsePastedKeys(`themebot|${CLIENT_ID}|${SECRET}`)).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET });
  });

  it('extracts id + secret from messy pasted text regardless of order or surrounding noise', () => {
    const messy = `Client secret\n  ${SECRET}\nClient ID: ${CLIENT_ID}  (copied)`;
    expect(parsePastedKeys(messy)).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET });
  });

  it('returns partial results when only one value is present', () => {
    expect(parsePastedKeys(CLIENT_ID)).toEqual({ clientId: CLIENT_ID, clientSecret: null });
    expect(parsePastedKeys(SECRET)).toEqual({ clientId: null, clientSecret: SECRET });
  });

  it('rejects a too-short id and a non-shpss secret', () => {
    expect(parsePastedKeys('deadbeef nope_secret')).toEqual({ clientId: null, clientSecret: null });
  });

  it('builds a javascript: bookmarklet href on a single line', () => {
    expect(BOOKMARKLET_HREF.startsWith('javascript:')).toBe(true);
    expect(BOOKMARKLET_HREF).not.toContain('\n');
  });
});
