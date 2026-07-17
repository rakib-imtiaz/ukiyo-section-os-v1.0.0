// Full-screen startup gate. The app does not run until (1) Claude is connected — via the
// CLI's own OAuth login or an API key — and (2) a working directory is chosen. A persistent
// demo panel lets an unconnected visitor see how the product works. Localhost-only backend.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle, AppWindow, ArrowLeft, Check, ChevronRight, Folder, FolderPlus, HardDrive, HelpCircle,
  Info, KeyRound, Loader, Lock, RefreshCw, Sparkles, TerminalSquare,
} from 'lucide-react';

interface ClaudeStatus { connected: boolean; method: string | null; cliPresent: boolean; cliCredentialsPresent: boolean; claudePath: string; loginActive: boolean; reason?: string }
interface ProgressLine { at: number; line: string }
interface BrowseResult { path: string | null; parent: string | null; dirs: Array<{ name: string; path: string }>; drives?: string[] }
type Step = 'connect' | 'workspace' | 'init';

async function getJson<T>(url: string): Promise<T | null> { try { const r = await fetch(url); return r.ok ? (await r.json() as T) : null; } catch { return null; } }
async function postJson<T>(url: string, body?: unknown): Promise<{ ok: boolean; data: T | null }> {
  try { const r = await fetch(url, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }); return { ok: r.ok, data: await r.json().catch(() => null) as T | null }; }
  catch { return { ok: false, data: null }; }
}

function IllustrationPanel({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <aside className="ob-aside" aria-hidden>
      <div className="ob-aside__glow" />
      <img className="ob-aside__art" src={theme === 'dark' ? '/onboarding/crystal-dark.png' : '/onboarding/crystal.png'} alt="" draggable={false} />
      <div className="ob-aside__sparks">{[0, 1, 2, 3, 4].map((i) => <i key={i} style={{ ['--d' as string]: `${i * 0.8}s`, ['--x' as string]: `${(i - 2) * 20}px` }} />)}</div>
      <div className="ob-aside__caption"><b>Clone React sites into Shopify.</b><span>Design, QA, and ship — from one cockpit.</span></div>
    </aside>
  );
}

function ProgressStream({ lines }: { lines: ProgressLine[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [lines.length]);
  return (
    <div className="ob-stream">
      {lines.length === 0 && <div className="ob-stream__row ob-stream__row--dim">Waiting for output…</div>}
      {lines.map((entry, index) => <div key={index} className={`ob-stream__row${/[✓]/.test(entry.line) ? ' ob-stream__row--ok' : /[⚠]|fail|error/i.test(entry.line) ? ' ob-stream__row--warn' : ''}`}>{entry.line}</div>)}
      <div ref={endRef} />
    </div>
  );
}

export default function OnboardingGate({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>('connect');
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [lines, setLines] = useState<ProgressLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // ---- progress polling (shared across steps) ----
  const sinceRef = useRef(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const snap = await getJson<{ lines: ProgressLine[]; busy: boolean }>(`/api/onboarding/progress?since=${sinceRef.current}`);
      if (!alive || !snap) return;
      if (snap.lines.length) { sinceRef.current = snap.lines[snap.lines.length - 1].at; setLines((current) => [...current, ...snap.lines].slice(-200)); }
    };
    const id = window.setInterval(tick, 1500); void tick();
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const refreshClaude = useCallback(async (force = false) => {
    const status = await getJson<ClaudeStatus>(`/api/claude/status${force ? '?force=1' : ''}`);
    if (status) { setClaude(status); if (status.connected && step === 'connect') setStep('workspace'); }
    return status;
  }, [step]);

  useEffect(() => { void refreshClaude(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // While a CLI login is active, poll status until it connects.
  useEffect(() => {
    if (!claude?.loginActive) return;
    const id = window.setInterval(() => void refreshClaude(true), 2500);
    return () => window.clearInterval(id);
  }, [claude?.loginActive, refreshClaude]);

  const steps: Array<{ id: Step; label: string }> = [
    { id: 'connect', label: 'Connect Claude' }, { id: 'workspace', label: 'Choose workspace' }, { id: 'init', label: 'Index projects' },
  ];
  const stepIndex = steps.findIndex((entry) => entry.id === step);

  const theme = document.documentElement.getAttribute('data-app-theme') === 'dark' ? 'dark' : 'light';
  return (
    <div className="ob-root factory-root" data-theme={theme}>
      <div className="ob-shell">
        <IllustrationPanel theme={theme} />
        <div className="ob-main">
          <div className="ob-brand"><span className="ob-brand__mark"><Sparkles size={15} /></span> THEMEBOT</div>
          <ol className="ob-steps">
            {steps.map((entry, index) => (
              <li key={entry.id} className={`ob-step${index === stepIndex ? ' is-active' : ''}${index < stepIndex ? ' is-done' : ''}`}>
                <span className="ob-step__num">{index < stepIndex ? <Check size={13} /> : index + 1}</span>{entry.label}
              </li>
            ))}
          </ol>

          {step === 'connect' && <ConnectStep claude={claude} busy={busy} setBusy={setBusy} error={error} setError={setError} onRefresh={refreshClaude} lines={lines} />}
          {step === 'workspace' && <WorkspaceStep busy={busy} setBusy={setBusy} onBack={() => setStep('connect')} onSelected={() => setStep('init')} />}
          {step === 'init' && <InitStep lines={lines} onComplete={onComplete} />}

          <div className="ob-foot"><Lock size={13} /> Credentials are encrypted and never leave this machine.</div>
        </div>
      </div>
    </div>
  );
}

function ConnectStep({ claude, busy, setBusy, error, setError, onRefresh, lines }: {
  claude: ClaudeStatus | null; busy: boolean; setBusy: (v: boolean) => void; error: string; setError: (v: string) => void; onRefresh: (force?: boolean) => Promise<ClaudeStatus | null>; lines: ProgressLine[];
}) {
  const [mode, setMode] = useState<'choose' | 'api'>('choose');
  const [apiKey, setApiKey] = useState('');

  if (!claude) return <div className="ob-panel"><Loader className="spin" size={22} /><p>Checking Claude connection…</p></div>;

  if (!claude.cliPresent) {
    return (
      <div className="ob-panel">
        <h2>Claude Code CLI not found</h2>
        <p>ThemeBot drives the Claude Code CLI to clone and QA sites. Install it, then reload.</p>
        <pre className="ob-code">npm install -g @anthropic-ai/claude-code</pre>
        <p className="ob-muted">Expected at <code>{claude.claudePath}</code> — override with <code>FACTORY_CLAUDE_PATH</code>.</p>
        <button className="ob-btn" onClick={() => void onRefresh(true)}><RefreshCw size={15} /> Re-check</button>
      </div>
    );
  }

  const startLogin = async () => {
    setBusy(true); setError('');
    const { ok, data } = await postJson<{ started: boolean; error?: string }>('/api/claude/login');
    setBusy(false);
    if (!ok || !data?.started) setError(data?.error || 'Could not start sign-in.');
    else void onRefresh(true);
  };
  const useCli = async () => { setBusy(true); setError(''); await postJson('/api/claude/use-cli'); await onRefresh(true); setBusy(false); };
  const submitKey = async () => {
    setBusy(true); setError('');
    const { ok, data } = await postJson<{ connected: boolean; error?: string }>('/api/claude/api-key', { key: apiKey });
    setBusy(false);
    if (ok && data?.connected) { setApiKey(''); void onRefresh(true); } else setError(data?.error || 'The key did not work.');
  };

  return (
    <div className="ob-panel">
      <h2>Connect Claude</h2>
      <p>ThemeBot needs your Claude account to run. Nothing works until it is connected.</p>
      {claude.reason && !claude.loginActive && <div className="ob-hint"><span><Info size={16} /> {claude.reason}</span><HelpCircle size={16} className="ob-hint__help" /></div>}

      {claude.loginActive ? (
        <div className="ob-login-wait">
          <div className="ob-hint"><span><Loader className="spin" size={16} /> Complete the sign-in in the browser window that opened…</span></div>
          <ProgressStream lines={lines.filter((l) => l.line.includes('claude login') || l.line.includes('Claude'))} />
        </div>
      ) : mode === 'choose' ? (
        <div className="ob-actions">
          {claude.cliCredentialsPresent
            ? <>
                <button className="ob-btn ob-btn--accent ob-btn--lg" disabled={busy} onClick={useCli}><TerminalSquare size={17} /> Use my Claude CLI login</button>
                <button className="ob-btn ob-btn--lg" disabled={busy} onClick={startLogin}><AppWindow size={17} /> Sign in with a different account (browser)</button>
              </>
            : <button className="ob-btn ob-btn--accent ob-btn--lg" disabled={busy} onClick={startLogin}><TerminalSquare size={17} /> Sign in with Claude (browser)</button>}
          <button className="ob-btn ob-btn--lg" disabled={busy} onClick={() => setMode('api')}><KeyRound size={17} /> Use an API key instead</button>
          {claude.cliCredentialsPresent && <p className="ob-muted ob-muted--center">You're already signed in to the Claude CLI on this machine — ThemeBot won't use it until you choose to here.</p>}
        </div>
      ) : (
        <div className="ob-actions">
          <label className="ob-field"><span>Anthropic API key</span>
            <input type="password" value={apiKey} placeholder="sk-ant-…" autoFocus onChange={(e) => setApiKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && apiKey) void submitKey(); }} />
          </label>
          <div className="ob-row">
            <button className="ob-btn ob-btn--ghost" onClick={() => { setMode('choose'); setError(''); }}><ArrowLeft size={15} /> Back</button>
            <button className="ob-btn ob-btn--accent" disabled={busy || !apiKey} onClick={submitKey}>{busy ? <Loader className="spin" size={15} /> : <Check size={15} />} Connect</button>
          </div>
          <p className="ob-muted">The key is encrypted on this machine and never shown again.</p>
        </div>
      )}
      {error && <div className="ob-error"><AlertCircle size={14} /> {error}</div>}
    </div>
  );
}

function WorkspaceStep({ busy, setBusy, onBack, onSelected }: { busy: boolean; setBusy: (v: boolean) => void; onBack: () => void; onSelected: () => void }) {
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (path?: string) => {
    const result = await getJson<BrowseResult>(`/api/workspace/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`);
    if (result) setBrowse(result); else setError('That folder could not be opened.');
  }, []);

  useEffect(() => { void load(); void getJson<{ recents: string[] }>('/api/workspace/state').then((s) => setRecents(s?.recents ?? [])); }, [load]);

  const select = async (path: string, create = false) => {
    setBusy(true); setError('');
    const { ok, data } = await postJson<{ error?: string }>('/api/workspace/select', { path, create });
    setBusy(false);
    if (ok) onSelected(); else setError(data?.error || 'Could not select that folder.');
  };

  return (
    <div className="ob-panel">
      <h2>Choose a working directory</h2>
      <p>ThemeBot initializes and remembers this folder. Existing clone projects inside it are discovered automatically.</p>

      {recents.length > 0 && (
        <div className="ob-recents">
          <span>Recent</span>
          {recents.map((path) => <button key={path} className="ob-chip" disabled={busy} onClick={() => select(path)} title={path}>{path.split(/[\\/]/).filter(Boolean).pop()}</button>)}
        </div>
      )}

      <div className="ob-browser">
        <div className="ob-browser__bar">
          <button className="ob-icon" disabled={!browse?.parent} onClick={() => void load(browse?.parent ?? undefined)} title="Up"><ArrowLeft size={15} /></button>
          <code>{browse?.path ?? 'This PC'}</code>
          <button className="ob-icon" onClick={() => void load(browse?.path ?? undefined)} title="Refresh"><RefreshCw size={13} /></button>
        </div>
        <div className="ob-browser__list">
          {(browse?.dirs ?? []).map((dir) => (
            <button key={dir.path} className="ob-browser__row" onDoubleClick={() => void load(dir.path)} onClick={() => void load(dir.path)}>
              {browse?.drives ? <HardDrive size={14} /> : <Folder size={14} />}<span>{dir.name}</span><ChevronRight size={13} className="ob-browser__chev" />
            </button>
          ))}
          {browse && !browse.dirs.length && <div className="ob-browser__empty">No subfolders here.</div>}
        </div>
        <div className="ob-browser__foot">
          {creating ? (
            <div className="ob-row">
              <input className="ob-newfolder" value={newName} autoFocus placeholder="new-folder-name" onChange={(e) => setNewName(e.target.value.replace(/[^\w .-]/g, ''))} />
              <button className="ob-btn ob-btn--accent" disabled={!newName || !browse?.path || busy} onClick={() => browse?.path && select(`${browse.path.replace(/[\\/]$/, '')}${browse.path.includes('\\') ? '\\' : '/'}${newName}`, true)}><FolderPlus size={15} /> Create &amp; open</button>
              <button className="ob-btn ob-btn--ghost" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
            </div>
          ) : (
            <>
              <button className="ob-btn ob-btn--ghost" disabled={!browse?.path} onClick={() => setCreating(true)}><FolderPlus size={15} /> New folder here</button>
              <button className="ob-btn ob-btn--accent" disabled={!browse?.path || busy} onClick={() => browse?.path && select(browse.path)}>{busy ? <Loader className="spin" size={15} /> : <Check size={15} />} Use this folder</button>
            </>
          )}
        </div>
      </div>
      {error && <div className="ob-error"><AlertCircle size={14} /> {error}</div>}
      <button className="ob-btn ob-btn--ghost ob-back" onClick={onBack}><ArrowLeft size={15} /> Back to Claude</button>
    </div>
  );
}

function InitStep({ lines, onComplete }: { lines: ProgressLine[]; onComplete: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const state = await getJson<{ ready: boolean }>('/api/workspace/state');
      if (alive && state?.ready) setReady(true);
    };
    const id = window.setInterval(tick, 1500); void tick();
    return () => { alive = false; window.clearInterval(id); };
  }, []);
  return (
    <div className="ob-panel">
      <h2>Setting up your workspace</h2>
      <p>Discovering and indexing projects with a quick Claude Haiku scan. This continues in the background — you can enter now.</p>
      <ProgressStream lines={lines} />
      <button className="ob-btn ob-btn--accent ob-enter" disabled={!ready} onClick={onComplete}>{ready ? <><Sparkles size={16} /> Enter ThemeBot</> : <><Loader className="spin" size={15} /> Preparing…</>}</button>
    </div>
  );
}
