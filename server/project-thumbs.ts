// Homepage thumbnails for the Projects and Builds cards — taken by the SERVER in the background,
// never by the cards. At startup (and every few hours) every project/build is checked: a missing
// or week-old picture is (re)taken; a failed site is retried after a day. Pages only read the
// saved pictures (GET /workspace/thumbs for the list, /workspace/thumb for the image), so
// switching tabs never starts a capture. One hidden Chromium, one page at a time (low-memory
// machine); it closes itself when the queue is empty. No AI involved.
import { createHash } from 'node:crypto';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A site that failed (down, 404, blank) is retried after a day, or at once via Retake. */
const FAIL_AGE_MS = 24 * 60 * 60 * 1000;
const PAGE_TIMEOUT_MS = 30_000;
/** A JPEG this small is a blank or near-blank page (e.g. an app that hadn't drawn yet). */
const BLANK_BYTES = 8_000;

export interface ThumbSource { path: string; url: string }
export type ThumbStatus = { status: 'ready'; v: number; busy?: boolean } | { status: 'pending' } | { status: 'failed' };

let browser: Browser | null = null;
let chain: Promise<unknown> = Promise.resolve();
let queued = 0;
const inflight = new Map<string, Promise<string | null>>();

export const thumbKey = (projectPath: string) => path.resolve(projectPath).toLowerCase();
export const thumbPath = (workspace: string, projectPath: string) =>
  path.join(workspace, '.themebot-thumbs', `${createHash('sha1').update(thumbKey(projectPath)).digest('hex').slice(0, 16)}.jpg`);

async function launch(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
  return browser;
}

async function capture(url: string, file: string): Promise<string | null> {
  const instance = await launch();
  const context = await instance.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 0.5 });
  try {
    const page = await context.newPage();
    try { await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS }); } catch { /* keep whatever loaded */ }
    try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch { /* SPA still polling */ }
    // Single-page apps can finish "loading" before drawing anything: wait for real content.
    await page.waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 40 || document.images.length > 2, undefined, { timeout: 10_000 }).catch(() => {});
    // Error pages ("Application not found", 404…) are not the homepage.
    const text = (await page.evaluate(() => document.body?.innerText.trim() ?? '').catch(() => '')).slice(0, 400);
    if (text.length < 300 && /application not found|page not found|\b404\b|site not found|not deployed|deployment.*not found/i.test(text)) {
      console.warn(`[thumbs] ${url}: error page ("${text.slice(0, 60)}")`); await unlink(file).catch(() => {}); return null;
    }
    let image: Buffer | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.waitForTimeout(attempt === 0 ? 1500 : 5000); // let hero images and animations settle
      image = await page.screenshot({ type: 'jpeg', quality: 72 });
      if (image.length >= BLANK_BYTES) break;
    }
    if (!image || image.length < BLANK_BYTES) { console.warn(`[thumbs] ${url}: page stayed blank`); return null; }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, image);
    return file;
  } catch (error) { console.warn(`[thumbs] ${url}: ${error instanceof Error ? error.message : error}`); return null; }
  finally { await context.close().catch(() => {}); }
}

/** Queue a capture (deduplicated). Resolves to the saved file, or null when it failed. */
function enqueue(url: string, file: string): Promise<string | null> {
  const running = inflight.get(file);
  if (running) return running;
  const failMark = `${file}.failed`;
  queued += 1;
  const job = chain.then(() => capture(url, file)).catch(() => null).then(async (result) => {
    if (result) await unlink(failMark).catch(() => {});
    else await mkdir(path.dirname(failMark), { recursive: true }).then(() => writeFile(failMark, new Date().toISOString())).catch(() => {});
    return result;
  }).finally(async () => {
    inflight.delete(file);
    queued -= 1;
    if (queued === 0 && browser) { const closing = browser; browser = null; await closing.close().catch(() => {}); }
  });
  chain = job;
  inflight.set(file, job);
  return job;
}

/** Status of one source; queues a capture when its picture is missing or older than a week. */
async function statusOf(workspace: string, source: ThumbSource): Promise<ThumbStatus> {
  const file = thumbPath(workspace, source.path);
  const info = await stat(file).catch(() => null);
  const fresh = info && Date.now() - info.mtimeMs < MAX_AGE_MS;
  if (!fresh && source.url && !inflight.has(file)) {
    const failed = await stat(`${file}.failed`).catch(() => null);
    const failedRecently = failed && Date.now() - failed.mtimeMs < FAIL_AGE_MS;
    if (!failedRecently) void enqueue(source.url, file);
    else if (!info) return { status: 'failed' };
  }
  // An old picture keeps showing while a new one is taken (busy).
  if (info) return { status: 'ready', v: Math.round(info.mtimeMs), ...(inflight.has(file) ? { busy: true } : {}) };
  return source.url ? { status: 'pending' } : { status: 'failed' };
}

/** Status for every source, keyed by thumbKey(path). Doubles as the background warm-up:
 *  whatever is missing or stale gets queued. */
export async function thumbStatuses(workspace: string, sources: ThumbSource[]): Promise<Record<string, ThumbStatus>> {
  const out: Record<string, ThumbStatus> = {};
  for (const source of sources) out[thumbKey(source.path)] = await statusOf(workspace, source);
  return out;
}

/** The saved picture for a path (never captures). */
export async function savedThumb(workspace: string, projectPath: string): Promise<string | null> {
  const file = thumbPath(workspace, projectPath);
  return (await stat(file).catch(() => null)) ? file : null;
}

/** Retake now (the card's refresh button), even when the saved one is fresh or the site failed. */
export function retakeThumb(workspace: string, source: ThumbSource): boolean {
  if (!source.url) return false;
  void enqueue(source.url, thumbPath(workspace, source.path));
  return true;
}
