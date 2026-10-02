// Keyword + fuzzy search for the Projects page. Every word you type must match somewhere
// (name, folder, summary or status). Exact/prefix hits on the name rank first; typo-tolerant
// "fuzzy" hits (letters in order, e.g. "mtrch" → matriarch) still match but rank lower.

export interface Searchable { name: string; folder: string; summary: string; status: string }

const norm = (value: string) => value.toLowerCase().replace(/[_\-.]+/g, ' ');

/** Letters of `needle` appear in order inside `hay`; tighter spans score higher (0 = no match). */
function fuzzy(needle: string, hay: string): number {
  let from = 0; let first = -1; let last = -1;
  for (const char of needle) {
    const at = hay.indexOf(char, from);
    if (at < 0) return 0;
    if (first < 0) first = at;
    last = at; from = at + 1;
  }
  return needle.length / (last - first + 1);
}

function scoreWord(word: string, item: Searchable): number {
  const name = norm(item.name); const folder = norm(item.folder);
  const summary = norm(item.summary); const status = norm(item.status);
  if (name === word) return 100;
  if (name.startsWith(word) || name.split(' ').some((part) => part.startsWith(word))) return 80;
  if (name.includes(word) || folder.includes(word)) return 60;
  if (status.includes(word)) return 45;
  if (summary.includes(word)) return 35;
  if (word.length < 3) return 0; // fuzzy on 1–2 letters matches almost everything
  const nameFuzzy = Math.max(fuzzy(word, name), fuzzy(word, folder));
  if (nameFuzzy >= 0.5) return 20 + nameFuzzy * 10;
  return 0;
}

/** Filter + rank. An empty query returns the list unchanged. */
export function searchProjects<T>(items: T[], query: string, pick: (item: T) => Searchable): T[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items
    .map((item) => {
      const fields = pick(item);
      let total = 0;
      for (const word of words) { const score = scoreWord(word, fields); if (!score) return null; total += score; }
      return { item, total };
    })
    .filter((entry): entry is { item: T; total: number } => entry != null)
    .sort((a, b) => b.total - a.total)
    .map((entry) => entry.item);
}
