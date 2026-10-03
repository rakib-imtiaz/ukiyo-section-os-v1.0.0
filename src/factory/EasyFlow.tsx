import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Circle, FileArchive, FolderOpen, Globe, ImageIcon, Loader2, LogIn, RefreshCw, Rocket, ShieldCheck, KeyRound, LayoutTemplate, Sparkles, Store, ThumbsDown, ThumbsUp, Upload, UserCog, XCircle } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Field, Input, Spinner, useToast } from './ui';
import { api } from './api';
import { ActivityFeed } from './ActivityFeed';
import { BuildScene } from './BuildScene';
import { StoryPath, type StoryIcon, type StoryState } from './StoryPath';
import { StoreCheckCard } from './StoreCheckCard';
import { RightsCheck } from './RightsCheck';
import { WatchVideoButton } from '../SetupVideo';
import { BrowserQaSetup, QaChoice } from './QaChoice';
import { FRAMEWORK_LABEL, type EasyRun, type EasyStatus, type FactorySettings, type PreviewRun, type ProjectInfo, type QaEngine } from './types';

/** The one "Build a new store" flow. Four short screens:
 *   1. About your website — name, optional website link, project .zip (or folder). The only
 *      thing everyone must fill in, whichever way the store gets set up.
 *   2. Is this your website? — we run the project (or open the link) and show a picture.
 *   3. Set up the store — the user picks: ThemeBot's script creates + connects the store, or
 *      they do it manually (existing store + keys).
 *   4. Script: Ready to go + Start (then a live progress list). Manual: the store/keys/review
 *      steps, rendered by the caller via renderManual with the website details carried over. */

const DRAFT_KEY = 'factory-easy-draft';
type SetupMode = 'script' | 'manual';
interface EasyDraft { step: number; storeName: string; siteUrl: string; intakeId: string | null; reactFilesPath: string; info: ProjectInfo | null; sourceKind: 'zip' | 'folder'; confirmed: boolean; qaEngine: QaEngine; setupMode: SetupMode; shop?: string | null }
const loadDraft = (): Partial<EasyDraft> | null => { try { const raw = localStorage.getItem(DRAFT_KEY); return raw ? JSON.parse(raw) as Partial<EasyDraft> : null; } catch { return null; } };
export function getEasyDraft(): { name: string; step: number } | null {
  const draft = loadDraft();
  if (!draft) return null;
  if (!(draft.storeName ?? '').trim() && !(draft.siteUrl ?? '').trim() && !draft.reactFilesPath) return null;
  return { name: (draft.storeName ?? '').trim() || 'New store', step: Math.min((draft.step ?? 0) + 1, STEPS.length) };
}
export function clearEasyDraft() { localStorage.removeItem(DRAFT_KEY); }

const STEPS = ['About your website', 'Is this your website?', 'Set up the store', 'Ready to go'];

function Stepper({ step, labels = STEPS }: { step: number; labels?: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-y-3">
      {labels.map((label, index) => (
        <Fragment key={label}>
          {index > 0 && (
            <div className="mx-3 h-0.5 w-8 overflow-hidden rounded-full bg-border sm:w-12" aria-hidden>
              <div className={`h-full origin-left bg-primary transition-transform duration-500 ease-out ${index <= step ? 'scale-x-100' : 'scale-x-0'}`} />
            </div>
          )}
          <div className="flex items-center gap-2.5 px-1 py-0.5" aria-current={index === step ? 'step' : undefined}>
            <span className={`flex size-9 items-center justify-center rounded-full text-[14px] font-bold transition-all duration-300 ${index < step ? 'bg-primary text-primary-foreground' : index === step ? 'bg-primary text-primary-foreground shadow-md ring-4 ring-primary/15' : 'bg-muted text-muted-foreground'}`}>
              {index < step ? <Check className="size-4.5" /> : index + 1}
            </span>
            <span className={`text-[14px] font-bold ${index === step ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</span>
          </div>
        </Fragment>
      ))}
      <span className="ml-auto hidden text-[13px] font-semibold text-muted-foreground sm:block">Step {step + 1} of {STEPS.length}</span>
    </div>
  );
}

/** Drag-and-drop zip intake with upload progress and the detected-project summary. */
function ProjectDrop({ info, reactFilesPath, sourceKind, onUploaded, onClear, onFolder }: {
  info: ProjectInfo | null; reactFilesPath: string; sourceKind: 'zip' | 'folder';
  onUploaded: (result: { intakeId: string; reactFilesPath: string; info: ProjectInfo }) => void;
  onClear: () => void;
  onFolder: (path: string, info: ProjectInfo) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'unpacking'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [folderMode, setFolderMode] = useState(sourceKind === 'folder');
  const [folder, setFolder] = useState(sourceKind === 'folder' ? reactFilesPath : '');
  const [folderBusy, setFolderBusy] = useState(false);

  const upload = async (file: File) => {
    if (!/\.zip$/i.test(file.name)) { setError('Please choose a .zip file (right-click your project folder → Compress / Send to → Compressed folder).'); return; }
    setError(null); setPhase('uploading'); setProgress(0);
    try {
      const result = await api.uploadProject(file, (fraction) => { setProgress(fraction); if (fraction >= 1) setPhase('unpacking'); });
      onUploaded(result);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Upload failed.'); }
    finally { setPhase('idle'); setProgress(null); }
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void upload(file);
  };
  const checkFolder = async () => {
    if (!folder.trim()) return;
    setFolderBusy(true); setError(null);
    try { const result = await api.inspectProject(folder.trim()); onFolder(result.reactFilesPath, result.info); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Folder not found.'); }
    finally { setFolderBusy(false); }
  };

  if (info && reactFilesPath) {
    return (
      <div className="rise-in rounded-xl border border-success/30 bg-success/5 p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-bold text-foreground">Project received{info.name ? `: ${info.name}` : ''}</p>
            <p className="mt-1 text-[13px] font-medium leading-relaxed text-muted-foreground">
              Built with <b className="text-foreground">{FRAMEWORK_LABEL[info.framework]}</b>
              {info.pages.length > 0 ? <> · {info.pages.length} page{info.pages.length === 1 ? '' : 's'} found ({info.pages.slice(0, 6).join(', ')}{info.pages.length > 6 ? ', …' : ''})</> : null}
              {!info.devScript && <span className="text-warning"> · This project has no start command, so ThemeBot will not be able to run it for the preview.</span>}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClear}>Change</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {!folderMode ? (
        <div
          role="button" tabIndex={0} aria-label="Upload your project zip"
          onClick={() => inputRef.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click(); }}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${dragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/30 hover:border-primary/50 hover:bg-primary/[0.03]'}`}
        >
          <input ref={inputRef} type="file" accept=".zip,application/zip" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} />
          {phase === 'idle' ? (
            <>
              <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary"><Upload className="size-5" /></span>
              <p className="text-[14.5px] font-bold text-foreground">Drop your project .zip here, or click to choose it</p>
              <p className="text-[12.5px] font-medium text-muted-foreground">The zip of your website's source code (the folder your developer or AI tool gave you).</p>
            </>
          ) : (
            <>
              <Loader2 className="size-7 animate-spin text-primary" />
              <p className="text-[14px] font-bold text-foreground">{phase === 'uploading' ? `Uploading… ${Math.round((progress ?? 0) * 100)}%` : 'Unpacking and reading your project…'}</p>
              <div className="h-1.5 w-56 overflow-hidden rounded-full bg-border"><div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} /></div>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 p-4">
          <p className="text-[13px] font-bold text-foreground">Folder on this computer</p>
          <div className="flex gap-2">
            <Input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="C:\Users\you\Desktop\my-website" spellCheck={false} />
            <Button variant="outline" onClick={() => void checkFolder()} disabled={!folder.trim() || folderBusy}>{folderBusy ? <Spinner /> : <FolderOpen />} Use folder</Button>
          </div>
        </div>
      )}
      {error && <p className="text-[13px] font-semibold text-destructive">{error}</p>}
      <button type="button" onClick={() => { setFolderMode((value) => !value); setError(null); }} className="self-start text-[12.5px] font-bold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
        {folderMode ? 'Upload a .zip instead' : 'The project is already a folder on this computer'}
      </button>
    </div>
  );
}

const PREVIEW_PHASE_TEXT: Record<PreviewRun['phase'], string> = {
  queued: 'Getting ready…',
  installing: 'Installing what your project needs (first time only — this can take a few minutes)…',
  starting: 'Starting your website…',
  capturing: 'Taking a picture of the home page…',
  done: 'Here is what we found.',
  failed: 'We could not show your website.',
  stopped: 'Stopped.',
};

/** Step 2: run the project (or open the link), show the landing page, ask for a yes/no. */
function PreviewConfirm({ reactFilesPath, siteUrl, canRun, onYes, onNo, onSkip }: { reactFilesPath: string; siteUrl: string; canRun: boolean; onYes: () => void; onNo: () => void; onSkip: () => void }) {
  const [run, setRun] = useState<PreviewRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setInterval> | null = null;
    setRun(null); setError(null);
    const source = reactFilesPath && canRun ? { path: reactFilesPath } : siteUrl ? { url: siteUrl } : null;
    if (!source) { setError('Nothing to preview yet.'); return; }
    void api.startPreview(source).then(({ preview }) => {
      if (!alive) return;
      setRun(preview);
      timer = setInterval(() => {
        void api.previewStatus(preview.id).then(({ preview: next }) => {
          if (!alive) return;
          setRun(next);
          if (['done', 'failed', 'stopped'].includes(next.phase) && timer) { clearInterval(timer); timer = null; }
        }).catch(() => { /* transient */ });
      }, 1500);
    }).catch((caught) => { if (alive) setError(caught instanceof Error ? caught.message : 'Could not start the preview.'); });
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [reactFilesPath, siteUrl, canRun, attempt]);

  const busy = run && !['done', 'failed', 'stopped'].includes(run.phase);
  // Older servers only send plain log lines — show those as simple notes.
  const events = run?.events ?? (run?.log ?? []).map((text, index) => ({ at: Date.now() - (run!.log.length - index) * 1000, kind: 'info' as const, text }));
  const packages = (() => { for (let i = events.length - 1; i >= 0; i -= 1) { const m = events[i].text.match(/^(\d+) packages (in place|installed)/) ?? events[i].text.match(/(\d+) packages installed/); if (m) return Number(m[1]); } return null; })();

  return (
    <Card className="rise-in">
      <CardHeader>
        <CardTitle>Is this your website?</CardTitle>
        <CardDescription>{reactFilesPath && canRun ? 'ThemeBot is running the project you uploaded and taking a picture of its home page, so you can make sure it is the right one.' : 'ThemeBot is opening the link you gave and taking a picture of the home page, so you can make sure it is the right one.'}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
            <p className="flex items-center gap-2 text-[14px] font-bold text-destructive"><XCircle className="size-4.5" /> {error}</p>
          </div>
        )}
        {run && (
          <div className="overflow-hidden rounded-xl border border-border bg-muted/30">
            {run.phase === 'done' && run.hasScreenshot ? (
              <img src={api.previewScreenshotUrl(run.id)} alt="Home page of your website" className="block aspect-[16/10] w-full bg-white object-cover object-top" />
            ) : busy && run.stages ? (
              <BuildScene stages={run.stages} elapsedSec={run.elapsedSec} packages={packages} />
            ) : (
              <div className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-3 p-6 text-center">
                {busy ? <Loader2 className="size-8 animate-spin text-primary" /> : run.phase === 'failed' ? <XCircle className="size-8 text-destructive" /> : <ImageIcon className="size-8 text-muted-foreground" />}
                <p className="text-[14.5px] font-bold text-foreground">{PREVIEW_PHASE_TEXT[run.phase]}</p>
                {busy && <p className="text-[12.5px] font-medium text-muted-foreground">{run.elapsedSec}s so far</p>}
                {run.phase === 'failed' && run.error && <p className="max-w-md text-[13px] font-medium leading-relaxed text-muted-foreground">{run.error}</p>}
              </div>
            )}
            {run.phase === 'done' && run.url && (
              <p className="border-t border-border px-4 py-2.5 text-[12.5px] font-medium text-muted-foreground"><Globe className="mr-1.5 inline size-3.5" />{run.url}</p>
            )}
          </div>
        )}
        {!run && !error && (
          <div className="flex aspect-[16/10] w-full items-center justify-center rounded-xl border border-border bg-muted/30"><Loader2 className="size-8 animate-spin text-primary" /></div>
        )}
        {run && <ActivityFeed events={events} live={Boolean(busy)} />}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg" onClick={onYes} disabled={!run || run.phase !== 'done'}><ThumbsUp /> Yes, that's my website</Button>
          <Button variant="outline" size="lg" onClick={onNo}><ThumbsDown /> No, wrong one</Button>
          {run?.phase === 'failed' && (
            <>
              <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}><RefreshCw /> Try again</Button>
              <Button variant="ghost" onClick={onSkip}>Skip this check</Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Live progress while the server-side orchestrator works through the plain-English steps. */
const STEP_ICON: Record<string, StoryIcon> = { signin: 'window', store: 'bag', app: 'plug', keys: 'key', test: 'check', site: 'compare', clone: 'layout' };

function EasyProgress({ status, onDone, onCancel, onDismiss }: { status: EasyStatus; onDone: () => void; onCancel: () => void; onDismiss: () => void }) {
  const run = status.run!;
  const [opening, setOpening] = useState(false);
  const [resuming, setResuming] = useState(false);
  const toast = useToast();
  const latest = status.collector.log[status.collector.log.length - 1]?.text ?? null;

  const openSignIn = async () => {
    setOpening(true);
    try { if (run.method === 'llm') await api.openInChrome('https://admin.shopify.com/'); else await api.easySigninWindow(); }
    catch (caught) { toast.push({ title: 'Could not open Chrome', detail: caught instanceof Error ? caught.message : undefined, variant: 'destructive' }); }
    finally { setOpening(false); }
  };
  const resume = async (method?: 'scripted' | 'llm') => {
    setResuming(true);
    try { await api.easyResume(method); }
    catch (caught) { toast.push({ title: 'Could not continue', detail: caught instanceof Error ? caught.message : undefined, variant: 'destructive' }); }
    finally { setResuming(false); }
  };

  const headline = run.phase === 'running' ? 'ThemeBot is setting everything up…'
    : run.phase === 'needs_login' ? 'One thing first: your Chrome needs to be ready'
    : run.phase === 'done' ? 'All set — your theme is being built'
    : run.phase === 'canceled' ? 'Setup stopped'
    : 'Something needs your attention';

  return (
    <Card className="rise-in">
      <CardHeader>
        <CardTitle>{headline}</CardTitle>
        <CardDescription>
          {run.phase === 'running' ? `Store "${run.storeName}". A Chrome window opens on this computer and the bot works in it — hands off. If Shopify asks for a sign-in, log in there and the bot carries on by itself.`
            : run.phase === 'needs_login' ? (run.method === 'llm' ? 'The AI bot works inside your own Chrome through its browser extension. It needs Chrome, the extension, and your Shopify sign-in there.' : 'Please sign in to Shopify in the ThemeBot window, then press Continue.')
            : run.phase === 'done' ? `Your store ${run.shop ?? ''} is connected and the build has started. Follow it on the Dashboard.`
            : run.phase === 'canceled' ? 'You stopped the setup. Nothing else was changed — pick up where it left off whenever you like.'
            : run.error ?? 'The setup stopped before finishing.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <StoryPath
          animate={false}
          compact
          states={run.steps.map((step) => step.state as StoryState)}
          steps={run.steps.map((step) => ({
            icon: STEP_ICON[step.id] ?? 'check',
            title: step.label,
            detail: <>
              {step.detail && <span className={step.state === 'failed' ? 'text-destructive' : undefined}>{step.detail}</span>}
              {step.state === 'active' && status.collector.running && latest && <span className="mt-1 block truncate font-mono text-[11.5px] text-muted-foreground/80">› {latest}</span>}
            </>,
          }))}
        />

        <ActivityFeed
          title="What the setup bot is doing"
          live={status.collector.running}
          emptyText="The bot's actions show up here as soon as it starts."
          events={status.collector.log.map((entry) => ({ at: entry.at, kind: entry.kind === 'action' ? 'cmd' as const : entry.kind === 'system' ? 'step' as const : 'info' as const, text: entry.text }))}
        />

        {run.phase === 'needs_login' && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/5 p-4">
            {run.method === 'llm'
              ? <p className="w-full text-[13px] font-medium leading-relaxed text-muted-foreground">Open Shopify in Chrome, log in like you normally would, then press <b className="text-foreground">Continue</b>. If the Chrome setup was never confirmed, go back and finish it first.</p>
              : <ol className="w-full list-decimal pl-5 text-[13px] font-medium leading-relaxed text-muted-foreground">
                  <li>Press <b className="text-foreground">Open the sign-in window</b> — a normal Chrome window opens (ThemeBot's own profile, nothing is controlling it).</li>
                  <li>Sign in to Shopify there the way you always do — Google sign-in works.</li>
                  <li><b className="text-foreground">Close that window</b>, then press <b className="text-foreground">I've signed in — continue</b>. You only do this once.</li>
                </ol>}
            <Button onClick={() => void openSignIn()} disabled={opening}>{opening ? <Spinner className="text-primary-foreground" /> : <LogIn />} {run.method === 'llm' ? 'Open Shopify in Chrome' : 'Open the sign-in window'}</Button>
            <Button variant="outline" onClick={() => void resume()} disabled={resuming}>{resuming ? <Spinner /> : <RefreshCw />} I've signed in — continue</Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {run.phase === 'done' && <Button size="lg" onClick={onDone}><Rocket /> Go to the Dashboard</Button>}
          {(run.phase === 'running' || run.phase === 'needs_login') && <Button variant="ghost" onClick={onCancel}>Stop the setup</Button>}
          {(run.phase === 'failed' || run.phase === 'canceled') && <Button onClick={() => void resume()} disabled={resuming}>{resuming ? <Spinner className="text-primary-foreground" /> : <RefreshCw />} {run.shop ? 'Continue from where it stopped' : 'Try again'}</Button>}
          {run.phase === 'failed' && run.method !== 'llm' && <Button variant="outline" onClick={() => void resume('llm')} disabled={resuming} title="Uses the AI bot in your own Chrome instead of the script — slower, but copes with Shopify page changes.">Let the AI bot try instead</Button>}
          {run.phase === 'failed' && run.method === 'llm' && <Button variant="outline" onClick={() => void resume('scripted')} disabled={resuming}>Back to the fast script</Button>}
          {(run.phase === 'failed' || run.phase === 'canceled') && <Button variant="outline" onClick={onDismiss}><ArrowLeft /> Back to the form</Button>}
        </div>
      </CardContent>
    </Card>
  );
}

export interface ManualHandoff { name: string; reactUrl: string; reactFilesPath: string; onBack: () => void }

export function EasyFlow({ onCreated, onCancel, renderManual }: {
  onCreated: () => void; onCancel: () => void; onOpenBrowser?: () => void;
  /** Renders the manual store + keys steps with the website details from step 1 carried over. */
  renderManual?: (handoff: ManualHandoff) => ReactNode;
}) {
  const toast = useToast();
  const [stored] = useState(loadDraft);
  const [step, setStep] = useState(stored?.step ?? 0);
  const [storeName, setStoreName] = useState(stored?.storeName ?? '');
  const [siteUrl, setSiteUrl] = useState(stored?.siteUrl ?? '');
  const [intakeId, setIntakeId] = useState<string | null>(stored?.intakeId ?? null);
  const [reactFilesPath, setReactFilesPath] = useState(stored?.reactFilesPath ?? '');
  const [info, setInfo] = useState<ProjectInfo | null>(stored?.info ?? null);
  const [sourceKind, setSourceKind] = useState<'zip' | 'folder'>(stored?.sourceKind ?? 'zip');
  const [confirmed, setConfirmed] = useState(stored?.confirmed ?? false);
  const [qaEngine, setQaEngine] = useState<QaEngine>(stored?.qaEngine ?? 'playwright');
  const [setupMode, setSetupMode] = useState<SetupMode>(stored?.setupMode === 'manual' ? 'manual' : 'script');
  // A store an earlier attempt already created — Start then skips store creation (never a duplicate).
  const [knownShop, setKnownShop] = useState<string | null>(stored?.shop ?? null);
  // Reusing a store needs a one-click "yes, that's the right one" (never persisted — asked each time).
  const [shopConfirmed, setShopConfirmed] = useState(false);
  const [newStore, setNewStore] = useState(false);
  useEffect(() => { setShopConfirmed(false); }, [knownShop]);
  const [settings, setSettings] = useState<FactorySettings | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState<EasyStatus | null>(null);
  const [discardConfirm, setDiscardConfirm] = useState(false);

  useEffect(() => {
    const draft: EasyDraft = { step, storeName, siteUrl, intakeId, reactFilesPath, info, sourceKind, confirmed, qaEngine, setupMode, shop: knownShop };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [step, storeName, siteUrl, intakeId, reactFilesPath, info, sourceKind, confirmed, qaEngine, setupMode, knownShop]);
  useEffect(() => { void api.settings().then((response) => setSettings(response.settings)).catch(() => {}); }, []);
  useEffect(() => {
    if (step !== 3 || knownShop || newStore || storeName.trim().length < 2) return;
    let alive = true;
    void api.easyRememberedStore(storeName.trim()).then(({ shop }) => { if (alive && shop) setKnownShop(shop); }).catch(() => {});
    return () => { alive = false; };
  }, [step, knownShop, newStore, storeName]);

  // Re-attach to a server-side run (page reload, tab switch) and poll while it works.
  useEffect(() => {
    let alive = true;
    const tick = () => api.easyStatus().then((next) => { if (alive) setStatus(next.run ? next : null); }).catch(() => { /* server unreachable — keep the last state */ });
    void tick();
    const timer = setInterval(() => { if (!document.hidden) void tick(); }, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const urlValid = !siteUrl.trim() || (() => { try { const url = new URL(siteUrl.trim()); return /^https?:$/.test(url.protocol); } catch { return false; } })();
  const hasSource = Boolean(siteUrl.trim()) || Boolean(reactFilesPath);
  const step1Ready = storeName.trim().length >= 2 && urlValid && hasSource;
  const canRunProject = Boolean(reactFilesPath && info?.devScript);
  const canPreview = canRunProject || Boolean(siteUrl.trim());
  // Both the store creation and the optional Chrome QA ride on the same one-time Chrome setup.
  // The setup itself runs in ThemeBot's own browser window — the Chrome + Claude setup is only
  // needed when the user picks "Check in my Chrome with Claude" for the build checks.
  const chromeSetupMissing = qaEngine === 'chrome' && !settings?.browserQaSetup?.done;

  const goNext = () => {
    if (step === 0) {
      if (!step1Ready) { setAttempted(true); return; }
      setAttempted(false);
      // Nothing we can show a picture of → jump straight to the store-setup choice.
      setStep(canPreview ? 1 : 2);
      return;
    }
    setStep((value) => Math.min(STEPS.length - 1, value + 1));
  };

  const reset = () => {
    localStorage.removeItem(DRAFT_KEY);
    setStep(0); setStoreName(''); setSiteUrl(''); setIntakeId(null); setReactFilesPath(''); setInfo(null); setSourceKind('zip'); setConfirmed(false); setAttempted(false); setSetupMode('script'); setKnownShop(null); setNewStore(false);
  };
  const dirty = Boolean(storeName || siteUrl || reactFilesPath || step > 0);

  const [rightsOk, setRightsOk] = useState(false);
  const start = async () => {
    setStarting(true);
    try {
      const next = await api.easyStart({ storeName: storeName.trim(), siteUrl: siteUrl.trim() || undefined, reactFilesPath: reactFilesPath || undefined, intakeId: intakeId ?? undefined, qaEngine, shop: knownShop ?? undefined, newStore: newStore || undefined, rightsConfirmed: rightsOk });
      setStatus(next);
      localStorage.removeItem(DRAFT_KEY);
    } catch (caught) {
      toast.push({ title: 'Could not start', detail: caught instanceof Error ? caught.message : undefined, variant: 'destructive' });
    } finally { setStarting(false); }
  };

  if (status?.run) {
    return (
      <div className="relative mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="rise-in">
          <h2 className="text-2xl font-bold tracking-tight">Setting up "{status.run.storeName}"</h2>
          <p className="mt-1 text-[14.5px] font-medium leading-relaxed text-muted-foreground">Sit back — ThemeBot does the store, the connection, and the build. It only stops if it needs you to sign in.</p>
        </div>
        <EasyProgress
          status={status}
          onDone={() => { void api.easyDismiss(); setStatus(null); reset(); onCreated(); }}
          onCancel={() => { void api.easyCancel().then(() => api.easyStatus()).then((next) => setStatus(next.run ? next : null)).catch(() => {}); }}
          onDismiss={() => { if (status.run?.shop) setKnownShop(status.run.shop); void api.easyDismiss(); setStatus(null); }}
        />
      </div>
    );
  }

  return (
    <div className="relative mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="rise-in">
        <h2 className="text-2xl font-bold tracking-tight">Build a Shopify store from your website</h2>
        <p className="mt-1 text-[14.5px] font-medium leading-relaxed text-muted-foreground">Give your project a name and your website. Then ThemeBot sets up the Shopify store for you — or you connect one yourself — and builds the theme.</p>
        <div className="mt-4"><WatchVideoButton label="Watch how it works" /></div>
      </div>

      <Stepper step={step} labels={setupMode === 'manual' ? [...STEPS.slice(0, 3), 'Connect your store'] : STEPS} />

      {step === 0 && (
        <Card key="easy-0" className="rise-in">
          <CardHeader>
            <CardTitle>About your website</CardTitle>
            <CardDescription>The only thing you have to fill in. You choose how the Shopify store is set up in a moment.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <Field label="What should the store be called?" icon={<Store />} error={attempted && storeName.trim().length < 2 ? 'Give your store a name.' : null} help="This becomes the name of your Shopify store and of this project.">
              <Input value={storeName} onChange={(event) => setStoreName(event.target.value)} placeholder="Wild & Sacred" autoFocus aria-invalid={attempted && storeName.trim().length < 2 || undefined} />
            </Field>
            <Field label="Link to your website (optional)" icon={<Globe />} error={siteUrl && !urlValid ? 'That does not look like a web address — it should start with https://' : null} help="If the website is already online somewhere, paste its address. ThemeBot compares its work against it.">
              <Input value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} placeholder="https://my-website.vercel.app" inputMode="url" aria-invalid={(!!siteUrl && !urlValid) || undefined} />
            </Field>
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-2 text-[13px] font-bold leading-none tracking-tight text-foreground"><FileArchive className="size-4 text-muted-foreground" /> Your website's files{siteUrl.trim() ? ' (optional)' : ''}</p>
              <ProjectDrop
                info={info} reactFilesPath={reactFilesPath} sourceKind={sourceKind}
                onUploaded={(result) => { setIntakeId(result.intakeId); setReactFilesPath(result.reactFilesPath); setInfo(result.info); setSourceKind('zip'); setConfirmed(false); }}
                onFolder={(path, projectInfo) => { setIntakeId(null); setReactFilesPath(path); setInfo(projectInfo); setSourceKind('folder'); setConfirmed(false); }}
                onClear={() => { setIntakeId(null); setReactFilesPath(''); setInfo(null); setConfirmed(false); }}
              />
              {attempted && !hasSource && <p className="text-[13px] font-semibold text-destructive">Add a website link or upload your project files (or both).</p>}
              {!attempted && <p className="text-[13px] font-medium leading-relaxed text-muted-foreground">ThemeBot runs your project on this computer to see exactly how it should look.</p>}
            </div>
          </CardContent>
        </Card>
      )}

      {step === 1 && (
        <PreviewConfirm
          reactFilesPath={reactFilesPath} siteUrl={siteUrl.trim()} canRun={canRunProject}
          onYes={() => { setConfirmed(true); setStep(2); }}
          onNo={() => { setConfirmed(false); setStep(0); toast.push({ title: 'No problem', detail: 'Upload the right project (or fix the link) and try again.', variant: 'default' }); }}
          onSkip={() => { setConfirmed(false); setStep(2); }}
        />
      )}

      {step === 2 && (
        <Card key="easy-choice" className="rise-in">
          <CardHeader>
            <CardTitle>How should the Shopify store be set up?</CardTitle>
            <CardDescription>Your website is ready. Now the store it goes into.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="setup-choice grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="How should the store be set up?">
              <button type="button" role="radio" aria-checked={setupMode === 'script'} onClick={() => setSetupMode('script')} className={`setup-choice__card${setupMode === 'script' ? ' is-on' : ''}`}>
                <span className="setup-choice__top"><span className="setup-choice__icon"><Sparkles className="size-5" /></span><em>Recommended</em></span>
                <b>Let ThemeBot do it</b>
                <span>ThemeBot opens its own browser window, creates a new Shopify store called <strong>{storeName.trim() || 'your store'}</strong>, connects it and saves the keys. You only sign in to Shopify once.</span>
                <ul><li><Check className="size-3.5" /> No store yet? No problem.</li><li><Check className="size-3.5" /> No card, no technical steps.</li></ul>
              </button>
              <button type="button" role="radio" aria-checked={setupMode === 'manual'} onClick={() => setSetupMode('manual')} className={`setup-choice__card${setupMode === 'manual' ? ' is-on' : ''}`}>
                <span className="setup-choice__top"><span className="setup-choice__icon"><UserCog className="size-5" /></span></span>
                <b>I'll do it manually</b>
                <span>You already have a store and its connection app. Paste the store address and the two app keys yourself.</span>
                <ul><li><Check className="size-3.5" /> Works with any existing store.</li><li><Check className="size-3.5" /> Step-by-step guide included.</li></ul>
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 3 && setupMode === 'manual' && renderManual?.({ name: storeName.trim(), reactUrl: siteUrl.trim(), reactFilesPath, onBack: () => setStep(2) })}

      {step === 3 && setupMode === 'script' && (
        <Card key="easy-2" className="rise-in">
          <CardHeader>
            <CardTitle>Ready to go</CardTitle>
            <CardDescription>Press Start and ThemeBot does the rest in its own browser window. The first time only, sign in to Shopify when it asks.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <QaChoice value={qaEngine} onChange={setQaEngine} settings={settings} onSettingsChange={setSettings} hideSetup />
            {qaEngine === 'chrome' && <BrowserQaSetup settings={settings} onSettingsChange={setSettings} />}
            {knownShop && (
              <StoreCheckCard
                shop={knownShop}
                confirmed={shopConfirmed}
                onUse={() => setShopConfirmed(true)}
                onNew={() => { setKnownShop(null); setNewStore(true); }}
                onChange={() => setShopConfirmed(false)}
              />
            )}
            <div className="ready-steps">
              <p className="ready-steps__label">What happens next</p>
              <ol className="next-steps">
                {[
                  { icon: <Store />, text: knownShop ? <>Use your store <b>{knownShop}</b></> : <>Create the store <b>{storeName.trim() || '…'}</b></> },
                  { icon: <KeyRound />, text: 'Connect ThemeBot to it' },
                  { icon: <CheckCircle2 />, text: 'Test the connection' },
                  { icon: <Globe />, text: 'Compare with your website' },
                  { icon: <LayoutTemplate />, text: 'Build your Shopify theme' },
                ].map((item, index) => (
                  <li key={index} style={{ ['--i' as string]: index }}>
                    <span className="next-steps__icon">{item.icon}</span>
                    <span className="next-steps__text">{item.text}</span>
                    <span className="next-steps__num">{index + 1}</span>
                  </li>
                ))}
              </ol>
              {!confirmed && canPreview && <p className="mt-2 text-[12.5px] font-semibold text-warning">You skipped the "is this your website?" check.</p>}
            </div>
            <p className="ready-note"><ShieldCheck className="size-4" /> No card needed, and your other stores are never touched.</p>
          </CardContent>
        </Card>
      )}

      {step === 3 && setupMode !== 'manual' && <RightsCheck checked={rightsOk} onChange={setRightsOk} />}

      {!(step === 3 && setupMode === 'manual') && <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => { if (dirty) setDiscardConfirm(true); else { reset(); onCancel(); } }}>Cancel</Button>
          {step > 0 && <Button variant="ghost" onClick={() => setStep((value) => (value === 2 && !canPreview ? 0 : Math.max(0, value - 1)))}><ArrowLeft /> Back</Button>}
        </div>
        {step < 3
          ? <Button onClick={goNext}>{step === 2 ? (setupMode === 'script' ? 'Next' : 'Continue manually') : 'Next'} <ArrowRight /></Button>
          : <Button size="lg" onClick={() => void start()} disabled={starting || chromeSetupMissing || (Boolean(knownShop) && !shopConfirmed) || !rightsOk} title={chromeSetupMissing ? 'Finish the one-time Chrome setup first' : knownShop && !shopConfirmed ? 'Confirm the store above first' : !rightsOk ? 'Confirm you have the rights to this site first' : undefined}>{starting ? <Spinner className="text-primary-foreground" /> : <Rocket />} Start — do it for me</Button>}
      </div>}

      <ConfirmDialog
        open={discardConfirm}
        title="Throw away what you entered?"
        description="The store name, link, and uploaded project are cleared. You can start again any time."
        confirmLabel="Throw it away" destructive
        onCancel={() => setDiscardConfirm(false)}
        onConfirm={() => { setDiscardConfirm(false); reset(); onCancel(); }}
      />
    </div>
  );
}
