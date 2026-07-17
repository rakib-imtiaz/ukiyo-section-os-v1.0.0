import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, Cpu, FolderCog, RefreshCw, Save, ScanSearch, ShieldCheck, TimerReset, TriangleAlert, XCircle } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Field, Separator, Slider, Spinner, Switch, useToast } from './ui';
import { api } from './api';
import type { FactorySettings, Job, SettingsResponse } from './types';

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

export function SettingsPanel({ jobs, refreshFleet }: { jobs: Job[]; refreshFleet: () => void }) {
  const toast = useToast();
  const [response, setResponse] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<FactorySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [danger, setDanger] = useState<'killAll' | 'clearQueue' | 'reset' | null>(null);

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
      toast.push({ title: 'Settings saved', detail: 'Applied live — the scheduler re-reads them immediately.', variant: 'success' });
    } catch (error) { toast.push({ title: 'Save failed', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  const lockNote = (field: string) => locked[field] ? 'Locked: set via environment variable.' : undefined;
  const weightTotal = draft.scoreWeights.presence + draft.scoreWeights.text + draft.scoreWeights.interaction || 1;
  const setWeight = (key: 'presence' | 'text' | 'interaction', value: number) => set('scoreWeights', { ...draft.scoreWeights, [key]: value });

  const activeJobs = jobs.filter((job) => ['scaffolding', 'cloning', 'qa_running', 'fixing'].includes(job.status) || job.running);
  const queuedJobs = jobs.filter((job) => job.status === 'queued');

  return (
    <div className="stagger mx-auto flex w-full max-w-2xl flex-col gap-5 pb-24">
      <Card>
        <SectionHeader icon={<Cpu />} title="Execution" description="How many stores run at once and how launches are spaced." />
        <CardContent className="flex flex-col gap-5">
          <Field label="Parallel clone slots" help={lockNote('concurrency') ?? 'Each slot is a full Claude session. 2 is a good balance; >3 burns usage limits fast.'}>
            <Slider value={draft.concurrency} onValueChange={(value) => set('concurrency', value)} min={1} max={5} disabled={locked.concurrency} />
          </Field>
          <Field label="Launch stagger (seconds)" help={lockNote('launchStaggerSec') ?? 'Delay between slot launches so simultaneous clones do not spike token spend.'}>
            <Slider value={draft.launchStaggerSec} onValueChange={(value) => set('launchStaggerSec', value)} min={0} max={600} step={10} format={(value) => `${value}s`} disabled={locked.launchStaggerSec} />
          </Field>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[15px] font-bold">Pause queue on usage limit</p>
              <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-muted-foreground">When a run hits the Claude usage limit, hold all queued jobs instead of burning through them.</p>
            </div>
            <Switch checked={draft.pauseQueueOnUsageLimit} onCheckedChange={(value) => set('pauseQueueOnUsageLimit', value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<TimerReset />} title="Timeouts" description="Watchdogs that kill stalled runs and mark the job blocked (resumable)." />
        <CardContent className="flex flex-col gap-5">
          <Field label="Inactivity watchdog (minutes)" help={lockNote('inactivityTimeoutMin') ?? 'Kill a CLI session with no output for this long.'}>
            <Slider value={draft.inactivityTimeoutMin} onValueChange={(value) => set('inactivityTimeoutMin', value)} min={5} max={120} format={(value) => `${value}m`} disabled={locked.inactivityTimeoutMin} />
          </Field>
          <Field label="Clone wall-clock cap" help={lockNote('cloneTimeoutMin')}>
            <Slider value={draft.cloneTimeoutMin} onValueChange={(value) => set('cloneTimeoutMin', value)} min={30} max={720} step={10} format={(value) => `${value}m`} disabled={locked.cloneTimeoutMin} />
          </Field>
          <Field label="Fix session cap" help={lockNote('fixTimeoutMin')}>
            <Slider value={draft.fixTimeoutMin} onValueChange={(value) => set('fixTimeoutMin', value)} min={10} max={240} step={5} format={(value) => `${value}m`} disabled={locked.fixTimeoutMin} />
          </Field>
          <Field label="QA run cap" help={lockNote('qaTimeoutMin')}>
            <Slider value={draft.qaTimeoutMin} onValueChange={(value) => set('qaTimeoutMin', value)} min={5} max={120} step={5} format={(value) => `${value}m`} disabled={locked.qaTimeoutMin} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<ScanSearch />} title="QA & convergence" description="Defaults for new jobs, and how the composite match score is weighed." />
        <CardContent className="flex flex-col gap-5">
          <Field label="Default max fix iterations">
            <Slider value={draft.defaultMaxIterations} onValueChange={(value) => set('defaultMaxIterations', value)} min={1} max={10} />
          </Field>
          <Field label="Default convergence threshold">
            <Slider value={draft.defaultScoreThreshold} onValueChange={(value) => set('defaultScoreThreshold', value)} min={0.5} max={1} step={0.01} format={(value) => `${Math.round(value * 100)}%`} />
          </Field>
          <Separator />
          <p className="text-[13.5px] font-bold">Score weights <span className="font-semibold text-muted-foreground">(normalized on save — currently {Math.round((draft.scoreWeights.presence / weightTotal) * 100)}% / {Math.round((draft.scoreWeights.text / weightTotal) * 100)}% / {Math.round((draft.scoreWeights.interaction / weightTotal) * 100)}%)</span></p>
          <Field label="Section presence" help="Are all React sections there?">
            <Slider value={draft.scoreWeights.presence} onValueChange={(value) => setWeight('presence', value)} min={0} max={1} step={0.05} format={(value) => value.toFixed(2)} />
          </Field>
          <Field label="Text match" help="Does the copy match, word for word?">
            <Slider value={draft.scoreWeights.text} onValueChange={(value) => setWeight('text', value)} min={0} max={1} step={0.05} format={(value) => value.toFixed(2)} />
          </Field>
          <Field label="Interaction parity" help="Do buttons, links, and menus behave the same?">
            <Slider value={draft.scoreWeights.interaction} onValueChange={(value) => setWeight('interaction', value)} min={0} max={1} step={0.05} format={(value) => value.toFixed(2)} />
          </Field>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[15px] font-bold">Early-stop when stalled</p>
              <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-muted-foreground">Stop the loop after two iterations with less than {(draft.noProgressEpsilon * 100).toFixed(0)}% score movement.</p>
            </div>
            <Switch checked={draft.earlyStopOnNoProgress} onCheckedChange={(value) => set('earlyStopOnNoProgress', value)} />
          </div>
          <Field label="No-progress epsilon" help="Minimum score delta that counts as progress.">
            <Slider value={draft.noProgressEpsilon} onValueChange={(value) => set('noProgressEpsilon', value)} min={0} max={0.2} step={0.005} format={(value) => `${(value * 100).toFixed(1)}%`} />
          </Field>
          <Field label="Keep screenshot iterations" help="Older QA screenshot folders beyond this are eligible for pruning.">
            <Slider value={draft.keepIterations} onValueChange={(value) => set('keepIterations', value)} min={1} max={20} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<FolderCog />} title="Paths & binaries" description="Where workspaces are created and which binaries the factory drives. Overridable via FACTORY_* env vars." />
        <CardContent className="flex flex-col gap-5">
          <PathCheck label="Workspace root" value={response.paths?.workspaceRoot ?? ''} kind="workspace" />
          <PathCheck label="Claude CLI" value={response.paths?.claudePath ?? ''} kind="claude" />
          <PathCheck label="Playwright root" value={response.paths?.playwrightRoot ?? ''} kind="playwright" />
          <BrowserStatus />
        </CardContent>
      </Card>

      <Card>
        <SectionHeader icon={<ShieldCheck />} title="Safety" description="What spawned CLI sessions are allowed to do." />
        <CardContent className="flex flex-col gap-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[15px] font-bold">Scrub secrets from logs</p>
              <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-muted-foreground">Replace shpat_/shpss_/vso_live_ tokens with *** before logs hit disk.</p>
            </div>
            <Switch checked={draft.secretScrub} onCheckedChange={(value) => set('secretScrub', value)} />
          </div>
          <Field label="Extra permission allowlist entries (advanced)" help="One per line, appended to each job's scoped .claude/settings.json — e.g. Bash(python:*). The base allowlist already covers node, npm, curl, and the two project domains.">
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
        <SectionHeader danger icon={<TriangleAlert />} title="Danger zone" description="Irreversible or fleet-wide actions — each asks for confirmation." />
        <CardContent className="flex flex-wrap gap-2.5">
          <Button variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDanger('killAll')} disabled={!activeJobs.length}>Kill all running jobs ({activeJobs.length})</Button>
          <Button variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDanger('clearQueue')} disabled={!queuedJobs.length}>Clear queue ({queuedJobs.length})</Button>
          <Button variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDanger('reset')}>Reset settings to defaults</Button>
        </CardContent>
      </Card>

      <div className="sticky bottom-5 z-10 flex justify-end">
        <div className={`flex items-center gap-4 rounded-xl border border-border bg-card/95 py-2 pl-5 pr-2 shadow-xl backdrop-blur transition-all duration-300 ${dirty ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'}`}>
          <span className="text-[13.5px] font-bold text-muted-foreground">Unsaved changes</span>
          <Button onClick={save} disabled={!dirty || saving}>{saving ? <Spinner className="text-primary-foreground" /> : <Save />} Save settings</Button>
        </div>
      </div>

      <ConfirmDialog
        open={danger === 'killAll'} destructive title={`Kill ${activeJobs.length} running job(s)?`}
        description="Every active Claude CLI session is terminated. Jobs become paused and can be resumed with Retry."
        confirmLabel="Kill all"
        onCancel={() => setDanger(null)}
        onConfirm={async () => { setDanger(null); for (const job of activeJobs) await api.pause(job.id).catch(() => {}); toast.push({ title: 'All running jobs paused', variant: 'warning' }); refreshFleet(); }}
      />
      <ConfirmDialog
        open={danger === 'clearQueue'} destructive title={`Cancel ${queuedJobs.length} queued job(s)?`}
        description="Queued jobs are canceled (their workspaces stay on disk). Running jobs are untouched."
        confirmLabel="Clear queue"
        onCancel={() => setDanger(null)}
        onConfirm={async () => { setDanger(null); for (const job of queuedJobs) await api.cancel(job.id).catch(() => {}); toast.push({ title: 'Queue cleared', variant: 'warning' }); refreshFleet(); }}
      />
      <ConfirmDialog
        open={danger === 'reset'} destructive title="Reset all factory settings?"
        description="Restores every setting to its default (env-locked values stay as the environment defines them)."
        confirmLabel="Reset"
        onCancel={() => setDanger(null)}
        onConfirm={async () => {
          setDanger(null);
          const defaults: Partial<FactorySettings> = { concurrency: 2, launchStaggerSec: 90, inactivityTimeoutMin: 20, cloneTimeoutMin: 240, fixTimeoutMin: 60, qaTimeoutMin: 30, defaultMaxIterations: 5, defaultScoreThreshold: 0.92, scoreWeights: { presence: 0.5, text: 0.3, interaction: 0.2 }, noProgressEpsilon: 0.01, earlyStopOnNoProgress: true, pauseQueueOnUsageLimit: true, keepIterations: 3, secretScrub: true, extraAllow: [] };
          const saved = await api.saveSettings(defaults);
          setResponse((current) => current ? { ...current, settings: saved.settings } : current);
          setDraft(saved.settings);
          toast.push({ title: 'Settings reset to defaults', variant: 'default' });
        }}
      />
    </div>
  );
}
