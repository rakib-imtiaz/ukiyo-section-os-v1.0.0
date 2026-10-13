import { useEffect, useState, type ReactNode } from 'react';
import { Activity, Bot, Sparkles, Camera, CheckCircle2, ChevronDown, Chrome, Columns3, ExternalLink, Globe, LogOut, Store, UserMinus, UserPlus, UserRound, Clock3, Cpu, Eraser, FlaskConical, FolderCog, Gauge, Hammer, Hourglass, KeyRound, LayoutList, Layers, ListPlus, MousePointerClick, OctagonPause, PauseCircle, RefreshCw, Repeat2, Save, ScanSearch, ShieldCheck, SlidersHorizontal, Target, TimerReset, TrendingUp, TriangleAlert, Type, Wrench, XCircle } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Field, Separator, Slider, Spinner, Switch, Tabs, useToast } from './ui';
import { api } from './api';
import { animationsEnabled, setAnimationsEnabled, systemReducedMotion } from '../motion';
import type { BotModel, FactorySettings, Job, QaSelftestResult, SettingsResponse } from './types';

const MODEL_META: Record<BotModel, { label: string; hint: string }> = {
  opus: { label: 'Opus', hint: 'Most reliable · default' },
  sonnet: { label: 'Sonnet', hint: '~2–3× faster' },
  haiku: { label: 'Haiku', hint: 'Fastest · least careful' },
};

function ModelPicker({ value, onChange, ariaLabel }: { value: BotModel; onChange: (model: BotModel) => void; ariaLabel: string }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="grid grid-cols-3 gap-2">
      {(Object.keys(MODEL_META) as BotModel[]).map((model) => (
        <button
          key={model} type="button" role="radio" aria-checked={value === model} onClick={() => onChange(model)}
          className={`flex flex-col items-start gap-0.5 rounded-xl border px-3.5 py-2.5 text-left transition-all ${value === model ? 'border-primary bg-primary/5 shadow-sm' : 'border-border bg-card hover:border-ring/50'}`}
        >
          <span className="text-[13.5px] font-bold">{MODEL_META[model].label}</span>
          <span className="text-[11.5px] font-semibold text-muted-foreground">{MODEL_META[model].hint}</span>
        </button>
      ))}
    </div>
  );
}

function SectionHeader({ icon, title, description, danger }: { icon: ReactNode; title: string; description?: string; danger?: boolean }) {
  return (
    <CardHeader className="flex-row items-start gap-4 space-y-0">
      <div className={`flex size-10 shrink-0 items-center justify-center rounded-xl border [&_svg]:size-5 ${danger ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-border bg-muted text-foreground'}`}>
        {icon}
      </div>
      <div className="flex flex-col gap-1.5">
        <CardTitle className={danger ? 'text-destructive' : undefined}>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </div>
    </CardHeader>
  );
}

function PathCheck({ label, value, kind }: { label: string; value: string; kind: string }) {
  const [state, setState] = useState<{ ok: boolean; detail?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try { setState(await api.validate(kind, value)); } catch { setState({ ok: false, detail: 'Check failed' }); } finally { setChecking(false); }
  };
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13.5px] font-bold">{label}</p>
        <p className="truncate text-[13px] font-medium text-muted-foreground"><code>{value}</code></p>
        {state && <p className={`text-[13px] font-semibold ${state.ok ? 'text-success' : 'text-destructive'}`}>{state.detail}</p>}
      </div>
      <Button size="sm" variant="outline" onClick={check} disabled={checking}>
        {checking ? <Spinner /> : state == null ? <RefreshCw /> : state.ok ? <CheckCircle2 className="text-success" /> : <XCircle className="text-destructive" />}
        Check
      </Button>
    </div>
  );
}

function BrowserStatus() {
  const toast = useToast();
  const [status, setStatus] = useState<{ ready: boolean; hasChromium: boolean; installing: boolean } | null>(null);
  const refresh = () => api.browserStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(() => { void refresh(); }, []);
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13.5px] font-bold">QA browser (Chromium)</p>
        <p className={`text-[13px] font-semibold ${status?.ready ? 'text-success' : 'text-muted-foreground'}`}>{status == null ? 'checking…' : status.ready ? 'Installed — QA can run.' : 'Not installed — install to enable QA.'}</p>
      </div>
      {status && !status.ready
        ? <Button size="sm" variant="outline" disabled={status.installing} onClick={async () => { await api.installBrowser(); setStatus({ ...status, installing: true }); toast.push({ title: 'Installing QA browser…', variant: 'default' }); }}>{status.installing ? <Spinner /> : <RefreshCw />} {status.installing ? 'Installing…' : 'Install'}</Button>
        : <Button size="sm" variant="outline" onClick={refresh}><RefreshCw /> Re-check</Button>}
    </div>
  );
}

/** Runs the QA scoring pipeline against its known-good calibration fixture (POST /api/factory/qa-selftest). */
function QaSelfTest() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QaSelftestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  const run = async () => {
    setRunning(true); setResult(null); setError(null); setShowLog(false);
    try { setResult(await api.qaSelftest()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Self-test request failed.'); }
    finally { setRunning(false); }
  };

  const pct = (value: number | null | undefined) => value == null ? '—' : `${Math.round(value * 100)}%`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13.5px] font-bold">QA scoring self-test</p>
          <p className="text-[13px] font-medium leading-relaxed text-muted-foreground">
            Scores a known-good fixture through the full pipeline (Playwright, segmentation, alignment, scoring). Takes up to 5 minutes.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={run} disabled={running}>
          {running ? <Spinner /> : <FlaskConical />} {running ? 'Running…' : 'Run QA self-test'}
        </Button>
      </div>
      {running && <p className="text-[13px] font-semibold text-muted-foreground">The self-test drives a real browser — leave this page open; results appear here when it finishes.</p>}
      {error && <p className="text-[13px] font-semibold text-destructive">{error}</p>}
      {result && (
        <div className={`rounded-xl border p-4 ${result.ok ? 'border-success/25 bg-success/5' : 'border-destructive/25 bg-destructive/5'}`}>
          <p className={`flex items-center gap-2 text-[14px] font-bold ${result.ok ? 'text-success' : 'text-destructive'}`}>
            {result.ok ? <CheckCircle2 className="size-4.5" /> : <XCircle className="size-4.5" />}
            {result.ok ? 'QA pipeline is trustworthy on this machine' : 'QA self-test failed'}
            {result.score != null && <span className="tabular-nums">· score {pct(result.score)}</span>}
          </p>
          {!result.ok && result.error && <p className="mt-1.5 text-[13px] font-semibold leading-relaxed text-destructive">{result.error}</p>}
          {result.subscores && (
            <p className="mt-2 flex flex-wrap gap-1.5">
              {(['presence', 'text', 'interaction'] as const).map((key) => (
                <span key={key} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
                  {key} <span className="tabular-nums text-foreground">{pct(result.subscores?.[key])}</span>
                </span>
              ))}
            </p>
          )}
          {result.log && (
            <>
              <button type="button" onClick={() => setShowLog((value) => !value)} aria-expanded={showLog}
                className="mt-3 inline-flex items-center gap-1 text-[13px] font-bold text-foreground transition-opacity hover:opacity-70">
                <ChevronDown className={`size-4 transition-transform ${showLog ? 'rotate-180' : ''}`} /> {showLog ? 'Hide log' : 'Show log'}
              </button>
              <div className={`collapse-panel${showLog ? ' is-open' : ''}`} aria-hidden={!showLog}>
                <div className="collapse-panel__inner">
                  <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-terminal p-3.5 font-mono text-[12px] leading-5 text-zinc-100">{result.log}</pre>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Settings → Speed: turn every animation off (slow machines). Applies instantly, per browser. */
function AnimationsCard() {
  const [on, setOn] = useState(animationsEnabled);
  const system = systemReducedMotion();
  return (
    <Card>
      <SectionHeader icon={<Sparkles />} title="Animations" description="Moving pictures, spinning cube, flowing lines and page transitions." />
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[15px] font-bold">Show animations</p>
            <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-muted-foreground">Turn this off if ThemeBot feels slow or your computer gets hot. Everything still works — it just stops moving.</p>
          </div>
          <Switch checked={on && !system} disabled={system} onCheckedChange={(value) => { setOn(value); setAnimationsEnabled(value); }} aria-label="Show animations" />
        </div>
        {system && <p className="text-[13px] font-semibold text-muted-foreground">Your computer is set to reduce motion, so animations are already off.</p>}
      </CardContent>
    </Card>
  );
}

type BrowserPage = 'shopify' | 'shopify-accounts' | 'google-add' | 'google-manage';

/** The ThemeBot browser: its own Chrome profile the setup script signs in with. Lets the user
 *  open it on the account pages to add or remove Google / Shopify accounts, or sign out of all. */
function ThemeBotBrowser() {
  const toast = useToast();
  const [profile, setProfile] = useState<{ exists: boolean; path: string; inUse: boolean } | null>(null);
  const [opening, setOpening] = useState<BrowserPage | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const refresh = () => api.easyProfile().then(setProfile).catch(() => setProfile(null));
  useEffect(() => { void refresh(); }, []);

  const open = async (page: BrowserPage, title: string) => {
    setOpening(page);
    try { await api.easySigninWindow(page); toast.push({ title, detail: 'Look for the new Chrome window.', variant: 'success' }); void refresh(); }
    catch (error) { toast.push({ title: 'Could not open the window', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' }); }
    finally { setOpening(null); }
  };

  const rows: { page: BrowserPage; icon: ReactNode; label: string; help: string; action: string }[] = [
    { page: 'google-add', icon: <UserPlus />, label: 'Add a Google account', help: 'Sign in with another Google account the setup can use.', action: 'Add account' },
    { page: 'google-manage', icon: <UserMinus />, label: 'Remove Google accounts', help: 'See which Google accounts are signed in and remove the ones you don’t want.', action: 'Manage' },
    { page: 'shopify-accounts', icon: <Store />, label: 'Shopify accounts', help: 'Switch, add or log out of Shopify accounts.', action: 'Manage' },
    { page: 'shopify', icon: <Globe />, label: 'Open Shopify admin', help: 'Opens the window on Shopify, the page the setup starts from.', action: 'Open' },
  ];

  return (
    <Card>
      <SectionHeader icon={<Chrome />} title="ThemeBot browser" description="The separate Chrome window ThemeBot signs in with when it sets up your stores. Your everyday Chrome is never touched." />
      <CardContent className="flex flex-col gap-4">
        {profile?.inUse && (
          <p className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3.5 py-2.5 text-[13px] font-semibold leading-relaxed text-warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> The setup is using this browser right now. Wait for it to finish before changing accounts.
          </p>
        )}
        {rows.map((row, index) => (
          <div key={row.page} className="flex flex-col gap-4">
            {index > 0 && <Separator />}
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[15px] font-bold [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">{row.icon} {row.label}</p>
                <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-muted-foreground">{row.help}</p>
              </div>
              <Button size="sm" variant="outline" disabled={opening != null || profile?.inUse} onClick={() => void open(row.page, row.label)}>
                {opening === row.page ? <Spinner /> : <ExternalLink />} {row.action}
              </Button>
            </div>
          </div>
        ))}
        <Separator />
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[15px] font-bold text-destructive [&_svg]:size-4 [&_svg]:shrink-0"><LogOut /> Sign out of everything</p>
            <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-muted-foreground">
              {profile?.exists === false ? 'Nothing is signed in yet.' : 'Starts the ThemeBot browser fresh, signed out of every Google and Shopify account. Close its window first.'}
            </p>
          </div>
          <Button size="sm" variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={!profile?.exists || profile.inUse} onClick={() => setConfirmReset(true)}>Sign out</Button>
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirmReset} destructive title="Sign out of every account?"
        description="The ThemeBot browser forgets all its Google and Shopify sign-ins. Next time you set up a store you'll sign in again. Your stores and builds are not affected."
        confirmLabel="Sign out of everything"
        onCancel={() => setConfirmReset(false)}
        onConfirm={async () => {
          setConfirmReset(false);
          try { await api.easyProfileReset(); toast.push({ title: 'Signed out of everything', detail: 'The ThemeBot browser starts fresh next time.', variant: 'success' }); }
          catch (error) { toast.push({ title: 'Could not sign out', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' }); }
          void refresh();
        }}
      />
    </Card>
  );
}

type SettingsTab = 'accounts' | 'building' | 'quality' | 'advanced';
const TAB_KEY = 'themebot-settings-tab';
const SETTINGS_TABS: { id: SettingsTab; label: string; icon: ReactNode; intro: string }[] = [
  { id: 'accounts', label: 'Accounts', icon: <UserRound />, intro: 'The Google and Shopify accounts ThemeBot signs in with to set up your stores.' },
  { id: 'building', label: 'Speed', icon: <Gauge />, intro: 'Which AI builds your themes and how many stores are built at once.' },
  { id: 'quality', label: 'Quality', icon: <Target />, intro: 'How closely the store must match your website before a build is done.' },
  { id: 'advanced', label: 'Advanced', icon: <SlidersHorizontal />, intro: 'Time limits, system checks and developer options. The defaults suit most people.' },
];

export function SettingsPanel({ jobs, refreshFleet }: { jobs: Job[]; refreshFleet: () => void }) {
  const toast = useToast();
  const [response, setResponse] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<FactorySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [danger, setDanger] = useState<'killAll' | 'clearQueue' | 'reset' | null>(null);
  const [tab, setTab] = useState<SettingsTab>(() => { try { const saved = localStorage.getItem(TAB_KEY); return SETTINGS_TABS.some((entry) => entry.id === saved) ? saved as SettingsTab : 'accounts'; } catch { return 'accounts'; } });
  const chooseTab = (next: SettingsTab) => { setTab(next); try { localStorage.setItem(TAB_KEY, next); } catch { /* per-viewer convenience only */ } };

  useEffect(() => { void api.settings().then((data) => { setResponse(data); setDraft(data.settings); }); }, []);
  if (!response || !draft) return <div className="flex justify-center py-20"><Spinner className="size-7" /></div>;

  const locked = response.locked;
  const set = <K extends keyof FactorySettings>(key: K, value: FactorySettings[K]) => setDraft({ ...draft, [key]: value });
  const dirty = JSON.stringify(draft) !== JSON.stringify(response.settings);

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.saveSettings(draft);
      setResponse((current) => current ? { ...current, settings: saved.settings } : current);
      setDraft(saved.settings);
      toast.push({ title: 'Settings saved', detail: 'They apply straight away.', variant: 'success' });
    } catch (error) { toast.push({ title: 'Save failed', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  const lockNote = (field: string) => locked[field] ? 'Locked: set via environment variable.' : undefined;
  const weightTotal = draft.scoreWeights.presence + draft.scoreWeights.text + draft.scoreWeights.interaction || 1;
  const setWeight = (key: 'presence' | 'text' | 'interaction', value: number) => set('scoreWeights', { ...draft.scoreWeights, [key]: value });

  const activeJobs = jobs.filter((job) => ['scaffolding', 'cloning', 'qa_running', 'fixing'].includes(job.status) || job.running);
  const queuedJobs = jobs.filter((job) => job.status === 'queued');

  const tabMeta = SETTINGS_TABS.find((entry) => entry.id === tab) ?? SETTINGS_TABS[0];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 pb-24">
      <div className="flex flex-col gap-3">
        <Tabs className="settings-tabs" value={tab} onChange={(id) => chooseTab(id as SettingsTab)}
          tabs={SETTINGS_TABS.map((entry) => ({ id: entry.id, label: <>{entry.icon}{entry.label}</> }))} />
        <p className="text-[13.5px] font-medium leading-relaxed text-muted-foreground">{tabMeta.intro}</p>
      </div>

      <div key={tab} className="stagger flex flex-col gap-5">
      {tab === 'accounts' && <ThemeBotBrowser />}

      {tab === 'building' && (<>
      <AnimationsCard />
      <Card>
        <SectionHeader icon={<Bot />} title="Which AI does the work" description="Pick speed or care. Opus is slower but makes the fewest mistakes." />
        <CardContent className="flex flex-col gap-5">
          <Field icon={<Hammer />} label="Building your theme" help="The AI that turns your website into a Shopify theme and fixes what doesn't match.">
            <ModelPicker value={draft.cloneModel} onChange={(model) => set('cloneModel', model)} ariaLabel="Clone and fix model" />
          </Field>
          <Separator />
          <Field icon={<KeyRound />} label="Store setup (AI helper)" help="Only used when you choose “Let the AI bot try instead” during store setup. The normal setup script doesn't use AI.">
            <ModelPicker value={draft.collectorModel} onChange={(model) => set('collectorModel', model)} ariaLabel="Key collector model" />
          </Field>
          {draft.collectorModel !== 'opus' && (
            <p className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3.5 py-2.5 text-[13px] font-semibold leading-relaxed text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              Sonnet and Haiku usually refuse the store-setup job and stop straight away. Keep this on Opus.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<Cpu />} title="How many at once" description="Building more stores together finishes sooner but uses up your AI plan faster." />
        <CardContent className="flex flex-col gap-5">
          <Field icon={<Layers />} label="Stores built at the same time" help={lockNote('concurrency') ?? '2 is a good balance. More than 3 uses up your AI plan quickly.'}>
            <Slider value={draft.concurrency} onValueChange={(value) => set('concurrency', value)} min={1} max={5} disabled={locked.concurrency} />
          </Field>
          <Field icon={<Columns3 />} label="Pages built at once" help="Inside one store, how many pages the AI works on side by side. 2 is a good balance; more finishes a big site sooner but uses up your AI plan faster.">
            <Slider value={draft.pageConcurrency ?? 2} onValueChange={(value) => set('pageConcurrency', value)} min={1} max={4} />
          </Field>
          <Field icon={<Hourglass />} label="Wait between starting builds" help={lockNote('launchStaggerSec') ?? 'Spaces out new builds so they don’t all start at the same moment.'}>
            <Slider value={draft.launchStaggerSec} onValueChange={(value) => set('launchStaggerSec', value)} min={0} max={600} step={10} format={(value) => `${value}s`} disabled={locked.launchStaggerSec} />
          </Field>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-[15px] font-bold [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"><PauseCircle /> Pause when my AI usage limit is reached</p>
              <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-muted-foreground">Waiting builds hold instead of starting and failing one after another.</p>
            </div>
            <Switch checked={draft.pauseQueueOnUsageLimit} onCheckedChange={(value) => set('pauseQueueOnUsageLimit', value)} aria-label="Pause queue on usage limit" />
          </div>
        </CardContent>
      </Card>
      </>)}

      {tab === 'quality' && (<>
      <Card>
        <SectionHeader icon={<Target />} title="When a build counts as done" description="After building, ThemeBot compares the store with your website and fixes differences until it's close enough." />
        <CardContent className="flex flex-col gap-5">
          <Field icon={<Target />} label="Match needed to finish" help="How closely the store must match your website. 92% is recommended; 100% is rarely reachable.">
            <Slider value={draft.defaultScoreThreshold} onValueChange={(value) => set('defaultScoreThreshold', value)} min={0.5} max={1} step={0.01} format={(value) => `${Math.round(value * 100)}%`} />
          </Field>
          <Field icon={<Repeat2 />} label="Most fix rounds per build" help="Each round checks the store and fixes what's off. More rounds can mean a closer match but a longer build.">
            <Slider value={draft.defaultMaxIterations} onValueChange={(value) => set('defaultMaxIterations', value)} min={1} max={10} />
          </Field>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-[15px] font-bold [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"><OctagonPause /> Stop early if it isn't improving</p>
              <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-muted-foreground">Ends the fix rounds when two in a row improve the match by less than {(draft.noProgressEpsilon * 100).toFixed(1)}%.</p>
            </div>
            <Switch checked={draft.earlyStopOnNoProgress} onCheckedChange={(value) => set('earlyStopOnNoProgress', value)} aria-label="Early-stop when stalled" />
          </div>
          {draft.earlyStopOnNoProgress && (
            <Field icon={<TrendingUp />} label="Smallest improvement that counts" help="Below this, a round is treated as “not improving”.">
              <Slider value={draft.noProgressEpsilon} onValueChange={(value) => set('noProgressEpsilon', value)} min={0} max={0.2} step={0.005} format={(value) => `${(value * 100).toFixed(1)}%`} />
            </Field>
          )}
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<ScanSearch />} title="What the match score looks at" description={`How much each check counts. They're balanced automatically on save (now ${Math.round((draft.scoreWeights.presence / weightTotal) * 100)}% / ${Math.round((draft.scoreWeights.text / weightTotal) * 100)}% / ${Math.round((draft.scoreWeights.interaction / weightTotal) * 100)}%).`} />
        <CardContent className="flex flex-col gap-5">
          <Field icon={<LayoutList />} label="Every section is there" help="Does the store have all the parts of your website?">
            <Slider value={draft.scoreWeights.presence} onValueChange={(value) => setWeight('presence', value)} min={0} max={1} step={0.05} format={(value) => value.toFixed(2)} />
          </Field>
          <Field icon={<Type />} label="Same words" help="Does the text match your website word for word?">
            <Slider value={draft.scoreWeights.text} onValueChange={(value) => setWeight('text', value)} min={0} max={1} step={0.05} format={(value) => value.toFixed(2)} />
          </Field>
          <Field icon={<MousePointerClick />} label="Buttons and menus work the same" help="Do links, buttons and menus behave like on your website?">
            <Slider value={draft.scoreWeights.interaction} onValueChange={(value) => setWeight('interaction', value)} min={0} max={1} step={0.05} format={(value) => value.toFixed(2)} />
          </Field>
        </CardContent>
      </Card>
      </>)}

      {tab === 'advanced' && (<>
      <Card>
        <SectionHeader icon={<TimerReset />} title="Time limits" description="If a step runs longer than this, ThemeBot stops it and marks the build “Needs you”. You can press Retry to carry on." />
        <CardContent className="flex flex-col gap-5">
          <Field icon={<Activity />} label="Stop if nothing happens for" help={lockNote('inactivityTimeoutMin') ?? 'Catches a build that has frozen.'}>
            <Slider value={draft.inactivityTimeoutMin} onValueChange={(value) => set('inactivityTimeoutMin', value)} min={5} max={120} format={(value) => `${value}m`} disabled={locked.inactivityTimeoutMin} />
          </Field>
          <Field icon={<Clock3 />} label="Longest first build" help={lockNote('cloneTimeoutMin') ?? 'The first full build of a store.'}>
            <Slider value={draft.cloneTimeoutMin} onValueChange={(value) => set('cloneTimeoutMin', value)} min={30} max={720} step={10} format={(value) => `${value}m`} disabled={locked.cloneTimeoutMin} />
          </Field>
          <Field icon={<Wrench />} label="Longest fix round" help={lockNote('fixTimeoutMin')}>
            <Slider value={draft.fixTimeoutMin} onValueChange={(value) => set('fixTimeoutMin', value)} min={10} max={240} step={5} format={(value) => `${value}m`} disabled={locked.fixTimeoutMin} />
          </Field>
          <Field icon={<Gauge />} label="Longest check" help={lockNote('qaTimeoutMin') ?? 'Comparing the store with your website.'}>
            <Slider value={draft.qaTimeoutMin} onValueChange={(value) => set('qaTimeoutMin', value)} min={5} max={120} step={5} format={(value) => `${value}m`} disabled={locked.qaTimeoutMin} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<ShieldCheck />} title="Privacy & storage" />
        <CardContent className="flex flex-col gap-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-[15px] font-bold [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"><Eraser /> Hide store keys in logs</p>
              <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-muted-foreground">Store passwords and access keys are replaced with *** before anything is saved. Keep this on.</p>
            </div>
            <Switch checked={draft.secretScrub} onCheckedChange={(value) => set('secretScrub', value)} aria-label="Scrub secrets from logs" />
          </div>
          <Field icon={<Camera />} label="Screenshot rounds to keep" help="Older comparison screenshots can be cleaned up to save disk space.">
            <Slider value={draft.keepIterations} onValueChange={(value) => set('keepIterations', value)} min={1} max={20} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<FolderCog />} title="System check" description="Make sure everything ThemeBot needs is installed on this computer." />
        <CardContent className="flex flex-col gap-5">
          <PathCheck label="Builds folder" value={response.paths?.workspaceRoot ?? ''} kind="workspace" />
          <PathCheck label="AI engine program" value={response.paths?.claudePath ?? ''} kind="claude" />
          <PathCheck label="Browser tools" value={response.paths?.playwrightRoot ?? ''} kind="playwright" />
          <BrowserStatus />
          <Separator />
          <QaSelfTest />
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<ListPlus />} title="Developer options" description="Only change these if you know what they do." />
        <CardContent className="flex flex-col gap-5">
          <Field icon={<ListPlus />} label="Extra allowed commands" help="One per line, e.g. Bash(python:*). Added to what each build is allowed to run. The defaults already cover node, npm and curl.">
            <textarea
              value={draft.extraAllow.join('\n')}
              onChange={(event) => set('extraAllow', event.target.value.split('\n').map((entry) => entry.trim()).filter(Boolean))}
              rows={3} spellCheck={false}
              className="w-full rounded-lg border border-input bg-card px-3.5 py-2.5 font-mono text-[13px] font-medium text-foreground shadow-sm transition-all focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </Field>
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <SectionHeader danger icon={<TriangleAlert />} title="Danger zone" description="Each of these asks you to confirm first." />
        <CardContent className="flex flex-wrap gap-2.5">
          <Button variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDanger('killAll')} disabled={!activeJobs.length}>Stop all builds ({activeJobs.length})</Button>
          <Button variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDanger('clearQueue')} disabled={!queuedJobs.length}>Cancel waiting builds ({queuedJobs.length})</Button>
          <Button variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDanger('reset')}>Reset settings to defaults</Button>
        </CardContent>
      </Card>
      </>)}
      </div>

      <div className="sticky bottom-5 z-10 flex justify-end">
        <div className={`flex items-center gap-4 rounded-xl border border-border bg-card/95 py-2 pl-5 pr-2 shadow-xl backdrop-blur transition-all duration-300 ${dirty ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'}`}>
          <span className="text-[13.5px] font-bold text-muted-foreground">Unsaved changes</span>
          <Button onClick={save} disabled={!dirty || saving}>{saving ? <Spinner className="text-primary-foreground" /> : <Save />} Save settings</Button>
        </div>
      </div>

      <ConfirmDialog
        open={danger === 'killAll'} destructive title={`Stop ${activeJobs.length} running build(s)?`}
        description="Every running build stops where it is. You can carry on later with Retry."
        confirmLabel="Stop all"
        onCancel={() => setDanger(null)}
        onConfirm={async () => { setDanger(null); for (const job of activeJobs) await api.pause(job.id).catch(() => {}); toast.push({ title: 'All running jobs paused', variant: 'warning' }); refreshFleet(); }}
      />
      <ConfirmDialog
        open={danger === 'clearQueue'} destructive title={`Cancel ${queuedJobs.length} waiting build(s)?`}
        description="Builds that haven't started yet are canceled. Their files stay on this computer, and running builds carry on."
        confirmLabel="Cancel them"
        onCancel={() => setDanger(null)}
        onConfirm={async () => { setDanger(null); for (const job of queuedJobs) await api.cancel(job.id).catch(() => {}); toast.push({ title: 'Queue cleared', variant: 'warning' }); refreshFleet(); }}
      />
      <ConfirmDialog
        open={danger === 'reset'} destructive title="Reset all settings?"
        description="Every setting goes back to its recommended value. Your accounts and builds are not affected."
        confirmLabel="Reset"
        onCancel={() => setDanger(null)}
        onConfirm={async () => {
          setDanger(null);
          const defaults: Partial<FactorySettings> = { cloneModel: 'opus', collectorModel: 'opus', concurrency: 2, pageConcurrency: 2, launchStaggerSec: 90, inactivityTimeoutMin: 20, cloneTimeoutMin: 240, fixTimeoutMin: 60, qaTimeoutMin: 30, defaultMaxIterations: 5, defaultScoreThreshold: 0.92, scoreWeights: { presence: 0.5, text: 0.3, interaction: 0.2 }, noProgressEpsilon: 0.01, earlyStopOnNoProgress: true, pauseQueueOnUsageLimit: true, keepIterations: 3, secretScrub: true, extraAllow: [] };
          const saved = await api.saveSettings(defaults);
          setResponse((current) => current ? { ...current, settings: saved.settings } : current);
          setDraft(saved.settings);
          toast.push({ title: 'Settings reset to defaults', variant: 'default' });
        }}
      />
    </div>
  );
}
