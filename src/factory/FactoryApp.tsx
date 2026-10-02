import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Plus } from 'lucide-react';
import './theme.css';
import { Button, LiveDot, ToastProvider, useToast } from './ui';
import { api, usePoll } from './api';
import { Dashboard } from './Dashboard';
import { NewJobWizard } from './NewJobWizard';
import { JobDetail } from './JobDetail';
import { SettingsPanel } from './SettingsPanel';
import { STATUS_META, TERMINAL, type FactorySettings, type Job } from './types';

/** Views the factory surface can hand off to (terminal "open here", browser compare). */
export type FactoryNavigate = (view: 'terminal' | 'browser') => void;
export type FactoryTab = 'dashboard' | 'new' | 'settings';

/** The factory surface is driven by the app sidebar: Builds → dashboard, "Build a new store" →
 *  new, Settings → settings. It no longer draws its own brand bar or tab strip. */
function FactoryInner({ onNavigate, tab, onTabChange, focusJobId }: {
  onNavigate?: FactoryNavigate; tab: FactoryTab; onTabChange: (tab: FactoryTab) => void; focusJobId?: string | null;
}) {
  const toast = useToast();
  const [openJobId, setOpenJobId] = useState<string | null>(focusJobId ?? null);
  useEffect(() => { if (focusJobId) setOpenJobId(focusJobId); }, [focusJobId]);
  const [defaults, setDefaults] = useState<FactorySettings | null>(null);
  const { data, loading, refresh } = usePoll(() => api.listJobs(), 3000);
  const previousStatuses = useRef(new Map<string, string>());

  useEffect(() => { void api.settings().then((response) => setDefaults(response.settings)).catch(() => {}); }, []);

  // Toast on meaningful state transitions (done, needs you, failed…)
  useEffect(() => {
    const jobs = data?.jobs ?? [];
    for (const job of jobs) {
      const previous = previousStatuses.current.get(job.id);
      if (previous && previous !== job.status) {
        const meta = STATUS_META[job.status];
        if (TERMINAL.includes(job.status) || job.status === 'blocked') {
          toast.push({
            title: `${job.name}: ${meta.label}`,
            detail: job.status_detail ?? undefined,
            variant: job.status === 'converged' ? 'success' : job.status === 'blocked' || job.status === 'exhausted' ? 'warning' : TERMINAL.includes(job.status) ? 'destructive' : 'default',
          });
        }
      }
      previousStatuses.current.set(job.id, job.status);
    }
  }, [data, toast]);

  const jobs: Job[] = data?.jobs ?? [];
  const runningCount = data?.scheduler?.running.length ?? 0;

  return (
    <div className="glass-page">
      <div key={tab} className="tab-panel flex w-full flex-col gap-6">
        {tab === 'dashboard' && (
          <>
            <div className="glass-heading">
              <div>
                <h2>Builds</h2>
                <p>Every store ThemeBot is building or has built.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                {data?.scheduler && (
                  <span className="glass-pill">
                    {runningCount > 0 ? <LiveDot className="text-success" /> : <span className="inline-flex size-2 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />}
                    {runningCount > 0 ? `${runningCount} building now` : 'Nothing building'}{data.scheduler.queuePaused ? ' · queue paused' : ''}
                  </span>
                )}
                {data?.scheduler && jobs.length > 0 && (
                  <Button size="sm" variant="outline" aria-pressed={data.scheduler.queuePaused} onClick={() => { const paused = data.scheduler.queuePaused; void (paused ? api.resumeQueue() : api.pauseQueue()).then(() => { toast.push({ title: paused ? 'Queue resumed' : 'Queue paused', variant: 'default' }); void refresh(); }).catch((error) => toast.push({ title: 'Could not change the queue', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' })); }}>
                    {data.scheduler.queuePaused ? <><Play className="size-3.5" /> Resume queue</> : <><Pause className="size-3.5" /> Pause queue</>}
                  </Button>
                )}
                <Button onClick={() => onTabChange('new')}><Plus /> Build a new store</Button>
              </div>
            </div>
            <Dashboard jobs={jobs} scheduler={data?.scheduler ?? null} loading={loading} refresh={refresh} onOpen={setOpenJobId} onNew={() => onTabChange('new')} />
          </>
        )}
        {tab === 'new' && <NewJobWizard defaults={defaults} onCreated={() => { onTabChange('dashboard'); refresh(); }} onCancel={() => onTabChange('dashboard')} onOpenBrowser={onNavigate ? () => onNavigate('browser') : undefined} />}
        {tab === 'settings' && (
          <>
            <div className="glass-heading"><div><h2>Settings</h2><p>How ThemeBot builds, checks, and keeps things safe.</p></div></div>
            <SettingsPanel jobs={jobs} refreshFleet={refresh} />
          </>
        )}
      </div>

      <JobDetail jobId={openJobId} onClose={() => setOpenJobId(null)} onNavigate={onNavigate} />
    </div>
  );
}

export default function FactoryApp({ onNavigate, tab = 'dashboard', onTabChange, focusJobId }: {
  onNavigate?: FactoryNavigate; tab?: FactoryTab; onTabChange?: (tab: FactoryTab) => void; focusJobId?: string | null;
} = {}) {
  const initial = typeof localStorage !== 'undefined' && localStorage.getItem('factory-theme') === 'dark' ? 'dark' : 'light';
  const [localTab, setLocalTab] = useState<FactoryTab>(tab);
  useEffect(() => { setLocalTab(tab); }, [tab]);
  const changeTab = (next: FactoryTab) => { setLocalTab(next); onTabChange?.(next); };
  return (
    <div className="factory-root" data-theme={initial}>
      <ToastProvider>
        <FactoryInner onNavigate={onNavigate} tab={localTab} onTabChange={changeTab} focusJobId={focusJobId} />
      </ToastProvider>
    </div>
  );
}
