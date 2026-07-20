import { useEffect, useRef, useState } from 'react';
import { Bot, Check, CheckCircle2, ChevronDown, Chrome, Copy, ExternalLink, Loader2, PartyPopper, Play, Sparkles, Square, X, XCircle } from 'lucide-react';
import { api } from './api';

/** Guided "no credit card, ever" store-setup checklist for the wizard's Credentials step.
 *  Progress persists to localStorage so it survives closing the wizard / reloading. */

const CHECKLIST_KEY = 'factory-setup-checklist-v2';
// The user-verified full scope list the clone pipeline needs (admin + unauthenticated
// Storefront scopes), plus the navigation pair Test connection checks for. Keep in sync
// with AUTOPILOT_SCOPES in server/factory/routes.ts.
const SCOPES = 'read_files,write_files,read_locales,write_locales,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects,read_online_store_pages,write_online_store_pages,read_products,write_products,read_content,write_content,write_theme_code,read_themes,write_themes,read_translations,write_translations,read_online_store_navigation,write_online_store_navigation,unauthenticated_write_bulk_operations,unauthenticated_read_bulk_operations,unauthenticated_read_bundles,unauthenticated_write_checkouts,unauthenticated_read_checkouts,unauthenticated_write_customers,unauthenticated_read_customers,unauthenticated_read_customer_tags,unauthenticated_read_metaobjects,unauthenticated_read_product_pickup_locations';

interface GuideStep { title: string; body: string; link?: { href: string; label: string }; copy?: string; critical?: boolean }

const GUIDE_STEPS: GuideStep[] = [
  {
    title: 'Log in to Shopify',
    body: 'Sign in (or sign up) at Shopify with the account that will own the store.',
    link: { href: 'https://accounts.shopify.com', label: 'accounts.shopify.com' },
  },
  {
    title: 'Create your store — name it after your project',
    body: 'The signup asks "What should we call your store?" — the name you type becomes <name>.myshopify.com AND should match your ThemeBot project name, so you (and the bot) always know which store belongs to which project.',
  },
  {
    title: 'Activate the $1/month starter plan — do NOT skip',
    body: 'Pick the $1/month starter deal when Shopify offers it. Without an active plan, "Install app" in the Dev Dashboard stays disabled and the whole flow dead-ends. One dollar unlocks everything.',
    critical: true,
  },
  {
    title: 'Open the Dev Dashboard',
    body: 'Shopify\'s developer console — this is where custom apps are created and released.',
    link: { href: 'https://dev.shopify.com', label: 'dev.shopify.com' },
  },
  {
    title: 'Create the app — name it after your project too',
    body: 'Apps → Create app → "Start from Dev Dashboard". Name it "<project>_bot" (e.g. jacqueline_bot) so the app is tied to the project you\'re working on.',
  },
  {
    title: 'Add the access scopes',
    body: 'Open the app → Versions → New version → Access scopes. write_themes/read_themes are the bare minimum; the rest unlock catalog seeding, pages, blogs, menus, files, locales, translations, and the storefront checks QA uses. Paste the whole list into the comma-separated field (or tick them in the "Select scopes" dialog):',
    copy: SCOPES,
  },
  {
    title: 'Release and install',
    body: 'Click Release (leave the version name blank) → app Overview → Install app → pick your store → Install.',
  },
  {
    title: 'Copy the credentials',
    body: 'App → Settings tab → Client ID and Client Secret. Paste them below, hit Test connection — then tick "Remember this store" and you never do this again.',
  },
];

/** "Use your own Chrome" credential helper. Shopify's login runs hCaptcha bot-detection that
 *  flags the app's built-in automated browser — but the user's real Chrome is already signed
 *  in and fully trusted, so collecting the Client ID/Secret there has no login wall at all.
 *  Shows what's detected on this machine, what's needed, and a one-click page launcher. */
export function ChromeKeysCard({ storeUrl, projectName, keysOnFile, onKeys, onChangeKey, onRemoveKeys }: {
  storeUrl?: string; projectName?: string;
  /** Keys for this store already exist (saved store or filled fields) — lock the fetch buttons. */
  keysOnFile?: boolean;
  onKeys?: (keys: { clientId?: string | null; clientSecret?: string | null }) => void;
  onChangeKey?: () => void;
  onRemoveKeys?: () => void;
}) {
  const [status, setStatus] = useState<{ chrome: { installed: boolean }; edge: { installed: boolean }; claudeExtension: { installed: boolean } } | null>(null);
  const [opening, setOpening] = useState(false);
  const [openResult, setOpenResult] = useState<{ ok: boolean; detail: string } | null>(null);
  // "Lazy mode" bot: one click → running (poll) → done/error. No confirm step: the bot
  // waits out the Shopify login itself, so there's nothing to "come back and start".
  const [botPhase, setBotPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [botNote, setBotNote] = useState('');
  const [botElapsed, setBotElapsed] = useState(0);
  const [botLog, setBotLog] = useState<Array<{ at: number; text: string }>>([]);
  // Stop stays disarmed briefly after start: it renders where the start button was, so a
  // double-click would otherwise start the bot and instantly kill it ("Stopped by user").
  const [stopArmed, setStopArmed] = useState(false);
  const loginNotified = useRef(false);
  useEffect(() => {
    if (botPhase !== 'running') { setStopArmed(false); return; }
    const timer = setTimeout(() => setStopArmed(true), 1500);
    return () => clearTimeout(timer);
  }, [botPhase]);

  useEffect(() => { void api.chromeStatus().then(setStatus).catch(() => setStatus(null)); }, []);

  // Re-attach to the server-side bot on mount. The bot is a server process — switching
  // factory tabs, moving wizard steps, or refreshing the page unmounts this card but must
  // NOT lose the run. Three cases: still working → resume the running view + live feed;
  // finished while we were away with keys waiting → take them now (one-time handoff);
  // otherwise stay idle. Only the Stop button (or a server restart) ends a run.
  const onKeysRef = useRef(onKeys);
  onKeysRef.current = onKeys;
  useEffect(() => {
    let alive = true;
    void api.collectKeysStatus().then(async (state) => {
      if (!alive) return;
      if (state.running) {
        loginNotified.current = state.log?.some((entry) => /WAITING FOR LOGIN/i.test(entry.text)) ?? false;
        if (state.log) setBotLog(state.log);
        setBotElapsed(state.elapsedSec ?? 0);
        setBotPhase('running');
        return;
      }
      if (state.clientId === 'ready' || state.hasSecret) {
        const final = await api.collectKeysStatus(true);
        if (!alive) return;
        if (final.log) setBotLog(final.log);
        if (final.clientId || final.clientSecret) onKeysRef.current?.({ clientId: final.clientId, clientSecret: final.clientSecret });
        if (final.status === 'delivered') {
          setBotPhase('done'); setBotNote('Both keys are in the fields below — hit Test connection.');
        } else {
          setBotPhase('error'); setBotNote(final.note ?? 'The bot finished with a partial result — check the fields below.');
        }
        return;
      }
      // No keys waiting, but the run ended (failed/partial) in the last 10 minutes while this
      // card was unmounted — show the outcome instead of silently resetting to the idle button.
      if ((state.status === 'failed' || state.status === 'partial') && (state.finishedAgoSec ?? Infinity) < 600) {
        if (state.log) setBotLog(state.log);
        setBotPhase('error');
        setBotNote(state.note ?? 'The last bot run did not finish — see the feed below, then try again.');
      }
    }).catch(() => { /* server unreachable — stay idle */ });
    return () => { alive = false; };
  }, []);

  const browserReady = Boolean(status?.chrome.installed || status?.edge.installed);
  const shopHandle = storeUrl && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(storeUrl) ? storeUrl.replace(/\.myshopify\.com$/i, '') : null;
  const targetUrl = shopHandle
    ? `https://admin.shopify.com/store/${shopHandle}/settings/apps/development`
    : 'https://dev.shopify.com';

  const openPage = async () => {
    setOpening(true); setOpenResult(null);
    try {
      const result = await api.openInChrome(targetUrl);
      setOpenResult({ ok: true, detail: `Opened in ${result.browser} — copy the Client ID and Secret from that window, then paste them below.` });
    } catch (error) {
      setOpenResult({ ok: false, detail: error instanceof Error ? error.message : 'Could not open the browser.' });
    } finally { setOpening(false); }
  };

  /** System notification — reaches the user even while they're on the Shopify window. */
  const notify = (title: string, body: string) => {
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const notice = new Notification(title, { body });
        notice.onclick = () => { window.focus(); notice.close(); };
      }
    } catch { /* notifications unsupported — the in-app panel still shows everything */ }
  };

  // One click does it all: start the bot AND pop the user's Chrome. If Shopify wants a login,
  // the bot just waits for the user to finish it and then continues by itself.
  const startBot = async () => {
    if (!storeUrl) return;
    setBotNote('');
    try { if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission(); } catch { /* optional */ }
    loginNotified.current = false;
    try {
      await api.collectKeysStart(storeUrl, projectName);
      setBotPhase('running');
      // No extra tab here on purpose: the bot opens its own Dev Dashboard tab.
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The bot could not start.';
      // A run is already live server-side (e.g. started before a refresh) — attach to it
      // instead of erroring; the poll loop takes over from here.
      if (/already running/i.test(message)) { setBotPhase('running'); return; }
      setBotNote(message);
      setBotPhase('error');
    }
  };

  const stopBot = async () => { try { await api.collectKeysStop(); } catch { /* already stopped */ } setBotPhase('idle'); };

  // Poll while the bot works; when it finishes, take the keys (one-time handoff) into the form.
  useEffect(() => {
    if (botPhase !== 'running') return;
    let alive = true;
    const timer = setInterval(() => {
      void api.collectKeysStatus().then(async (state) => {
        if (!alive) return;
        if (state.log) setBotLog(state.log);
        // Login pause: the bot announces "WAITING FOR LOGIN" in its feed — surface it as a
        // system notification too, so the user gets pinged even while on the Shopify window.
        if (!loginNotified.current && state.log?.some((entry) => /WAITING FOR LOGIN/i.test(entry.text))) {
          loginNotified.current = true;
          notify('ThemeBot — login needed ⏸', 'The bot is paused on a Shopify login page. Log in there and it continues automatically.');
        }
        if (state.running) { setBotElapsed(state.elapsedSec ?? 0); return; }
        const final = await api.collectKeysStatus(true);
        if (!alive) return;
        if (final.clientId || final.clientSecret) onKeys?.({ clientId: final.clientId, clientSecret: final.clientSecret });
        if (final.status === 'delivered') {
          setBotPhase('done'); setBotNote('Both keys are in the fields below — hit Test connection.');
          notify('ThemeBot — keys collected 🎉', 'Client ID + Secret are filled into the wizard. Come back and hit Test connection.');
        } else {
          const note = final.note ?? (final.clientId ? 'Got the Client ID but not the Secret — copy it from the Chrome window.' : 'The bot could not fetch the keys — copy them from the Chrome window.');
          setBotPhase('error'); setBotNote(note);
          notify('ThemeBot — the bot needs you', note);
        }
      }).catch(() => { /* transient poll error — keep trying */ });
    }, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [botPhase, onKeys]);

  const Chip = ({ ok, label }: { ok: boolean | null; label: string }) => (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-bold ${
      ok === null ? 'border-border text-muted-foreground' : ok ? 'border-success/40 bg-success/5 text-success' : 'border-destructive/40 bg-destructive/5 text-destructive'}`}>
      {ok === null ? <Loader2 className="size-3 animate-spin" /> : ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
      {label}
    </span>
  );

  return (
    <div className="rounded-xl border border-success/25 bg-success/[0.04] p-4">
      <div className="flex items-start gap-3">
        <Chrome className="mt-0.5 size-4.5 shrink-0 text-success" />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-bold text-foreground">Fastest: collect the keys with your own Chrome</p>
          <p className="mt-0.5 text-[12.5px] font-medium leading-relaxed text-muted-foreground">
            Shopify's login blocks automated browsers (hCaptcha bot-check), so the built-in browser can't fetch keys for you.
            Your own Chrome has no such wall — it's already signed in and trusted by Shopify.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Chip ok={status ? status.chrome.installed || status.edge.installed : null} label={status?.chrome.installed ? 'Google Chrome installed' : status?.edge.installed ? 'Microsoft Edge installed' : 'Chrome / Edge installed'} />
            <Chip ok={status ? status.claudeExtension.installed : null} label="Claude for Chrome extension" />
          </div>
          <ul className="mt-2.5 flex flex-col gap-1 text-[12.5px] font-medium leading-relaxed text-muted-foreground">
            <li><b className="text-foreground">1. Chrome (or Edge) installed</b> — used with your normal profile and logins.</li>
            <li><b className="text-foreground">2. Signed into your Shopify admin</b> in that browser (one normal login, no captcha trouble).</li>
            <li><b className="text-foreground">3. Optional — Claude for Chrome extension:</b> with it installed, you can ask Claude to drive your Chrome through store + app creation and read the keys off the page for you, instead of copying them yourself.</li>
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            {status?.claudeExtension.installed && browserReady && (
              <button
                type="button" onClick={() => void startBot()} disabled={!shopHandle || botPhase === 'running' || keysOnFile}
                title={keysOnFile ? 'Keys are already on file for this store — use "Change key" below to replace them' : shopHandle ? 'One click: a Claude bot drives your Chrome and fetches the keys — it even waits while you log in' : 'Fill the Shopify store in step 1 first'}
                className={`inline-flex items-center gap-2.5 rounded-xl bg-success px-5 py-2.5 text-[14.5px] font-bold text-white transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40 ${shopHandle && botPhase !== 'running' && !keysOnFile ? 'bot-cta' : ''}`}
              >
                <Bot className="size-5" /> Feeling lazy? Send the bot
              </button>
            )}
            <button
              type="button" onClick={() => void openPage()} disabled={!browserReady || opening || keysOnFile}
              title={keysOnFile ? 'Keys are already on file for this store — use "Change key" below to replace them' : undefined}
              className="inline-flex items-center gap-2 rounded-lg border border-success/50 bg-card px-3.5 py-2 text-[13px] font-bold text-success transition-colors hover:bg-success/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {opening ? <Loader2 className="size-4 animate-spin" /> : <Chrome className="size-4" />}
              {shopHandle ? 'Open app credentials in Chrome' : 'Open the Dev Dashboard in Chrome'}
            </button>
          </div>

          {/* Keys already on file: fetch paths locked; offer manual replace or a full purge. */}
          {keysOnFile && botPhase === 'idle' && (
            <div className="mt-3 flex flex-wrap items-center gap-2.5 rounded-xl border border-border bg-muted/50 p-3">
              <p className="min-w-0 flex-1 text-[12.5px] font-medium leading-relaxed text-muted-foreground">
                <CheckCircle2 className="mr-1.5 inline size-3.5 text-success" />
                <b className="text-foreground">Keys are already on file for this store</b> — fetching again is locked so the bot can't overwrite them by accident.
              </p>
              <button type="button" onClick={() => onChangeKey?.()} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-bold text-foreground transition-colors hover:bg-accent">
                Change key
              </button>
              <button type="button" onClick={() => onRemoveKeys?.()} className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 bg-card px-3 py-1.5 text-[12.5px] font-bold text-destructive transition-colors hover:bg-destructive/10">
                <XCircle className="size-3.5" /> Remove keys everywhere
              </button>
            </div>
          )}
          {!browserReady && status && (
            <p className="mt-2 text-[12.5px] font-semibold text-destructive">No Chrome or Edge found on this machine — install Google Chrome to use this shortcut.</p>
          )}
          {openResult && botPhase === 'idle' && (
            <p className={`mt-2 text-[12.5px] font-semibold ${openResult.ok ? 'text-success' : 'text-destructive'}`}>{openResult.detail}</p>
          )}

          {/* Bot flow panel — confirm → running → done/error (smooth collapse). */}
          <div className={`collapse-panel${botPhase !== 'idle' ? ' is-open' : ''}`} aria-hidden={botPhase === 'idle'}>
            <div className="collapse-panel__inner">
              <div className="mt-3 rounded-xl border border-success/30 bg-card p-4">
                {botPhase === 'running' && (
                  <>
                    <p className="flex items-center gap-2 text-[13.5px] font-bold text-foreground">
                      <Loader2 className="size-4 animate-spin text-success" /> Bot is working <span className="tabular-nums text-muted-foreground">{botElapsed}s</span>
                    </p>
                    {/* Live activity feed straight from the agent's event stream (always redacted). */}
                    <div className="mt-2.5 flex flex-col gap-1 rounded-lg bg-muted/60 p-3">
                      {(botLog.length ? botLog.slice(-5) : [{ at: 0, text: 'Spawning the agent…' }]).map((entry, index, list) => (
                        <p key={`${entry.at}-${index}`} className={`flex items-start gap-2 text-[12.5px] leading-relaxed ${index === list.length - 1 ? 'font-bold text-foreground' : 'font-medium text-muted-foreground'}`}>
                          {index === list.length - 1 ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-success" /> : <Check className="mt-0.5 size-3.5 shrink-0 text-success/60" />}
                          <span className="min-w-0">{entry.text}</span>
                        </p>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[12px] font-medium leading-relaxed text-muted-foreground">
                      <b className="text-foreground">If Shopify asks you to log in, just log in — the bot waits for you and continues by itself.</b> Nothing else to click here:
                      the first ~30s is the agent booting, then Chrome starts moving on its own. A full first-time setup (create app → scopes → release → install → fetch keys)
                      can take several minutes; you'll get a notification when it's done. Don't close the Chrome window or click Stop unless the feed is clearly stuck.
                    </p>
                    <button type="button" onClick={() => void stopBot()} disabled={!stopArmed} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border px-3.5 py-2 text-[13px] font-bold text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40">
                      <Square className="size-3.5" /> Stop the bot
                    </button>
                  </>
                )}
                {(botPhase === 'done' || botPhase === 'error') && (
                  <>
                    <p className={`flex items-center gap-2 text-[13.5px] font-bold ${botPhase === 'done' ? 'text-success' : 'text-destructive'}`}>
                      {botPhase === 'done' ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
                      {botPhase === 'done' ? 'Keys collected!' : 'The bot could not finish.'}
                    </p>
                    {botNote && <p className="mt-1.5 text-[12.5px] font-medium leading-relaxed text-muted-foreground">{botNote}</p>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {botPhase === 'error' && (
                        <button type="button" onClick={() => void startBot()} className="inline-flex items-center gap-2 rounded-lg bg-success px-3.5 py-2 text-[13px] font-bold text-white transition-opacity hover:opacity-90">
                          <Bot className="size-4" /> Try again
                        </button>
                      )}
                      <button type="button" onClick={() => setBotPhase('idle')} className="inline-flex items-center gap-2 rounded-lg border border-border px-3.5 py-2 text-[13px] font-bold text-muted-foreground transition-colors hover:bg-accent">
                        Close
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Vite's dev proxy stalls on video Range requests — stream straight from the API origin in
 *  dev (port 5173 → API on 8787); in production the app is served by the API itself. */
const VIDEO_SRC = window.location.port === '5173'
  ? `${window.location.protocol}//${window.location.hostname}:8787/api/setup-video`
  : '/api/setup-video';

/** Pinned wizard-rail player: sits in the empty space left of the form on wide screens and
 *  stays put while the page scrolls. Renders nothing when the video isn't on this machine. */
export function SetupVideoCard() {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-md">
      <video src={VIDEO_SRC} controls muted playsInline preload="metadata" className="block aspect-video w-full bg-black" onError={() => setMissing(true)} />
      <div className="px-3.5 py-2.5">
        <p className="flex items-center gap-1.5 text-[13px] font-bold text-foreground"><Play className="size-3.5 text-primary" /> Store &amp; app setup — watch along</p>
        <p className="mt-0.5 text-[12px] font-medium leading-relaxed text-muted-foreground">All 9 steps in 1:44 — from login and the $1 plan to keys pasted into this wizard.</p>
      </div>
    </div>
  );
}

const loadProgress = (): boolean[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(CHECKLIST_KEY) ?? '[]') as unknown;
    if (Array.isArray(raw)) return GUIDE_STEPS.map((_, index) => raw[index] === true);
  } catch { /* corrupted — start fresh */ }
  return GUIDE_STEPS.map(() => false);
};

export function SetupChecklist() {
  const [done, setDone] = useState<boolean[]>(loadProgress);
  const [open, setOpen] = useState(() => loadProgress().some((value) => !value));
  const [copied, setCopied] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoMissing, setVideoMissing] = useState(false);
  const doneCount = done.filter(Boolean).length;

  const toggle = (index: number) => {
    setDone((current) => {
      const next = current.map((value, i) => (i === index ? !value : value));
      localStorage.setItem(CHECKLIST_KEY, JSON.stringify(next));
      return next;
    });
  };

  const copyScopes = async () => {
    try { await navigator.clipboard.writeText(SCOPES); } catch { /* clipboard blocked — the text is selectable anyway */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-primary/25 bg-primary/[0.04]">
      <button
        type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-primary/[0.06]"
      >
        <PartyPopper className="size-4.5 shrink-0 text-primary" />
        <span className="flex-1">
          <span className="block text-[14px] font-bold text-foreground">No store or app yet? Full setup in ~5 minutes — costs $1/month.</span>
          <span className="mt-0.5 block text-[12.5px] font-medium text-muted-foreground">
            {doneCount === GUIDE_STEPS.length ? 'All steps done — nice.' : `${doneCount}/${GUIDE_STEPS.length} steps done`} · Store + $1 starter plan + app + keys. The plan step can't be skipped.
          </span>
        </span>
        <ChevronDown className={`size-4.5 shrink-0 text-muted-foreground transition-transform duration-300 ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Prefer watching? Always visible, even with the checklist collapsed. */}
      <button
        type="button" onClick={() => setVideoOpen(true)}
        className="flex w-full items-center gap-2.5 border-t border-primary/15 px-4 py-2.5 text-left transition-colors hover:bg-primary/[0.06]"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"><Play className="ml-0.5 size-3" /></span>
        <span className="text-[12.5px] font-bold text-foreground">Prefer watching? 2-minute video of all the steps</span>
        <span className="ml-auto text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">1:44</span>
      </button>

      {/* Video modal */}
      {videoOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 sm:p-8" role="dialog" aria-modal="true" aria-label="Setup video" onClick={() => setVideoOpen(false)}>
          <div className="w-full max-w-4xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <p className="text-[14px] font-bold text-foreground">Set up your Shopify store &amp; app — 9 steps</p>
              <button type="button" onClick={() => setVideoOpen(false)} aria-label="Close video" className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><X className="size-4.5" /></button>
            </div>
            {videoMissing ? (
              <p className="px-4 pb-5 text-[13px] font-medium leading-relaxed text-muted-foreground">The tutorial video hasn't been rendered on this machine (it lives in <code>video/setup-guide/</code>). The checklist above covers the same 8 steps.</p>
            ) : (
              // eslint-disable-next-line jsx-a11y/media-has-caption -- silent-by-design video with burned-in captions
              <video src={VIDEO_SRC} controls autoPlay muted playsInline className="block max-h-[70vh] w-full bg-black" onError={() => setVideoMissing(true)} />
            )}
          </div>
        </div>
      )}

      <div className={`collapse-panel${open ? ' is-open' : ''}`} aria-hidden={!open}>
        <div className="collapse-panel__inner">
        <ol className="flex list-none flex-col gap-1 border-t border-primary/15 p-3">
          {GUIDE_STEPS.map((step, index) => (
            <li key={step.title} className={`flex items-start gap-3 rounded-lg p-2 transition-colors hover:bg-accent/50 ${step.critical && !done[index] ? 'border border-warning/40 bg-warning/5' : ''}`}>
              <input
                type="checkbox" checked={done[index]} onChange={() => toggle(index)}
                aria-label={`Mark "${step.title}" done`}
                className="mt-1 size-4 shrink-0 cursor-pointer accent-primary"
              />
              <div className="min-w-0 flex-1">
                <p className={`text-[13.5px] font-bold ${done[index] ? 'text-muted-foreground line-through' : step.critical ? 'text-warning' : 'text-foreground'}`}>
                  {index + 1}. {step.title}
                  {step.link && (
                    <a href={step.link.href} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 font-bold text-primary hover:underline">
                      {step.link.label} <ExternalLink className="size-3" />
                    </a>
                  )}
                </p>
                <p className="mt-0.5 text-[12.5px] font-medium leading-relaxed text-muted-foreground">{step.body}</p>
                {step.copy && (
                  <div className="mt-1.5">
                    <code className="block max-h-24 select-all overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-secondary p-2.5 font-mono text-[11px] leading-relaxed text-foreground">{step.copy}</code>
                    <button
                      type="button" onClick={copyScopes}
                      className="mt-1.5 inline-flex items-center gap-2 rounded-lg border border-border bg-secondary px-2.5 py-1.5 text-[12px] font-bold text-foreground transition-colors hover:border-primary/40 hover:text-primary"
                    >
                      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
                      {copied ? 'Copied!' : `Copy all ${SCOPES.split(',').length} scopes`}
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
          <li className="mt-1 list-none rounded-lg bg-muted/60 p-3 text-[12.5px] font-medium leading-relaxed text-muted-foreground">
            <span className="font-bold text-foreground">Going live later?</span> A dev store is a free practice loop forever. When it's time for customers: re-run this same job against the real store (installing the app there is free — the plan is the store's own subscription, never an app fee), or transfer the dev store in the Partner Dashboard.
          </li>
        </ol>
        </div>
      </div>
    </div>
  );
}
