import { useEffect, useState } from 'react';
import {
  CircleAlert, ExternalLink, Factory, FolderKanban, Globe, House, KeyRound, LoaderCircle, LogOut,
  Link2, Moon, RefreshCw, Search, Sparkles, Store, Sun, TerminalSquare,
} from 'lucide-react';
import FactoryApp, { applyFactoryTheme } from './factory/FactoryApp';
import HomeScreen from './HomeScreen';
import Sidebar from './Sidebar';
import TerminalPane from './TerminalPane';
import BrowserPane from './BrowserPane';
import OnboardingGate from './onboarding/OnboardingGate';

// Light styling is now the CSS default; stamp the persisted theme before first
// paint so returning dark-theme users don't flash light for a frame.
document.documentElement.setAttribute('data-app-theme', localStorage.getItem('factory-theme') === 'dark' ? 'dark' : 'light');

type View = 'home' | 'projects' | 'settings' | 'factory' | 'terminal' | 'browser';

interface AppSession { authenticated:boolean; shop:string|null; persistent:boolean; shopify:{configured:boolean;apiVersion:string}; billing:null|{enabled:boolean;active:boolean;mode:string;subscriptions:unknown[]}; claude?:{connected:boolean;method:string|null}; workspace?:{path:string|null;name:string|null;ready:boolean;projectCount:number}; }
/** Clone jobs surfaced as projects by the backend (kind 'clone'); section projects are legacy rows. */
interface CloneMeta { react_url?:string; store_url?:string; status?:string; status_detail?:string|null; last_score?:number|null; }
interface SavedProject { id:string; name:string; handle:string; description:string; kind?:'section'|'clone'|string; status?:string; clone_meta?:CloneMeta|null; factory_job_id?:string|null; created_at:string; updated_at:string; }
/** Clone project discovered in the active workspace (GET /api/workspace/state) — the fleet Home counts. */
interface WorkspaceProject { path:string; name:string; reactUrl:string; storeUrl:string; status:string; summary:string; sectionsCount:number; }

const navItems: Array<{ id: View; label: string; icon: typeof Factory; number: string }> = [
  { id: 'home', label: 'Home', icon: House, number: '00' },
  { id: 'projects', label: 'Projects', icon: FolderKanban, number: '01' },
  { id: 'settings', label: 'Connections', icon: KeyRound, number: '02' },
  { id: 'factory', label: 'Factory', icon: Factory, number: '03' },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare, number: '04' },
  { id: 'browser', label: 'Browser', icon: Globe, number: '05' },
];

/** Read the current view from location.hash so reloads/HMR return to the same view. */
const viewFromHash = (): View => {
  const hash = window.location.hash.replace(/^#/, '');
  return (navItems.some((item) => item.id === hash) ? hash : 'home') as View;
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === '1');
  useEffect(() => { localStorage.setItem('sidebar-collapsed', sidebarCollapsed ? '1' : '0'); }, [sidebarCollapsed]);
  const [dark, setDark] = useState(() => localStorage.getItem('factory-theme') === 'dark');
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
  const loadWorkspaceProjects = async () => {
    try { const response = await fetch('/api/workspace/state'); if (!response.ok) return; const data = await response.json(); setWorkspaceProjects(Array.isArray(data.projects) ? (data.projects as WorkspaceProject[]) : []); }
    catch { /* workspace state is optional — the saved-projects list below still renders */ }
  };
  useEffect(() => { if (view === 'projects') { void loadWorkspaceProjects(); if (session?.authenticated) void loadProjects(); } }, [view, session?.authenticated]);

  const logoutClaude = async () => {
    if (!(await confirm({ title: 'Log out of Claude?', body: 'This app will forget its Claude connection and return to the start screen. Your Claude CLI sign-in on this machine is not affected.', confirmLabel: 'Log out', danger: true }))) return;
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
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar items={navItems} view={view} onNavigate={(target) => setView(target)} collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((value) => !value)} settingsView="settings" account={session?.claude ? { workspaceName: session.workspace?.name ?? null, claudeMethod: session.claude.method, onSwitchWorkspace: () => void switchWorkspace(), onLogoutClaude: () => void logoutClaude() } : undefined} />

      <main>
        <header className="topbar">
          <div><p>THEMEBOT / PRODUCTION</p><h1 key={view}>{navItems.find((item) => item.id === view)?.label}</h1></div>
          <div className="topbar__actions">
            {session?.authenticated&&<div className="shop-pill is-connected"><i />{session.shop}</div>}
            {/* Theme toggle is always the last item → same top-right corner on every page. */}
            <button className="button button--quiet button--icon topbar__theme" title={dark?'Switch to light theme':'Switch to dark theme'} aria-label={dark?'Switch to light theme':'Switch to dark theme'} onClick={toggleTheme}>{dark?<span key="sun" className="theme-icon"><Sun size={15} /></span>:<span key="moon" className="theme-icon"><Moon size={15} /></span>}</button>
          </div>
        </header>

        {notice && <div className="notice"><Sparkles size={15} /><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}

        {view === 'home' && <HomeScreen onNavigate={(target) => setView(target)} workspaceName={session?.workspace?.name ?? null} onSwitchWorkspace={() => void switchWorkspace()} />}

        {view === 'projects' && <section className="page-pad projects-page">
          <div className="page-heading"><div><span>YOUR CLONE FLEET</span><h2>Clone projects</h2><p>Every React site the factory has cloned or is cloning — discovered from the active workspace and the connected store. Jobs run in the Factory.</p></div></div>
          {workspaceProjects.length>0&&<div className="workspace-projects">
            <div className="page-heading"><div><span>ACTIVE WORKSPACE</span><h2>{workspaceProjects.length} workspace clone projects</h2><p>Discovered in the active workspace{session?.workspace?.name?` (${session.workspace.name})`:''} — the same fleet the Home dashboard counts.</p></div></div>
            <div className="project-grid">
              {workspaceProjects.map((project)=><article className="project-card project-card--clone" key={project.path}>
                <div className="project-card__top"><span className="kind-badge kind-badge--clone"><Factory size={11}/>CLONE PROJECT</span></div>
                <div className="project-card__visual"><Factory size={29}/><i/></div>
                <h3>{project.name}</h3><code title={project.path}>{project.path.split(/[\\/]/).pop()}</code><p>{project.summary||'No summary indexed yet.'}</p>
                <footer>
                  <span>{project.status.replace(/_/g,' ')}{project.sectionsCount>0?` · ${project.sectionsCount} sections`:''}</span>
                  <button onClick={()=>setView('factory')}>Open in Factory <ExternalLink size={13}/></button>
                </footer>
              </article>)}
            </div>
          </div>}
          {!session?.authenticated&&<div className="connect-hero">
            <div className="connect-hero__mark"><Link2 size={27}/></div><div><span>CONNECT YOUR FIRST STORE</span><h3>{session?.shopify.configured?'Turn ThemeBot into your Shopify workspace.':'Production credentials are not configured yet.'}</h3><p>{session?.shopify.configured?'Authorize the app to track clone projects across connected Shopify stores.':'The factory remains available without a connected store. Add the Shopify credentials from .env.example when you are ready to connect one.'}</p></div>
            {session?.shopify.configured&&<form onSubmit={(event)=>{event.preventDefault();window.location.href=`/auth/shopify?shop=${encodeURIComponent(shopInput)}`;}}><input value={shopInput} onChange={(event)=>setShopInput(event.target.value)} placeholder="your-store.myshopify.com" required/><button className="button button--accent" type="submit"><Store size={15}/>Connect Shopify</button></form>}
          </div>}
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
                  <button onClick={()=>{setView('factory');setNotice(`${project.name} is a factory clone job — opening the Factory.`);}}>Open in Factory <ExternalLink size={13}/></button>
                </footer>
              </article>)}
            </div>
            {projectsLoading&&cloneProjects.length===0&&<div className="project-empty"><LoaderCircle className="spin" size={22}/><p>Loading your projects…</p></div>}
            {!projectsLoading&&cloneProjects.length===0&&!projectsError&&<div className="project-empty"><FolderKanban size={25}/><h3>No clone projects yet.</h3><p>Start your first clone job in the Factory to see it here.</p></div>}
            {cloneProjects.length>0&&filteredProjects.length===0&&<div className="project-empty"><Search size={22}/><p>No projects match “{projectQuery}”.</p></div>}
          </>}
        </section>}

        {view === 'settings' && <section className="page-pad settings-page">
          <div className="page-heading"><div><span>CONNECTIONS</span><h2>Platform connections</h2><p>Securely connect the Shopify stores your clone jobs deploy to.</p></div></div>
          <div className="settings-grid">
            <div className="settings-card"><div className="settings-card__heading"><Store size={19}/><div><span>SHOPIFY STORE</span><h3>{session?.shop??'Not connected'}</h3></div></div><p>{session?.authenticated?'The store is connected with an encrypted, rotating offline token.':'Connect from the Projects page to enable store-linked project tracking.'}</p><div className="settings-facts"><div><span>API version</span><b>{session?.shopify.apiVersion??'2026-07'}</b></div><div><span>Database</span><b>{session?.persistent?'PostgreSQL':'Development memory'}</b></div><div><span>Billing</span><b>{session?.billing?.enabled?(session.billing.active?'Active':'Approval required'):'Disabled'}</b></div></div>{session?.authenticated&&<button className="button button--quiet button--full" onClick={()=>fetch('/auth/logout',{method:'POST'}).then(()=>window.location.reload())}><LogOut size={14}/>Disconnect this browser</button>}</div>
            <div className="settings-card"><div className="settings-card__heading"><KeyRound size={19}/><div><span>FACTORY CREDENTIALS</span><h3>Per-job Shopify apps</h3></div></div><p>Each clone job connects with its own Shopify app credentials, entered in the Factory wizard and stored encrypted. Nothing is shared between jobs and secrets are never written to disk in plain text.</p><button className="button button--quiet button--full" onClick={()=>setView('factory')}><Factory size={14}/>Open the Factory</button></div>
          </div>
        </section>}

        {view === 'factory' && <FactoryApp onNavigate={(target) => setView(target)} />}

        {view === 'terminal' && <TerminalPane onActivity={() => window.dispatchEvent(new Event('app:refresh'))} />}

        {view === 'browser' && <BrowserPane onActivity={() => window.dispatchEvent(new Event('app:refresh'))} />}
      </main>
      {confirmState && <ConfirmModal state={confirmState} onResolve={resolveConfirm} />}
    </div>
  );
}
