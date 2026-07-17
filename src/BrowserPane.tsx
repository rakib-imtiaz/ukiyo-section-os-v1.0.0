// Integrated browser surface — a live multi-tab Playwright browser streamed over WebSocket
// (/browser, proxied by Vite). Frames are binary: a 4-byte big-endian tabId prefix + JPEG, so
// each tab draws to its own canvas (enabling split view). The same managed browser is driven by
// the local MCP browser tools, so Claude's actions render live here. Localhost-only.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Bug, Columns2, Download, Globe, Loader, Maximize, Network,
  PanelRightClose, PanelRightOpen, Plus, Power, Puzzle, RotateCw, ShieldCheck, Sparkles, SquareArrowOutUpRight, X, ZoomIn, ZoomOut,
} from 'lucide-react';

type EngineId = 'chromium' | 'chrome' | 'msedge';
interface EngineInfo { id: EngineId; label: string; isolated: boolean; available: boolean; executablePath?: string }
interface NavState { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }
interface TabSummary { id: number; title: string; url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }
interface ExtInfo { id: string; name: string; isClaude: boolean }
interface Status { running: boolean; engine: EngineInfo | null; engines: EngineInfo[]; headless: boolean; viewport: { width: number; height: number }; tabs: TabSummary[]; activeId: number; extensions: ExtInfo[]; nav: NavState }
interface ConsoleEntry { at: number; level: string; text: string }
interface NetworkEntry { at: number; method: string; url: string; status: number | null; ok: boolean; failure?: string }
interface QaPage { url: string; title: string; loadMs: number; nodeCount: number; consoleErrors: ConsoleEntry[]; failedRequests: NetworkEntry[]; screenshot: string }
interface QaReport { ok: boolean; checkedAt: number; pages: QaPage[]; issues: string[] }

/** Cross-surface handoff: a factory job can request a React-vs-Shopify side-by-side
 * comparison. The request is stashed module-level so it survives until BrowserPane
 * mounts, and also dispatched as a window event so an already mounted pane reacts
 * immediately. Event name: 'themebot:browser-compare'. */
export interface BrowserCompareRequest { reactUrl: string; shopifyUrl: string }
const BROWSER_COMPARE_EVENT = 'themebot:browser-compare';
let pendingCompareRequest: BrowserCompareRequest | null = null;
export function openBrowserCompare(request: BrowserCompareRequest) {
  pendingCompareRequest = request;
  window.dispatchEvent(new CustomEvent<BrowserCompareRequest>(BROWSER_COMPARE_EVENT, { detail: request }));
}

/** Loose URL match for pairing a compare target with the tab that loaded it (the page may
 * append a query string or trailing slash after navigation). */
function urlMatches(tabUrl: string, target: string): boolean {
  if (!tabUrl || tabUrl === 'about:blank' || !target) return false;
  const clean = (value: string) => value.replace(/\/+$/, '');
  const tab = clean(tabUrl);
  const wanted = clean(target);
  return tab === wanted || tab.startsWith(`${wanted}/`) || tab.startsWith(`${wanted}?`);
}

const CAP = 250;
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];
type PanelTab = 'console' | 'network' | 'qa';
function mouseButton(button: number): 'left' | 'right' | 'middle' { return button === 2 ? 'right' : button === 1 ? 'middle' : 'left'; }

const EMPTY_COPY: Record<PanelTab, { title: string; sub: string }> = {
  console: { title: 'Console is empty', sub: 'Navigate or reload a page to see logs, warnings, and errors here.' },
  network: { title: 'No network activity', sub: 'Requests the page makes appear here as it loads.' },
  qa: { title: 'No QA run yet', sub: 'Run QA on a URL to capture load time, console errors, failed requests, and a screenshot.' },
};

function PanelEmpty({ kind, onReload, onQa }: { kind: PanelTab; onReload: () => void; onQa: () => void }) {
  const copy = EMPTY_COPY[kind];
  return (
    <div className="browser-empty">
      <svg className="browser-empty__art" viewBox="0 0 120 100" fill="none" aria-hidden>
        <rect x="14" y="20" width="76" height="54" rx="9" fill="#16161d" stroke="#2c2c38" strokeWidth="2" />
        <circle cx="24" cy="30" r="2.4" fill="#3f3f4a" /><circle cx="32" cy="30" r="2.4" fill="#3f3f4a" /><circle cx="40" cy="30" r="2.4" fill="#3f3f4a" />
        <path d="M24 44l7 6-7 6" stroke="#8ab4ff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M40 56h20" stroke="#4b4b57" strokeWidth="2.6" strokeLinecap="round" />
        <circle cx="82" cy="66" r="15" fill="#0f1830" stroke="#4f7cff" strokeWidth="3" />
        <path d="M93 77l9 9" stroke="#4f7cff" strokeWidth="4" strokeLinecap="round" />
        <path d="M100 24l1.6 4.2 4.2 1.6-4.2 1.6L100 36l-1.6-4.6-4.2-1.6 4.2-1.6z" fill="#4f7cff" />
        <path d="M22 12l1.1 3 3 1.1-3 1.1L22 21l-1.1-2.8-3-1.1 3-1.1z" fill="#8ab4ff" opacity=".8" />
        <circle cx="106" cy="54" r="2.2" fill="#4f7cff" opacity=".7" />
      </svg>
      <b>{copy.title}</b>
      <span>{copy.sub}</span>
      <div className="browser-empty__hints">
        <button type="button" onClick={onReload}><kbd>R</kbd> Reload page</button>
        <button type="button" onClick={onQa}><kbd>Q</kbd> Run QA</button>
      </div>
    </div>
  );
}

export default function BrowserPane({ onActivity }: { onActivity?: () => void }) {
  const socketRef = useRef<WebSocket | null>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const drawing = useRef<Set<number>>(new Set());
  const lastMove = useRef(0);
  const activityTimer = useRef<number | undefined>(undefined);

  const [generation, setGeneration] = useState(0);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [launching, setLaunching] = useState(false);
  const [booting, setBooting] = useState(false); // brief stage entry animation after start
  const wasRunning = useRef(false);
  const knownTabIds = useRef<Set<number>>(new Set());
  const [tabs, setTabs] = useState<TabSummary[]>([]);
  const [focusedId, setFocusedId] = useState(0);      // primary pane / address-bar target
  const [secondaryId, setSecondaryId] = useState(0);  // secondary pane in split
  const [split, setSplit] = useState(false);
  const [fit, setFit] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [panelOpen, setPanelOpen] = useState(true);
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [addressDirty, setAddressDirty] = useState(false);
  const [consoleByTab, setConsoleByTab] = useState<Map<number, ConsoleEntry[]>>(new Map());
  const [networkByTab, setNetworkByTab] = useState<Map<number, NetworkEntry[]>>(new Map());
  const [panel, setPanel] = useState<PanelTab>('console');
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const [qaOpen, setQaOpen] = useState(false);
  const [qaUrl, setQaUrl] = useState('');
  const [qaCompare, setQaCompare] = useState('');
  const [qaRunning, setQaRunning] = useState(false);
  const [qaReport, setQaReport] = useState<QaReport | null>(null);
  const [extMenuOpen, setExtMenuOpen] = useState(false);
  // Pending React-vs-Shopify comparison (see openBrowserCompare). started → engine start sent;
  // opened → both tab-new sent; baseline → tab ids that existed before the compare tabs opened.
  const compareRef = useRef<(BrowserCompareRequest & { started: boolean; opened: boolean; baseline: Set<number> }) | null>(null);
  const [compareTick, setCompareTick] = useState(0);

  const flagActivity = useCallback(() => { if (!onActivity) return; window.clearTimeout(activityTimer.current); activityTimer.current = window.setTimeout(onActivity, 1200); }, [onActivity]);
  const send = useCallback((message: unknown) => { const socket = socketRef.current; if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }, []);

  const drawFrame = useCallback(async (tabId: number, blob: Blob) => {
    if (drawing.current.has(tabId)) return;
    drawing.current.add(tabId);
    try {
      const bitmap = await createImageBitmap(blob);
      const canvas = canvasRefs.current.get(tabId);
      if (canvas) {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      }
      bitmap.close();
    } catch { /* ignore */ }
    finally { drawing.current.delete(tabId); }
  }, []);

  // ---- websocket lifecycle ----
  useEffect(() => {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/browser`);
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    let retry: number | undefined;
    socket.onopen = () => { setConnected(true); setError(''); };
    // auto-reconnect: the API server restarts on every code save (node --watch), which kills
    // this socket — without a retry the surface stays dead until the view is remounted
    socket.onclose = () => { setConnected(false); retry = window.setTimeout(() => setGeneration((v) => v + 1), 1500); };
    socket.onerror = () => setConnected(false);
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        const tabId = view.getUint32(0);
        void drawFrame(tabId, new Blob([event.data.slice(4)], { type: 'image/jpeg' }));
        return;
      }
      let message: Record<string, unknown>;
      try { message = JSON.parse(event.data as string); } catch { return; }
      switch (message.type) {
        case 'status': {
          const next = message.status as Status; setStatus(next); setTabs(next.tabs);
          knownTabIds.current = new Set(next.tabs.map((t) => t.id));
          if (next.running) {
            setLaunching(false);
            setFocusedId((current) => current || next.activeId);
          } else {
            // engine stopped: clear all per-tab state so the launcher shows clean
            setFocusedId(0); setSecondaryId(0); setSplit(false);
            setConsoleByTab(new Map()); setNetworkByTab(new Map());
            canvasRefs.current.clear();
            // an in-flight compare that already opened its tabs can't survive a stop
            if (compareRef.current?.opened) compareRef.current = null;
          }
          break;
        }
        case 'tabs': {
          const list = message.tabs as TabSummary[]; setTabs(list); const active = message.activeId as number;
          // a freshly created tab takes focus (like a real browser's "+"); otherwise keep the user's focus
          const appeared = !!active && !knownTabIds.current.has(active);
          knownTabIds.current = new Set(list.map((t) => t.id));
          if (appeared) setFocusedId(active);
          else setFocusedId((current) => (current && list.some((t) => t.id === current) ? current : active));
          break;
        }
        case 'nav': {
          const id = message.id as number; const nav = message.nav as NavState;
          setTabs((list) => list.map((t) => (t.id === id ? { ...t, title: nav.title, url: nav.url, canGoBack: nav.canGoBack, canGoForward: nav.canGoForward, loading: nav.loading } : t)));
          flagActivity();
          break;
        }
        case 'console': { const id = message.id as number; const entry = message.entry as ConsoleEntry; setConsoleByTab((map) => { const next = new Map(map); next.set(id, [...(next.get(id) ?? []), entry].slice(-CAP)); return next; }); break; }
        case 'network': { const id = message.id as number; const entry = message.entry as NetworkEntry; setNetworkByTab((map) => { const next = new Map(map); next.set(id, [...(next.get(id) ?? []), entry].slice(-CAP)); return next; }); break; }
        case 'error': setError(String(message.message ?? 'Browser error.')); setLaunching(false); if (message.status) setStatus(message.status as Status); break;
        case 'install-start': setInstalling(true); setInstallLog('Installing isolated browser…'); break;
        case 'install-done': setInstalling(false); setInstallLog(String(message.log ?? '')); if (message.ok) { setError(''); setGeneration((v) => v + 1); } break;
        case 'qa-start': setQaRunning(true); setQaReport(null); break;
        case 'qa-done': setQaRunning(false); setQaReport(message.report as QaReport); setPanel('qa'); setPanelOpen(true); flagActivity(); break;
        case 'qa-error': setQaRunning(false); setError(String(message.message ?? 'QA failed.')); break;
      }
    };
    return () => { window.clearTimeout(activityTimer.current); window.clearTimeout(retry); socket.onclose = null; try { socket.close(); } catch { /* ignore */ } socketRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  // keep the address bar in sync with the focused tab (unless the user is editing it)
  const focusedTab = tabs.find((t) => t.id === focusedId);
  useEffect(() => { if (!addressDirty) setAddress(focusedTab && focusedTab.url !== 'about:blank' ? focusedTab.url : ''); }, [focusedTab?.url, addressDirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = status?.running ?? false;

  // ---- React vs Shopify comparison handoff ----
  // Adopt a compare request: one stashed before this pane mounted, or a live event.
  useEffect(() => {
    const adopt = (request: BrowserCompareRequest) => {
      compareRef.current = { ...request, started: false, opened: false, baseline: new Set() };
      setCompareTick((tick) => tick + 1);
    };
    if (pendingCompareRequest) { const request = pendingCompareRequest; pendingCompareRequest = null; adopt(request); }
    const onCompare = (event: Event) => {
      const detail = (event as CustomEvent<BrowserCompareRequest>).detail;
      pendingCompareRequest = null; // this pane handles it now — don't replay on a future remount
      if (detail?.reactUrl && detail?.shopifyUrl) adopt(detail);
    };
    window.addEventListener(BROWSER_COMPARE_EVENT, onCompare);
    return () => window.removeEventListener(BROWSER_COMPARE_EVENT, onCompare);
  }, []);

  // Drive the compare: auto-start the engine if it's off, then (once running) open both URLs.
  useEffect(() => {
    const request = compareRef.current;
    if (!request || !connected || !status) return;
    if (!status.running) {
      if (!request.started) { request.started = true; setError(''); setLaunching(true); send({ type: 'start' }); }
      return; // wait for a running status before opening tabs
    }
    if (!request.opened) {
      request.opened = true;
      request.baseline = new Set(tabs.map((t) => t.id));
      send({ type: 'tab-new', url: request.reactUrl });
      send({ type: 'tab-new', url: request.shopifyUrl });
    }
    // compareTick re-runs this after a request is adopted mid-session
  }, [connected, status, tabs, compareTick, send]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once both compare tabs exist, put them side by side (React left/primary, Shopify right).
  useEffect(() => {
    const request = compareRef.current;
    if (!request?.opened) return;
    const appeared = tabs.filter((t) => !request.baseline.has(t.id));
    if (appeared.length < 2) return;
    const primary = appeared.find((t) => urlMatches(t.url, request.reactUrl)) ?? appeared[0];
    const secondary = appeared.find((t) => t.id !== primary.id && urlMatches(t.url, request.shopifyUrl))
      ?? appeared.find((t) => t.id !== primary.id);
    if (!secondary) return;
    compareRef.current = null;
    setFocusedId(primary.id);
    setSecondaryId(secondary.id);
    setSplit(true);
    send({ type: 'tab-activate', id: primary.id });
  }, [tabs, send]);

  // play a short boot-in animation on the stage whenever the engine flips off → on
  useEffect(() => {
    const was = wasRunning.current; wasRunning.current = running;
    if (running && !was) { setBooting(true); const timer = window.setTimeout(() => setBooting(false), 1300); return () => window.clearTimeout(timer); }
  }, [running]);

  // keep split view pointing at two DISTINCT valid tabs (create a second if needed)
  useEffect(() => {
    if (!split || !running) return;
    if (tabs.length < 2) { send({ type: 'tab-new' }); return; }
    const others = tabs.filter((t) => t.id !== focusedId);
    if (!others.some((t) => t.id === secondaryId)) setSecondaryId(others[0].id);
  }, [split, running, tabs, focusedId, secondaryId, send]);

  // tell the server which tabs are on screen (so it polls background tabs for split view)
  const displayed = split ? [focusedId, secondaryId].filter(Boolean) : [focusedId].filter(Boolean);
  useEffect(() => { if (connected) send({ type: 'viewing', ids: displayed }); }, [connected, displayed.join(','), send]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- input mapping ----
  const toViewport = useCallback((event: React.MouseEvent | React.WheelEvent, canvas: HTMLCanvasElement): { x: number; y: number } | null => {
    const vp = status?.viewport; if (!vp) return null;
    const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return null;
    const x = Math.max(0, Math.min(vp.width, ((event.clientX - rect.left) / rect.width) * vp.width));
    const y = Math.max(0, Math.min(vp.height, ((event.clientY - rect.top) / rect.height) * vp.height));
    return { x: Math.round(x), y: Math.round(y) };
  }, [status]);

  const enterSplit = () => {
    if (split) { setSplit(false); return; }
    const other = tabs.find((t) => t.id !== focusedId);
    if (other) { setSecondaryId(other.id); setSplit(true); } else { send({ type: 'tab-new' }); setSplit(true); }
  };

  const zoomStep = (direction: 1 | -1) => {
    setFit(false);
    setZoom((current) => { const index = ZOOMS.findIndex((z) => z >= current - 0.001); const next = Math.max(0, Math.min(ZOOMS.length - 1, (index < 0 ? ZOOMS.indexOf(1) : index) + direction)); return ZOOMS[next]; });
  };

  const submitAddress = (event: React.FormEvent) => { event.preventDefault(); setAddressDirty(false); send({ type: 'navigate', id: focusedId, url: address }); };
  const runQa = (event: React.FormEvent) => { event.preventDefault(); if (!qaUrl.trim()) return; send({ type: 'qa', id: focusedId, url: qaUrl.trim(), compareUrl: qaCompare.trim() || undefined }); };

  const engine = status?.engine;
  const noEngine = !!status && !engine && status.engines.every((item) => !item.available);
  const extensions = status?.extensions ?? [];
  const hasClaudeExt = extensions.some((item) => item.isClaude);
  const focusedNav = focusedTab ?? status?.nav;
  const paneIds = split ? [focusedId, secondaryId].filter(Boolean) : [focusedId].filter(Boolean);

  const registerCanvas = (id: number) => (element: HTMLCanvasElement | null) => { if (element) canvasRefs.current.set(id, element); };

  const panelConsole = consoleByTab.get(focusedId) ?? [];
  const panelNetwork = networkByTab.get(focusedId) ?? [];

  // ---- launcher: engine is OFF (zero CPU) until the user explicitly starts it ----
  if (!running) {
    const bestEngine = engine ?? status?.engines.find((item) => item.available) ?? null;
    return (
      <div className="browser-surface">
        <div className="browser-bar">
          <span className="browser-bar__brand"><Globe size={15} /> Browser</span>
          <span style={{ flex: 1 }} />
          <div className="browser-bar__actions">
            {bestEngine && <span className={`browser-engine${bestEngine.isolated ? ' is-isolated' : ''}`} title={bestEngine.executablePath || bestEngine.label}>{bestEngine.isolated ? <ShieldCheck size={13} /> : <Globe size={13} />}{bestEngine.label}</span>}
            <span className={`browser-conn${connected ? ' is-on' : ''}`} title={connected ? 'Connected' : 'Disconnected'} />
          </div>
        </div>
        <div className="browser-body">
          <div className="browser-launch">
            <div className={`browser-launch__orb${launching ? ' is-launching' : ''}`}>
              <span className="browser-launch__ring browser-launch__ring--a" />
              <span className="browser-launch__ring browser-launch__ring--b" />
              <span className="browser-launch__ring browser-launch__ring--c" />
              <Globe size={34} />
            </div>
            {noEngine ? (
              <>
                <h3>No browser engine found</h3>
                <p>Download the isolated Chromium (no system Chrome required) to use the integrated browser.</p>
              </>
            ) : (
              <>
                <h3>{launching ? 'Launching browser…' : 'Browser is off'}</h3>
                <p>{launching ? 'Spinning up the managed engine and opening Google…' : 'Nothing is running right now, so zero CPU and memory are used. Start it when you need it — it opens on google.com.'}</p>
                <button type="button" className="browser-launch__btn" disabled={launching || !connected} onClick={() => { setError(''); setLaunching(true); send({ type: 'start' }); }}>
                  {launching || !connected ? <Loader size={16} className="spin" /> : <Power size={16} />} {launching ? 'Starting…' : connected ? 'Start browser' : 'Connecting…'}
                </button>
                {!!extensions.length && (
                  <div className="browser-launch__exts">
                    {hasClaudeExt ? <Sparkles size={13} /> : <Puzzle size={13} />}
                    <span>{extensions.map((item) => item.name).join(' · ')} {extensions.length === 1 ? 'extension' : 'extensions'} will load</span>
                  </div>
                )}
              </>
            )}
            {(noEngine || /engine|install/i.test(error)) && (noEngine || !!error) && (
              <button className="button button--accent" disabled={installing} onClick={() => send({ type: 'install' })}>{installing ? <Loader size={15} className="spin" /> : <Download size={15} />} Install isolated browser</button>
            )}
            {!!error && !noEngine && <p className="browser-launch__error">{error}</p>}
            {!!installLog && <pre className="browser-install-log">{installLog.slice(-1500)}</pre>}
          </div>
        </div>
        <div className="browser-foot">Managed browser · stopped · localhost-only · Claude can start and drive it via local MCP tools.</div>
      </div>
    );
  }

  return (
    <div className="browser-surface">
      {/* ---- toolbar ---- */}
      <div className="browser-bar">
        <span className="browser-bar__brand"><Globe size={15} /> Browser</span>
        <div className="browser-nav-btns">
          <button type="button" title="Back" disabled={!focusedNav?.canGoBack} onClick={() => send({ type: 'back', id: focusedId })}><ArrowLeft size={15} /></button>
          <button type="button" title="Forward" disabled={!focusedNav?.canGoForward} onClick={() => send({ type: 'forward', id: focusedId })}><ArrowRight size={15} /></button>
          <button type="button" title="Reload" onClick={() => send({ type: 'reload', id: focusedId })}><RotateCw size={14} /></button>
        </div>
        <form className="browser-address" onSubmit={submitAddress}>
          <input value={address} spellCheck={false} placeholder="Enter a URL or search…" onChange={(e) => { setAddress(e.target.value); setAddressDirty(true); }} onFocus={(e) => e.target.select()} />
          {focusedNav?.loading && <Loader size={14} className="spin" />}
        </form>
        <div className="browser-bar__actions">
          <div className="browser-zoom">
            <button type="button" title="Zoom out" onClick={() => zoomStep(-1)}><ZoomOut size={14} /></button>
            <button type="button" title="Fit to window" className={fit ? 'is-active' : ''} onClick={() => setFit(true)}>{fit ? 'Fit' : `${Math.round(zoom * 100)}%`}</button>
            <button type="button" title="Zoom in" onClick={() => zoomStep(1)}><ZoomIn size={14} /></button>
          </div>
          <button type="button" className={split ? 'is-active' : ''} title="Split view (compare two tabs)" onClick={enterSplit}><Columns2 size={14} /></button>
          {engine && <span className={`browser-engine${engine.isolated ? ' is-isolated' : ''}`} title={engine.executablePath || engine.label}>{engine.isolated ? <ShieldCheck size={13} /> : <Globe size={13} />}{engine.label}</span>}
          {hasClaudeExt && <button type="button" className="browser-claude-btn" title="Open the Claude extension side panel" onClick={() => send({ type: 'open-claude' })}><Sparkles size={13} /> Claude</button>}
          <div className="browser-ext-wrap">
            <button type="button" className={extMenuOpen ? 'is-active' : ''} title="Extensions" onClick={() => setExtMenuOpen((v) => !v)}><Puzzle size={14} />{extensions.length > 0 && <em className="browser-ext-count">{extensions.length}</em>}</button>
            {extMenuOpen && (
              <>
                <div className="browser-ext-backdrop" onClick={() => setExtMenuOpen(false)} />
                <div className="browser-ext-menu">
                  <div className="browser-ext-menu__head"><Puzzle size={13} /> Extensions</div>
                  <div className="browser-ext-menu__list">
                    {extensions.length ? extensions.map((ext) => (
                      <div key={ext.id} className="browser-ext-item">
                        <span className="browser-ext-item__mark">{ext.isClaude ? <Sparkles size={14} /> : <Puzzle size={14} />}</span>
                        <span className="browser-ext-item__name">{ext.name}</span>
                        {ext.isClaude
                          ? <button type="button" className="browser-ext-item__open" onClick={() => { send({ type: 'open-claude' }); setExtMenuOpen(false); }}>Open</button>
                          : <span className="browser-ext-item__badge">loaded</span>}
                      </div>
                    )) : <div className="browser-ext-empty">No extensions loaded.</div>}
                  </div>
                  <div className="browser-ext-menu__foot">
                    <p>To add extensions: install one in your normal Chrome — it's auto-detected here the next time you start the browser. Advanced: set <code>BROWSER_EXTENSIONS</code> to an unpacked extension folder.</p>
                    <button type="button" onClick={() => { send({ type: 'open-extensions' }); setExtMenuOpen(false); }}><Puzzle size={13} /> Open extensions manager</button>
                  </div>
                </div>
              </>
            )}
          </div>
          <label className="browser-toggle" title="Headless streams only; headed also opens a real OS window"><input type="checkbox" checked={!(status?.headless ?? false)} onChange={(e) => send({ type: 'headless', value: !e.target.checked })} /> Window</label>
          <button type="button" title="Bring OS window to front" onClick={() => send({ type: 'front' })}><SquareArrowOutUpRight size={14} /></button>
          <button type="button" className={qaOpen ? 'is-active' : ''} title="QA a URL" onClick={() => setQaOpen((v) => !v)}><Bug size={14} /> QA</button>
          <button type="button" title={panelOpen ? 'Hide panel' : 'Show panel'} onClick={() => setPanelOpen((v) => !v)}>{panelOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}</button>
          <button type="button" className="browser-stop" title="Stop browser — closes every tab and frees CPU & RAM" onClick={() => send({ type: 'stop' })}><Power size={14} /> Stop</button>
          <span className={`browser-conn${connected ? ' is-on' : ''}`} title={connected ? 'Connected' : 'Disconnected'} />
        </div>
      </div>

      {/* ---- tab strip ---- */}
      <div className="browser-tabs">
        {tabs.map((tab) => (
          <div key={tab.id} className={`browser-tab${tab.id === focusedId ? ' is-active' : ''}`}>
            <button type="button" className="browser-tab__main" onClick={() => { setFocusedId(tab.id); send({ type: 'tab-activate', id: tab.id }); }} title={tab.url}>
              {tab.loading ? <Loader size={11} className="spin" /> : <Globe size={11} />}
              <span>{tab.title || 'New tab'}</span>
            </button>
            {tabs.length > 1 && <button type="button" className="browser-tab__close" title="Close tab" onClick={() => send({ type: 'tab-close', id: tab.id })}><X size={11} /></button>}
          </div>
        ))}
        <button type="button" className="browser-tab__add" title="New tab" onClick={() => send({ type: 'tab-new' })}><Plus size={14} /></button>
      </div>

      {/* ---- QA input row ---- */}
      {qaOpen && (
        <form className="browser-qa-bar" onSubmit={runQa}>
          <Bug size={14} />
          <input value={qaUrl} placeholder="URL to QA (e.g. http://localhost:5173)" onChange={(e) => setQaUrl(e.target.value)} />
          <input value={qaCompare} placeholder="Compare URL (optional)" onChange={(e) => setQaCompare(e.target.value)} />
          <button type="submit" className="button button--accent" disabled={qaRunning}>{qaRunning ? <Loader size={14} className="spin" /> : <Bug size={14} />} Run QA</button>
        </form>
      )}

      {/* ---- body: live panes + optional side panel ---- */}
      <div className="browser-body">
        <div className={`browser-stage-wrap${split ? ' is-split' : ''}${booting ? ' is-booting' : ''}`}>
          {noEngine || error ? (
            <div className="browser-overlay">
              <Globe size={30} />
              <h3>{noEngine ? 'No browser engine found' : 'Browser problem'}</h3>
              <p>{noEngine ? 'Download the isolated Chromium (no system Chrome required) to use the integrated browser.' : error}</p>
              {(noEngine || /engine|install/i.test(error)) && <button className="button button--accent" disabled={installing} onClick={() => send({ type: 'install' })}>{installing ? <Loader size={15} className="spin" /> : <Download size={15} />} Install isolated browser</button>}
              {!!installLog && <pre className="browser-install-log">{installLog.slice(-1500)}</pre>}
            </div>
          ) : paneIds.map((paneId, index) => {
            const paneTab = tabs.find((t) => t.id === paneId);
            const canvasStyle = fit ? undefined : { width: `${(status?.viewport.width ?? 1280) * zoom}px`, height: `${(status?.viewport.height ?? 800) * zoom}px`, maxWidth: 'none' as const, maxHeight: 'none' as const };
            return (
              <div key={`${paneId}-${index}`} className={`browser-pane${split && paneId === focusedId ? ' is-focused' : ''}`} onMouseDown={() => setFocusedId(paneId)}>
                {split && (
                  <div className="browser-pane__head">
                    <select value={paneId} onChange={(e) => { const value = Number(e.target.value); if (index === 0) { setFocusedId(value); send({ type: 'tab-activate', id: value }); } else setSecondaryId(value); }}>
                      {tabs.map((t) => <option key={t.id} value={t.id}>{t.title || 'New tab'}</option>)}
                    </select>
                    <small>{paneTab?.url}</small>
                  </div>
                )}
                <div className={`browser-stage${fit ? ' is-fit' : ''}`}>
                  <canvas
                    ref={registerCanvas(paneId)} className="browser-canvas" tabIndex={0} style={canvasStyle}
                    onMouseMove={(e) => { const now = Date.now(); if (now - lastMove.current < 30) return; lastMove.current = now; const p = toViewport(e, e.currentTarget); if (p) send({ type: 'mouse', id: paneId, action: 'move', ...p }); }}
                    onMouseDown={(e) => { e.currentTarget.focus(); setFocusedId(paneId); const p = toViewport(e, e.currentTarget); if (p) send({ type: 'mouse', id: paneId, action: 'down', ...p, button: mouseButton(e.button), clickCount: e.detail || 1 }); }}
                    onMouseUp={(e) => { const p = toViewport(e, e.currentTarget); if (p) send({ type: 'mouse', id: paneId, action: 'up', ...p, button: mouseButton(e.button), clickCount: e.detail || 1 }); }}
                    onContextMenu={(e) => e.preventDefault()}
                    onWheel={(e) => { const p = toViewport(e, e.currentTarget); if (p) send({ type: 'wheel', id: paneId, ...p, dx: e.deltaX, dy: e.deltaY }); }}
                    onKeyDown={(e) => { if (['Tab', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Enter'].includes(e.key)) e.preventDefault(); send({ type: 'key', id: paneId, action: 'down', key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }); }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {panelOpen && (
          <aside className="browser-panel">
            <div className="browser-panel__tabs">
              <button className={panel === 'console' ? 'is-active' : ''} onClick={() => setPanel('console')}><Bug size={13} /> Console {panelConsole.length ? <i>{panelConsole.length}</i> : null}</button>
              <button className={panel === 'network' ? 'is-active' : ''} onClick={() => setPanel('network')}><Network size={13} /> Network {panelNetwork.length ? <i>{panelNetwork.length}</i> : null}</button>
              <button className={panel === 'qa' ? 'is-active' : ''} onClick={() => setPanel('qa')}><ShieldCheck size={13} /> QA</button>
              <button className="browser-panel__collapse" title="Hide panel" onClick={() => setPanelOpen(false)}><PanelRightClose size={14} /></button>
            </div>
            <div className="browser-panel__body">
              {panel === 'console' && (panelConsole.length ? panelConsole.slice().reverse().map((entry, index) => (
                <div key={index} className={`browser-log-row browser-log-row--${entry.level}`}><span>{entry.level}</span><code>{entry.text}</code></div>
              )) : <PanelEmpty kind="console" onReload={() => send({ type: 'reload', id: focusedId })} onQa={() => setQaOpen(true)} />)}
              {panel === 'network' && (panelNetwork.length ? panelNetwork.slice().reverse().map((entry, index) => (
                <div key={index} className={`browser-log-row${entry.ok ? '' : ' browser-log-row--error'}`}><span>{entry.status ?? (entry.failure ? 'ERR' : '—')}</span><code>{entry.method} {entry.url}</code></div>
              )) : <PanelEmpty kind="network" onReload={() => send({ type: 'reload', id: focusedId })} onQa={() => setQaOpen(true)} />)}
              {panel === 'qa' && (qaReport ? (
                <div className="browser-qa-report">
                  <div className={`browser-qa-verdict${qaReport.ok ? ' is-ok' : ' is-warn'}`}>{qaReport.ok ? 'No issues found' : `${qaReport.issues.length} issue(s)`}</div>
                  {qaReport.issues.map((issue, index) => <div key={index} className="browser-qa-issue">{issue}</div>)}
                  {qaReport.pages.map((page, index) => (
                    <div key={index} className="browser-qa-page"><b>{page.title || page.url}</b><small>{page.loadMs}ms · {page.nodeCount} nodes · {page.consoleErrors.length} errors · {page.failedRequests.length} failed</small><img src={page.screenshot} alt={page.url} /></div>
                  ))}
                </div>
              ) : <PanelEmpty kind="qa" onReload={() => send({ type: 'reload', id: focusedId })} onQa={() => setQaOpen(true)} />)}
            </div>
          </aside>
        )}
      </div>

      <div className="browser-foot">Managed {engine?.isolated ? 'isolated' : ''} browser · {tabs.length} tab{tabs.length === 1 ? '' : 's'}{split ? ' · split view' : ''} · localhost-only · Claude drives the same view via local MCP tools.</div>
    </div>
  );
}
