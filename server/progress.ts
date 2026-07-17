// Shared onboarding/background progress feed — an in-memory ring of human-readable lines
// (Claude login output, workspace init, project discovery, Haiku scans). Polled by the
// onboarding gate and the Home terminal card. Local-only, never persisted.
export interface ProgressLine { at: number; line: string }

const RING = 200;
const lines: ProgressLine[] = [];
let busyCount = 0;

export function addProgress(line: string) {
  const clean = line.replace(/\s+$/g, '');
  if (!clean) return;
  lines.push({ at: Date.now(), line: clean.slice(0, 400) });
  if (lines.length > RING) lines.shift();
}

/** Mark a background task running; returns a done() to call in finally. */
export function beginTask(): () => void {
  busyCount += 1;
  let done = false;
  return () => { if (!done) { done = true; busyCount = Math.max(0, busyCount - 1); } };
}

export function progressSnapshot(since = 0): { lines: ProgressLine[]; busy: boolean } {
  return { lines: since ? lines.filter((entry) => entry.at > since) : lines.slice(-60), busy: busyCount > 0 };
}
