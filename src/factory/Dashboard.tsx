import { useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Factory, FolderOpen, MoreVertical, PencilLine, PlayCircle, Timer, X } from 'lucide-react';
import { Badge, Button, ConfirmDialog, DropdownMenu, EmptyState, LiveDot, Progress, Skeleton, useToast, type BusyStep } from './ui';
import { FlipNumber, ScoreRing, Sparkline, SpotlightCard } from './fx';
import { api } from './api';
import { clearWizardDraft, getWizardDraft } from './NewJobWizard';
import { STATUS_META, TERMINAL, plainDetail, type Job, type SchedulerStatus } from './types';
import { ProjectThumb } from '../ProjectThumb';

const ACTIVE_STATUSES = ['scaffolding', 'cloning', 'qa_running', 'fixing'];
const LEAVE_MS = 420;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Walks a list of step labels while `work` runs, so a fast API call still reads as
 *  deliberate progress (each step shows at least ~350ms) and a slow one never looks frozen. */
async function runSteps(labels: string[], work: () => Promise<unknown>, onStep: (steps: BusyStep[]) => void) {
  const show = (index: number) => onStep(labels.map((label, i) => ({ label, state: i < index ? 'done' : i === index ? 'active' : 'todo' })));
  show(0);
  const job = work();
  for (let index = 1; index < labels.length; index += 1) { await wait(380); show(index); }
  await job;
  await wait(320);
  onStep(labels.map((label) => ({ label, state: 'done' })));
  await wait(360);
}

function elapsed(job: Job) {
  const start = job.started_at ?? job.created_at;
  const end = job.finished_at ?? new Date().toISOString();
  const minutes = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

type StatFilter = 'running' | 'queued' | 'converged' | 'attention';

function StatTile({ icon, label, value, alert, active, onClick }: { icon: React.ReactNode; label: string; value: number; alert?: boolean; active?: boolean; onClick?: () => void }) {
  return (
    <SpotlightCard
      className={`stat-tile flex items-center justify-between gap-2 p-4 sm:gap-3 sm:p-5${active ? ' is-active' : ''}`}
      role="button" tabIndex={0} aria-pressed={active} title={active ? 'Show all builds' : `Show only: ${label.toLowerCase()}`}
      onClick={onClick}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick?.(); } }}
    >
      <div className="min-w-0">
        <p className="text-[10.5px] font-bold uppercase leading-snug tracking-[0.08em] text-muted-foreground sm:text-xs sm:tracking-[0.12em]">{label}</p>
        <p className="mt-2 text-3xl font-bold leading-none tracking-tight">
          <FlipNumber value={value} />
        </p>
      </div>
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-xl border [&_svg]:size-4 sm:size-11 sm:[&_svg]:size-5 ${alert && value > 0 ? 'border-warning/30 bg-warning/10 text-warning' : 'border-border bg-muted text-foreground'}`}>
        {icon}
      </div>
    </SpotlightCard>
  );
}

function JobCard({ job, onOpen, menuItems }: { job: Job; onOpen: () => void; menuItems: React.ComponentProps<typeof DropdownMenu>['items'] }) {
  const meta = STATUS_META[job.status] ?? { label: job.status, tone: 'secondary' as const };
  const running = ACTIVE_STATUSES.includes(job.status) || job.running;
  const detail = job.status_detail
    ? plainDetail(job.status_detail)
    : `${job.react_url.replace(/^https?:\/\//, '')} → ${job.store_url.replace('https://', '')}`;
  return (
    <SpotlightCard live={running} className="build-card flex flex-col" role="link" tabIndex={0} aria-label={`Open ${job.name}`}
      onClick={onOpen} onKeyDown={(event) => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); onOpen(); } }}>
      <div className="build-card__media">
        <ProjectThumb path={job.workspace_path} name={job.name} />
        <span className="build-card__status"><Badge variant={meta.tone}>{running && <LiveDot className="size-1.5" />}{meta.label}</Badge></span>
        {job.last_score != null && <span className="build-card__score" title="How closely the store matches your website"><ScoreRing value={job.last_score} size={44} stroke={4} /></span>}
      </div>

      <div className="flex items-start gap-2 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-[17px] font-bold tracking-tight">{job.name}<ArrowRight className="build-card__arrow size-4 shrink-0 text-muted-foreground" /></p>
          <p className="mt-1 truncate text-[13.5px] font-medium text-muted-foreground">{detail}</p>
        </div>
        <div onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <DropdownMenu trigger={<MoreVertical className="size-4.5" />} label={`Actions for ${job.name}`} items={menuItems} />
        </div>
      </div>

      {job.last_score != null && job.score_history.length > 1 && (
        <div className="flex items-center gap-3 px-4 pt-3">
          <Progress value={job.last_score} active={running} className="flex-1" />
          <Sparkline history={job.score_history} width={80} height={22} className="text-muted-foreground" />
        </div>
      )}

      <div className="mt-auto flex items-center gap-4 px-4 pb-3.5 pt-3 text-[12.5px] font-semibold text-muted-foreground">
        {/* What differs per build: where it is, how close it matches (once checked), time spent. */}
        <span className="text-foreground">
          {job.status === 'converged' ? 'Finished'
            : ['canceled', 'failed', 'aborted'].includes(job.status) ? 'Stopped'
            : job.iteration > 0 && job.auto_qa ? <>Round <span className="tabular-nums">{job.iteration} of {job.max_iterations}</span></>
            : 'First build'}
        </span>
        {job.last_score != null && (
          <span title={`Stops once the store matches your website this closely: ${Math.round(job.score_threshold * 100)}%`}>
            Match <span className={`tabular-nums ${job.last_score >= job.score_threshold ? 'text-success' : 'text-foreground'}`}>{Math.round(job.last_score * 100)}%</span>
            <span className="tabular-nums"> / {Math.round(job.score_threshold * 100)}%</span>
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1 tabular-nums"
          title={`Latest run: started ${new Date(job.started_at ?? job.created_at).toLocaleString()}${job.finished_at ? `, ended ${new Date(job.finished_at).toLocaleString()}` : ''}. Rebuild starts the clock again.`}>
          <Timer className="size-3.5" />{running ? `${elapsed(job)} so far` : `last run ${elapsed(job)}`}
        </span>
      </div>
    </SpotlightCard>
  );
}

export function Dashboard({ jobs, scheduler, loading, onOpen, onNew, refresh }: {
  jobs: Job[]; scheduler: SchedulerStatus | null; loading: boolean;
  onOpen: (id: string) => void; onNew: () => void; refresh: () => void;
}) {
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ kind: 'cancel' | 'delete'; job: Job } | null>(null);
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState<{ label: string; steps: BusyStep[] } | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());

  const deleteJob = async (job: Job, purgeNow: boolean) => {
    const labels = ['Stopping anything still running', 'Removing the build history', ...(purgeNow ? ['Deleting the project folder'] : []), 'Tidying up'];
    try {
      await runSteps(labels, () => api.remove(job.id, purgeNow), (steps) => setBusy({ label: 'Deleting…', steps }));
      setConfirm(null); setBusy(null);
      setLeaving((current) => new Set(current).add(job.id));   // card collapses out
      await wait(LEAVE_MS);
      refresh();
      toast.push({ title: `“${job.name}” deleted`, detail: purgeNow ? 'The build and its project folder are gone.' : 'The build and its history are gone. The project folder is kept.', variant: 'success' });
    } catch (error) {
      setBusy(null); setConfirm(null);
      toast.push({ title: 'Could not delete the build', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    } finally {
      setTimeout(() => setLeaving((current) => { const next = new Set(current); next.delete(job.id); return next; }), 1500);
    }
  };

  const cancelJob = async (job: Job) => {
    try {
      await runSteps(['Telling ThemeBot to stop', 'Saving what was already built', 'Stopped'], () => api.cancel(job.id), (steps) => setBusy({ label: 'Stopping…', steps }));
      setConfirm(null); setBusy(null); refresh();
      toast.push({ title: `“${job.name}” stopped`, detail: 'Anything already built on the draft theme is kept.', variant: 'success' });
    } catch (error) {
      setBusy(null); setConfirm(null);
      toast.push({ title: 'Could not stop the build', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    }
  };
  // In-progress wizard draft (localStorage) — surfaced so a refresh never hides where you left off.
  const [draft, setDraft] = useState(getWizardDraft);

  const act = async (label: string, action: () => Promise<unknown>) => {
    try { await action(); toast.push({ title: label, variant: 'default' }); refresh(); }
    catch (error) { toast.push({ title: `${label} failed`, detail: error instanceof Error ? error.message : undefined, variant: 'destructive' }); }
  };

  const groups: Record<StatFilter, (job: Job) => boolean> = {
    running: (job) => ACTIVE_STATUSES.includes(job.status),
    queued: (job) => job.status === 'queued',
    converged: (job) => job.status === 'converged',
    attention: (job) => ['blocked', 'exhausted', 'failed', 'aborted'].includes(job.status),
  };
  const counts = {
    running: jobs.filter(groups.running).length,
    queued: jobs.filter(groups.queued).length,
    converged: jobs.filter(groups.converged).length,
    attention: jobs.filter(groups.attention).length,
  };
  // Clicking a stat tile shows only those builds; clicking it again shows all.
  const [filter, setFilter] = useState<StatFilter | null>(null);
  const toggleFilter = (next: StatFilter) => setFilter((current) => (current === next ? null : next));
  const shown = filter ? jobs.filter(groups[filter]) : jobs;
  const FILTER_LABEL: Record<StatFilter, string> = { running: 'building', queued: 'waiting', converged: 'done', attention: 'needing you' };

  if (loading) {
    return (
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-24 w-full" />)}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-36 w-full" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {scheduler?.queuePaused && (
        <div className="rise-in flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/5 px-5 py-3.5">
          <p className="flex items-center gap-2.5 text-[14px] font-semibold text-warning">
            <AlertTriangle className="size-4.5 shrink-0" />
            {scheduler.queuePausedReason ?? 'Queue paused.'}
          </p>
          <Button size="sm" variant="outline" onClick={() => act('Queue resumed', api.resumeQueue)}>Resume queue</Button>
        </div>
      )}

      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile icon={<PlayCircle />} label="Building" value={counts.running} active={filter === 'running'} onClick={() => toggleFilter('running')} />
        <StatTile icon={<Timer />} label="Waiting" value={counts.queued} active={filter === 'queued'} onClick={() => toggleFilter('queued')} />
        <StatTile icon={<CheckCircle2 />} label="Done" value={counts.converged} active={filter === 'converged'} onClick={() => toggleFilter('converged')} />
        <StatTile icon={<AlertTriangle />} label="Needs you" value={counts.attention} alert active={filter === 'attention'} onClick={() => toggleFilter('attention')} />
      </div>

      {filter && jobs.length > 0 && (
        <div className="stat-filter rise-in">
          <span>Showing {shown.length} {shown.length === 1 ? 'build' : 'builds'} {FILTER_LABEL[filter]}</span>
          <button type="button" onClick={() => setFilter(null)}><X className="size-3.5" /> Show all</button>
        </div>
      )}

      {draft && (
        <SpotlightCard className="rise-in flex flex-wrap items-center gap-3.5 border-primary/30 p-4">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
            <PencilLine className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-bold tracking-tight">Draft in progress — “{draft.name}”</p>
            <p className="mt-0.5 text-[13px] font-medium text-muted-foreground">You left off on step {draft.step} of 3. Everything you entered is saved locally.</p>
          </div>
          <Button onClick={onNew}>Resume where I left off <ArrowRight /></Button>
          <Button variant="ghost" onClick={() => { clearWizardDraft(); setDraft(null); }}>Discard draft</Button>
        </SpotlightCard>
      )}

      {!jobs.length ? (
        <EmptyState
          icon={<Factory />}
          title={draft ? 'No builds yet — but your draft is ready' : 'No builds yet'}
          description={draft ? 'Resume the draft above to finish setting up your first build.' : 'Give ThemeBot a website and a name. It creates the Shopify store, connects it, and rebuilds your website as a Shopify theme.'}
          action={<Button size="lg" onClick={onNew}>{draft ? 'Resume draft' : 'Build a new store'}</Button>}
        />
      ) : (
        <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filter && !shown.length && <p className="col-span-full rounded-xl border border-dashed border-border p-6 text-center text-[13.5px] font-medium text-muted-foreground">No builds {FILTER_LABEL[filter]} right now.</p>}
          {shown.map((job) => (
            <div key={job.id} className={`job-slot${leaving.has(job.id) ? ' is-leaving' : ''}`}>
            <JobCard
              key={job.id}
              job={job}
              onOpen={() => onOpen(job.id)}
              menuItems={[
                { label: 'Open details', onSelect: () => onOpen(job.id) },
                { label: 'Rebuild from the start', onSelect: () => act('Rebuilding', () => api.rebuild(job.id)), disabled: job.running || !['canceled', 'converged', 'exhausted', 'failed', 'aborted'].includes(job.status), title: 'Start a finished or cancelled build again, on the same store' },
                { label: 'Retry / resume', onSelect: () => act('Job re-queued', () => api.retry(job.id)), disabled: !['blocked', 'paused', 'exhausted', 'failed', 'aborted'].includes(job.status), title: 'Available for blocked, paused, exhausted, failed, or aborted jobs' },
                { label: 'Pause', onSelect: () => act('Job paused', () => api.pause(job.id)), disabled: !job.running && job.status !== 'queued' },
                { label: 'Stop', onSelect: () => setConfirm({ kind: 'cancel', job }), destructive: true, disabled: TERMINAL.includes(job.status) },
                { label: 'Delete', onSelect: () => { setPurge(false); setConfirm({ kind: 'delete', job }); }, destructive: true, disabled: !TERMINAL.includes(job.status) && job.status !== 'paused', title: 'Stop the build first' },
              ]}
            />
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirm?.kind === 'cancel'}
        title={`Stop “${confirm?.job.name}”?`}
        description="ThemeBot stops working on this store. Anything already built on the draft theme is kept, and you can delete the build afterwards."
        confirmLabel="Stop build" destructive
        busy={confirm?.kind === 'cancel' ? busy : null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm) void cancelJob(confirm.job); }}
      />
      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        title={`Delete “${confirm?.job.name}”?`}
        description="Removes this build and its history from ThemeBot. Your Shopify store and its draft theme are not touched."
        confirmLabel="Delete build" destructive
        busy={confirm?.kind === 'delete' ? busy : null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm) void deleteJob(confirm.job, purge); }}
      >
        <label className="flex cursor-pointer items-center gap-2.5 text-[14px] font-semibold">
          <input type="checkbox" checked={purge} onChange={(event) => setPurge(event.target.checked)} className="size-4.5 accent-primary" />
          Also delete the project folder on this computer
          <FolderOpen className="size-4 text-muted-foreground" />
        </label>
      </ConfirmDialog>
    </div>
  );
}
