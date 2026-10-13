import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  CircleAlert, ExternalLink, Factory, FolderKanban, FolderOpen, Globe, House, KeyRound, Layers, LoaderCircle, LogOut,
  Link2, RefreshCw, ArrowUpDown, ChevronDown, Search, Sparkles, Store, TerminalSquare,
} from 'lucide-react';
import FactoryApp from './factory/FactoryApp';
import { applyFactoryTheme } from './factory/applyTheme';
import HomeScreen from './HomeScreen';
import Sidebar, { useHealth } from './Sidebar';
import './glass.css';
import TerminalPane from './TerminalPane';
import BrowserPane from './BrowserPane';
import OnboardingGate from './onboarding/OnboardingGate';
import IntroSplash from './IntroSplash';
import { applyMotionSetting } from './motion';
import ConnectionsPage from './ConnectionsPage';
import { searchProjects } from './projectSearch';
import { ProjectThumb } from './ProjectThumb';
import { SortMenu } from './SortMenu';

// Light styling is now the CSS default; stamp the persisted theme before first
// paint so returning dark-theme users don't flash light for a frame.
document.documentElement.setAttribute('data-app-theme', localStorage.getItem('factory-theme') === 'dark' ? 'dark' : 'light');
applyMotionSetting();

// 'settings' is the Connections page (historic id); 'preferences' is the factory Settings panel.
type View = 'home' | 'builds' | 'new' | 'projects' | 'settings' | 'preferences' | 'terminal' | 'browser';

interface AppSession { authenticated:boolean; shop:string|null; persistent:boolean; shopify:{configured:boolean;apiVersion:string}; billing:null|{enabled:boolean;active:boolean;mode:string;subscriptions:unknown[]}; claude?:{connected:boolean;method:string|null}; workspace?:{path:string|null;name:string|null;ready:boolean;projectCount:number}; edition?:'customer'|'internal'; desktop?:boolean; cloud?:{required:boolean;signedIn:boolean;email:string|null;plan:string|null;passExpiresAt:string|null;offline:boolean}; }
/** Clone jobs surfaced as projects by the backend (kind 'clone'); section projects are legacy rows. */
interface CloneMeta { react_url?:string; store_url?:string; status?:string; status_detail?:string|null; last_score?:number|null; }
interface SavedProject { id:string; name:string; handle:string; description:string; kind?:'section'|'clone'|string; status?:string; clone_meta?:CloneMeta|null; factory_job_id?:string|null; created_at:string; updated_at:string; }
/** Clone project discovered in the active workspace (GET /api/workspace/state) — the fleet Home counts. */
interface WorkspaceProject { path:string; name:string; reactUrl:string; storeUrl:string; status:string; summary:string; sectionsCount:number; createdAt?:string|null; updatedAt?:string|null; }

const formatDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
/** "Today", "Yesterday", "5 days ago", else the date. */
const relativeDay = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return formatDay(iso);
};

/** Live picture of the project's homepage (captured by the server, cached a week). */
/** Status filter with a pill that slides to the chosen option. */
function FilterPills({ options, value, onChange }: { options: Array<{ id: string; label: string; count: number }>; value: string; onChange: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const active = ref.current?.querySelector<HTMLElement>('[aria-checked="true"]');
      if (active) setPill({ left: active.offsetLeft, width: active.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [value, options.length]);
  return (
    <div ref={ref} className="proj-filters" role="radiogroup" aria-label="Filter by status">
      {pill && <span className="proj-filters__pill" style={{ transform: `translateX(${pill.left}px)`, width: pill.width }} aria-hidden />}
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={value === option.id} className={value === option.id ? 'is-on' : ''} onClick={() => onChange(option.id)}>
          {option.label}<span>{option.count}</span>
        </button>
      ))}
    </div>
  );
}

const navItems: Array<{ id: View; label: string; icon: typeof Factory }> = [
  { id: 'home', label: 'Home', icon: House },
  { id: 'builds', label: 'Builds', icon: Layers },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'settings', label: 'Connections', icon: KeyRound },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { id: 'browser', label: 'Browser', icon: Globe },
];
const ALL_VIEWS: View[] = ['home', 'builds', 'new', 'projects', 'settings', 'preferences', 'terminal', 'browser'];

/** Read the current view from location.hash so reloads/HMR return to the same view. */
const viewFromHash = (): View => {
  const hash = window.location.hash.replace(/^#/, '');
  if (hash === 'factory') return 'builds'; // old bookmark
  return (ALL_VIEWS.includes(hash as View) ? hash : 'home') as View;
};

interface ConfirmOptions { title: string; body?: string; confirmLabel?: string; danger?: boolean }
interface ConfirmState extends ConfirmOptions { resolve: (ok: boolean) => void }

function ConfirmModal({ state, onResolve }: { state: ConfirmState; onResolve: (ok: boolean) => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onResolve(false); if (event.key === 'Enter') onResolve(true); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onResolve]);
  return (
    <div className="modal-overlay" onClick={() => onResolve(false)}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <h3>{state.title}</h3>
        {state.body && <p>{state.body}</p>}
        <div className="modal-actions">
          <button className="button button--quiet" onClick={() => onResolve(false)}>Cancel</button>
          <button className={`button ${state.danger ? 'button--danger' : 'button--accent'}`} onClick={() => onResolve(true)} autoFocus>{state.confirmLabel ?? 'Confirm'}</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const confirm = (options: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirmState({ ...options, resolve }));
  const resolveConfirm = (ok: boolean) => { setConfirmState((current) => { current?.resolve(ok); return null; }); };
  const [focusJobId, setFocusJobId] = useState<string | null>(null);
  const { state: healthState, cloudOffline } = useHealth();
  const [dark, setDark] = useState(() => localStorage.getItem('factory-theme') === 'dark');
  // Terminal + Browser are operator tools: hidden from the sidebar unless developer mode is on.
  const [developerMode, setDeveloperMode] = useState(() => localStorage.getItem('themebot-developer-mode') === '1');
  useEffect(() => { localStorage.setItem('themebot-developer-mode', developerMode ? '1' : '0'); }, [developerMode]);
  // Theme is applied (data-app-theme) and persisted ONLY here, on an explicit user toggle —
  // never on mount/boot, so a stray render can never silently flip the stored preference.
  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    localStorage.setItem('factory-theme', next ? 'dark' : 'light');
    applyFactoryTheme(next);
    // Fallback removal: applyFactoryTheme's 450ms timer can be throttled/lost in hidden tabs.
    window.setTimeout(() => document.documentElement.classList.remove('theme-anim'), 1200);
  };
  const [notice, setNotice] = useState('');
  const [session, setSession] = useState<AppSession | null>(null);
  const [shopInput, setShopInput] = useState('');
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState('');
  const [projectQuery, setProjectQuery] = useState('');

  const [sessionError, setSessionError] = useState(false);
  const [sessionRetry, setSessionRetry] = useState(0);
  const loadSession = async () => {
    try {
      const response = await fetch('/api/session');
      if (!response.ok) throw new Error(`Session request failed (${response.status})`);
      const data = await response.json() as AppSession;
      setSession(data);
      setSessionError(false);
      if (data.authenticated) void loadProjects();
    } catch { setSessionError(true); }
  };

  const loadProjects = async () => {
    setProjectsLoading(true); setProjectsError('');
    try {
      const response = await fetch('/api/projects');
      if (!response.ok) { if (response.status !== 401) setProjectsError('Projects could not be loaded.'); return; }
      const payload = await response.json(); setProjects(payload.projects ?? []);
    } catch { setProjectsError('Could not reach the server.'); }
    finally { setProjectsLoading(false); }
  };

  useEffect(() => { void loadSession(); }, []);

  // Auto-retry a failed boot with capped backoff (2s, 4s, … max 30s) instead of an infinite spinner.
  useEffect(() => {
    if (!sessionError || session !== null) return;
    const timer = window.setTimeout(() => { setSessionRetry((count) => count + 1); void loadSession(); }, Math.min(30000, 2000 * (sessionRetry + 1)));
    return () => window.clearTimeout(timer);
  }, [sessionError, session, sessionRetry]);

  // Hash routing: mirror the active view into location.hash so reloads/HMR return to it.
  useEffect(() => { const target = `#${view}`; if (window.location.hash !== target) window.history.replaceState(null, '', target); }, [view]);
  useEffect(() => {
    const onHashChange = () => setView((current) => { const target = viewFromHash(); return target === current ? current : target; });
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Notices auto-dismiss after ~5s (the × button still clears them early).
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Workspace clone projects (the fleet the Home 'projects' stat counts) for the Projects view.
  const [workspaceProjects, setWorkspaceProjects] = useState<WorkspaceProject[]>([]);
  const [wsQuery, setWsQuery] = useState('');
  // ThemeBot builds, keyed by project folder, so a card's Open goes straight to its build.
  const [buildByFolder, setBuildByFolder] = useState<Record<string, string>>({});
  const loadBuilds = async () => {
    try {
      const response = await fetch('/api/factory/jobs'); if (!response.ok) return;
      const data = await response.json() as { jobs?: Array<{ id: string; workspace_path: string; updated_at: string }> };
      const map: Record<string, string> = {};
      for (const job of [...(data.jobs ?? [])].sort((x, y) => x.updated_at.localeCompare(y.updated_at))) map[job.workspace_path.toLowerCase()] = job.id;
      setBuildByFolder(map);
    } catch { /* cards fall back to opening the folder */ }
  };
  const openProject = async (project: WorkspaceProject) => {
    const jobId = buildByFolder[project.path.toLowerCase()];
    if (jobId) { setFocusJobId(jobId); setView('builds'); return; }
    const response = await fetch('/api/workspace/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: project.path }) }).catch(() => null);
    setNotice(response?.ok ? `${project.name} has no ThemeBot build yet — opened its folder instead.` : `Could not open ${project.name}.`);
  };
  const [wsStatus, setWsStatus] = useState('all');
  const [wsSort, setWsSort] = useState<'recent' | 'oldest' | 'started' | 'name'>(() => { try { const saved = localStorage.getItem('themebot-projects-sort'); return saved === 'oldest' || saved === 'started' || saved === 'name' ? saved : 'recent'; } catch { return 'recent'; } });
  const chooseSort = (next: typeof wsSort) => { setWsSort(next); try { localStorage.setItem('themebot-projects-sort', next); } catch { /* remembered for this visit only */ } };
  const loadWorkspaceProjects = async () => {
    try { const response = await fetch('/api/workspace/state'); if (!response.ok) return; const data = await response.json(); setWorkspaceProjects(Array.isArray(data.projects) ? (data.projects as WorkspaceProject[]) : []); }
    catch { /* workspace state is optional — the saved-projects list below still renders */ }
  };
  useEffect(() => { if (view === 'projects') { void loadWorkspaceProjects(); void loadBuilds(); if (session?.authenticated) void loadProjects(); } }, [view, session?.authenticated]);

  const logoutClaude = async () => {
    if (!(await confirm({ title: 'Log out of the AI account?', body: 'ThemeBot will forget its AI connection and return to the start screen. Sign-ins on this computer itself are not affected.', confirmLabel: 'Log out', danger: true }))) return;
    await fetch('/api/claude/disconnect', { method: 'POST' }).catch(() => undefined);
    await loadSession();
  };
  const switchWorkspace = async () => {
    if (!(await confirm({ title: 'Switch workspace?', body: 'You will return to the workspace picker. Indexed project summaries stay cached in each folder.', confirmLabel: 'Switch' }))) return;
    await fetch('/api/workspace/close', { method: 'POST' }).catch(() => undefined);
    await loadSession();
  };

  // Clone jobs are the only projects ThemeBot manages now — legacy section rows are filtered out.
  const cloneProjects = projects.filter((project) => project.kind === 'clone');
  const filteredProjects = cloneProjects.filter((project) =>
    `${project.name} ${project.handle} ${project.description ?? ''}`.toLowerCase().includes(projectQuery.trim().toLowerCase()));

  // Startup gate: the app must not run until Claude is connected AND a workspace is chosen.
  // (In production the server reports claude/workspace ready, so the gate is skipped.)
  if (session === null) {
    if (sessionError) return (
      <div className="app-boot">
        <div className="modal-card" role="alert">
          <h3>Could not reach the ThemeBot server</h3>
          <p>The initial session request failed. Retrying automatically with backoff{sessionRetry > 0 ? ` (attempt ${sessionRetry + 1})` : ''}…</p>
          <div className="modal-actions">
            <button className="button button--accent" onClick={() => { setSessionRetry(0); void loadSession(); }}><RefreshCw size={14} />Retry now</button>
          </div>
        </div>
      </div>
    );
    return <div className="app-boot"><LoaderCircle className="spin" size={26} /></div>;
  }
  const claudeReady = session.claude ? session.claude.connected : true;
  const workspaceReady = session.workspace ? session.workspace.ready : true;
  if (!claudeReady || !workspaceReady) return <OnboardingGate onComplete={() => void loadSession()} />;

  return (
    <div className="glass-shell">
      <IntroSplash />
      <div className="glass-window">
      <Sidebar
        items={navItems.filter((item) => (developerMode && session?.edition !== 'customer') || (item.id !== 'terminal' && item.id !== 'browser'))}
        view={view === 'new' ? 'builds' : view}
        onNavigate={(target) => { setFocusJobId(null); setView(target); }}
        settingsActive={view === 'preferences'}
        onOpenSettings={() => setView('preferences')}
        dark={dark}
        onToggleTheme={toggleTheme}
      />

      <main className="glass-main">
        <header className="glass-topbar">
          <span className={`glass-status is-${cloudOffline ? 'offline' : healthState}`} role="status" title={cloudOffline ? 'New builds start again as soon as ThemeBot is back online.' : undefined}>
            <i />{cloudOffline ? 'Can’t reach ThemeBot — check your internet' : healthState === 'online' ? 'All systems normal' : healthState === 'offline' ? 'Could not reach ThemeBot' : 'Checking…'}
          </span>
        </header>

        {notice && <div className="notice"><Sparkles size={15} /><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}

        {view === 'home' && <HomeScreen onNewBuild={() => setView('new')} onOpenBuilds={() => { setFocusJobId(null); setView('builds'); }} onOpenBuild={(jobId) => { setFocusJobId(jobId); setView('builds'); }} />}

        {view === 'projects' && <section className="page-pad projects-page">
          <div className="glass-heading"><div><h2>Projects</h2><p>{workspaceProjects.length} project{workspaceProjects.length === 1 ? '' : 's'} in {session?.workspace?.name ?? 'your workspace'}.</p></div><button type="button" className="gbtn gbtn--outline" onClick={() => void switchWorkspace()}><FolderOpen size={14} /> Switch folder</button></div>
          {workspaceProjects.length>0&&(()=>{
            const folderOf=(project:WorkspaceProject)=>project.path.split(/[\\/]/).pop()??'';
            const statuses=[...new Set(workspaceProjects.map((project)=>project.status))].sort();
            const byStatus=wsStatus==='all'?workspaceProjects:workspaceProjects.filter((project)=>project.status===wsStatus);
            const time=(value?:string|null)=>value?new Date(value).getTime():0;
            const sorted=[...byStatus].sort((a,b)=>wsSort==='name'?a.name.localeCompare(b.name,undefined,{sensitivity:'base'}):wsSort==='oldest'?time(a.updatedAt)-time(b.updatedAt):wsSort==='started'?time(b.createdAt)-time(a.createdAt):time(b.updatedAt)-time(a.updatedAt));
            // While searching, best matches come first; otherwise the chosen sort order.
            const shown=searchProjects(sorted,wsQuery,(project)=>({name:project.name,folder:folderOf(project),summary:`${project.summary??''} ${project.createdAt?formatDay(project.createdAt):''}`,status:project.status}));
            return <div className="workspace-projects">
              <div className="proj-toolbar">
                <label className="proj-search"><Search size={16}/>
                  <input value={wsQuery} onChange={(event)=>setWsQuery(event.target.value)} onKeyDown={(event)=>{if(event.key==='Escape')setWsQuery('');}} placeholder="Search projects — name, store, or anything in the summary" aria-label="Search projects"/>
                  {wsQuery&&<button type="button" onClick={()=>setWsQuery('')} aria-label="Clear search">×</button>}
                </label>
                <SortMenu value={wsSort} onChange={(next)=>chooseSort(next as typeof wsSort)} hint={wsQuery?'Best match first while searching':undefined}
                  options={[{id:'recent',label:'Recently worked on',detail:'Latest activity first'},{id:'oldest',label:'Oldest worked on',detail:'Least recent activity first'},{id:'started',label:'Newest started',detail:'Most recently created first'},{id:'name',label:'Name A–Z',detail:'Alphabetical'}]}/>
                <FilterPills value={wsStatus} onChange={setWsStatus}
                  options={['all',...statuses].map((status)=>({id:status,label:status==='all'?'All':status.replace(/_/g,' '),count:status==='all'?workspaceProjects.length:workspaceProjects.filter((project)=>project.status===status).length}))}/>
              </div>
              {(wsQuery||wsStatus!=='all')&&<p className="proj-count">{shown.length} of {workspaceProjects.length} projects</p>}
              {shown.length===0?<div className="project-empty"><Search size={22}/><h3>No projects match “{wsQuery}”</h3><p>Try fewer letters or a different word.</p></div>:
              <div className="project-grid proj-grid">
                {shown.map((project,index)=><article className="project-card project-card--clone proj-card" key={project.path} style={{'--i':Math.min(index,8)} as React.CSSProperties}
                  role="link" tabIndex={0} aria-label={`Open ${project.name}`} onClick={()=>void openProject(project)} onKeyDown={(event)=>{if(event.key==='Enter'){event.preventDefault();void openProject(project);}}}>
                  <ProjectThumb path={project.path} name={project.name}/>
                  <div className="proj-card__body">
                    <h3 title={project.path}>{project.name}</h3>
                    <footer>
                      <span className="proj-card__date">{project.updatedAt?<>Last worked on <b title={new Date(project.updatedAt).toLocaleString()}>{relativeDay(project.updatedAt)}</b></>:project.createdAt?<>Started <b>{formatDay(project.createdAt)}</b></>:null}</span>
                      <button tabIndex={-1} onClick={(event)=>{event.stopPropagation();void openProject(project);}} title={buildByFolder[project.path.toLowerCase()]?'Open this build':'No build yet — opens the project folder'}>{buildByFolder[project.path.toLowerCase()]?'Open build':'Open folder'} {buildByFolder[project.path.toLowerCase()]?<ExternalLink size={13}/>:<FolderOpen size={13}/>}</button>
                    </footer>
                  </div>
                </article>)}
              </div>}
            </div>;
          })()}
          {session?.authenticated&&<>
            {projectsError&&<div className="error-line"><CircleAlert size={15}/>{projectsError}<button className="button button--quiet" onClick={()=>void loadProjects()}><RefreshCw size={13}/>Retry</button></div>}
            {cloneProjects.length>0&&<div className="projects-toolbar">
              <div className="projects-search"><Search size={14}/><input value={projectQuery} onChange={(event)=>setProjectQuery(event.target.value)} placeholder="Search projects by name or handle…"/></div>
              <span>{filteredProjects.length} of {cloneProjects.length}</span>
            </div>}
            <div className="project-grid">
              {filteredProjects.map((project)=><article className="project-card project-card--clone" key={project.id}>
                <div className="project-card__top"><span className="kind-badge kind-badge--clone"><Factory size={11}/>CLONE PROJECT</span></div>
                <div className="project-card__visual"><Factory size={29}/><i/></div>
                <h3>{project.name}</h3><code>{project.handle}</code><p>{project.description}</p>
                <footer>
                  <span>{(()=>{const cloneStatus=project.clone_meta?.status??project.status;return cloneStatus?`${cloneStatus.replace(/_/g,' ')} · `:'';})()}Updated {new Date(project.updated_at).toLocaleDateString()}</span>
                  <button onClick={()=>{setView('builds');setNotice(`${project.name} — opening its build.`);}}>Open <ExternalLink size={13}/></button>
                </footer>
              </article>)}
            </div>
            {projectsLoading&&cloneProjects.length===0&&<div className="project-empty"><LoaderCircle className="spin" size={22}/><p>Loading your projects…</p></div>}
            {!projectsLoading&&cloneProjects.length===0&&!projectsError&&<div className="project-empty"><FolderKanban size={25}/><h3>No clone projects yet.</h3><p>Start your first clone job in the Factory to see it here.</p></div>}
            {cloneProjects.length>0&&filteredProjects.length===0&&<div className="project-empty"><Search size={22}/><p>No projects match “{projectQuery}”.</p></div>}
          </>}
        </section>}

        {view === 'settings' && <ConnectionsPage
          claudeConnected={session?.claude?.connected ?? true}
          workspaceName={session?.workspace?.name ?? null}
          developerMode={developerMode}
          showDeveloperTools={session?.edition !== 'customer'}
          account={session?.cloud?.required ? { email: session.cloud.email, signedIn: session.cloud.signedIn } : null}
          onDeveloperMode={setDeveloperMode}
          onSwitchWorkspace={() => void switchWorkspace()}
          onLogoutClaude={() => void logoutClaude()}
          onOpenAccounts={() => { try { localStorage.setItem('themebot-settings-tab', 'accounts'); } catch { /* opens on the last tab instead */ } setView('preferences'); }}
          onNewBuild={() => setView('new')}
          confirm={confirm}
        />}

        {view === 'builds' && <FactoryApp tab="dashboard" focusJobId={focusJobId} onTabChange={(tab) => setView(tab === 'new' ? 'new' : tab === 'settings' ? 'preferences' : 'builds')} onNavigate={(target) => setView(target)} />}
        {view === 'new' && <FactoryApp tab="new" onTabChange={(tab) => setView(tab === 'new' ? 'new' : tab === 'settings' ? 'preferences' : 'builds')} onNavigate={(target) => setView(target)} />}
        {view === 'preferences' && <FactoryApp tab="settings" onTabChange={(tab) => setView(tab === 'new' ? 'new' : tab === 'settings' ? 'preferences' : 'builds')} onNavigate={(target) => setView(target)} />}

        {view === 'terminal' && <TerminalPane onActivity={() => window.dispatchEvent(new Event('app:refresh'))} />}

        {view === 'browser' && <BrowserPane onActivity={() => window.dispatchEvent(new Event('app:refresh'))} />}
      </main>
      </div>
      {confirmState && <ConfirmModal state={confirmState} onResolve={resolveConfirm} />}
    </div>
  );
}
