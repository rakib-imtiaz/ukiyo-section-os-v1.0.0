// HOME — "Your stores". Answers one question: what is happening with my stores, and what do I
// do next? Builds that need the user come first, then the latest builds with their one main
// action, then a single way to start a new build. Empty state for first-time users.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, LoaderCircle, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { api } from './factory/api';
import { WatchVideoButton, WatchVideoCard } from './SetupVideo';
import { RotatingWords } from './RotatingWords';
import { HomeJourney } from './HomeJourney';
import { plainDetail, type EasyStatus, type Job, type JobStatus } from './factory/types';

type Tone = 'grey' | 'blue' | 'green' | 'amber' | 'red';
type ActionKind = 'open' | 'retry' | 'resume' | 'store' | 'continue';

/** Plain labels, tones and main action for every build status (see THEMEBOT_SCREEN_SPEC §D). */
export const BUILD_STATUS: Record<JobStatus, { label: string; tone: Tone; action: string; kind: ActionKind }> = {
  draft: { label: 'Draft', tone: 'grey', action: 'Continue', kind: 'continue' },
  queued: { label: 'Waiting to start', tone: 'grey', action: 'View', kind: 'open' },
  scaffolding: { label: 'Preparing', tone: 'blue', action: 'View', kind: 'open' },
  cloning: { label: 'Building', tone: 'blue', action: 'View', kind: 'open' },
  qa_running: { label: 'Checking', tone: 'blue', action: 'View', kind: 'open' },
  fixing: { label: 'Fixing differences', tone: 'blue', action: 'View', kind: 'open' },
  converged: { label: 'Done', tone: 'green', action: 'Open store', kind: 'store' },
  exhausted: { label: 'Needs a look', tone: 'amber', action: 'See what differs', kind: 'open' },
  blocked: { label: 'Paused, needs you', tone: 'amber', action: 'Retry', kind: 'retry' },
  paused: { label: 'Paused by you', tone: 'grey', action: 'Resume', kind: 'resume' },
  aborted: { label: 'Stopped', tone: 'red', action: 'Retry', kind: 'retry' },
  failed: { label: 'Failed', tone: 'red', action: 'Retry', kind: 'retry' },
  canceled: { label: 'Cancelled', tone: 'grey', action: 'View', kind: 'open' },
  checked: { label: 'Checked', tone: 'blue', action: 'See the match', kind: 'open' },
};

const NEEDS_YOU: JobStatus[] = ['blocked', 'exhausted', 'failed', 'aborted'];

const pct = (value: number | null) => (value == null ? '—' : `${Math.round(value * 100)}%`);
const storeHost = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** Friendlier status sentence than the raw scheduler detail. */
function sentence(job: Job) {
  const detail = job.status_detail ?? '';
  const stalled = detail.match(/no CLI activity for (\d+m)/i);
  if (stalled) return `Paused: no activity for ${stalled[1].replace('m', ' minutes')}`;
  return detail.replace(/CLI stalled:?\s*/i, 'Paused: ').replace(/Headless \/clone-theme run in progress/i, 'Building the theme…') || BUILD_STATUS[job.status].label;
}

// ———————————————— live activity terminal ————————————————
// Every line here comes from something that really happened: the setup bot's own log, a build
// changing stage, or a round finishing. Nothing is simulated; when nothing runs it says so.

type FeedLine = { at: number; text: string; tone: 'info' | 'ok' | 'warn' | 'run' | 'dim' };
const STAGES = ['Setup', 'Build', 'Check', 'Fix', 'Done'] as const;
const RUNNING: JobStatus[] = ['scaffolding', 'cloning', 'qa_running', 'fixing', 'queued'];

function stageOf(status: JobStatus | 'setup' | null): number {
  if (status === 'setup') return 0;
  if (status === 'scaffolding' || status === 'cloning' || status === 'queued') return 1;
  if (status === 'qa_running') return 2;
  if (status === 'fixing') return 3;
  if (status === 'converged') return 4;
  return -1;
}
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const ago = (iso: string) => { const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : Math.round(m / 1440) === 1 ? '1 day ago' : `${Math.round(m / 1440)} days ago`; };
const toneOf = (status: JobStatus): FeedLine['tone'] => { const tone = BUILD_STATUS[status].tone; return tone === 'green' ? 'ok' : tone === 'amber' || tone === 'red' ? 'warn' : tone === 'blue' ? 'run' : 'dim'; };

function LiveTerminal({ jobs }: { jobs: Job[] }) {
  const [easy, setEasy] = useState<EasyStatus | null>(null);
  const seen = useRef(new Map<string, JobStatus>());
  const [events, setEvents] = useState<FeedLine[]>([]);

  useEffect(() => {
    let alive = true;
    const tick = () => api.easyStatus().then((next) => { if (alive) setEasy(next); }).catch(() => {});
    void tick();
    const timer = setInterval(() => { if (!document.hidden) void tick(); }, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  // Record real stage changes as they happen while this page is open.
  useEffect(() => {
    const fresh: FeedLine[] = [];
    for (const job of jobs) {
      const before = seen.current.get(job.id);
      if (before && before !== job.status) fresh.push({ at: Date.now(), text: `${job.name} · ${BUILD_STATUS[before].label} → ${BUILD_STATUS[job.status].label}`, tone: toneOf(job.status) });
      seen.current.set(job.id, job.status);
    }
    if (fresh.length) setEvents((current) => [...current, ...fresh].slice(-20));
  }, [jobs]);

  const setupRun = easy?.run && (easy.run.phase === 'running' || easy.run.phase === 'needs_login') ? easy.run : null;
  const byRecent = [...jobs].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const active = byRecent.find((job) => RUNNING.includes(job.status)) ?? null;
  const latest = byRecent[0] ?? null;

  let title = 'Idle';
  let live = false;
  let stage = -1;
  let lines: FeedLine[] = [];

  if (setupRun) {
    live = true; stage = 0; title = `Setting up ${setupRun.storeName}`;
    const log: FeedLine[] = (easy?.collector.log ?? []).slice(-9).map((entry) => ({ at: entry.at, text: entry.text.replace(/\s+/g, ' ').slice(0, 140), tone: entry.kind === 'action' ? 'run' : entry.kind === 'thought' ? 'info' : 'dim' }));
    const step = setupRun.steps.find((item) => item.state === 'active' || item.state === 'failed');
    lines = log.length ? log : [{ at: setupRun.updatedAt, text: step ? `${step.label}…` : 'Starting…', tone: 'run' }];
    if (setupRun.phase === 'needs_login') lines.push({ at: setupRun.updatedAt, text: 'Waiting for you — sign in to Shopify in Chrome', tone: 'warn' });
  } else if (active) {
    live = true; stage = stageOf(active.status); title = `Building ${active.name}`;
    const history: FeedLine[] = [];
    if (active.started_at) history.push({ at: new Date(active.started_at).getTime(), text: `Build started for ${active.store_url.replace(/^https?:\/\//, '')}`, tone: 'info' });
    for (const round of active.score_history) history.push({ at: new Date(round.at).getTime(), text: `Round ${round.iter} checked · ${Math.round(round.score * 100)}% match`, tone: round.score >= active.score_threshold ? 'ok' : 'info' });
    history.push({ at: new Date(active.updated_at).getTime(), text: plainDetail(active.status_detail) || BUILD_STATUS[active.status].label, tone: 'run' });
    lines = [...history, ...events.filter((line) => line.text.startsWith(active.name))].sort((a, b) => a.at - b.at).slice(-9);
  } else if (latest) {
    stage = stageOf(latest.status);
    const updated = new Date(latest.updated_at).getTime();
    lines = [
      { at: updated, text: `Last build: ${latest.name} · ${BUILD_STATUS[latest.status].label} (${ago(latest.updated_at)})`, tone: toneOf(latest.status) },
      ...(latest.status_detail ? [{ at: updated, text: plainDetail(latest.status_detail), tone: 'dim' as const }] : []),
      ...(latest.last_score != null ? [{ at: updated, text: `Best match so far: ${Math.round(latest.last_score * 100)}%`, tone: 'dim' as const }] : []),
      ...events.slice(-5),
      { at: Date.now(), text: 'Nothing is running right now', tone: 'dim' },
    ];
  } else {
    lines = [{ at: Date.now(), text: 'No builds yet — start one and it shows up here live', tone: 'dim' }];
  }

  // Panel style: dark terminal (default) or see-through glass. Remembered in this browser.
  const [glass, setGlass] = useState(() => { try { return localStorage.getItem('themebot-term-style') === 'glass'; } catch { return false; } });
  const chooseGlass = (next: boolean) => { setGlass(next); try { localStorage.setItem('themebot-term-style', next ? 'glass' : 'dark'); } catch { /* this visit only */ } };

  return (
    <div className={`hs-term${glass ? ' is-glass' : ''}`} role="log" aria-live="polite" aria-label="Live activity">
      <div className="hs-term__head">
        <span>ThemeBot · Live activity</span>
        <span className="hs-term__tools">
          <span className="hs-term__look" role="radiogroup" aria-label="Panel style">
            <button type="button" role="radio" aria-checked={!glass} className={glass ? '' : 'is-on'} onClick={() => chooseGlass(false)}>Dark</button>
            <button type="button" role="radio" aria-checked={glass} className={glass ? 'is-on' : ''} onClick={() => chooseGlass(true)}>Glass</button>
          </span>
          <span className={`hs-term__state${live ? ' is-live' : ''}`}>{live ? 'Live' : 'Idle'} <i /></span>
        </span>
      </div>
      <p className="hs-term__title">{title}</p>
      <div className="hs-term__lines">
        {lines.map((line, index) => (
          <div key={`${line.at}-${index}`} className={`hs-term__line is-${line.tone}`}>
            <time>{clock(line.at)}</time>
            <b aria-hidden>{line.tone === 'ok' ? '✓' : line.tone === 'warn' ? '!' : line.tone === 'run' ? '▸' : '·'}</b>
            <span>{line.text}</span>
          </div>
        ))}
        <div className="hs-term__line is-dim"><time>--:--:--</time><b aria-hidden>▸</b><span><i className="hs-term__cursor" aria-hidden /></span></div>
      </div>
    </div>
  );
}

export default function HomeScreen({ onNewBuild, onOpenBuilds, onOpenBuild }: {
  onNewBuild: () => void;
  onOpenBuilds: () => void;
  onOpenBuild: (jobId: string) => void;
}) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const result = await api.listJobs(); setJobs(result.jobs); setError(false); }
    catch { setError(true); }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 4000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (job: Job) => {
    const meta = BUILD_STATUS[job.status];
    if (meta.kind === 'open' || meta.kind === 'continue') { if (meta.kind === 'continue') onNewBuild(); else onOpenBuild(job.id); return; }
    if (meta.kind === 'store') { window.open(job.store_url, '_blank', 'noopener'); return; }
    setBusy(job.id);
    try { await (meta.kind === 'retry' ? api.retry(job.id) : api.start(job.id)); await load(); }
    catch { /* the list refresh shows the real state */ }
    finally { setBusy(null); }
  };

  const sorted = [...(jobs ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const attention = sorted.filter((job) => NEEDS_YOU.includes(job.status));
  const latestFive = sorted.slice(0, 5);
  const activeJob = sorted.find((job) => RUNNING.includes(job.status) && job.status !== 'queued') ?? null;
  const journeyState: 'idle' | 'running' | 'done' = activeJob ? 'running' : sorted.some((job) => job.status === 'converged') ? 'done' : 'idle';
  const journeyLabel = activeJob ? `ThemeBot is turning ${activeJob.name} into a Shopify store right now.` : journeyState === 'done' ? 'Your website is now a Shopify store.' : 'Give ThemeBot a website — it becomes a Shopify store.';

  return (
    <section className="glass-page hs-page">
      <div className="glass-heading">
        <div>
          <h2>Your stores</h2>
          <p>See what is happening and what needs you.</p>
        </div>
      </div>

      {error && (
        <div className="hs-alert hs-alert--red">
          <div><b>Could not load your builds.</b><span>ThemeBot is not answering right now. It will keep trying.</span></div>
          <button type="button" className="gbtn gbtn--outline" onClick={() => void load()}><RefreshCw size={14} /> Retry now</button>
        </div>
      )}

      {jobs === null && !error && <div className="hs-loading"><LoaderCircle className="spin" size={20} /> Loading your stores…</div>}

      {jobs !== null && jobs.length === 0 && (
        <div className="hs-intro">
        <div className="glass-card hs-empty">
          <h3>Build your first store</h3>
          <p>Give ThemeBot a website and a name. It creates the Shopify store, connects it, and rebuilds your website as a Shopify theme.</p>
          <ol>
            <li><span>1</span><strong>Tell us about your store</strong></li>
            <li><span>2</span><strong>Confirm your website</strong></li>
            <li><span>3</span><strong>Press Start</strong></li>
          </ol>
          <p className="hs-rotate">
            <Sparkles size={16} />
            <span>Turns any <RotatingWords words={['React site', 'Lovable app', 'Bolt project', 'Kimi page', 'Next.js site', 'landing page']} /> into a Shopify store.</span>
          </p>
          <button type="button" className="gbtn gbtn--primary" onClick={onNewBuild}>Build a new store</button>
        </div>
        <WatchVideoCard />
        </div>
      )}

      {attention.map((job) => {
        const meta = BUILD_STATUS[job.status];
        return (
          <div key={`a-${job.id}`} className={`hs-alert hs-alert--${meta.tone}`}>
            <div>
              <b>{job.name} <em className={`gpill gpill--${meta.tone}`}>{meta.label}</em></b>
              <span>{sentence(job)}</span>
            </div>
            <button type="button" className="gbtn gbtn--outline" disabled={busy === job.id} onClick={() => void act(job)}>
              {busy === job.id ? <LoaderCircle className="spin" size={14} /> : null}{meta.action}
            </button>
          </div>
        );
      })}

      {jobs !== null && (
      <div className="hs-grid">
      {jobs.length > 0 ? (
        <div className="glass-card hs-table-wrap">
          <table className="hs-table">
            <thead><tr><th>Name</th><th>Store</th><th>Status</th><th>Match</th><th>Round</th><th aria-label="Action" /></tr></thead>
            <tbody>
              {latestFive.map((job) => {
                const meta = BUILD_STATUS[job.status];
                return (
                  <tr key={job.id}>
                    <td><button type="button" className="hs-name" onClick={() => onOpenBuild(job.id)}>{job.name}</button></td>
                    <td className="hs-mono">{storeHost(job.store_url)}</td>
                    <td><em className={`gpill gpill--${meta.tone}`}>{job.running && meta.tone === 'blue' ? <i className="gpill__dot" /> : null}{meta.label}</em></td>
                    <td className="hs-num">{pct(job.last_score)}</td>
                    <td>Round {Math.max(job.iteration, 0)} of {job.max_iterations}</td>
                    <td className="hs-actions">
                      <button type="button" className="gbtn gbtn--outline gbtn--sm" disabled={busy === job.id} onClick={() => void act(job)}>{meta.action}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <div />}
      <LiveTerminal jobs={jobs} />
      </div>
      )}

      {jobs !== null && jobs.length > 0 && (
        <div className="hs-footer">
          <button type="button" className="gbtn gbtn--primary hs-cta" onClick={onNewBuild}><span className="hs-cta__plus" aria-hidden><Plus size={18} strokeWidth={2.6} /></span>Build a new store</button>
          <span className="hs-footer__links">
            <WatchVideoButton variant="link" label="How it works" />
            <i className="hs-footer__sep" aria-hidden />
            <button type="button" className="glink" onClick={onOpenBuilds}>See all builds <ArrowRight size={14} /></button>
          </span>
        </div>
      )}
      {jobs !== null && <HomeJourney state={journeyState} label={journeyLabel} />}
    </section>
  );
}
