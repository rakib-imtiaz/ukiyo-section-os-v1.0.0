import { useEffect, useRef, useState } from 'react';
import { Cog, LayoutDashboard, Moon, Pause, Play, Plus, Settings2, Sun } from 'lucide-react';
import './theme.css';
import { Badge, Button, LiveDot, Tabs, ToastProvider, useToast } from './ui';
import { api, usePoll } from './api';
import { Dashboard } from './Dashboard';
import { NewJobWizard } from './NewJobWizard';
import { JobDetail } from './JobDetail';
import { SettingsPanel } from './SettingsPanel';
import { STATUS_META, TERMINAL, type FactorySettings, type Job } from './types';

/** Views the factory surface can hand off to (terminal "open here", browser compare). */
export type FactoryNavigate = (view: 'terminal' | 'browser') => void;

function FactoryInner({ onNavigate }: { onNavigate?: FactoryNavigate }) {
  const toast = useToast();
  const [tab, setTab] = useState('dashboard');
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<FactorySettings | null>(null);
  const { data, loading, refresh } = usePoll(() => api.listJobs(), 3000);
  const previousStatuses = useRef(new Map<string, string>());

  useEffect(() => { void api.settings().then((response) => setDefaults(response.settings)).catch(() => {}); }, []);

  // Toast on meaningful state transitions (converged, blocked, failed…)
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
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-background/85 px-6 py-3 backdrop-blur-md">
        <div className="spin-on-hover mr-1 flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card shadow-sm">
            <Cog className="spin-slow size-5 text-foreground" aria-hidden />
          </div>
          <div className="hidden leading-tight lg:block">
            <p className="text-[15px] font-bold tracking-tight">ThemeBot</p>
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Autonomous builder</p>
          </div>
        </div>

        <Tabs value={tab} onChange={setTab} tabs={[
          { id: 'dashboard', label: <><LayoutDashboard className="size-4" /> Dashboard {jobs.length > 0 && <Badge variant="secondary">{jobs.length}</Badge>}</> },
          { id: 'new', label: <><Plus className="size-4" /> New clone</> },
          { id: 'settings', label: <><Settings2 className="size-4" /> Settings</> },
        ]} />

        <div className="ml-auto flex items-center gap-2.5">
          {data?.scheduler && (
            <span className="hidden items-center gap-2.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-[13px] font-bold text-muted-foreground sm:inline-flex">
              {runningCount > 0
                ? <LiveDot className="text-success" />
                : <span className="inline-flex size-2 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />}
              <span><span className="tabular-nums text-foreground">{runningCount}</span> running{data.scheduler.queuePaused ? ' · queue paused' : ''}</span>
            </span>
          )}
          {data?.scheduler && (
            <Button size="sm" variant="outline" disabled={jobs.length === 0} aria-pressed={data.scheduler.queuePaused} title={jobs.length === 0 ? 'No clone jobs in the fleet yet' : undefined} onClick={() => { const paused = data.scheduler.queuePaused; void (paused ? api.resumeQueue() : api.pauseQueue()).then(() => { toast.push({ title: paused ? 'Queue resumed' : 'Queue paused', variant: 'default' }); void refresh(); }).catch((error) => toast.push({ title: 'Queue action failed', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' })); }}>
              {data.scheduler.queuePaused ? <><Play className="size-3.5" /> Resume queue</> : <><Pause className="size-3.5" /> Pause queue</>}
            </Button>
          )}
          {/* Theme toggle lives once in the app-shell topbar (consistent across all pages). */}
        </div>
      </div>

      <div key={tab} className="tab-panel mx-auto flex w-full max-w-6xl flex-col gap-6 p-6 md:p-8">
        {tab === 'dashboard' && (
          <Dashboard jobs={jobs} scheduler={data?.scheduler ?? null} loading={loading} refresh={refresh} onOpen={setOpenJobId} onNew={() => setTab('new')} />
        )}
        {tab === 'new' && <NewJobWizard defaults={defaults} onCreated={() => { setTab('dashboard'); refresh(); }} onCancel={() => setTab('dashboard')} />}
        {tab === 'settings' && <SettingsPanel jobs={jobs} refreshFleet={refresh} />}
      </div>

      <JobDetail jobId={openJobId} onClose={() => setOpenJobId(null)} onNavigate={onNavigate} />
    </div>
  );
}

let themeAnimTimer: number | undefined;
export function applyFactoryTheme(dark: boolean) {
  const html = document.documentElement;
  const changing = html.getAttribute('data-app-theme') !== (dark ? 'dark' : 'light');
  if (changing) {
    // Enable a brief global color cross-fade so the flip glides instead of snapping.
    html.classList.add('theme-anim');
    window.clearTimeout(themeAnimTimer);
    themeAnimTimer = window.setTimeout(() => html.classList.remove('theme-anim'), 450);
  }
  document.querySelectorAll('.factory-root').forEach((root) => root.setAttribute('data-theme', dark ? 'dark' : 'light'));
  // The whole app shell (sidebar + topbar) follows the toggle too.
  html.setAttribute('data-app-theme', dark ? 'dark' : 'light');
  // Persistence lives in App.tsx's toggleTheme — the single writer of 'factory-theme'.
}

export function ThemeToggle() {
  const [dark, setDark] = useState(() => localStorage.getItem('factory-theme') === 'dark');
  useEffect(() => { applyFactoryTheme(dark); }, [dark]);
  return (
    <Button variant="outline" size="sm" onClick={() => setDark((value) => !value)} aria-pressed={dark}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}>
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      {dark ? 'Light mode' : 'Dark mode'}
    </Button>
  );
}

export default function FactoryApp({ onNavigate }: { onNavigate?: FactoryNavigate } = {}) {
  const initial = typeof localStorage !== 'undefined' && localStorage.getItem('factory-theme') === 'dark' ? 'dark' : 'light';
  return (
    <div className="factory-root h-full min-h-0" data-theme={initial}>
      <ToastProvider>
        <FactoryInner onNavigate={onNavigate} />
      </ToastProvider>
    </div>
  );
}
