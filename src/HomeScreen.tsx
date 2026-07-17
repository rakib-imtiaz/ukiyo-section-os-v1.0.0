// HOME — control-plane dashboard (3 columns: shell sidebar / main / right rail).
// Rendered inside its own .factory-root wrapper so it shares the factory's
// token set, Tailwind utilities, and light/dark theming. The blue accent is a
// deliberate departure from the app's strict monochrome (see home/home.css).
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight, BookOpen, Factory, FolderKanban, KeyRound, Layers3, Link2, Plus, Rocket, WandSparkles,
} from 'lucide-react';
import './factory/theme.css';
import './home/home.css';
import { SpotlightCard, useReducedMotion } from './factory/fx';
import { useLiveFactory } from './home/useLiveFactory';
import type { Iteration, Job, JobStatus } from './factory/types';

export type HomeTarget = 'factory' | 'build' | 'projects' | 'contract' | 'deploy' | 'settings' | 'code';

/** Follows the app-shell theme set by the theme toggle (localStorage + <html data-app-theme>). */
function useFactoryTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem('factory-theme') === 'dark' ? 'dark' : 'light');
  useEffect(() => {
    const sync = () => setTheme(document.documentElement.getAttribute('data-app-theme') === 'dark' ? 'dark' : 'light');
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-app-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

interface DashStats { authenticated: boolean | null; projects: number | null; sections: number | null; deployments: number | null; apis: number | null; storage: string | null; uptimeSec: number | null }

interface WorkspaceProject { name: string; path: string; reactUrl: string; storeUrl: string; status: string; summary: string; sectionsCount: number }

/** Live workspace: discovered projects + summed sections, and the newest as the current target. */
function useWorkspace(): { name: string | null; projects: WorkspaceProject[] } {
  const [state, setState] = useState<{ name: string | null; projects: WorkspaceProject[] }>({ name: null, projects: [] });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const r = await fetch('/api/workspace/state'); if (!r.ok) return; const data = await r.json();
        if (alive) setState({ name: data.name ?? null, projects: Array.isArray(data.projects) ? data.projects : [] }); } catch { /* ignore */ }
    };
    void load();
    const id = window.setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);
  return state;
}

/** Poll the onboarding/background progress feed for the terminal card. */
function useOnboardingProgress(): { lines: string[]; busy: boolean } {
  const [state, setState] = useState<{ lines: string[]; busy: boolean }>({ lines: [], busy: false });
  const since = useRef(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const r = await fetch(`/api/onboarding/progress?since=${since.current}`); if (!r.ok) return; const data = await r.json();
        if (!alive) return;
        if (Array.isArray(data.lines) && data.lines.length) { since.current = data.lines[data.lines.length - 1].at; setState((current) => ({ lines: [...current.lines, ...data.lines.map((l: { line: string }) => l.line)].slice(-40), busy: data.busy })); }
        else setState((current) => ({ ...current, busy: data.busy })); } catch { /* ignore */ }
    };
    void tick();
    const id = window.setInterval(() => { if (!document.hidden) void tick(); }, 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);
  return state;
}

/** Live control-plane stats. Counts stay null (rendered as "—") until real data loads or when
 *  no store is connected — never fabricated placeholder numbers. */
function useDashboardStats(): DashStats {
  const [stats, setStats] = useState<DashStats>({ authenticated: null, projects: null, sections: null, deployments: null, apis: null, storage: null, uptimeSec: null });
  useEffect(() => {
    let alive = true;
    const json = async (url: string) => { try { const response = await fetch(url); return response.ok ? await response.json() : null; } catch { return null; } };
    (async () => {
      const [session, health] = await Promise.all([json('/api/session'), json('/api/health')]);
      const authenticated = !!session?.authenticated;
      let projects: number | null = null, deployments: number | null = null, apis: number | null = null;
      if (authenticated) {
        const [projectData, deployData, keyData] = await Promise.all([json('/api/projects'), json('/api/deployments'), json('/api/api-keys')]);
        projects = Array.isArray(projectData?.projects) ? projectData.projects.length : null;
        deployments = Array.isArray(deployData?.deployments) ? deployData.deployments.length : null;
        apis = Array.isArray(keyData?.keys) ? keyData.keys.filter((key: { revoked_at?: string | null }) => !key.revoked_at).length : null;
      }
      if (alive) setStats({ authenticated, projects, sections: projects, deployments, apis, storage: health?.database ?? null, uptimeSec: typeof health?.uptimeSec === 'number' ? health.uptimeSec : null });
    })();
    return () => { alive = false; };
  }, []);
  return stats;
}

const INTRO_KEY = 'factory-intro-played';

function IntroOverlay({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<'open' | 'closed'>('open');
  const closing = useRef(false);
  const finish = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setState('closed');
    setTimeout(onDone, 500);
  }, [onDone]);
  useEffect(() => {
    sessionStorage.setItem(INTRO_KEY, '1');
    const timer = setTimeout(finish, 1600);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey); };
  }, [finish]);
  const letters = 'THEMEBOT'.split('');
  return (
    <div
      className="intro-overlay fixed inset-0 z-[100] flex cursor-pointer flex-col items-center justify-center gap-7 bg-background"
      data-state={state} onClick={finish} role="presentation" aria-label="Intro — click to skip"
    >
      <div className="intro-mark home-blue-fill flex size-20 items-center justify-center rounded-2xl shadow-xl">
        <Layers3 className="size-9" aria-hidden />
      </div>
      <div className="text-2xl font-bold tracking-[0.3em] sm:text-3xl" aria-label="ThemeBot">
        {letters.map((letter, index) => (
          <span key={index} aria-hidden className="intro-letter" style={{ ['--letter-i' as string]: index }}>
            {letter === ' ' ? ' ' : letter}
          </span>
        ))}
      </div>
      <p className="intro-tagline text-[12px] font-bold uppercase tracking-[0.22em] text-muted-foreground">The autonomous Shopify theme builder</p>
      <p className="intro-skip absolute bottom-8 text-[12px] font-semibold text-muted-foreground">Click anywhere to skip</p>
    </div>
  );
}

/* ————————————————————————— Main column ————————————————————————— */

function HomeTopBar({ onNavigate }: { onNavigate: (view: HomeTarget) => void }) {
  // Theme toggle lives once in the app shell topbar (consistent across every page) — not here.
  return (
    <div className="rise-in flex flex-wrap items-center gap-3">
      <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
        Control plane <span className="opacity-40">/</span> <span className="text-foreground">Overview</span>
        <span className="inline-block size-1.5 rounded-full bg-brand-blue" aria-hidden />
      </p>
      <div className="ml-auto flex items-center gap-2.5">
        <button
          type="button" onClick={() => onNavigate('settings')}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-[12px] font-bold text-foreground shadow-sm transition-colors hover:border-brand-blue/50"
          title="API & MCP access"
        >
          <BookOpen className="size-3.5" /> Docs
        </button>
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-success shadow-sm">
          Live <span className="pulse-dot relative inline-flex size-1.5 rounded-full bg-success" aria-hidden />
        </span>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="flex flex-col items-start justify-center gap-4 py-2">
      <span className="inline-flex items-center gap-2.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground shadow-sm">
        <Layers3 className="size-3.5 text-brand-blue" aria-hidden />
        ThemeBot · Control plane
      </span>
      <h1 className="text-4xl font-bold tracking-tight sm:text-[46px] sm:leading-[1.08]">
        What are you <em className="home-serif">building</em> today?
      </h1>
      <p className="max-w-xl text-[15px] font-medium leading-relaxed text-muted-foreground">
        Clone entire React sites into Shopify stores autonomously, design modular sections visually, and ship them to
        themes — all from one monochrome cockpit.
      </p>
    </section>
  );
}

interface LogLine { t: string; glyph: '▸' | '✓' | '●'; text: string; dot: 'blue' | 'green' | 'orange' }

const PIPELINE_LOG: LogLine[] = [
  { t: '10:42:31', glyph: '▸', text: 'Scaffolding sections...', dot: 'blue' },
  { t: '10:42:11', glyph: '▸', text: 'Cloning components...', dot: 'blue' },
  { t: '10:42:04', glyph: '▸', text: 'Running QA in real browser...', dot: 'orange' },
  { t: '10:41:52', glyph: '✓', text: 'APIs synced', dot: 'green' },
  { t: '10:41:27', glyph: '▸', text: 'Finding matching elements...', dot: 'orange' },
  { t: '10:41:03', glyph: '▸', text: 'Deploying to theme...', dot: 'blue' },
  { t: '10:41:00', glyph: '●', text: 'Deployment queued', dot: 'blue' },
  { t: '10:40:58', glyph: '✓', text: 'Preview URL: themebot.dev/theme/1a2b3c4d', dot: 'green' },
];

const PIPE_NODES = ['CLONE', 'QA', 'FIX', 'DEPLOY'] as const;

function pipeIndexFor(job: Job | null): number {
  if (!job) return -1; // no live job → no node highlighted (honest idle state)
  switch (job.status) {
    case 'queued': case 'scaffolding': case 'cloning': return 0;
    case 'qa_running': return 1;
    case 'fixing': case 'blocked': case 'paused': return 2;
    case 'converged': return 3;
    default: return 2;
  }
}

function glyphClass(glyph: LogLine['glyph']) {
  if (glyph === '✓') return 'text-success';
  if (glyph === '●') return 'text-brand-blue';
  return 'text-zinc-100';
}

/** ✓/OK/PASSED lines render green, error lines red, the rest neutral. */
function liveLineTone(text: string): 'green' | 'red' | 'plain' {
  if (/✗|✖|\berror\b|\bfailed?\b|\bfatal\b|exception/i.test(text)) return 'red';
  if (/✓|✔|\bok\b|\bpassed\b|\bpass\b|\bdone\b|success/i.test(text)) return 'green';
  return 'plain';
}

function TerminalCard({ job, lines, reduced, bootLines }: { job: Job | null; lines: string[] | null; reduced: boolean; bootLines?: string[] }) {
  // Boot/onboarding progress (dir init, discovery, Haiku scans) takes priority over factory logs.
  const booting = Boolean(bootLines && bootLines.length > 0);
  const effectiveLines = booting ? bootLines! : lines;
  const live = booting || Boolean(job && lines && lines.length > 0);
  // The CLONE—QA—FIX—DEPLOY track maps from the real status whenever a job exists.
  const active = pipeIndexFor(job);
  // Subtle refresh loop (demo mode only): re-key the log every ~14s so the lines re-type in.
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    if (reduced || live) return;
    const timer = setInterval(() => setCycle((current) => current + 1), 14000);
    return () => clearInterval(timer);
  }, [reduced, live]);
  // Boot/onboarding lines reveal ONE AT A TIME (~220ms) so a refresh reads like tasks streaming
  // in, instead of dumping all at once. Stable absolute-index keys mean only the newest line mounts
  // (and plays its fade-in); continuous factory logs are shown in full immediately.
  const total = effectiveLines?.length ?? 0;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!booting) { setShown(total); return; }
    if (shown >= total) return;
    const step = window.setTimeout(() => setShown((current) => Math.min(total, current + 1)), reduced ? 0 : 220);
    return () => window.clearTimeout(step);
  }, [booting, shown, total, reduced]);
  useEffect(() => { if (shown > total) setShown(total); }, [total, shown]);
  const revealCount = booting ? shown : total;
  const start = live && effectiveLines ? Math.max(0, revealCount - 12) : 0;
  const liveTail = live && effectiveLines ? effectiveLines.slice(start, revealCount) : [];
  return (
    <section className="home-terminal flex min-w-0 flex-col rounded-2xl p-5 sm:p-6" aria-label="ThemeBot pipeline">
      <header className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[10px] font-bold uppercase tracking-[0.22em] text-zinc-400">
          {booting ? 'Workspace indexing' : job ? job.name : 'ThemeBot · Factory pipeline'}
        </span>
        <span className="inline-flex shrink-0 items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-success">
          Live <span className="pulse-dot relative inline-flex size-1.5 rounded-full bg-success" aria-hidden />
        </span>
      </header>
      {live ? (
        <div className="mt-4 grid content-end gap-[7px] font-mono text-[12px] leading-relaxed min-h-[344px]">
          {liveTail.map((line, index) => {
            const tone = liveLineTone(line);
            return (
              <div key={start + index} className="home-log-line home-log-line--live">
                <span className={tone === 'green' ? 'text-success' : tone === 'red' ? 'text-red-400' : 'text-zinc-500'}>
                  {tone === 'green' ? '✓' : tone === 'red' ? '✗' : '▸'}
                </span>
                <span className={`truncate ${tone === 'green' ? 'text-success' : tone === 'red' ? 'text-red-400' : 'text-zinc-200'}`}>{line}</span>
              </div>
            );
          })}
          <div className="home-log-line home-log-line--live" aria-hidden>
            <span className="text-zinc-500">▸</span>
            <span><span className="home-caret" /></span>
          </div>
        </div>
      ) : (
        <div key={cycle} className="mt-4 grid content-end gap-[7px] font-mono text-[12px] leading-relaxed min-h-[344px]">
          {PIPELINE_LOG.map((line, index) => (
            <div key={index} className="home-log-line" style={{ animationDelay: `${0.15 + index * 0.14}s` }}>
              <span className="text-zinc-500">{line.t}</span>
              <span className={glyphClass(line.glyph)}>{line.glyph}</span>
              <span className={`truncate ${line.glyph === '✓' ? 'text-success' : line.glyph === '●' ? 'text-brand-blue' : 'text-zinc-200'}`}>{line.text}</span>
            </div>
          ))}
          <div className="home-log-line" style={{ animationDelay: `${0.15 + PIPELINE_LOG.length * 0.14}s` }} aria-hidden>
            <span className="text-zinc-600">--:--:--</span>
            <span className="text-zinc-500">▸</span>
            <span><span className="home-caret" /></span>
          </div>
        </div>
      )}
      <div className="home-pipe mt-auto" role="img" aria-label={active >= 0 ? `Pipeline: ${PIPE_NODES[active]} in progress` : 'Pipeline idle — no active job'}>
        {PIPE_NODES.map((node, index) => (
          <Fragment key={node}>
            {index > 0 && <span className={`home-pipe__seg${index <= active ? ' is-filled' : ''}`} aria-hidden />}
            <span className={`home-pipe__node${index === active ? ' is-active' : index < active ? ' is-done' : ''}`}>
              <i className="home-pipe__dot" />
              <span className="home-pipe__label">{node}</span>
            </span>
          </Fragment>
        ))}
      </div>
    </section>
  );
}

function StatsRow({ stats: data }: { stats: DashStats }) {
  const show = (value: number | null) => (value == null ? '—' : value);
  const stats = [
    { icon: FolderKanban, value: show(data.projects), label: 'Projects' },
    { icon: Layers3, value: show(data.sections), label: 'Sections' },
    { icon: Rocket, value: show(data.deployments), label: 'Deployments' },
    { icon: KeyRound, value: show(data.apis), label: 'APIs Connected' },
  ];
  return (
    <section className="rise-in home-card grid grid-cols-2 gap-y-2 rounded-2xl border border-border bg-card p-2 sm:grid-cols-4" style={{ animationDelay: '0.2s' }}>
      {stats.map(({ icon: Icon, value, label }) => (
        <div key={label} className="flex items-center gap-3 rounded-xl px-4 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-blue/10 text-brand-blue">
            <Icon className="size-4" />
          </span>
          <span className="min-w-0">
            <b className="block text-[17px] font-bold leading-tight tabular-nums">{value}</b>
            <span className="block truncate text-[11.5px] font-semibold text-muted-foreground">{label}</span>
          </span>
        </div>
      ))}
    </section>
  );
}

function FeatureCard({ icon, title, chip, copy, cta, onClick, image, tall, children }: {
  icon: React.ReactNode; title: string; chip?: string; copy: string; cta: string; onClick: () => void;
  image?: string; tall?: boolean; children?: React.ReactNode;
}) {
  return (
    <SpotlightCard className={`home-card group rounded-2xl ${tall ? 'lg:row-span-2' : ''}`}>
      <div className="relative flex h-full flex-col gap-4 overflow-hidden p-6">
        {/* Framed chip anchored INSIDE the card: the source PNGs have light backgrounds,
            so free-floating they read as gray boxes in dark mode and detach at mid widths. */}
        {image && (
          <img
            src={image} alt="" aria-hidden loading="lazy"
            className="home-float pointer-events-none absolute bottom-4 right-4 hidden w-16 select-none rounded-xl border border-border object-cover opacity-90 shadow-sm sm:block"
          />
        )}
        <div className="flex items-start justify-between gap-4">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-muted text-foreground transition-transform duration-300 ease-out group-hover:-rotate-3 group-hover:scale-110 [&_svg]:size-5">
            {icon}
          </span>
          {chip && (
            <span className="rounded-full bg-brand-blue/10 px-2.5 py-1 text-[11px] font-bold text-brand-blue">{chip}</span>
          )}
        </div>
        <div className={image ? 'pr-16' : undefined}>
          <h3 className="text-[17px] font-bold tracking-tight">{title}</h3>
          <p className="mt-1.5 text-[13.5px] font-medium leading-relaxed text-muted-foreground">{copy}</p>
        </div>
        {children}
        <button
          type="button" onClick={onClick}
          className="mt-auto inline-flex w-max items-center gap-1.5 text-[13.5px] font-bold text-foreground transition-colors hover:text-brand-blue"
        >
          {cta}
          <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-1" />
        </button>
      </div>
    </SpotlightCard>
  );
}

/** Embedded mini-mock of the visual builder: layer rows + chair-image preview. */
function BuilderMiniPreview() {
  const layers = ['Hero/Banner', 'Container', 'Headline', 'Text', 'Button', 'Media'];
  return (
    <div className="grid gap-3 rounded-xl border border-border bg-muted/60 p-3 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-2 shadow-sm">
        <span className="px-2 pb-1 pt-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Layers</span>
        {layers.map((layer, index) => (
          <span
            key={layer}
            className={`flex items-center gap-2 rounded-md px-2 py-[5px] text-[11px] font-semibold ${index === 0 ? 'bg-brand-blue/10 text-brand-blue' : 'text-muted-foreground'}`}
          >
            <i className={`size-1.5 shrink-0 rounded-[2px] ${index === 0 ? 'bg-brand-blue' : 'bg-current opacity-50'}`} />
            {layer}
          </span>
        ))}
      </div>
      <div className="relative min-h-[178px] overflow-hidden rounded-lg shadow-sm">
        <img src="/home-assets/modern_gray_armchair_in_minimalist_studio.png" alt="" aria-hidden loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent" aria-hidden />
        <div className="relative flex h-full flex-col justify-end gap-1.5 p-3.5 text-white">
          <span className="text-[8px] font-bold uppercase tracking-[0.26em] opacity-80">ThemeBot</span>
          <span className="text-[16px] leading-tight" style={{ fontFamily: 'Newsreader, Georgia, serif', fontWeight: 400 }}>Built for performance</span>
          <span className="mt-1 flex gap-1.5">
            <i className="rounded-[3px] bg-white px-2 py-1 text-[8px] font-bold uppercase not-italic tracking-[0.08em] text-black">Shop now</i>
            <i className="rounded-[3px] border border-white/60 px-2 py-1 text-[8px] font-bold uppercase not-italic tracking-[0.08em]">Learn more</i>
          </span>
        </div>
      </div>
    </div>
  );
}

function FeatureGrid({ onNavigate, projectCount, deploymentCount }: {
  onNavigate: (view: HomeTarget) => void; projectCount: number | null; deploymentCount: number | null;
}) {
  return (
    <div className="stagger grid items-stretch gap-5 lg:grid-cols-2">
      <FeatureCard
        tall
        icon={<WandSparkles />}
        title="Visual Section Builder"
        chip="26 controls"
        copy="Design cinematic hero sections with 26 native theme controls and a live desktop + mobile preview."
        cta="Start designing"
        onClick={() => onNavigate('build')}
      >
        <BuilderMiniPreview />
      </FeatureCard>
      <FeatureCard
        icon={<Factory />}
        title="Clone Factory"
        chip="Autonomous"
        copy="Clone entire React sites into Shopify stores autonomously, with real-browser QA and auto-fix loops."
        cta="New clone job"
        onClick={() => onNavigate('factory')}
        image="/home-assets/glowing_orbital_diagram_on_transparent_background.png"
      />
      <FeatureCard
        icon={<FolderKanban />}
        title="Projects Library"
        chip={projectCount != null ? `${projectCount} projects` : undefined}
        copy="Every saved section project, versioned on each change and ready to reopen or redeploy."
        cta="Browse projects"
        onClick={() => onNavigate('projects')}
        image="/home-assets/frosted_glass_folder_stack_icon.png"
      />
      <FeatureCard
        icon={<Rocket />}
        title="Deployments"
        chip={deploymentCount != null ? `${deploymentCount} active` : undefined}
        copy="Install compiled section packages to unpublished themes, with a full ledger and one-click rollback."
        cta="View deployments"
        onClick={() => onNavigate('deploy')}
        image="/home-assets/glowing_status_icons_on_transparent_background.png"
      />
      <FeatureCard
        icon={<KeyRound />}
        title="Connections & API Keys"
        copy="Connect Shopify stores and mint scoped keys for Claude, Kimi, Bolt, or any outside coding agent."
        cta="Manage access"
        onClick={() => onNavigate('settings')}
        image="/home-assets/futuristic_security_lock_in_cube.png"
      />
      <FeatureCard
        icon={<Layers3 />}
        title="Generated Files"
        copy="All assets: theme liquid, section schemas, snippets, and assets — organized and versioned."
        cta="Open files"
        onClick={() => onNavigate('code')}
        image="/home-assets/frosted_glass_cube_with_warm_glow.png"
      />
    </div>
  );
}

const BANNERS = [
  { image: '/home-assets/glossy_blue_curly_braces_icon.png', title: 'Design-contract driven', sub: 'Every section follows a strict contract.' },
  { image: '/home-assets/minimalist_shopping_bag_icon.png', title: 'Native Shopify output', sub: 'Clean, production-ready Liquid & JSON.' },
  { image: '/home-assets/glossy_blue_shield_with_checkmark.png', title: 'Version-controlled everything', sub: 'Traceable, rollback-safe, audit-ready.' },
];

function BannerRow() {
  // Mobile-first: single column, 3-up only when there's genuinely room (xl).
  // Copy WRAPS — truncating these descriptions made them unreadable at mid widths.
  return (
    <section className="stagger grid grid-cols-1 gap-4 xl:grid-cols-3">
      {BANNERS.map((banner) => (
        <div key={banner.title} className="home-card flex items-center gap-3.5 rounded-2xl border border-border bg-card px-5 py-4">
          <img src={banner.image} alt="" aria-hidden loading="lazy" className="home-float-slow size-11 shrink-0 select-none rounded-xl border border-border object-cover shadow-sm" />
          <div className="min-w-0">
            <b className="block text-[14px] font-bold leading-snug">{banner.title}</b>
            <p className="text-[13px] font-medium leading-snug text-muted-foreground">{banner.sub}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

/* ————————————————————————— Right rail ————————————————————————— */

const OPS_TABS = ['Pipeline', 'QA', 'Deploy'] as const;
type OpsTab = (typeof OPS_TABS)[number];
const DOT_CLASS: Record<LogLine['dot'], string> = { blue: 'bg-brand-blue', green: 'bg-success', orange: 'bg-warning' };

function iterationDot(status: string): LogLine['dot'] {
  if (/success|passed|converged|done|complete|ok/i.test(status)) return 'green';
  if (/fail|error|abort|blocked/i.test(status)) return 'orange';
  return 'blue';
}

/** Live iterations → OPERATIONS LOG rows (newest first). */
function iterationEntries(iterations: Iteration[]): LogLine[] {
  return [...iterations]
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
    .slice(0, 8)
    .map((iteration) => ({
      t: new Date(iteration.started_at).toLocaleTimeString('en-GB', { hour12: false }),
      glyph: '▸' as const,
      text: `${iteration.kind.toUpperCase()} · iter ${iteration.iteration} — ${iteration.status}${iteration.score != null ? ` · ${Math.round(iteration.score)}%` : ''}`,
      dot: iterationDot(iteration.status),
    }));
}

/** Real operations per tab, drawn from the live iteration timeline — no mock fallback.
 *  Returns null when there is no live run (API unreachable / no active job) so the UI can
 *  distinguish "unknown" from a genuinely empty (but live) tab. */
function opsEntriesFor(tab: OpsTab, iterations: Iteration[] | null): LogLine[] | null {
  // Deploys are recorded on the Deployments page, not the factory iteration feed.
  if (tab === 'Deploy') return [];
  if (iterations === null) return null;
  if (tab === 'QA') return iterationEntries(iterations.filter((iteration) => iteration.kind === 'qa'));
  return iterationEntries(iterations);
}

function opsEmptyMessage(tab: OpsTab): string {
  if (tab === 'Deploy') return 'Deploy activity is tracked on the Deployments page.';
  if (tab === 'QA') return 'No QA iterations in the current run yet.';
  return 'No operations in the current run yet.';
}

function OperationsLog({ iterations }: { iterations: Iteration[] | null }) {
  const [tab, setTab] = useState<OpsTab>('Pipeline');
  const entries = opsEntriesFor(tab, iterations);
  return (
    <section className="home-card rounded-2xl border border-border bg-card p-5">
      <h3 className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Operations log</h3>
      <div className="mt-2.5 flex items-center gap-5 border-b border-border" role="tablist" aria-label="Operations log filter">
        {OPS_TABS.map((name) => (
          <button key={name} type="button" role="tab" aria-selected={tab === name}
            className={`home-tab${tab === name ? ' is-active' : ''}`} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>
      {/* Column flex (not grid): an implicit grid column sizes to the widest row's
          max-content, so nowrap labels overflow the card instead of truncating. */}
      {entries === null ? (
        <p key={`${tab}-idle`} className="tab-panel mt-3 px-1.5 py-6 text-center text-[12px] font-semibold text-muted-foreground">
          Waiting for a live clone job to stream operations.
        </p>
      ) : entries.length === 0 ? (
        <p key={`${tab}-empty`} className="tab-panel mt-3 px-1.5 py-6 text-center text-[12px] font-semibold text-muted-foreground">
          {opsEmptyMessage(tab)}
        </p>
      ) : (
        <ul key={tab} className="tab-panel mt-3 flex min-w-0 flex-col gap-0.5">
          {entries.map((entry, index) => (
            <li key={index} className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-[7px] transition-colors hover:bg-muted/70">
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{entry.t}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{entry.text}</span>
              <i className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS[entry.dot]}`} aria-hidden />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ————————————————————————— Fleet summary ————————————————————————— */

const FLEET_RUNNING: JobStatus[] = ['scaffolding', 'cloning', 'qa_running', 'fixing'];
const FLEET_BLOCKED: JobStatus[] = ['blocked', 'paused', 'exhausted', 'failed', 'aborted', 'canceled'];

interface FleetCounts { running: number; queued: number; converged: number; blocked: number }

function fleetCounts(jobs: Job[]): FleetCounts {
  const counts: FleetCounts = { running: 0, queued: 0, converged: 0, blocked: 0 };
  for (const job of jobs) {
    if (FLEET_RUNNING.includes(job.status)) counts.running += 1;
    else if (job.status === 'queued') counts.queued += 1;
    else if (job.status === 'converged') counts.converged += 1;
    else if (FLEET_BLOCKED.includes(job.status)) counts.blocked += 1;
  }
  return counts;
}

/** Real fleet snapshot across ALL jobs from /api/factory/jobs — not just the single active job. */
function FleetSummary({ jobs, onNavigate }: { jobs: Job[] | null; onNavigate: (view: HomeTarget) => void }) {
  const counts = jobs ? fleetCounts(jobs) : null;
  const show = (value: number | undefined) => (counts == null || value == null ? '—' : value);
  const cells: Array<{ key: keyof FleetCounts; label: string; dot: string; tone: string }> = [
    { key: 'running', label: 'Running', dot: 'bg-brand-blue', tone: 'text-brand-blue' },
    { key: 'queued', label: 'Queued', dot: 'bg-muted-foreground', tone: 'text-foreground' },
    { key: 'converged', label: 'Converged', dot: 'bg-success', tone: 'text-success' },
    { key: 'blocked', label: 'Blocked', dot: 'bg-warning', tone: 'text-warning' },
  ];
  return (
    <section className="home-card rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Clone fleet</h3>
        <button
          type="button" onClick={() => onNavigate('factory')}
          className="inline-flex items-center gap-1 text-[11px] font-bold text-brand-blue transition-colors hover:text-brand-blue/80"
        >
          Open factory <ArrowRight className="size-3" />
        </button>
      </div>
      <div className="mt-3.5 grid grid-cols-2 gap-2">
        {cells.map((cell) => (
          <div key={cell.key} className="flex items-center gap-2.5 rounded-xl border border-border bg-muted/40 px-3 py-2.5">
            <i className={`size-1.5 shrink-0 rounded-full ${cell.dot}`} aria-hidden />
            <span className="min-w-0">
              <b className={`block text-[19px] font-bold leading-none tabular-nums ${cell.tone}`}>{show(counts?.[cell.key])}</b>
              <span className="mt-1 block truncate text-[11px] font-semibold text-muted-foreground">{cell.label}</span>
            </span>
          </div>
        ))}
      </div>
      {jobs != null && jobs.length === 0 && (
        <p className="mt-3 text-[11.5px] font-semibold text-muted-foreground">No clone jobs yet — start one in the Factory.</p>
      )}
    </section>
  );
}

function PipelineStatus({ job }: { job: Job | null }) {
  const reduced = useReducedMotion();
  const [filled, setFilled] = useState(reduced);
  useEffect(() => {
    const timer = setTimeout(() => setFilled(true), 250);
    return () => clearTimeout(timer);
  }, []);
  const iteration = job?.iteration ?? 0;
  const maxIterations = job?.max_iterations ?? 0;
  const score = job?.last_score ?? null;
  const threshold = job?.score_threshold ?? null;
  const pct = !job ? 0 : Math.max(0, Math.min(100, Math.round((score != null && threshold ? score / threshold : iteration / Math.max(1, maxIterations)) * 100)));
  return (
    <section className="home-card rounded-2xl border border-border bg-card p-5">
      <h3 className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Pipeline status</h3>
      <div className="mt-3 flex items-baseline gap-2">
        <b className="text-[30px] font-bold leading-none tabular-nums tracking-tight">{job ? `${iteration} / ${maxIterations}` : '—'}</b>
        <span className="text-[12px] font-semibold text-muted-foreground">{job ? 'QA iterations' : 'No active job'}</span>
      </div>
      <div className="home-progress-green mt-4" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: filled ? `${pct}%` : '0%' }} />
      </div>
      <div className="mt-3.5 flex items-center justify-between text-[12px] font-semibold">
        <span className="text-muted-foreground">{job ? 'Score' : 'Status'}</span>
        <span className="font-mono tabular-nums">{job ? (score != null ? `${Math.round(score)}${threshold ? ` / ${Math.round(threshold)}` : ''}` : job.status.replace(/_/g, ' ')) : 'Idle'}</span>
      </div>
    </section>
  );
}

function CurrentTarget({ job, project }: { job: Job | null; project?: WorkspaceProject | null }) {
  const name = job?.name ?? project?.name ?? 'No active project';
  const target = job?.store_url ?? project?.storeUrl ?? project?.reactUrl ?? 'Select a project to begin';
  return (
    <section className="home-card flex items-center gap-3.5 rounded-2xl border border-border bg-card p-5">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-success/10 shadow-sm">
        <img src="/home-assets/minimalist_shopping_bag_icon.png" alt="" aria-hidden className="size-7 object-contain" />
      </span>
      <div className="min-w-0">
        <h3 className="mb-0.5 text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Current target</h3>
        <b className="block truncate text-[13.5px] font-bold">{name}</b>
        <code className="block truncate font-mono text-[11px] text-muted-foreground">{target}</code>
      </div>
    </section>
  );
}

function QuickActions({ onNavigate }: { onNavigate: (view: HomeTarget) => void }) {
  return (
    <section className="home-card rounded-2xl border border-border bg-card p-5">
      <h3 className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Quick actions</h3>
      <div className="mt-3.5 grid gap-2.5">
        <button
          type="button" onClick={() => onNavigate('factory')}
          className="home-blue-fill inline-flex h-10 items-center justify-center gap-2 rounded-xl text-[13px] font-bold transition-transform hover:-translate-y-0.5 active:translate-y-0"
        >
          <Factory className="size-4" /> New clone job
        </button>
        <button
          type="button" onClick={() => onNavigate('projects')}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border bg-muted/60 text-[13px] font-bold transition-all hover:-translate-y-0.5 hover:border-brand-blue/50 active:translate-y-0"
        >
          <Plus className="size-4" /> Create new project
        </button>
        <button
          type="button" onClick={() => onNavigate('settings')}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border bg-muted/60 text-[13px] font-bold transition-all hover:-translate-y-0.5 hover:border-brand-blue/50 active:translate-y-0"
        >
          <Link2 className="size-4" /> Connect new store
        </button>
      </div>
    </section>
  );
}

/* ————————————————————————— Screen ————————————————————————— */

export default function HomeScreen({ onNavigate }: { onNavigate: (view: HomeTarget) => void }) {
  const theme = useFactoryTheme();
  const reduced = useReducedMotion();
  const stats = useDashboardStats();
  const workspace = useWorkspace();
  const boot = useOnboardingProgress();
  const { jobs, activeJob, lines, iterations } = useLiveFactory();
  const targetJob = activeJob ?? jobs?.[0] ?? null;
  // When a workspace is active its discovered projects are the meaningful counts.
  const mergedStats: DashStats = workspace.projects.length
    ? { ...stats, projects: workspace.projects.length, sections: workspace.projects.reduce((sum, project) => sum + (project.sectionsCount || 0), 0) }
    : stats;
  const [showIntro, setShowIntro] = useState(() => {
    if (typeof window === 'undefined') return false;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    return sessionStorage.getItem(INTRO_KEY) !== '1';
  });

  return (
    <div className="factory-root home-root h-full min-h-0 overflow-y-auto" data-theme={theme}>
      {showIntro && !reduced && <IntroOverlay onDone={() => setShowIntro(false)} />}

      <div className="relative min-h-full">
        {/* subtle backdrop: dot grid fading into the page */}
        <div className="dot-grid pointer-events-none absolute inset-x-0 top-0 h-[380px]" aria-hidden
          style={{ maskImage: 'radial-gradient(ellipse 80% 100% at 50% 0%, black 15%, transparent 72%)', WebkitMaskImage: 'radial-gradient(ellipse 80% 100% at 50% 0%, black 15%, transparent 72%)' }} />

        <div className="relative mx-auto w-full max-w-[1440px] px-5 py-8 md:px-8 md:py-10">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
            {/* MAIN COLUMN */}
            <div className="flex min-w-0 flex-col gap-6">
              <HomeTopBar onNavigate={onNavigate} />
              <div className="stagger grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
                <Hero />
                <TerminalCard job={activeJob} lines={lines} reduced={reduced} bootLines={boot.busy || boot.lines.length ? boot.lines : undefined} />
              </div>
              <StatsRow stats={mergedStats} />
              <FeatureGrid onNavigate={onNavigate} projectCount={mergedStats.projects} deploymentCount={mergedStats.deployments} />
              <BannerRow />
            </div>

            {/* RIGHT RAIL */}
            <aside className="stagger grid min-w-0 content-start gap-5 sm:grid-cols-2 xl:grid-cols-1" aria-label="Live status">
              <div className="sm:col-span-2 xl:col-span-1"><FleetSummary jobs={jobs} onNavigate={onNavigate} /></div>
              <div className="sm:col-span-2 xl:col-span-1"><OperationsLog iterations={iterations} /></div>
              <PipelineStatus job={targetJob} />
              <CurrentTarget job={targetJob} project={workspace.projects[0] ?? null} />
              <div className="sm:col-span-2 xl:col-span-1"><QuickActions onNavigate={onNavigate} /></div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
