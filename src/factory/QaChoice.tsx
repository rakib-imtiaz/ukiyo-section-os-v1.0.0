import { useEffect, useState } from 'react';
import { Check, CheckCircle2, Chrome, ExternalLink, Eye, Loader2, RefreshCw, ShieldCheck, XCircle, Zap } from 'lucide-react';
import { Button, Spinner, useToast } from './ui';
import { api } from './api';
import type { FactorySettings, QaEngine } from './types';

/** "How should ThemeBot check its work?" — two branches the user picks between:
 *   • Quiet automatic check (Playwright, headless): nothing to set up.
 *   • Check in my Chrome with Claude: Claude verifies in the user's own Chrome through the
 *     Claude for Chrome extension. Needs a ONE-TIME setup (Chrome, the extension, signed in to
 *     Claude and Shopify). Chrome keeps those sign-ins itself; ThemeBot only remembers that the
 *     setup was completed (Settings → browserQaSetup) so it is never asked for again. */

const CLAUDE_EXTENSION_URL = 'https://chromewebstore.google.com/search/Claude%20for%20Chrome';

export function QaChoice({ value, onChange, settings, onSettingsChange, hideSetup }: {
  value: QaEngine; onChange: (engine: QaEngine) => void;
  settings: FactorySettings | null; onSettingsChange?: (next: FactorySettings) => void;
  /** The page already shows the one-time Chrome setup card elsewhere — do not render it twice. */
  hideSetup?: boolean;
}) {
  const chrome = value === 'chrome';
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px] font-bold">How should ThemeBot check its work?</p>
      <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="How ThemeBot checks its work">
        <button type="button" role="radio" aria-checked={!chrome} onClick={() => onChange(value === 'headed' ? 'headed' : 'playwright')}
          className={`flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors ${!chrome ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-foreground/30'}`}>
          <span className="flex items-center gap-2 text-[14px] font-bold text-foreground"><Zap className="size-4.5 text-primary" /> Quiet automatic check <span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-bold text-success">Recommended</span></span>
          <span className="text-[12.5px] font-medium leading-relaxed text-muted-foreground">Runs in the background with its own hidden browser. Nothing to install, nothing to sign in to.</span>
        </button>
        <button type="button" role="radio" aria-checked={chrome} onClick={() => onChange('chrome')}
          className={`flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors ${chrome ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-foreground/30'}`}>
          <span className="flex items-center gap-2 text-[14px] font-bold text-foreground"><Chrome className="size-4.5 text-primary" /> Check in my own Chrome</span>
          <span className="text-[12.5px] font-medium leading-relaxed text-muted-foreground">The AI also opens the pages in your everyday Chrome and looks at them like a person would. Slower, and needs a one-time Chrome setup.</span>
        </button>
      </div>
      {!chrome && (
        <label className="flex cursor-pointer items-center gap-2.5 text-[13px] font-medium text-muted-foreground">
          <input type="checkbox" className="size-4 accent-primary" checked={value === 'headed'} onChange={(event) => onChange(event.target.checked ? 'headed' : 'playwright')} />
          <Eye className="size-4" /> Show me the window while it checks (slower, but you can watch)
        </label>
      )}
      {chrome && !hideSetup && <BrowserQaSetup settings={settings} onSettingsChange={onSettingsChange} />}
    </div>
  );
}

/** One-time setup card for the "check in my Chrome" branch. Detection where we can (Chrome +
 *  extension installed), honest checkboxes where we cannot (sign-ins live inside Chrome). */
export function BrowserQaSetup({ settings, onSettingsChange }: { settings: FactorySettings | null; onSettingsChange?: (next: FactorySettings) => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<{ chrome: { installed: boolean }; edge: { installed: boolean }; claudeExtension: { installed: boolean } } | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const [redo, setRedo] = useState(false);
  const [ticks, setTicks] = useState({ chromeSignedIn: false, claudeSignedIn: false, shopifySignedIn: false });
  const done = Boolean(settings?.browserQaSetup?.done) && !redo;

  const detect = async () => {
    setChecking(true);
    try { setStatus(await api.chromeStatus()); } catch { setStatus(null); }
    finally { setChecking(false); }
  };
  useEffect(() => { void detect(); }, []);

  const openChrome = async () => {
    setOpening(true);
    try { await api.openInChrome('https://accounts.shopify.com'); }
    catch (caught) { toast.push({ title: 'Could not open Chrome', detail: caught instanceof Error ? caught.message : undefined, variant: 'destructive' }); }
    finally { setOpening(false); }
  };

  const chromeOk = Boolean(status?.chrome.installed || status?.edge.installed);
  const extensionOk = Boolean(status?.claudeExtension.installed);
  const allGood = chromeOk && extensionOk && ticks.chromeSignedIn && ticks.claudeSignedIn && ticks.shopifySignedIn;

  const save = async (value: boolean) => {
    setSaving(true);
    try {
      const response = await api.saveSettings({ browserQaSetup: { done: value, doneAt: value ? new Date().toISOString() : null } });
      onSettingsChange?.(response.settings);
      setRedo(false);
      toast.push({ title: value ? 'Setup saved' : 'Setup cleared', detail: value ? 'ThemeBot will use your Chrome from now on and will not ask again.' : undefined, variant: 'success' });
    } catch (caught) {
      toast.push({ title: 'Could not save', detail: caught instanceof Error ? caught.message : undefined, variant: 'destructive' });
    } finally { setSaving(false); }
  };

  if (done) {
    const when = settings?.browserQaSetup?.doneAt ? new Date(settings.browserQaSetup.doneAt).toLocaleDateString() : null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-success/30 bg-success/5 p-3.5">
        <p className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
          <CheckCircle2 className="size-4.5 shrink-0 text-success" />
          <span><b className="text-foreground">Your Chrome is set up{when ? ` (since ${when})` : ''}.</b> The AI uses the sign-ins Chrome already remembers.</span>
        </p>
        <Button variant="ghost" size="sm" onClick={() => setRedo(true)}>Redo the setup</Button>
      </div>
    );
  }

  const Row = ({ ok, label, hint, action }: { ok: boolean | null; label: string; hint: string; action?: React.ReactNode }) => (
    <li className="flex items-start gap-3 rounded-lg p-2">
      <span className="mt-0.5 shrink-0">{ok === null ? <Loader2 className="size-4.5 animate-spin text-muted-foreground" /> : ok ? <CheckCircle2 className="size-4.5 text-success" /> : <XCircle className="size-4.5 text-warning" />}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-bold text-foreground">{label}</p>
        <p className="text-[12.5px] font-medium leading-relaxed text-muted-foreground">{hint}</p>
        {action && <div className="mt-1.5">{action}</div>}
      </div>
    </li>
  );
  const Tick = ({ id, label, hint }: { id: keyof typeof ticks; label: string; hint: string }) => (
    <li className="flex items-start gap-3 rounded-lg p-2">
      <input type="checkbox" id={`qa-setup-${id}`} className="mt-1 size-4 shrink-0 cursor-pointer accent-primary" checked={ticks[id]} onChange={(event) => setTicks((current) => ({ ...current, [id]: event.target.checked }))} />
      <label htmlFor={`qa-setup-${id}`} className="min-w-0 flex-1 cursor-pointer">
        <p className="text-[13.5px] font-bold text-foreground">{label}</p>
        <p className="text-[12.5px] font-medium leading-relaxed text-muted-foreground">{hint}</p>
      </label>
    </li>
  );

  return (
    <div className="rise-in rounded-xl border border-primary/25 bg-primary/[0.04] p-4">
      <p className="flex items-center gap-2 text-[14px] font-bold text-foreground"><ShieldCheck className="size-4.5 text-primary" /> One-time setup — about 3 minutes</p>
      <p className="mt-1 text-[12.5px] font-medium leading-relaxed text-muted-foreground">Chrome keeps these sign-ins itself, so you only do this once. ThemeBot just remembers that it is done.</p>
      <ol className="mt-3 flex flex-col gap-0.5">
        <Row ok={status ? chromeOk : null} label="1. Google Chrome is installed" hint={chromeOk ? 'Found on this computer.' : 'Install Google Chrome, then press Check again.'} />
        <Row ok={status ? extensionOk : null} label="2. The Claude for Chrome extension is installed" hint={extensionOk ? 'Found in your Chrome.' : 'Add it from the Chrome Web Store, then press Check again.'}
          action={!extensionOk && <a href={CLAUDE_EXTENSION_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-primary hover:underline">Open the Chrome Web Store <ExternalLink className="size-3.5" /></a>} />
        <Tick id="chromeSignedIn" label="3. I am signed in to Chrome" hint="Your Google account in Chrome — so the extension and your sign-ins are kept." />
        <Tick id="claudeSignedIn" label="4. I am signed in to the extension" hint="Click the extension's icon in Chrome's toolbar and log in once." />
        <Tick id="shopifySignedIn" label="5. I am signed in to Shopify in Chrome" hint="So the AI can open your store's pages without hitting a login wall." />
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void openChrome()} disabled={opening || !chromeOk}>{opening ? <Spinner /> : <Chrome />} Open Chrome to sign in</Button>
        <Button variant="outline" size="sm" onClick={() => void detect()} disabled={checking}>{checking ? <Spinner /> : <RefreshCw />} Check again</Button>
        <Button size="sm" onClick={() => void save(true)} disabled={!allGood || saving} title={!allGood ? 'Finish every step first' : undefined}>{saving ? <Spinner className="text-primary-foreground" /> : <Check />} Save — setup done</Button>
        {settings?.browserQaSetup?.done && <Button variant="ghost" size="sm" onClick={() => setRedo(false)}>Keep the old setup</Button>}
      </div>
    </div>
  );
}
