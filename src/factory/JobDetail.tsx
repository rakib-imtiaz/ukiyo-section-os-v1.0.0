import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowRight, ChevronDown, Code2, LayoutGrid, MoreHorizontal, Square, Store, Ban, Bug, CheckCircle2, CircleDashed, Columns2, ExternalLink, FileText, FolderOpen, Globe, Hammer, ImageOff, Images, LayoutDashboard, Palette, Pause, Play, RotateCcw, ScanSearch, ScrollText, ShoppingBag, TerminalSquare, XCircle } from 'lucide-react';
import { Badge, Button, ConfirmDialog, DropdownMenu, Progress, Select, Sheet, Skeleton, Tabs, useToast } from './ui';
import { ScoreRing, Sparkline } from './fx';
import { api, usePoll } from './api';
import { ActivityFeed } from './ActivityFeed';
import { LiveCode } from './LiveCode';
import { BuildProgressCard } from './BuildProgressCard';
import { CheckPanel } from './CheckPanel';
import {
  STATUS_META, TERMINAL, issueKindMeta,
  type InteractionsReport, type Iteration, type Job, type QaIssue, type QaSubscores, type SectionsReport, blockedHint, plainDetail, plainRoundStatus, isDeveloperMode } from './types';
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
  if (iteration.status === 'interrupted' || iteration.status === 'killed') return <Pause className="size-4 text-muted-foreground" />;
  if (iteration.status === 'running') return <CircleDashed className="size-4.5 animate-spin text-foreground" />;
  if (['succeeded'].includes(iteration.status)) return <CheckCircle2 className="size-4.5 text-success" />;
  if (iteration.status === 'regressed') return <XCircle className="size-4.5 text-warning" />;
  return <XCircle className="size-4.5 text-destructive" />;
}

const kindMeta: Record<Iteration['kind'], { label: string; icon: React.ReactNode }> = {
  clone: { label: 'First build', icon: <Hammer className="size-4" /> },
  qa: { label: 'Checked against your website', icon: <ScanSearch className="size-4" /> },
  fix: { label: 'Fixed differences', icon: <Hammer className="size-4" /> },
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

/** presence / text / interaction as compact chips — shown on QA timeline rows. */
function SubscoreChips({ breakdown }: { breakdown: Record<string, unknown> | null }) {
  const subscores = (breakdown as { subscores?: QaSubscores } | null)?.subscores;
  if (!subscores) return null;
  const entries: Array<[string, number | null]> = [
    ['presence', subscores.presence], ['text', subscores.text], ['interaction', subscores.interaction],
  ];
  const shown = entries.filter(([, value]) => value != null) as Array<[string, number]>;
  if (!shown.length) return null;
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {shown.map(([label, value]) => (
        <span key={label} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
          {label}
          <span className="tabular-nums text-foreground">{Math.round(value * 100)}%</span>
        </span>
      ))}
    </span>
  );
}

/** Iteration numbers that have machine-readable issue reports, from the reports listing. */
function issueIterations(reports: string[]): number[] {
  const iterations = new Set<number>();
  for (const name of reports) {
    const match = name.match(/^factory\/(?:sections|interactions)-(\d+)\.json$/);
    if (match) iterations.add(Number(match[1]));
  }
  return [...iterations].sort((a, b) => a - b);
}

type FlaggedIssue = QaIssue & { informational: boolean };

function IssueRow({ issue }: { issue: FlaggedIssue }) {
  const meta = issueKindMeta(issue.kind);
  return (
    <div className="rise-in rounded-xl border border-border bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={meta.tone}>{meta.label}</Badge>
        {issue.informational && <Badge variant="outline">informational</Badge>}
        <code className="rounded bg-muted px-1.5 py-0.5 text-[12px] font-semibold text-muted-foreground">{issue.page}</code>
      </div>
      <p className="mt-2 text-[14px] font-bold leading-snug">{issue.title}</p>
      {issue.detail && <p className="mt-1 whitespace-pre-wrap text-[13px] font-medium leading-relaxed text-muted-foreground">{issue.detail}</p>}
    </div>
  );
}

/** First-class defect list: merges sections-<iter>.json + interactions-<iter>.json issues. */
function IssuesTab({ jobId, reports }: { jobId: string; reports: string[] }) {
  const iterations = useMemo(() => issueIterations(reports), [reports]);
  const [selected, setSelected] = useState<number | null>(null);
  const iteration = selected != null && iterations.includes(selected) ? selected : iterations[iterations.length - 1];
  const [state, setState] = useState<{ iteration: number; issues: FlaggedIssue[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<'kind' | 'page'>('kind');
  const [kindFilter, setKindFilter] = useState<string | null>(null);

  useEffect(() => {
    if (iteration == null) return;
    let alive = true;
    setError(null);
    (async () => {
      // Either report may not exist yet (QA mid-run) — treat a missing file as empty, not an error.
      const [sections, interactions] = await Promise.all([
        api.reportJson<SectionsReport>(jobId, `factory/sections-${iteration}.json`).catch(() => null),
        api.reportJson<InteractionsReport>(jobId, `factory/interactions-${iteration}.json`).catch(() => null),
      ]);
      if (!alive) return;
      if (!sections && !interactions) { setError('The issue reports for this iteration could not be loaded yet.'); return; }
      const issues: FlaggedIssue[] = [
        ...(sections?.issues ?? []).map((issue) => ({ ...issue, informational: false })),
        ...(interactions?.issues ?? []).map((issue) => ({ ...issue, informational: false })),
        ...(interactions?.informational ?? []).map((issue) => ({ ...issue, informational: true })),
      ];
      setState({ iteration, issues });
    })();
    return () => { alive = false; };
  }, [jobId, iteration]);

  if (!iterations.length) {
    return <p className="text-[14px] font-medium text-muted-foreground">No issue reports yet — the QA pass writes <code className="rounded bg-muted px-1 py-0.5 text-[12px]">sections-&lt;iter&gt;.json</code> and <code className="rounded bg-muted px-1 py-0.5 text-[12px]">interactions-&lt;iter&gt;.json</code> after its first comparison.</p>;
  }
  if (error) return <p className="text-[14px] font-medium text-muted-foreground">{error}</p>;
  if (!state || state.iteration !== iteration) return <Skeleton className="h-40 w-full" />;

  const kindCounts = new Map<string, number>();
  for (const issue of state.issues) kindCounts.set(issue.kind, (kindCounts.get(issue.kind) ?? 0) + 1);
  const filtered = kindFilter ? state.issues.filter((issue) => issue.kind === kindFilter) : state.issues;
  const scoring = state.issues.filter((issue) => !issue.informational).length;

  const groups = new Map<string, FlaggedIssue[]>();
  for (const issue of filtered) {
    const key = groupBy === 'page' ? issue.page : issue.kind;
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {iterations.length > 1 && (
          <Select value={String(iteration)} onChange={(event) => setSelected(Number(event.target.value))} className="h-9 w-44 text-[13px]">
            {iterations.map((entry) => <option key={entry} value={entry}>Round {entry}</option>)}
          </Select>
        )}
        <Tabs value={groupBy} onChange={(id) => setGroupBy(id as 'kind' | 'page')} className="h-9" tabs={[
          { id: 'kind', label: 'By kind' },
          { id: 'page', label: 'By page' },
        ]} />
        <span className="ml-auto text-[13px] font-semibold text-muted-foreground">
          {scoring} scoring · {state.issues.length - scoring} informational
        </span>
      </div>

      {kindCounts.size > 1 && (
        <div className="flex flex-wrap gap-2">
          {[...kindCounts.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => (
            <button
              key={kind} type="button" aria-pressed={kindFilter === kind}
              onClick={() => setKindFilter((current) => current === kind ? null : kind)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition-all duration-150 active:scale-[0.97] ${
                kindFilter === kind ? 'border-primary bg-primary text-primary-foreground shadow-sm' : 'border-border bg-card text-foreground hover:bg-accent'}`}
            >
              {issueKindMeta(kind).label} <span className="tabular-nums opacity-70">{count}</span>
            </button>
          ))}
        </div>
      )}

      {!state.issues.length ? (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-5">
          <CheckCircle2 className="size-5 shrink-0 text-success" />
          <p className="text-[14px] font-semibold">No differences found in round {iteration} — the store matched everything that was checked.</p>
        </div>
      ) : (
        [...groups.entries()].map(([key, entries]) => (
          <div key={key} className="flex flex-col gap-2">
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.1em] text-muted-foreground">
              {groupBy === 'page' ? <code className="rounded bg-muted px-1.5 py-0.5 text-[12px] normal-case">{key}</code> : issueKindMeta(key).label}
              <span className="tabular-nums">({entries.length})</span>
            </p>
            {entries.map((issue) => <IssueRow key={issue.id} issue={issue} />)}
          </div>
        ))
      )}
    </div>
  );
}

const LIVE_KEY = 'themebot-live-activity';
/** On/off live feed of what the build is doing (remembered per browser; on by default). */
function LiveActivity({ jobId, running }: { jobId: string; running: boolean }) {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(LIVE_KEY) !== 'off'; } catch { return true; } });
  const toggle = () => setOn((value) => { const next = !value; try { localStorage.setItem(LIVE_KEY, next ? 'on' : 'off'); } catch { /* private mode */ } return next; });
  const { data, error } = usePoll(() => (on ? api.activity(jobId) : Promise.resolve(null)), running ? 3000 : 15000, [jobId, on]);
  return (
    <div className="mb-5 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[14px] font-bold">Live activity</p>
          <p className="text-[12.5px] font-medium text-muted-foreground">{on ? 'Every file the build writes and every step it takes, as it happens.' : 'Turned off — switch it on to watch the build work.'}</p>
        </div>
        <button type="button" role="switch" aria-checked={on} aria-label="Show live activity" onClick={toggle} className={`gs-switch${on ? ' is-on' : ''}`}><b /></button>
      </div>
      {on && <ActivityFeed events={data?.events ?? []} live={running} title="What the build is doing" emptyText={error ? 'Live activity is not available yet — it switches on the next time ThemeBot restarts (restarting now would stop this build). The build keeps working in the meantime.' : running ? 'Waiting for the build to write its first files…' : 'No activity recorded for this build.'} />}
      {on && data && !data.streaming && running && <p className="text-[12px] font-medium text-muted-foreground">This build started before step-by-step streaming was switched on, so only the files it writes are shown. New builds show every step.</p>}
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

// QA writes screenshots as factory/<iter>/<route-slug>/{react,shopify}-{desktop,mobile}.png
// (section-compare.mjs; slug is the route with '/'→'_', '/' itself → '_home').
interface ParsedShot { name: string; iter: number; slug: string; side: 'react' | 'shopify'; viewport: string }

function parseShot(name: string): ParsedShot | null {
  const match = name.match(/^factory\/(\d+)\/(.+)\/(react|shopify)-(desktop|mobile)\.(?:png|jpe?g|webp)$/i);
  if (!match) return null;
  return { name, iter: Number(match[1]), slug: match[2], side: match[3].toLowerCase() as 'react' | 'shopify', viewport: match[4].toLowerCase() };
}

const routeFromSlug = (slug: string) => slug === '_home' ? '/' : slug.replace(/_/g, '/');

function ShotSide({ jobId, name, label }: { jobId: string; name: string | null; label: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
      {name ? (
        <a href={api.screenshotUrl(jobId, name)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-border bg-muted transition-shadow hover:shadow-md">
          <img src={api.screenshotUrl(jobId, name)} alt={`${label}: ${name}`} loading="lazy" className="block max-h-96 w-full object-cover object-top" />
        </a>
      ) : (
        <div className="flex h-32 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-muted-foreground">
          <ImageOff className="size-5" />
          <span className="text-[12px] font-semibold">Not captured</span>
        </div>
      )}
    </div>
  );
}

function Screenshots({ jobId }: { jobId: string }) {
  const { data, loading, error } = usePoll(() => api.listScreenshots(jobId), 5000, [jobId]);
  const shots = data?.screenshots ?? [];
  const [selectedIter, setSelectedIter] = useState<number | null>(null);

  const parsed = useMemo(() => shots.map(parseShot).filter((shot): shot is ParsedShot => shot != null), [shots]);
  const unpaired = useMemo(() => shots.filter((name) => !parseShot(name)), [shots]);
  const iterations = useMemo(() => [...new Set(parsed.map((shot) => shot.iter))].sort((a, b) => a - b), [parsed]);
  const iteration = selectedIter != null && iterations.includes(selectedIter) ? selectedIter : iterations[iterations.length - 1];

  if (loading && !data) return <Skeleton className="h-40 w-full" />;
  if (error) return <p className="text-[14px] font-medium text-muted-foreground">Screenshots could not be loaded: {error}</p>;
  if (!shots.length) return <p className="text-[14px] font-medium text-muted-foreground">No screenshots yet — QA captures them after the first comparison pass.</p>;

  // Pair React vs Shopify per route + viewport for the selected iteration.
  const pairs = new Map<string, { slug: string; viewport: string; react: string | null; shopify: string | null }>();
  for (const shot of parsed) {
    if (shot.iter !== iteration) continue;
    const key = `${shot.slug}|${shot.viewport}`;
    const entry = pairs.get(key) ?? { slug: shot.slug, viewport: shot.viewport, react: null, shopify: null };
    entry[shot.side] = shot.name;
    pairs.set(key, entry);
  }
  const ordered = [...pairs.values()].sort((a, b) =>
    a.slug.localeCompare(b.slug) || (a.viewport === b.viewport ? 0 : a.viewport === 'desktop' ? -1 : 1));

  return (
    <div className="flex flex-col gap-4">
      {iterations.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          {iterations.length > 1 && (
            <Select value={String(iteration)} onChange={(event) => setSelectedIter(Number(event.target.value))} className="h-9 w-44 text-[13px]">
              {iterations.map((entry) => <option key={entry} value={entry}>Round {entry}</option>)}
            </Select>
          )}
          <span className="text-[13px] font-semibold text-muted-foreground">React (source of truth) vs Shopify (clone), per route and viewport.</span>
        </div>
      )}

      <div className="stagger flex flex-col gap-4">
        {ordered.map((pair) => (
          <div key={`${pair.slug}|${pair.viewport}`} className="rise-in rounded-xl border border-border bg-card p-3.5">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-1.5 py-0.5 text-[12.5px] font-bold">{routeFromSlug(pair.slug)}</code>
              <Badge variant="outline">{pair.viewport}</Badge>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ShotSide jobId={jobId} name={pair.react} label="React · source" />
              <ShotSide jobId={jobId} name={pair.shopify} label="Shopify · clone" />
            </div>
          </div>
        ))}
      </div>

      {unpaired.length > 0 && (
        <>
          <p className="text-xs font-bold uppercase tracking-[0.1em] text-muted-foreground">Other captures</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {unpaired.map((name) => (
              <a key={name} href={api.screenshotUrl(jobId, name)} target="_blank" rel="noreferrer" className="rise-in overflow-hidden rounded-xl border border-border bg-card transition-shadow hover:shadow-md">
                <img src={api.screenshotUrl(jobId, name)} alt={name} loading="lazy" className="block w-full bg-muted" />
                <span className="block truncate px-3 py-2 text-[12px] font-semibold text-muted-foreground">{name}</span>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function JobDetail({ jobId, onClose, onNavigate }: { jobId: string | null; onClose: () => void; onNavigate?: (view: 'terminal' | 'browser') => void }) {
  const { data, refresh } = usePoll(() => jobId ? api.getJob(jobId) : Promise.resolve(null), 3000, [jobId]);
  const toast = useToast();
  const [tab, setTab] = useState('timeline');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const devMode = isDeveloperMode();
  useEffect(() => { setTab('timeline'); setConfirmCancel(false); }, [jobId]);
  const job: Job | undefined = data?.job;
  const meta = job ? STATUS_META[job.status] : null;

  // One command at a time: the buttons lock while a request is in flight, so a double press can
  // never send Pause/Resume twice (the server also guards against it).
  const [acting, setActing] = useState(false);
  const act = async (label: string, action: () => Promise<unknown>) => {
    if (acting) return;
    setActing(true);
    try { await action(); toast.push({ title: label, variant: 'default' }); await refresh(); }
    catch (error) { toast.push({ title: `${label} failed`, detail: error instanceof Error ? error.message : undefined, variant: 'destructive' }); }
    finally { setActing(false); }
  };

  // The store admin opens in ThemeBot's own window: it is signed in to the Shopify account that
  // owns the store (the user's everyday Chrome may be on another account).
  const openAdmin = async (adminPath: string) => {
    if (!job) return;
    try { await api.easySigninWindow(undefined, job.store_url, adminPath); }
    catch (error) { toast.push({ title: 'Could not open the store admin', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' }); }
  };

  // Same state rules as the Dashboard card menu (mirrors the server's checks).
  const canStart = job?.status === 'draft';
  const canPause = Boolean(job && (job.running || job.status === 'queued'));
  const canRetry = Boolean(job && ['blocked', 'paused', 'exhausted', 'failed', 'aborted'].includes(job.status));
  const canCancel = Boolean(job && !TERMINAL.includes(job.status));
  // Finished or cancelled builds can start over (Resume covers paused/blocked ones).
  const canRebuild = Boolean(job && !job.running && ['canceled', 'converged', 'exhausted', 'failed', 'aborted', 'checked'].includes(job.status));

  // Issue count for the tab label — the latest QA iteration's breakdown carries it.
  const latestQa = data?.iterations
    ? [...data.iterations].filter((iteration) => iteration.kind === 'qa' && iteration.breakdown).sort((a, b) => b.iteration - a.iteration)[0]
    : undefined;
  const issueCount = latestQa ? (latestQa.breakdown as { issues?: number }).issues : undefined;

  return (
    <Sheet open={Boolean(jobId)} onClose={onClose} wide title={
      job ? (
        <div className="flex items-center gap-2.5">
          <span className="truncate">{job.name}</span>
          {meta && <span className={`jd-pill jd-pill--${meta.tone}`}>{job.status === 'paused' ? <Pause /> : job.running ? <CircleDashed className="animate-spin" /> : job.status === 'converged' ? <CheckCircle2 /> : null}{meta.label}</span>}
          {job.last_score != null && <span className="text-[13px] font-semibold tabular-nums text-muted-foreground">{(job.last_score * 100).toFixed(1)}%</span>}
        </div>
      ) : 'Loading…'
    }>
      {!job ? <Skeleton className="h-40 w-full" /> : (
        <div className="flex h-full flex-col gap-5">
          {/* Big actions */}
          <div className="jd-actions">
            {canStart && <button type="button" disabled={acting} className="jd-btn jd-btn--primary" onClick={() => { setTab('code'); void act('Build started', () => api.start(job.id)); }}><Play /> Start</button>}
            {canPause && <button type="button" disabled={acting} className="jd-btn jd-btn--outline" title="Pause the build — you can resume it later" onClick={() => act('Build paused', () => api.pause(job.id))}><Pause /> Pause</button>}
            {canRetry && (
              <button type="button" disabled={acting} className="jd-btn jd-btn--primary" title="Carry on from where it stopped" onClick={() => { setTab('code'); void act(job.status === 'paused' || job.status === 'blocked' ? 'Build resumed' : 'Build restarted', () => api.retry(job.id)); }}>
                {job.status === 'paused' || job.status === 'blocked' ? <><Play /> Resume</> : <><RotateCcw /> Retry</>}
              </button>
            )}
            {canRebuild && (
              <button type="button" disabled={acting} className="jd-btn jd-btn--primary" title="Start this build again from the first step, on the same store" onClick={() => setConfirmRebuild(true)}>
                <Hammer /> Rebuild
              </button>
            )}
            {canCancel && <button type="button" disabled={acting} className="jd-btn jd-btn--danger" title="Cancel this build" onClick={() => setConfirmCancel(true)}><Square /> Cancel</button>}
            <DropdownMenu
              label="More actions"
              triggerClassName="jd-more"
              trigger={<MoreHorizontal className="size-4" />}
              items={[
                { label: 'Open your website', icon: <Globe />, title: job.react_url, onSelect: () => window.open(job.react_url, '_blank', 'noopener') },
                { label: 'Open project folder', icon: <FolderOpen />, title: job.workspace_path, onSelect: () => void fetch('/api/workspace/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: job.workspace_path }) }) },
                ...(devMode ? [
                  { label: 'Compare side by side', icon: <Columns2 />, onSelect: () => { openBrowserCompare({ reactUrl: job.react_url, shopifyUrl: shopifyPreviewUrl(job) }); onNavigate?.('browser'); } },
                  { label: 'Terminal in project', icon: <TerminalSquare />, onSelect: () => { openTerminalSession({ cwd: job.workspace_path, label: job.slug }); onNavigate?.('terminal'); } },
                ] : []),
              ]}
            />
          </div>

          {/* Store / Environment / Theme */}
          <div className="jd-links">
            <button type="button" className="jd-link" title="The live store, as shoppers see it" onClick={() => window.open(job.store_url, '_blank', 'noopener')}>
              <Store className="jd-link__icon" />
              <span><small>Store</small><b>Storefront <ExternalLink className="size-3.5" /></b></span>
            </button>
            <button type="button" className="jd-link" title="The store's Shopify admin — opens in the ThemeBot window, signed in to the account that owns it" onClick={() => void openAdmin('')}>
              <LayoutGrid className="jd-link__icon" />
              <span><small>Environment</small><b>Admin</b></span>
            </button>
            <button type="button" className="jd-link" title="The store's themes — the theme ThemeBot builds shows up here" onClick={() => void openAdmin('/themes')}>
              <Palette className="jd-link__icon" />
              <span><small>Theme</small><b>Themes</b></span>
            </button>
          </div>

          <BuildProgressCard jobId={job.id} running={Boolean(job.running) || ['scaffolding', 'cloning', 'qa_running', 'fixing'].includes(job.status)} />

          {/* Match + check / fix controls */}
          <CheckPanel job={job} running={Boolean(job.running) || ['scaffolding', 'cloning', 'qa_running', 'fixing'].includes(job.status)} busy={acting} onChanged={() => { setTab('timeline'); void refresh(); }} />

          {['failed', 'blocked', 'aborted'].includes(job.status) && (
            <div className={`rounded-xl border p-4 text-[13.5px] font-semibold leading-6 ${job.status === 'blocked' ? 'border-warning/40 bg-warning/10 text-warning' : 'border-destructive/40 bg-destructive/10 text-destructive'}`}>
              <p>{plainDetail(job.status_detail) || 'The build stopped.'}</p>
              <p className="mt-1 font-medium text-muted-foreground">{job.status === 'blocked' ? blockedHint(job.status_detail) : 'Press Retry to try again. Anything already built on the draft theme is kept.'}</p>
            </div>
          )}


          <Tabs className="job-tabs job-tabs--line" value={tab} onChange={setTab} tabs={[
            { id: 'timeline', label: <><Activity className="size-4" /> Activity</> },
            { id: 'code', label: <><Code2 className="size-4" /> Live code{(Boolean(job.running) || ['scaffolding', 'cloning', 'qa_running', 'fixing'].includes(job.status)) && <span className="tab-live" title="Building now — watch it live" aria-label="live" />}</> },
            { id: 'issues', label: <><Bug className="size-4" /> Differences{issueCount != null ? <Badge variant="secondary">{issueCount}</Badge> : null}</> },
            { id: 'screenshots', label: <><Images className="size-4" /> Pictures</> },
            ...(devMode ? [{ id: 'log', label: <><ScrollText className="size-4" /> Log</> }, { id: 'reports', label: <><FileText className="size-4" /> Reports</> }] : []),
          ]} />

          {tab === 'code' && <LiveCode jobId={job.id} running={Boolean(job.running) || ['scaffolding', 'cloning', 'qa_running', 'fixing'].includes(job.status)} />}
          {tab === 'timeline' && <LiveActivity jobId={job.id} running={Boolean(job.running) || ['scaffolding', 'cloning', 'qa_running', 'fixing'].includes(job.status)} />}

          {tab === 'timeline' && (
            <div className="stagger flex flex-col">
              {!data!.iterations.length && <p className="text-[14px] font-medium text-muted-foreground">Nothing has happened yet.</p>}
              {data!.iterations.map((raw, index) => {
                // Only the newest round of a running build can still be in progress; older "running"
                // rows were cut off by a restart or a pause.
                const live = Boolean(job.running) || ['scaffolding', 'cloning', 'qa_running', 'fixing'].includes(job.status);
                const iteration = raw.status === 'running' && !(live && index === data!.iterations.length - 1) ? { ...raw, status: 'interrupted' } as Iteration : raw;
                return (
                <div key={iteration.id} className={`jd-row jd-row--${iteration.status}`}>
                  <span className="jd-row__time">{new Date(iteration.started_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                  <div className="flex flex-col items-center">
                    <span className="flex size-8 items-center justify-center rounded-full border border-border bg-card shadow-sm">{iterationIcon(iteration)}</span>
                    {index < data!.iterations.length - 1 && <div className="my-1 w-px flex-1 bg-border" />}
                  </div>
                  <div className="flex-1 pb-6">
                    <p className="flex flex-wrap items-center gap-2 text-[15px] font-bold leading-8">
                      {kindMeta[iteration.kind].icon} {kindMeta[iteration.kind].label}
                      {iteration.kind !== 'clone' && <span className="text-[13px] font-semibold text-muted-foreground">round {iteration.iteration}</span>}
                      {iteration.score != null && <Badge variant={iteration.status === 'regressed' ? 'warning' : 'info'}>{(iteration.score * 100).toFixed(1)}%{iteration.status === 'regressed' ? ' ↓' : ''}</Badge>}
                    </p>
                    <p className="mt-0.5 text-[13px] font-medium text-muted-foreground">
                      {(() => { const text = plainRoundStatus(iteration.status); return text.charAt(0).toUpperCase() + text.slice(1); })()}
                      {iteration.breakdown ? ` · ${String((iteration.breakdown as { issues?: number }).issues ?? '—')} differences` : ''}
                    </p>
                    {iteration.kind === 'qa' && <SubscoreChips breakdown={iteration.breakdown} />}
                  </div>
                </div>
                );
              })}
            </div>
          )}

          {tab === 'issues' && <IssuesTab jobId={job.id} reports={data!.reports} />}
          {tab === 'log' && <div className="min-h-0 flex-1"><LiveLog jobId={job.id} iterations={data!.iterations} /></div>}
          {tab === 'reports' && <Reports jobId={job.id} reports={data!.reports} />}
          {tab === 'screenshots' && <Screenshots jobId={job.id} />}
        </div>
      )}
      <ConfirmDialog
        open={confirmRebuild}
        title={`Rebuild "${job?.name ?? ''}"?`}
        description="ThemeBot starts this build again from the first step, on the same store with the same connection. The last run's reports are kept in the project folder; its rounds are cleared from this timeline."
        confirmLabel="Rebuild"
        onCancel={() => setConfirmRebuild(false)}
        onConfirm={() => { setConfirmRebuild(false); if (job) { setTab('code'); void act('Rebuilding', () => api.rebuild(job.id)); } }}
      />
      <ConfirmDialog
        open={confirmCancel}
        title={`Cancel "${job?.name ?? ''}"?`}
        description="ThemeBot stops working on this store. Anything already built on the draft theme is kept, and you can delete the build afterwards."
        confirmLabel="Cancel build" destructive
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => { setConfirmCancel(false); if (job) void act('Job canceled', () => api.cancel(job.id)); }}
      />
    </Sheet>
  );
}
