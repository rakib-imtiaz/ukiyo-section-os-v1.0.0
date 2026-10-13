// WebFetch — fetches a page from a host the project allows (WebFetch(domain:…) rules: the React site,
// the store, cdn.shopify.com) and returns it as text. Redirects are followed only to allowed hosts.
// A long page is answered by a small model with the caller's prompt (as Claude Code does), so it does
// not land whole in the main model's context.
import { z } from 'zod';
import { hostAllowed } from '../permissions';
import { fail, ok, type ToolDef } from './types';

const MAX_REDIRECTS = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const RAW_LIMIT = 24_000;       // up to this many characters are returned as they are
const SUMMARY_INPUT = 400_000;  // what the summarizer may read
const IMAGE_LIMIT = 3.5 * 1024 * 1024;

/** HTML → readable text: drops scripts/styles/comments, keeps link targets and line structure. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => `${label} (${href})`)
    .replace(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (_match, src: string) => `[image ${src}]`)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/header|\/footer)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

const webSchema = z.object({
  url: z.string().describe('Full http(s) URL on an allowed host.'),
  prompt: z.string().describe('What you want to know from the page (used to answer over long pages).'),
});

export const webFetchTool: ToolDef<typeof webSchema> = {
  name: 'WebFetch',
  description: 'Fetches a URL on a host this project allows (the React site, the Shopify store, cdn.shopify.com) and returns its text; long pages are answered with your prompt instead. Images come back as the image. For other hosts use the project scripts.',
  schema: webSchema,
  parallelSafe: true,
  async run(input, context) {
    let url: URL;
    try { url = new URL(input.url); } catch { return fail('That is not a valid URL.'); }
    const fetcher = context.fetchImpl ?? fetch;
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('Only http(s) URLs can be fetched.');
      if (!hostAllowed(context.permissions, url.hostname)) {
        const hosts = context.permissions.webHosts.join(', ') || 'none';
        return fail(`${url.hostname} is not an allowed host for WebFetch in this project (allowed: ${hosts}).`);
      }
      try {
        response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]), headers: { 'user-agent': 'ThemeBot-Engine/1.0', accept: 'text/html,application/json,text/plain,image/*;q=0.8,*/*;q=0.5' } });
      } catch (error) { return fail(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`); }
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!location) break;
      url = new URL(location, url);
      response = null;
    }
    if (!response) return fail('Too many redirects.');
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) return fail(`The response is larger than ${MAX_BYTES / 1048576} MB.`);
    if (!response.ok) return fail(`HTTP ${response.status} from ${url.href}\n${buffer.toString('utf8').slice(0, 500)}`);
    const image = /^image\/(png|jpeg|gif|webp)/.exec(type);
    if (image) {
      if (buffer.length > IMAGE_LIMIT) return ok(`${url.href} is a ${type} image of ${buffer.length} bytes (too large to show).`);
      return ok([{ type: 'text', text: `${url.href} (${type}, ${buffer.length} bytes):` }, { type: 'image', source: { type: 'base64', media_type: `image/${image[1]}` as 'image/png', data: buffer.toString('base64') } }]);
    }
    const raw = buffer.toString('utf8');
    const text = type.includes('html') || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
    const header = `${url.href} — HTTP ${response.status}${type ? ` (${type.split(';')[0]})` : ''}`;
    if (text.length <= RAW_LIMIT) return ok(`${header}\n\n${text}`);
    if (context.summarize) {
      try { return ok(`${header} — answered from ${text.length} characters of page text:\n\n${await context.summarize(text.slice(0, SUMMARY_INPUT), input.prompt, url.href)}`); }
      catch (error) { if ((error as Error)?.name === 'BudgetExceeded') throw error; /* fall through to the cut text */ }
    }
    return ok(`${header}\n\n${text.slice(0, RAW_LIMIT)}\n\n[page cut at ${RAW_LIMIT} of ${text.length} characters]`);
  },
};
