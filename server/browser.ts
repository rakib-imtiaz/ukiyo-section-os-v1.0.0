// Integrated browser — LOCAL OPERATOR TOOL.
// A managed Playwright browser (isolated bundled Chromium by default, else system Chrome/Edge)
// with MULTIPLE TABS, streamed into the app via CDP screencast over WebSocket (/browser) and
// driven by the same singleton the local MCP browser tools use — so Claude's actions render live.
// The active tab is brought to the front (smooth screencast); other displayed tabs (split view)
// are kept fresh with periodic screenshots. Disabled in production, localhost-only.
import type { IncomingMessage } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { WebSocketServer, type WebSocket } from 'ws';
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright';
import { config } from './config';
import { addWsRoute } from './ws-hub';

const require = createRequire(import.meta.url);

/** Only loopback hosts may connect (defence-in-depth on top of the prod gate). */
function isLocalRequest(host: string | undefined, origin: string | undefined): boolean {
  const hostname = (value: string | undefined) => {
    if (!value) return null;
    try { return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase(); } catch { return null; }
  };
  const loop = (name: string | null) => name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]';
  return loop(hostname(host)) && (origin == null || loop(hostname(origin)));
}

// ---------------------------------------------------------------------------
// Engine resolution — isolated bundled Chromium, else system Chrome / Edge.
// ---------------------------------------------------------------------------
export type EngineId = 'chromium' | 'chrome' | 'msedge';
export interface EngineInfo { id: EngineId; label: string; isolated: boolean; available: boolean; executablePath?: string }

function fileExists(p: string | undefined): boolean { try { return !!p && fs.existsSync(p); } catch { return false; } }
function isolatedExecutable(): string { try { return chromium.executablePath(); } catch { return ''; } }

function systemCandidates(): Record<'chrome' | 'msedge', string[]> {
  const env = process.env;
  if (process.platform === 'win32') {
    const pf = env['ProgramFiles'] || 'C:/Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
    const local = env['LOCALAPPDATA'] || '';
    return {
      chrome: [`${pf}/Google/Chrome/Application/chrome.exe`, `${pf86}/Google/Chrome/Application/chrome.exe`, path.join(local, 'Google/Chrome/Application/chrome.exe')],
      msedge: [`${pf86}/Microsoft/Edge/Application/msedge.exe`, `${pf}/Microsoft/Edge/Application/msedge.exe`],
    };
  }
  if (process.platform === 'darwin') {
    return { chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'], msedge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] };
  }
  return {
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    msedge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
  };
}

export function detectEngines(): EngineInfo[] {
  const iso = isolatedExecutable();
  const sys = systemCandidates();
  const chromePath = sys.chrome.find(fileExists);
  const edgePath = sys.msedge.find(fileExists);
  return [
    { id: 'chromium', label: 'Isolated Chromium', isolated: true, available: fileExists(iso), executablePath: iso || undefined },
    { id: 'chrome', label: 'System Chrome', isolated: false, available: !!chromePath, executablePath: chromePath },
    { id: 'msedge', label: 'System Edge', isolated: false, available: !!edgePath, executablePath: edgePath },
  ];
}

function resolveEngine(): EngineInfo | null {
  const engines = detectEngines();
  const pref = (config.browser.engine || 'auto').toLowerCase();
  if (pref !== 'auto') return engines.find((engine) => engine.id === pref && engine.available) ?? null;
  for (const id of ['chromium', 'chrome', 'msedge'] as EngineId[]) { const found = engines.find((engine) => engine.id === id && engine.available); if (found) return found; }
  return null;
}

// ---------------------------------------------------------------------------
// Extensions — auto-detect the Claude extension from the user's real Chrome/Edge
// profiles, plus any unpacked dirs from BROWSER_EXTENSIONS. Loaded into the managed
// browser via a persistent profile + --load-extension (the only way Chromium loads them).
// ---------------------------------------------------------------------------
export interface LoadedExtension { id: string; name: string; path: string; isClaude: boolean }

/** Real Chrome/Edge "User Data" roots (each contains Default/, Profile 1/, … with an Extensions/ dir). */
function chromeUserDataDirs(): string[] {
  const env = process.env;
  if (process.platform === 'win32') {
    const local = env['LOCALAPPDATA'] || '';
    return local ? [path.join(local, 'Google/Chrome/User Data'), path.join(local, 'Microsoft/Edge/User Data')] : [];
  }
  if (process.platform === 'darwin') {
    const home = env['HOME'] || '';
    return home ? [path.join(home, 'Library/Application Support/Google/Chrome'), path.join(home, 'Library/Application Support/Microsoft Edge')] : [];
  }
  const home = env['HOME'] || '';
  return home ? [path.join(home, '.config/google-chrome'), path.join(home, '.config/microsoft-edge')] : [];
}

// The Claude for Chrome extension carries a fixed `key`, so this ID is stable wherever it loads.
const CLAUDE_EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';

/** Pick the newest version folder (that has a manifest) inside an installed extension dir. */
function latestUnpackedDir(extDir: string): string | null {
  try {
    const subs = fs.readdirSync(extDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const sub of subs) { const full = path.join(extDir, sub); if (fs.existsSync(path.join(full, 'manifest.json'))) return full; }
  } catch { /* ignore */ }
  return null;
}

function findClaudeExtensionDir(): string | null {
  for (const base of chromeUserDataDirs()) {
    let profiles: string[] = [];
    try { profiles = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const profile of profiles) {
      const dir = path.join(base, profile, 'Extensions', CLAUDE_EXTENSION_ID);
      if (fs.existsSync(dir)) { const unpacked = latestUnpackedDir(dir); if (unpacked) return unpacked; }
    }
  }
  return null;
}

/** All extensions to load: configured extras (BROWSER_EXTENSIONS) + the auto-detected Claude extension. */
export function resolveExtensions(): LoadedExtension[] {
  const out: LoadedExtension[] = [];
  const seen = new Set<string>();
  const add = (dir: string, isClaude: boolean) => {
    const clean = dir.trim(); if (!clean) return;
    const keyed = clean.toLowerCase();
    if (seen.has(keyed) || !fs.existsSync(path.join(clean, 'manifest.json'))) return;
    let name = isClaude ? 'Claude' : path.basename(clean);
    try { const m = JSON.parse(fs.readFileSync(path.join(clean, 'manifest.json'), 'utf8')); if (typeof m.name === 'string' && !m.name.startsWith('__MSG_')) name = m.name; } catch { /* ignore */ }
    seen.add(keyed);
    out.push({ id: isClaude ? CLAUDE_EXTENSION_ID : crypto.createHash('md5').update(keyed).digest('hex').slice(0, 8), name, path: clean, isClaude });
  };
  for (const extra of (config.browser.extensions || '').split(';')) add(extra, false);
  const claude = findClaudeExtensionDir();
  if (claude) add(claude, true);
  return out;
}

// ---------------------------------------------------------------------------
interface NavState { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }
interface ConsoleEntry { at: number; level: string; text: string }
interface NetworkEntry { at: number; method: string; url: string; status: number | null; ok: boolean; failure?: string }
interface Tab { id: number; page: Page; cdp: CDPSession | null; console: ConsoleEntry[]; network: NetworkEntry[]; nav: NavState; lastFrame: Buffer | null }
interface TabSummary { id: number; title: string; url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }

type ClientMessage =
  | { type: 'mouse'; id?: number; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { type: 'wheel'; id?: number; x: number; y: number; dx: number; dy: number }
  | { type: 'key'; id?: number; action: 'down' | 'up'; key: string; code?: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
  | { type: 'navigate'; id?: number; url: string }
  | { type: 'back'; id?: number } | { type: 'forward'; id?: number } | { type: 'reload'; id?: number }
  | { type: 'tab-new'; url?: string } | { type: 'tab-close'; id: number } | { type: 'tab-activate'; id: number }
  | { type: 'viewing'; ids: number[] }
  | { type: 'headless'; value: boolean }
  | { type: 'start' } | { type: 'stop' }
  | { type: 'open-claude' } | { type: 'open-extensions' }
  | { type: 'front' } | { type: 'install' }
  | { type: 'qa'; id?: number; url: string; compareUrl?: string };

const RING = 250;

// Branded new-tab page (rendered via setContent, so the address bar stays empty like a real
// browser's new tab). Search box submits to Google; direct URLs navigate straight to them.
const NEW_TAB_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>New tab</title><style>
  :root { color-scheme: dark; }
  * { margin: 0; box-sizing: border-box; font-family: system-ui, "Segoe UI", sans-serif; }
  body { min-height: 100vh; display: grid; place-items: center; background: radial-gradient(1100px 560px at 50% -10%, #151b30, #0b0b0e 62%); color: #e4e4e7; }
  main { width: min(680px, 92vw); display: grid; justify-items: center; gap: 32px; padding: 40px 0 70px; }
  .logo { display: grid; place-items: center; width: 84px; height: 84px; border-radius: 26px; background: linear-gradient(135deg, #4f7cff, #3b5fe0); box-shadow: 0 18px 50px rgba(79,124,255,.35); animation: pop .6s cubic-bezier(.22,1,.36,1) both; }
  h1 { font-size: 25px; font-weight: 800; letter-spacing: -.02em; animation: rise .55s .08s cubic-bezier(.22,1,.36,1) both; }
  h1 span { color: #8ab4ff; }
  form { width: 100%; display: flex; gap: 10px; animation: rise .55s .16s cubic-bezier(.22,1,.36,1) both; }
  input { flex: 1; height: 52px; padding: 0 22px; border-radius: 16px; border: 1px solid #26262d; background: #15151b; color: #f2f3f7; font-size: 15px; outline: none; transition: border-color .15s, box-shadow .15s; }
  input:focus { border-color: #3b5fe0; box-shadow: 0 0 0 3px rgba(79,124,255,.18); }
  input::placeholder { color: #6c6c75; }
  form button { height: 52px; padding: 0 26px; border: 0; border-radius: 16px; background: linear-gradient(135deg, #4f7cff, #3b5fe0); color: #fff; font-size: 14px; font-weight: 800; cursor: pointer; transition: filter .15s, transform .15s; }
  form button:hover { filter: brightness(1.08); transform: translateY(-1px); }
  nav { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; animation: rise .55s .24s cubic-bezier(.22,1,.36,1) both; }
  nav a { display: grid; justify-items: center; gap: 9px; width: 96px; padding: 14px 6px; border-radius: 14px; color: #a9a9b3; font-size: 11.5px; font-weight: 600; text-decoration: none; transition: background .15s, color .15s, transform .15s; }
  nav a:hover { background: #17171f; color: #fff; transform: translateY(-2px); }
  nav i { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 13px; background: #1a1a23; border: 1px solid #26262d; font-style: normal; font-size: 19px; font-weight: 800; }
  @keyframes pop { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: scale(1); } }
  @keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
</style></head><body><main>
  <div class="logo"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7"><circle cx="12" cy="12" r="9.2"/><path d="M2.8 12h18.4M12 2.8c2.6 2.5 4 5.7 4 9.2s-1.4 6.7-4 9.2c-2.6-2.5-4-5.7-4-9.2s1.4-6.7 4-9.2z"/></svg></div>
  <h1>New tab &middot; <span>ThemeBot Browser</span></h1>
  <form action="https://www.google.com/search"><input name="q" placeholder="Search Google or enter a URL&hellip;" autofocus autocomplete="off"><button type="submit">Search</button></form>
  <nav>
    <a href="https://www.google.com"><i style="color:#8ab4ff">G</i>Google</a>
    <a href="https://www.youtube.com"><i style="color:#f87171">&#9654;</i>YouTube</a>
    <a href="https://github.com"><i style="font-size:14px">GH</i>GitHub</a>
    <a href="https://admin.shopify.com"><i style="color:#7fe0a6">S</i>Shopify</a>
    <a href="https://claude.ai"><i style="color:#f5b678">C</i>Claude</a>
    <a href="http://localhost:5173"><i style="color:#8ab4ff">T</i>ThemeBot</a>
  </nav>
</main><script>
  document.querySelector('form').addEventListener('submit', function (event) {
    var value = document.querySelector('input').value.trim();
    var isUrl = /^https?:\\/\\//i.test(value) || /^localhost([:/]|$)/i.test(value) || /^[\\w-]+(\\.[\\w-]+)+([:/].*)?$/.test(value);
    if (value && isUrl) { event.preventDefault(); location.href = /^https?:/i.test(value) ? value : (/^localhost/i.test(value) ? 'http://' : 'https://') + value; }
  });
</script></body></html>`;

class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private tabs = new Map<number, Tab>();
  private order: number[] = [];
  private nextTabId = 1;
  private activeId = 0;
  private viewing = new Set<number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private launching: Promise<void> | null = null;
  private closing = false;
  /** Set while a probe() launches the browser on its own: no extensions (so it can run truly
   *  headless with no window on screen) and it is closed again as soon as the probe finishes. */
  private minimalLaunch = false;
  private subscribers = new Set<(message: unknown) => void>();
  private inputChain: Promise<void> = Promise.resolve();
  engine: EngineInfo | null = null;
  headless = config.browser.headless;
  loadedExtensions: LoadedExtension[] = [];

  // ---- lifecycle ----
  isRunning() { return !!this.context && this.tabs.size > 0; }

  async ensure(): Promise<void> {
    if (this.isRunning()) return;
    if (!this.launching) this.launching = this.launch().finally(() => { this.launching = null; });
    await this.launching;
  }

  private launchArgs(): string[] {
    const { width, height } = config.browser;
    return ['--no-first-run', '--no-default-browser-check', '--disable-infobars', '--disable-features=TranslateUI,Translate',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--window-size=${width},${height}`];
  }

  private async launch(): Promise<void> {
    const engine = resolveEngine();
    if (!engine) throw new Error('No browser engine available. Install the isolated browser or install Chrome/Edge.');
    this.engine = engine;
    const extensions = this.minimalLaunch ? [] : resolveExtensions();
    this.loadedExtensions = extensions;

    const args = this.launchArgs();
    if (extensions.length) {
      const list = extensions.map((extension) => extension.path).join(',');
      args.push(`--disable-extensions-except=${list}`, `--load-extension=${list}`);
    }
    // Chromium only loads extensions in a HEADED persistent context. When the user wants no
    // visible window (headless) but extensions are present, run headed but positioned off-screen —
    // the window still composites (so the CDP screencast keeps streaming) yet never appears.
    const hasExtensions = extensions.length > 0;
    const runHeadless = this.headless && !hasExtensions;
    if (this.headless && hasExtensions) args.push('--window-position=-2400,-2400');

    const options: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: runHeadless, args,
      viewport: { width: config.browser.width, height: config.browser.height }, deviceScaleFactor: 1,
    };
    // The exact browser we found (Chrome, Edge, or a distro Chromium on Linux) — Playwright's
    // channels only know the vendors' default install paths.
    if (!engine.isolated && engine.executablePath) options.executablePath = engine.executablePath;

    // Persistent profile: cookies, sign-ins, and extension state survive stop/start & app restarts.
    try { fs.mkdirSync(config.browser.profileDir, { recursive: true }); } catch { /* ignore */ }
    this.context = await chromium.launchPersistentContext(config.browser.profileDir, options);
    this.browser = this.context.browser(); // null for persistent contexts — lifecycle keys off `this.context`
    // Adopt any page the browser or an extension opens (welcome tabs, popups) as a real tab in our UI,
    // so nothing ever appears as a stray untracked window.
    this.context.on('page', (page) => { void this.trackPage(page, { activate: false }); });

    const start = config.browser.startUrl || 'about:blank';
    const initial = this.context.pages()[0]; // persistent context opens with one blank page — reuse it
    await this.createTab(start && start !== 'about:blank' ? start : undefined, initial);
    this.startPoll();
    // any launch path (UI Start button or an MCP tool auto-starting) flips every client to the live view
    this.broadcast({ type: 'status', status: this.status() });
  }

  private tabForPage(page: Page): Tab | undefined { for (const tab of this.tabs.values()) if (tab.page === page) return tab; return undefined; }

  /** Wrap a Playwright page as a tracked tab (idempotent — a page is only ever tracked once). */
  private async trackPage(page: Page, opts: { url?: string; activate?: boolean } = {}): Promise<Tab> {
    const existing = this.tabForPage(page);
    if (existing) {
      // RACE: context.on('page') adopts every new page (with no url) and usually claims it before
      // createTab's own trackPage call runs — which used to silently drop createTab's target URL,
      // leaving the tab on the branded new-tab page. If we hold a URL for an adopted-but-blank
      // page, navigate it now (setContent leaves page.url() at about:blank, so this check covers
      // both the raw-blank and branded-new-tab states).
      if (opts.url && page.url() === 'about:blank') {
        try { await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch { /* ignore */ }
        await this.refreshNav(existing);
        await this.pushFrame(existing);
      }
      if (opts.activate) { this.activeId = existing.id; this.broadcastTabs(); }
      return existing;
    }
    const tab: Tab = { id: this.nextTabId++, page, cdp: null, console: [], network: [], nav: { url: 'about:blank', title: 'New tab', canGoBack: false, canGoForward: false, loading: false }, lastFrame: null };
    this.tabs.set(tab.id, tab);
    this.order.push(tab.id);
    if (opts.activate !== false || !this.activeId) this.activeId = tab.id;
    this.wirePage(tab);
    await this.startScreencast(tab);
    if (opts.url) { try { await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch { /* ignore */ } }
    else if (page.url() === 'about:blank') { try { await page.setContent(NEW_TAB_HTML, { waitUntil: 'domcontentloaded' }); } catch { /* ignore */ } }
    await this.refreshNav(tab);
    await this.pushFrame(tab);
    this.broadcastTabs();
    return tab;
  }

  private async createTab(url?: string, existingPage?: Page): Promise<Tab> {
    if (!this.context) throw new Error('Browser not started.');
    const page = existingPage ?? await this.context.newPage();
    return this.trackPage(page, { url, activate: true });
  }

  private wirePage(tab: Tab) {
    const { page } = tab;
    page.on('console', (message) => {
      const entry: ConsoleEntry = { at: Date.now(), level: message.type(), text: message.text().slice(0, 2000) };
      tab.console.push(entry); if (tab.console.length > RING) tab.console.shift();
      this.broadcast({ type: 'console', id: tab.id, entry });
    });
    page.on('response', (response) => {
      const entry: NetworkEntry = { at: Date.now(), method: response.request().method(), url: response.url().slice(0, 500), status: response.status(), ok: response.ok() };
      tab.network.push(entry); if (tab.network.length > RING) tab.network.shift();
      this.broadcast({ type: 'network', id: tab.id, entry });
    });
    page.on('requestfailed', (request) => {
      const entry: NetworkEntry = { at: Date.now(), method: request.method(), url: request.url().slice(0, 500), status: null, ok: false, failure: request.failure()?.errorText };
      tab.network.push(entry); if (tab.network.length > RING) tab.network.shift();
      this.broadcast({ type: 'network', id: tab.id, entry });
    });
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) void this.refreshNav(tab).then(() => this.pushFrame(tab)); });
    page.on('load', () => void this.refreshNav(tab).then(() => this.pushFrame(tab)));
    page.on('close', () => { if (!this.closing && this.tabs.has(tab.id)) void this.closeTab(tab.id); });
  }

  private async startScreencast(tab: Tab) {
    const cdp = await tab.page.context().newCDPSession(tab.page);
    tab.cdp = cdp;
    cdp.on('Page.screencastFrame', async (frame: { data: string; sessionId: number }) => {
      try { tab.lastFrame = Buffer.from(frame.data, 'base64'); this.broadcastFrame(tab.id, tab.lastFrame); await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }); } catch { /* gone */ }
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 68, maxWidth: config.browser.width, maxHeight: config.browser.height, everyNthFrame: 1 });
  }

  private async refreshNav(tab: Tab) {
    const { page } = tab;
    let canGoBack = false, canGoForward = false;
    try {
      const history = await tab.cdp?.send('Page.getNavigationHistory') as { currentIndex: number; entries: unknown[] } | undefined;
      if (history) { canGoBack = history.currentIndex > 0; canGoForward = history.currentIndex < history.entries.length - 1; }
    } catch { /* ignore */ }
    let title = ''; try { title = await page.title(); } catch { /* ignore */ }
    tab.nav = { url: page.url(), title: title || tab.nav.title, canGoBack, canGoForward, loading: false };
    this.broadcast({ type: 'nav', id: tab.id, nav: tab.nav });
    this.broadcastTabs();
  }

  /** Force a fresh frame (used after nav/reload/activate/connect) so the canvas never stays blank. */
  private async pushFrame(tab: Tab) {
    try { const buffer = await tab.page.screenshot({ type: 'jpeg', quality: 68 }); tab.lastFrame = buffer; this.broadcastFrame(tab.id, buffer); } catch { /* page busy */ }
  }

  // ---- pub/sub ----
  subscribe(fn: (message: unknown) => void): () => void { this.subscribers.add(fn); return () => this.subscribers.delete(fn); }
  private broadcast(message: unknown) { for (const fn of this.subscribers) { try { fn(message); } catch { /* ignore */ } } }
  private broadcastFrame(id: number, jpeg: Buffer) {
    const header = Buffer.allocUnsafe(4); header.writeUInt32BE(id, 0);
    const framed = Buffer.concat([header, jpeg]);
    for (const fn of this.subscribers) { try { fn(framed); } catch { /* ignore */ } }
  }
  primeClient(send: (message: unknown) => void) {
    send({ type: 'status', status: this.status() });
    for (const id of this.order) { const tab = this.tabs.get(id); if (tab?.lastFrame) { const header = Buffer.allocUnsafe(4); header.writeUInt32BE(id, 0); send(Buffer.concat([header, tab.lastFrame])); } }
  }

  // ---- tabs ----
  private tabsSummary(): TabSummary[] { return this.order.map((id) => this.tabs.get(id)).filter((tab): tab is Tab => !!tab).map((tab) => ({ id: tab.id, title: tab.nav.title, url: tab.nav.url, loading: tab.nav.loading, canGoBack: tab.nav.canGoBack, canGoForward: tab.nav.canGoForward })); }
  private broadcastTabs() { this.broadcast({ type: 'tabs', tabs: this.tabsSummary(), activeId: this.activeId }); }
  private tabOr(id?: number): Tab | undefined { return this.tabs.get(id ?? this.activeId); }

  async newTab(url?: string) { await this.ensure(); await this.createTab(url); }
  async activateTab(id: number) {
    const tab = this.tabs.get(id); if (!tab) return;
    this.activeId = id;
    try { await tab.page.bringToFront(); } catch { /* ignore */ }
    this.broadcastTabs();
    await this.pushFrame(tab);
  }
  async closeTab(id: number) {
    const tab = this.tabs.get(id); if (!tab) return;
    this.tabs.delete(id); this.order = this.order.filter((value) => value !== id); this.viewing.delete(id);
    try { await tab.cdp?.detach(); } catch { /* ignore */ }
    try { if (!tab.page.isClosed()) await tab.page.close(); } catch { /* ignore */ }
    if (this.activeId === id) this.activeId = this.order[this.order.length - 1] ?? 0;
    if (this.tabs.size === 0) { if (!this.closing) await this.createTab(); return; } // never leave zero tabs while running
    if (this.activeId) await this.activateTab(this.activeId); else this.broadcastTabs();
  }
  setViewing(ids: number[]) { this.viewing = new Set(ids); }

  // ---- navigation ----
  private normalizeUrl(input: string): string {
    const value = input.trim();
    if (!value) return 'about:blank';
    if (/^(https?|about|file|data):/i.test(value)) return value;
    if (/^localhost([:/]|$)/i.test(value) || /^\d{1,3}(\.\d{1,3}){3}([:/]|$)/.test(value)) return `http://${value}`;
    if (/^[\w-]+(\.[\w-]+)+([:/].*)?$/.test(value)) return `https://${value}`;
    return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  }
  async navigate(url: string, id?: number) {
    await this.ensure(); const tab = this.tabOr(id); if (!tab) return { url: '', title: '', canGoBack: false, canGoForward: false, loading: false };
    tab.nav.loading = true; this.broadcast({ type: 'nav', id: tab.id, nav: tab.nav });
    try { await tab.page.goto(this.normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: 30000 }); } finally { await this.refreshNav(tab); await this.pushFrame(tab); }
    return tab.nav;
  }
  async goBack(id?: number) { const tab = this.tabOr(id); if (!tab) return; try { await tab.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }); } catch { /* nothing */ } await this.refreshNav(tab); await this.pushFrame(tab); }
  async goForward(id?: number) { const tab = this.tabOr(id); if (!tab) return; try { await tab.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }); } catch { /* nothing */ } await this.refreshNav(tab); await this.pushFrame(tab); }
  async reload(id?: number) { const tab = this.tabOr(id); if (!tab) return; try { await tab.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); } catch { /* nothing */ } await this.refreshNav(tab); await this.pushFrame(tab); }

  // ---- input (serialized so down/up can't reorder) ----
  private serialize(fn: () => Promise<void>): Promise<void> { this.inputChain = this.inputChain.then(fn, fn).catch(() => {}); return this.inputChain; }
  dispatchMouse(message: Extract<ClientMessage, { type: 'mouse' }>) {
    const button = message.button ?? 'left';
    if (message.action === 'down' && message.id && message.id !== this.activeId) void this.activateTab(message.id);
    return this.serialize(async () => {
      const tab = this.tabOr(message.id); if (!tab) return;
      if (message.action === 'move') await tab.page.mouse.move(message.x, message.y);
      else if (message.action === 'down') { await tab.page.mouse.move(message.x, message.y); await tab.page.mouse.down({ button, clickCount: message.clickCount ?? 1 }); }
      else await tab.page.mouse.up({ button, clickCount: message.clickCount ?? 1 });
    });
  }
  dispatchWheel(message: Extract<ClientMessage, { type: 'wheel' }>) {
    return this.serialize(async () => { const tab = this.tabOr(message.id); if (!tab) return; await tab.page.mouse.move(message.x, message.y); await tab.page.mouse.wheel(message.dx, message.dy); });
  }
  dispatchKey(message: Extract<ClientMessage, { type: 'key' }>) {
    if (message.action !== 'down') return Promise.resolve();
    const mods: string[] = [];
    if (message.ctrl) mods.push('Control'); if (message.shift) mods.push('Shift'); if (message.alt) mods.push('Alt'); if (message.meta) mods.push('Meta');
    const named = NAMED_KEYS[message.key];
    return this.serialize(async () => {
      const tab = this.tabOr(message.id); if (!tab) return;
      if (named) { await tab.page.keyboard.press([...mods, named].join('+')); return; }
      if (message.key.length === 1) {
        if (message.ctrl || message.alt || message.meta) await tab.page.keyboard.press([...mods, message.key.toUpperCase()].join('+'));
        else await tab.page.keyboard.insertText(message.key);
      }
    });
  }

  // ---- programmatic control (active tab) — shared with MCP tools ----
  async screenshot(fullPage = false, id?: number): Promise<Buffer> { await this.ensure(); const tab = this.tabOr(id); if (!tab) throw new Error('No tab.'); return tab.page.screenshot({ type: 'png', fullPage }); }

  /** Load a URL in a throwaway page and report where it ended up (redirect-aware), optionally
   *  with a screenshot. Used by the factory's Shopify sign-in check and the project preview.
   *  The page is closed before returning, so nothing lingers in the tab strip. Because the
   *  context adopts every new page as a tab, the throwaway briefly appears and is then removed. */
  async probe(url: string, opts: { timeoutMs?: number; screenshot?: boolean; settleMs?: number } = {}): Promise<{ finalUrl: string; title: string; screenshot: Buffer | null; loginForm: boolean }> {
    // If nobody is using the browser, launch a quiet extension-free headless instance for this
    // probe only and close it afterwards — never leave a stray window on the user's screen.
    const launchedHere = !this.isRunning() && !this.launching;
    if (launchedHere) this.minimalLaunch = true;
    try {
      await this.ensure();
    } catch (error) { this.minimalLaunch = false; throw error; }
    if (!this.context) { this.minimalLaunch = false; throw new Error('Browser not started.'); }
    const page = await this.context.newPage();
    try {
      try { await page.goto(url, { waitUntil: 'load', timeout: opts.timeoutMs ?? 30000 }); } catch { /* keep whatever loaded */ }
      try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch { /* fine — SPA still polling */ }
      if (opts.settleMs) await page.waitForTimeout(opts.settleMs);
      const screenshot = opts.screenshot ? await page.screenshot({ type: 'png', fullPage: false }).catch(() => null) : null;
      // A password field (or an email-only lookup form) on the landed page means "not signed in"
      // even when the URL never left admin.shopify.com.
      const loginForm = await page.evaluate(() => Boolean(document.querySelector('input[type="password"], form[action*="lookup"], form[action*="login"]'))).catch(() => false);
      return { finalUrl: page.url(), title: await page.title().catch(() => ''), screenshot, loginForm };
    } finally {
      const tab = this.tabForPage(page);
      if (tab) await this.closeTab(tab.id).catch(() => { /* ignore */ });
      else await page.close().catch(() => { /* ignore */ });
      if (launchedHere) { await this.stop().catch(() => { /* ignore */ }); this.minimalLaunch = false; }
    }
  }
  async click(target: { selector?: string; x?: number; y?: number }, id?: number) {
    await this.ensure(); const tab = this.tabOr(id); if (!tab) throw new Error('No tab.');
    if (target.selector) await tab.page.click(target.selector, { timeout: 8000 });
    else if (typeof target.x === 'number' && typeof target.y === 'number') await tab.page.mouse.click(target.x, target.y);
    else throw new Error('click requires a selector or x/y.');
    await this.refreshNav(tab); await this.pushFrame(tab);
  }
  async typeText(target: { selector?: string; text: string; submit?: boolean }, id?: number) {
    await this.ensure(); const tab = this.tabOr(id); if (!tab) throw new Error('No tab.');
    if (target.selector) await tab.page.fill(target.selector, target.text, { timeout: 8000 });
    else await tab.page.keyboard.insertText(target.text);
    if (target.submit) { await tab.page.keyboard.press('Enter'); await this.refreshNav(tab); }
    await this.pushFrame(tab);
  }
  async readPage(id?: number) {
    await this.ensure(); const tab = this.tabOr(id); if (!tab) throw new Error('No tab.');
    return tab.page.evaluate(() => {
      const text = (document.body?.innerText || '').slice(0, 12000);
      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map((a) => ({ text: (a.textContent || '').trim().slice(0, 120), href: (a as HTMLAnchorElement).href }));
      return { url: location.href, title: document.title, text, links };
    });
  }
  async evaluate(expression: string, id?: number): Promise<unknown> { await this.ensure(); const tab = this.tabOr(id); if (!tab) throw new Error('No tab.'); return tab.page.evaluate(`(async()=>{return (${expression});})()`); }
  recentConsole(limit = 100, id?: number) { return (this.tabOr(id)?.console ?? []).slice(-limit); }
  recentNetwork(limit = 100, id?: number) { return (this.tabOr(id)?.network ?? []).slice(-limit); }

  async runQa(input: { url: string; compareUrl?: string }, id?: number) {
    await this.ensure(); const tab = this.tabOr(id); if (!tab) throw new Error('No tab.');
    const urls = [input.url, input.compareUrl].filter((value): value is string => !!value);
    const pages: unknown[] = []; const issues: string[] = [];
    for (const url of urls) {
      const before = tab.console.length; const netBefore = tab.network.length; const started = Date.now();
      await this.navigate(url, tab.id);
      try { await tab.page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* ignore */ }
      const loadMs = Date.now() - started;
      const consoleErrors = tab.console.slice(before).filter((entry) => entry.level === 'error');
      const failed = tab.network.slice(netBefore).filter((entry) => !entry.ok);
      const shot = await tab.page.screenshot({ type: 'png' });
      const nodeCount = await tab.page.evaluate('document.querySelectorAll("*").length').catch(() => 0);
      if (consoleErrors.length) issues.push(`${url}: ${consoleErrors.length} console error(s)`);
      if (failed.length) issues.push(`${url}: ${failed.length} failed/blocked request(s)`);
      pages.push({ url: tab.nav.url, title: tab.nav.title, loadMs, nodeCount, consoleErrors: consoleErrors.slice(0, 20), failedRequests: failed.slice(0, 20), screenshot: `data:image/png;base64,${shot.toString('base64')}` });
    }
    return { ok: issues.length === 0, checkedAt: Date.now(), pages, issues };
  }

  async setHeadless(value: boolean) {
    if (!this.isRunning()) { this.headless = value; return; }
    if (value === this.headless) return;
    const urls = this.order.map((id) => this.tabs.get(id)?.nav.url).filter((url): url is string => !!url && url !== 'about:blank');
    const activeIndex = Math.max(0, this.order.indexOf(this.activeId));
    this.headless = value;
    await this.close();
    await this.ensure(); // first tab
    for (let index = 1; index < urls.length; index += 1) await this.createTab(urls[index]);
    if (urls.length) { const first = this.order[0]; const firstTab = this.tabs.get(first); if (firstTab && urls[0]) await this.navigate(urls[0], first); }
    const target = this.order[activeIndex] ?? this.order[0];
    if (target) await this.activateTab(target);
  }
  async bringToFront() { try { await this.tabOr()?.page.bringToFront(); } catch { /* ignore */ } }

  /** Open the Claude extension's side-panel page in a new tab (its ID is fixed by the manifest key). */
  async openClaude() {
    await this.ensure();
    const claude = this.loadedExtensions.find((extension) => extension.isClaude);
    if (!claude) throw new Error('Claude extension is not loaded. Install it in Chrome, then restart the browser.');
    await this.createTab(`chrome-extension://${CLAUDE_EXTENSION_ID}/sidepanel.html`);
  }

  /** Open Chrome's extensions manager in a new tab (chrome:// may be blocked → stays on the new-tab page). */
  async openExtensionsPage() {
    await this.ensure();
    const tab = await this.createTab();
    try { await tab.page.goto('chrome://extensions', { timeout: 8000 }); await this.refreshNav(tab); await this.pushFrame(tab); } catch { /* chrome:// navigation restricted */ }
  }

  /** Explicit user start — launches the engine and pushes fresh state to every client. */
  async start() {
    await this.ensure();
    this.broadcast({ type: 'status', status: this.status() });
  }

  /** Explicit user stop — kills the engine (frees CPU/RAM) and tells every client. */
  async stop() {
    await this.close();
    this.broadcast({ type: 'status', status: this.status() });
  }

  async close() {
    this.closing = true;
    try {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      for (const tab of this.tabs.values()) { try { await tab.cdp?.detach(); } catch { /* ignore */ } }
      try { await this.context?.close(); } catch { /* ignore */ }
      try { await this.browser?.close(); } catch { /* ignore */ }
      this.tabs.clear(); this.order = []; this.context = null; this.browser = null; this.activeId = 0;
    } finally { this.closing = false; }
  }

  status() {
    const extensions = this.isRunning() ? this.loadedExtensions : resolveExtensions();
    return { running: this.isRunning(), engine: this.engine, engines: detectEngines(), headless: this.headless, viewport: { width: config.browser.width, height: config.browser.height }, tabs: this.tabsSummary(), activeId: this.activeId, extensions: extensions.map((extension) => ({ id: extension.id, name: extension.name, isClaude: extension.isClaude })), nav: this.tabOr()?.nav ?? { url: 'about:blank', title: '', canGoBack: false, canGoForward: false, loading: false } };
  }

  // ---- background poll: keep displayed non-foreground tabs fresh in split view ----
  private startPoll() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => { void this.pollBackground(); }, 850);
  }
  private async pollBackground() {
    for (const id of this.viewing) {
      if (id === this.activeId) continue; const tab = this.tabs.get(id); if (!tab || tab.page.isClosed()) continue;
      try { const buffer = await tab.page.screenshot({ type: 'jpeg', quality: 55 }); tab.lastFrame = buffer; this.broadcastFrame(id, buffer); } catch { /* ignore */ }
    }
  }
}

const NAMED_KEYS: Record<string, string> = {
  Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};

export const browserManager = new BrowserManager();

export function installBrowser(): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolve) => {
    const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { env: process.env });
    let log = '';
    child.stdout.on('data', (chunk) => { log += chunk.toString(); });
    child.stderr.on('data', (chunk) => { log += chunk.toString(); });
    child.on('error', (error) => resolve({ ok: false, log: `${log}\n${error.message}` }));
    child.on('close', (code) => resolve({ ok: code === 0, log: log.slice(-8000) }));
  });
}

export function attachBrowser() {
  if (!config.browser.enabled) return;
  const wss = new WebSocketServer({
    noServer: true,
    verifyClient: ({ req }: { req: IncomingMessage }, done: (ok: boolean, code?: number, message?: string) => void) => {
      done(isLocalRequest(req.headers.host, req.headers.origin), 403, 'Browser is available on localhost only.');
    },
  });
  addWsRoute('/browser', wss);

  wss.on('connection', (socket: WebSocket) => {
    const send = (message: unknown) => { if (socket.readyState !== socket.OPEN) return; if (Buffer.isBuffer(message)) socket.send(message); else socket.send(JSON.stringify(message)); };
    const unsubscribe = browserManager.subscribe(send);

    // No auto-launch: connecting to the surface must not spawn a browser process.
    // The client shows a launcher; the engine starts only on an explicit 'start' message.
    if (browserManager.isRunning()) browserManager.primeClient(send);
    else send({ type: 'status', status: browserManager.status() });

    socket.on('message', async (raw) => {
      let message: ClientMessage;
      try { message = JSON.parse(raw.toString()) as ClientMessage; } catch { return; }
      try {
        switch (message.type) {
          case 'mouse': await browserManager.dispatchMouse(message); break;
          case 'wheel': await browserManager.dispatchWheel(message); break;
          case 'key': await browserManager.dispatchKey(message); break;
          case 'navigate': await browserManager.navigate(message.url, message.id); break;
          case 'back': await browserManager.goBack(message.id); break;
          case 'forward': await browserManager.goForward(message.id); break;
          case 'reload': await browserManager.reload(message.id); break;
          case 'tab-new': await browserManager.newTab(message.url); break;
          case 'tab-close': await browserManager.closeTab(message.id); break;
          case 'tab-activate': await browserManager.activateTab(message.id); break;
          case 'viewing': browserManager.setViewing(message.ids); break;
          case 'headless': await browserManager.setHeadless(message.value); send({ type: 'status', status: browserManager.status() }); break;
          case 'start': await browserManager.start(); browserManager.primeClient(send); break;
          case 'stop': await browserManager.stop(); break;
          case 'open-claude': await browserManager.openClaude(); break;
          case 'open-extensions': await browserManager.openExtensionsPage(); break;
          case 'front': await browserManager.bringToFront(); break;
          case 'install': { send({ type: 'install-start' }); const outcome = await installBrowser(); send({ type: 'install-done', ...outcome, status: browserManager.status() }); break; }
          case 'qa': { send({ type: 'qa-start' }); try { const report = await browserManager.runQa({ url: message.url, compareUrl: message.compareUrl }, message.id); send({ type: 'qa-done', report }); } catch (error) { send({ type: 'qa-error', message: error instanceof Error ? error.message : 'QA failed.' }); } break; }
        }
      } catch (error) { send({ type: 'error', message: error instanceof Error ? error.message : 'Command failed.' }); }
    });

    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });

  wss.on('error', () => { /* keep the http server alive if the ws layer errors */ });
  console.log(`Integrated browser enabled at ws://localhost:${config.port}/browser (engine: ${config.browser.engine}, localhost-only)`);
}
