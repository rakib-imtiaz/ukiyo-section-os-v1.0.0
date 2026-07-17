import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, CircleDashed, Columns2, FileText, Hammer, ScanSearch, TerminalSquare, XCircle } from 'lucide-react';
import { Badge, Button, Progress, Select, Separator, Sheet, Skeleton, Tabs } from './ui';
import { ScoreRing, Sparkline } from './fx';
import { api, usePoll } from './api';
import { STATUS_META, type Iteration, type Job } from './types';
import { openTerminalSession } from '../TerminalPane';
import { openBrowserCompare } from '../BrowserPane';

/** Best-available Shopify preview URL for a job: prefer an explicit preview URL or dev theme id
 * if the job detail payload carries one (backend-dependent), else the store URL as-is. */
function shopifyPreviewUrl(job: Job): string {
  const extras = job as Job & Partial<{ preview_url: string; dev_theme_id: number | string; preview_theme_id: number | string }>;
  if (typeof extras.preview_url === 'string' && extras.preview_url) return extras.preview_url;
  const devThemeId = extras.dev_theme_id ?? extras.preview_theme_id;
  if (devThemeId == null || devThemeId === '') return job.store_url;
  return `${job.store_url.replace(/\/+$/, '')}/?preview_theme_id=${encodeURIComponent(String(devThemeId))}`;
}

function iterationIcon(iteration: Iteration) {
  if (iteration.status === 'running') return <CircleDashed className="size-4.5 animate-spin text-foreground" />;
  if (['succeeded'].includes(iteration.status)) return <CheckCircle2 className="size-4.5 text-success" />;
  if (iteration.status === 'regressed') return <XCircle className="size-4.5 text-warning" />;
  return <XCircle className="size-4.5 text-destructive" />;
}

const kindMeta: Record<Iteration['kind'], { label: string; icon: React.ReactNode }> = {
  clone: { label: 'Initial clone', icon: <Hammer className="size-4" /> },
  qa: { label: 'QA comparison', icon: <ScanSearch className="size-4" /> },
  fix: { label: 'Fix session', icon: <Hammer className="size-4" /> },
};

/** Minimal markdown renderer (headings, bold, code, tables degrade to <pre>) — no extra deps. */
function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => text.split(/\n{2,}/), [text]);
  return (
    <div className="flex flex-col gap-2.5 text-[14px] font-medium leading-relaxed">
      {blocks.map((block, index) => {
        if (/^#{1,3}\s/.test(block)) {
          const level = block.match(/^(#{1,3})/)![1].length;
          const content = block.replace(/^#{1,3}\s*/, '');
          return level === 1
            ? <h2 key={index} className="text-[16px] font-bold tracking-tight">{content}</h2>
            : <h3 key={index} className={level === 2 ? 'text-[14.5px] font-bold' : 'text-xs font-bold uppercase tracking-[0.1em] text-muted-foreground'}>{content}</h3>;
        }
        if (block.includes('|---') || block.startsWith('    ') || block.startsWith('```')) {
          return <pre key={index} className="overflow-x-auto rounded-lg bg-muted p-3.5 text-[12.5px] leading-5">{block.replace(/^```\w*\n?|```$/g, '')}</pre>;
        }
        const html = block
          .replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/~~(.+?)~~/g, '<del>$1</del>')
          .replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1 py-0.5 text-[12.5px]">$1</code>');
        return <p key={index} className="whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: html }} />;
      })}
    </div>
  );
}

function LiveLog({ jobId, iterations }: { jobId: string; iterations: Iteration[] }) {
  const options = useMemo(() => {
    const seen = new Set<string>();
    return iterations
      .map((iteration) => ({ kind: iteration.kind === 'qa' ? 'qa' : iteration.kind, iter: iteration.iteration }))
      .filter((entry) => { const key = `${entry.kind}-${entry.iter}`; if (seen.has(key)) return false; seen.add(key); return true; });
  }, [iterations]);
  const [selected, setSelected] = useState<string>('');
  const active = selected || (options.length ? `${options[options.length - 1].kind}-${options[options.length - 1].iter}` : 'clone-0');
  const [kind, iter] = active.split('-');
  const { data } = usePoll(() => api.log(jobId, kind, Number(iter)), 2000, [jobId, active]);
  const preRef = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => { if (follow && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight; }, [data, follow]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={active} onChange={(event) => setSelected(event.target.value)} className="h-9 w-60 text-[13px]">
          {(options.length ? options : [{ kind: 'clone', iter: 0 }]).map((option) => (
            <option key={`${option.kind}-${option.iter}`} value={`${option.kind}-${option.iter}`}>{option.kind} — iteration {option.iter}</option>
          ))}
        </Select>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-muted-foreground">
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} className="size-4 accent-primary" /> auto-follow
        </label>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-terminal shadow-inner">
        <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-white/20" /><span className="size-2.5 rounded-full bg-white/20" /><span className="size-2.5 rounded-full bg-white/20" />
          <span className="ml-2 font-mono text-[11px] font-semibold tracking-wide text-zinc-400">{kind} · iteration {iter}</span>
        </div>
        <pre
          ref={preRef}
          onScroll={() => { const el = preRef.current; if (el && el.scrollTop + el.clientHeight < el.scrollHeight - 40) setFollow(false); }}
          className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[12px] leading-5 text-zinc-100"
        >
          {data?.exists ? data.log : 'No log yet for this run.'}
        </pre>
      </div>
    </div>
  );
}

function Reports({ jobId, reports }: { jobId: string; reports: string[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    if (!selected) return;
    setContent(null);
    void api.report(jobId, selected).then(setContent).catch((error) => setContent(`Could not load: ${error.message}`));
  }, [jobId, selected]);
  const interesting = ['factory/qa-summary', 'final.md', 'BLOCKED.md', 'ABORTED.md'];
  const sorted = [...reports].sort((a, b) => {
    const rank = (name: string) => interesting.findIndex((entry) => name.includes(entry.replace('factory/', ''))) + (name.includes('factory/') ? 0 : 0.5);
    return rank(a) - rank(b) || b.localeCompare(a);
  });
  if (!reports.length) return <p className="text-[14px] font-medium text-muted-foreground">No reports yet — they appear as the clone and QA runs progress.</p>;
  return (
    <div className="flex flex-col gap-4">
      <div className="stagger flex flex-wrap gap-2">
        {sorted.map((name) => (
          <button
            key={name} type="button" onClick={() => setSelected(name)} aria-pressed={selected === name}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition-all duration-150 active:scale-[0.97] ${
              selected === name ? 'border-primary bg-primary text-primary-foreground shadow-sm' : 'border-border bg-card text-foreground hover:bg-accent'}`}
          >
            <FileText className="size-3.5" /> {name}
          </button>
        ))}
      </div>
      {selected && (content == null
        ? <Skeleton className="h-40 w-full" />
        : <div className="rise-in rounded-xl border border-border bg-card p-5"><Markdown text={content} /></div>)}
    </div>
  );
}

function Screenshots({ jobId }: { jobId: string }) {
  const { data, loading, error } = usePoll(() => api.listScreenshots(jobId), 5000, [jobId]);
  const shots = data?.screenshots ?? [];
  if (loading && !data) return <Skeleton className="h-40 w-full" />;
  if (error) return <p className="text-[14px] font-medium text-muted-foreground">Screenshots could not be loaded: {error}</p>;
  if (!shots.length) return <p className="text-[14px] font-medium text-muted-foreground">No screenshots yet — QA captures them after the first comparison pass.</p>;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {shots.map((name) => (
        <a key={name} href={api.screenshotUrl(jobId, name)} target="_blank" rel="noreferrer" className="rise-in overflow-hidden rounded-xl border border-border bg-card transition-shadow hover:shadow-md">
          <img src={api.screenshotUrl(jobId, name)} alt={name} loading="lazy" className="block w-full bg-muted" />
          <span className="block truncate px-3 py-2 text-[12px] font-semibold text-muted-foreground">{name}</span>
        </a>
      ))}
    </div>
  );
}

export function JobDetail({ jobId, onClose, onNavigate }: { jobId: string | null; onClose: () => void; onNavigate?: (view: 'terminal' | 'browser') => void }) {
  const { data } = usePoll(() => jobId ? api.getJob(jobId) : Promise.resolve(null), 3000, [jobId]);
  const [tab, setTab] = useState('timeline');
  useEffect(() => { setTab('timeline'); }, [jobId]);
  const job: Job | undefined = data?.job;
  const meta = job ? STATUS_META[job.status] : null;

  return (
    <Sheet open={Boolean(jobId)} onClose={onClose} wide title={
      job ? (
        <div className="flex items-center gap-2.5">
          <span className="truncate">{job.name}</span>
          {meta && <Badge variant={meta.tone}>{meta.label}</Badge>}
          {job.last_score != null && <span className="text-[13px] font-semibold tabular-nums text-muted-foreground">{(job.last_score * 100).toFixed(1)}%</span>}
        </div>
      ) : 'Loading…'
    }>
      {!job ? <Skeleton className="h-40 w-full" /> : (
        <div className="flex h-full flex-col gap-5">
          <div className="rounded-xl border border-border bg-card p-4 text-[13.5px] font-medium leading-6 text-muted-foreground">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-bold text-foreground">{job.react_url}</span>
              <ArrowRight className="size-3.5 shrink-0" />
              <span className="font-bold text-foreground">{job.store_url.replace('https://', '')}</span>
            </p>
            <p className="mt-1">{job.status_detail ?? '—'}</p>
            <p className="mt-1 truncate">workspace: <code className="rounded bg-muted px-1 py-0.5 text-[12px]">{job.workspace_path}</code></p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm" variant="outline"
                title={`Open a shell in ${job.workspace_path}`}
                onClick={() => { openTerminalSession({ cwd: job.workspace_path, label: job.slug }); onNavigate?.('terminal'); }}
              >
                <TerminalSquare className="size-4" /> Open terminal here
              </Button>
              <Button
                size="sm" variant="outline"
                title="Open the React source and the Shopify clone side by side in the integrated browser"
                onClick={() => { openBrowserCompare({ reactUrl: job.react_url, shopifyUrl: shopifyPreviewUrl(job) }); onNavigate?.('browser'); }}
              >
                <Columns2 className="size-4" /> Compare in Browser
              </Button>
            </div>
          </div>

          {['failed', 'blocked', 'aborted'].includes(job.status) && job.status_detail && (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-[13.5px] font-semibold leading-6 text-red-600 dark:text-red-400">{job.status_detail}</div>
          )}

          {job.last_score != null && (
            <div className="flex items-center gap-5 rounded-xl border border-border bg-card p-4">
              <ScoreRing value={job.last_score} size={60} stroke={5} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3 text-[13px] font-bold">
                  <span>Match score</span>
                  <span className="text-muted-foreground">target {Math.round(job.score_threshold * 100)}%</span>
                </div>
                <Progress value={job.last_score} active={job.running} className="mt-2.5" />
              </div>
              <Sparkline history={job.score_history} width={110} height={34} className="hidden text-muted-foreground sm:block" />
            </div>
          )}

          <Tabs value={tab} onChange={setTab} tabs={[
            { id: 'timeline', label: 'Timeline' },
            { id: 'log', label: 'Live log' },
            { id: 'reports', label: 'Reports' },
            { id: 'screenshots', label: 'Screenshots' },
          ]} />

          {tab === 'timeline' && (
            <div className="stagger flex flex-col">
              {!data!.iterations.length && <p className="text-[14px] font-medium text-muted-foreground">Nothing has run yet.</p>}
              {data!.iterations.map((iteration, index) => (
                <div key={iteration.id} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <span className="flex size-8 items-center justify-center rounded-full border border-border bg-card shadow-sm">{iterationIcon(iteration)}</span>
                    {index < data!.iterations.length - 1 && <div className="my-1 w-px flex-1 bg-border" />}
                  </div>
                  <div className="flex-1 pb-6">
                    <p className="flex flex-wrap items-center gap-2 text-[15px] font-bold leading-8">
                      {kindMeta[iteration.kind].icon} {kindMeta[iteration.kind].label}
                      <span className="text-[13px] font-semibold text-muted-foreground">iteration {iteration.iteration}</span>
                      {iteration.score != null && <Badge variant={iteration.status === 'regressed' ? 'warning' : 'info'}>{(iteration.score * 100).toFixed(1)}%{iteration.status === 'regressed' ? ' ↓' : ''}</Badge>}
                    </p>
                    <p className="mt-0.5 text-[13px] font-medium text-muted-foreground">
                      {new Date(iteration.started_at).toLocaleTimeString()} · {iteration.status}
                      {iteration.breakdown ? ` · ${String((iteration.breakdown as { issues?: number }).issues ?? '—')} issues` : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'log' && <div className="min-h-0 flex-1"><LiveLog jobId={job.id} iterations={data!.iterations} /></div>}
          {tab === 'reports' && <Reports jobId={job.id} reports={data!.reports} />}
          {tab === 'screenshots' && <Screenshots jobId={job.id} />}
        </div>
      )}
    </Sheet>
  );
}
