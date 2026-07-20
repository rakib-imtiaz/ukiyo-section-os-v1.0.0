import { useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Factory, FolderOpen, MoreVertical, PencilLine, PlayCircle, Timer } from 'lucide-react';
import { Badge, Button, ConfirmDialog, DropdownMenu, EmptyState, LiveDot, Progress, Skeleton, useToast } from './ui';
import { CountUp, ScoreRing, Sparkline, SpotlightCard } from './fx';
import { api } from './api';
import { clearWizardDraft, getWizardDraft } from './NewJobWizard';
import { STATUS_META, TERMINAL, type Job, type SchedulerStatus } from './types';

const ACTIVE_STATUSES = ['scaffolding', 'cloning', 'qa_running', 'fixing'];

function elapsed(job: Job) {
  const start = job.started_at ?? job.created_at;
  const end = job.finished_at ?? new Date().toISOString();
  const minutes = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function StatTile({ icon, label, value, alert }: { icon: React.ReactNode; label: string; value: number; alert?: boolean }) {
  return (
    <SpotlightCard className="flex items-center justify-between gap-2 p-4 sm:gap-3 sm:p-5">
      <div className="min-w-0">
        <p className="text-[10.5px] font-bold uppercase leading-snug tracking-[0.08em] text-muted-foreground sm:text-xs sm:tracking-[0.12em]">{label}</p>
        <p className="mt-1.5 text-3xl font-bold leading-none tracking-tight">
          <CountUp value={value} />
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
  return (
    <SpotlightCard live={running} className="flex flex-col">
      <div className="flex items-start gap-3 p-5 pb-0">
        <button type="button" className="group min-w-0 flex-1 text-left" onClick={onOpen}>
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="truncate text-[16px] font-bold tracking-tight">{job.name}</span>
            <Badge variant={meta.tone}>
              {running && <LiveDot className="size-1.5" />}
              {meta.label}
            </Badge>
            <ArrowRight className="size-4 -translate-x-1 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100" />
          </div>
          <p className="mt-1.5 truncate text-[13.5px] font-medium text-muted-foreground">
            {job.status_detail ?? `${job.react_url} → ${job.store_url.replace('https://', '')}`}
          </p>
        </button>
        <DropdownMenu trigger={<MoreVertical className="size-4.5" />} label={`Actions for ${job.name}`} items={menuItems} />
      </div>

      {job.last_score != null && (
        <div className="flex items-center gap-4 px-5 pt-4">
          <ScoreRing value={job.last_score} size={46} stroke={4} />
          <Progress value={job.last_score} active={running} className="max-w-56 flex-1" />
          <Sparkline history={job.score_history} width={92} height={26} className="ml-auto text-muted-foreground" />
        </div>
      )}

      <div className="mt-4 flex items-center gap-4 border-t border-border px-5 py-3 text-[12.5px] font-semibold text-muted-foreground">
        {job.auto_qa
          ? <span>iteration <span className="tabular-nums text-foreground">{job.iteration}/{job.max_iterations}</span></span>
          : <span>QA off</span>}
        <span>target <span className="tabular-nums text-foreground">{Math.round(job.score_threshold * 100)}%</span></span>
        <span className="ml-auto tabular-nums">{elapsed(job)}</span>
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
  // In-progress wizard draft (localStorage) — surfaced so a refresh never hides where you left off.
  const [draft, setDraft] = useState(getWizardDraft);

  const act = async (label: string, action: () => Promise<unknown>) => {
    try { await action(); toast.push({ title: label, variant: 'default' }); refresh(); }
    catch (error) { toast.push({ title: `${label} failed`, detail: error instanceof Error ? error.message : undefined, variant: 'destructive' }); }
  };

  const counts = {
    running: jobs.filter((job) => ACTIVE_STATUSES.includes(job.status)).length,
    queued: jobs.filter((job) => job.status === 'queued').length,
    converged: jobs.filter((job) => job.status === 'converged').length,
    attention: jobs.filter((job) => ['blocked', 'exhausted', 'failed', 'aborted'].includes(job.status)).length,
  };

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
        <StatTile icon={<PlayCircle />} label="Running" value={counts.running} />
        <StatTile icon={<Timer />} label="Queued" value={counts.queued} />
        <StatTile icon={<CheckCircle2 />} label="Converged" value={counts.converged} />
        <StatTile icon={<AlertTriangle />} label="Needs attention" value={counts.attention} alert />
      </div>

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
          title={draft ? 'No clone jobs yet — but your draft is ready' : 'No clone jobs yet'}
          description={draft ? 'Resume the draft above to finish setting up your first clone job.' : 'Create your first clone: point the factory at a deployed React site and a Shopify store, and it handles the rest — clone, QA, and fix loop.'}
          action={<Button size="lg" onClick={onNew}>{draft ? 'Resume draft' : 'Create your first clone'}</Button>}
        />
      ) : (
        <div className="stagger grid gap-4 lg:grid-cols-2">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onOpen={() => onOpen(job.id)}
              menuItems={[
                { label: 'Open details', onSelect: () => onOpen(job.id) },
                { label: 'Retry / resume', onSelect: () => act('Job re-queued', () => api.retry(job.id)), disabled: !['blocked', 'paused', 'exhausted', 'failed', 'aborted'].includes(job.status), title: 'Available for blocked, paused, exhausted, failed, or aborted jobs' },
                { label: 'Pause', onSelect: () => act('Job paused', () => api.pause(job.id)), disabled: !job.running && job.status !== 'queued' },
                { label: 'Cancel', onSelect: () => setConfirm({ kind: 'cancel', job }), destructive: true, disabled: TERMINAL.includes(job.status) },
                { label: 'Delete', onSelect: () => { setPurge(false); setConfirm({ kind: 'delete', job }); }, destructive: true, disabled: !TERMINAL.includes(job.status) && job.status !== 'paused', title: 'Cancel the job first' },
              ]}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirm?.kind === 'cancel'}
        title={`Cancel "${confirm?.job.name}"?`}
        description="This kills the running Claude CLI session for this job. Progress already pushed to the dev theme is kept; you can delete the job afterwards."
        confirmLabel="Cancel job" destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() => { const job = confirm!.job; setConfirm(null); void act('Job canceled', () => api.cancel(job.id)); }}
      />
      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        title={`Delete "${confirm?.job.name}"?`}
        description="Removes the job and its history from the factory."
        confirmLabel="Delete job" destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() => { const job = confirm!.job; const purgeNow = purge; setConfirm(null); void act('Job deleted', () => api.remove(job.id, purgeNow)); }}
      >
        <label className="flex cursor-pointer items-center gap-2.5 text-[14px] font-semibold">
          <input type="checkbox" checked={purge} onChange={(event) => setPurge(event.target.checked)} className="size-4.5 accent-primary" />
          Also delete the workspace folder on disk
          <FolderOpen className="size-4 text-muted-foreground" />
        </label>
      </ConfirmDialog>
    </div>
  );
}
