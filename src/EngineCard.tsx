// Sidebar "AI engine" card: which AI builds your themes, its connected account and plan, and how
// much ThemeBot has used. Opens a panel with every engine (switch between them; future ones show
// "Coming soon"), usage for today / the last 7 days / recent builds, and the last usage-limit hit.
// Usage is ThemeBot's own (from each session's final report) — Claude doesn't share the plan's
// remaining allowance with other apps, so we never pretend to show it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BRAND_ICONS } from './brandIcons';
import { BarChart3, Check, ChevronRight, Cpu, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { UsageDetails } from './UsageDetails';

type EngineId = 'claude' | 'openrouter' | 'openai' | 'gemini' | 'kimi' | 'glm' | 'meta' | 'deepseek' | 'qwen' | 'mistral';
interface Engine { id: EngineId; name: string; maker: string; available: boolean; note?: string; connected: boolean; account: string | null; plan: string | null }
type KeyProvider = 'anthropic' | 'openrouter' | 'openai' | 'gemini' | 'kimi' | 'glm' | 'deepseek' | 'qwen' | 'mistral';
interface KeyStatus { provider: KeyProvider; name: string; engine: EngineId; hint: string; hasKey: boolean; last4: string | null; verified: boolean | null; note: string | null; usageUsd?: number | null; limitUsd?: number | null; freeTier?: boolean | null }
interface AccountStatus { provider: 'claude' | 'openai' | 'gemini' | 'kimi'; name: string; via: string; detected: boolean; linked: boolean; account: string | null; plan: string | null; signInHelp: string }
interface Totals { sessions: number; tokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; estUsd: number; minutes: number; turns: number }
interface Usage { today: Totals; week: Totals; days: Array<Totals & { day: string }>; byModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; estUsd: number }>; builds: Array<Totals & { jobId: string; jobName: string | null; lastAt: number }>; lastLimit: { at: number; reset: string | null } | null; trackedSince: number | null }
interface EnginesResponse { active: EngineId; engines: Engine[]; accounts: AccountStatus[]; keys: KeyStatus[]; usage: Usage }
type Tab = 'engines' | 'accounts' | 'keys' | 'usage';

const tokens = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);
const money = (value: number) => value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
const ago = (at: number) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

// Simple colour tiles with the provider's initial (Claude keeps its drawn mark inside the panel).
const LOGO: Record<Exclude<EngineId, 'claude'>, { text: string; bg: string; fg?: string }> = {
  openrouter: { text: 'OR', bg: 'linear-gradient(145deg, #64748b, #334155)' },
  openai: { text: 'AI', bg: 'linear-gradient(145deg, #1f2937, #0b0f14)' },
  gemini: { text: 'G', bg: 'linear-gradient(145deg, #4f8cff, #9b6bff 60%, #ff7aa8)' },
  kimi: { text: 'K', bg: 'linear-gradient(145deg, #27272a, #09090b)' },
  glm: { text: 'GLM', bg: 'linear-gradient(145deg, #3563ff, #1b3fbf)' },
  meta: { text: 'M', bg: 'linear-gradient(145deg, #0a7cff, #0055d4)' },
  deepseek: { text: 'DS', bg: 'linear-gradient(145deg, #4d6bfe, #2c47d6)' },
  qwen: { text: 'Q', bg: 'linear-gradient(145deg, #7c5cff, #5136d6)' },
  mistral: { text: 'M', bg: 'linear-gradient(145deg, #ff8a1f, #e8540c)' },
};

function EngineLogo({ id }: { id: EngineId }) {
  const brand = BRAND_ICONS[id];
  if (brand) {
    // Real brand mark in its own colour on a white tile.
    return <span className="eng-logo eng-logo--brand" aria-hidden><svg viewBox="0 0 24 24"><path d={brand[1]} fill={brand[0]} fillRule={id === 'openai' ? 'evenodd' : undefined} /></svg></span>;
  }
  const logo = LOGO[id as Exclude<EngineId, 'claude'>];
  return <span className="eng-logo eng-logo--text" style={{ background: logo.bg }} aria-hidden>{logo.text}</span>;
}

const post = async (url: string, body?: unknown, method = 'POST') => {
  const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'Something went wrong.');
};

/** One provider's API key: add (checked with the provider first), status, replace, remove. Never shows the key. */
function KeyRow({ status, onChange }: { status: KeyStatus; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try { await post(`/api/factory/engines/keys/${status.provider}`, { key: value }); setValue(''); setEditing(false); onChange(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save the key.'); }
    finally { setBusy(false); }
  };
  const remove = async () => { setBusy(true); await post(`/api/factory/engines/keys/${status.provider}`, undefined, 'DELETE').catch(() => undefined); setBusy(false); onChange(); };
  const state = !status.hasKey ? '' : status.verified === false ? 'is-bad' : status.verified ? 'is-ok' : 'is-unknown';
  return (
    <div className={`prov-row ${state}`}>
      <div className="prov-row__main">
        <EngineLogo id={status.engine} />
        <div className="prov-row__text">
          <b>{status.name}</b>
          <small>{!status.hasKey ? status.hint
            : status.verified === false ? status.note
            : <>Key ••••{status.last4}{status.verified ? ' · works' : status.note ? ` · ${status.note.replace(/^Saved\s*—?\s*/, '')}` : ''}{status.usageUsd != null ? ` · ${money(status.usageUsd)} used${status.limitUsd != null ? ` of ${money(status.limitUsd)}` : ''}` : ''}{status.freeTier ? ' · free tier' : ''}</>}</small>
        </div>
        {!editing && (status.hasKey
          ? <div className="prov-row__actions"><button type="button" onClick={() => setEditing(true)} disabled={busy}>Replace</button><button type="button" className="is-danger" onClick={() => void remove()} disabled={busy}>Remove</button></div>
          : <button type="button" className="prov-row__add" onClick={() => setEditing(true)}>Add key</button>)}
      </div>
      {editing && (
        <form className="eng-key__form" onSubmit={(event) => { event.preventDefault(); if (value.trim()) void save(); }}>
          <input type="password" autoComplete="off" spellCheck={false} placeholder={`Paste your ${status.name} API key`} value={value} onChange={(event) => setValue(event.target.value)} aria-label={`${status.name} API key`} autoFocus />
          <button type="submit" disabled={busy || !value.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : 'Save'}</button>
          <button type="button" className="eng-key__cancel" onClick={() => { setEditing(false); setValue(''); setError(''); }}>Cancel</button>
        </form>
      )}
      {error && <p className="eng-panel__error">{error}</p>}
    </div>
  );
}

/** A sign-in that exists (or could exist) on this computer. Claude: ThemeBot's own sign-in. Others:
 *  the provider's own app — when it is already signed in, one click links it. */
function AccountRow({ status, onChange }: { status: AccountStatus; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); onChange(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Something went wrong.'); } finally { setBusy(false); } };
  const claude = status.provider === 'claude';
  return (
    <div className={`prov-row${status.linked ? ' is-ok' : ''}`}>
      <div className="prov-row__main">
        <EngineLogo id={status.provider} />
        <div className="prov-row__text">
          <b>{status.name} <em>via {status.via}</em></b>
          <small>{status.linked ? <>Signed in{status.account ? ` · ${status.account}` : ''}{status.plan ? ` · ${status.plan} plan` : ''}</>
            : status.detected ? <>Signed in on this computer{status.account ? ` · ${status.account}` : ''} — ready to use</>
            : status.signInHelp}</small>
        </div>
        {claude ? (
          status.linked
            ? <div className="prov-row__actions"><button type="button" disabled={busy} onClick={() => void act(() => post('/api/claude/login'))}>Switch</button><button type="button" className="is-danger" disabled={busy} onClick={() => void act(async () => { if (window.confirm('Log out of Claude? ThemeBot will return to its start screen until an AI account is connected again.')) { await post('/api/claude/disconnect'); window.location.reload(); } })}>Log out</button></div>
            : <button type="button" className="prov-row__add" disabled={busy} onClick={() => void act(() => post('/api/claude/login'))}>{busy ? <LoaderCircle className="spin" size={14} /> : 'Sign in'}</button>
        ) : status.linked
          ? <div className="prov-row__actions"><button type="button" className="is-danger" disabled={busy} onClick={() => void act(() => post(`/api/factory/engines/accounts/${status.provider}/link`, { on: false }))}>Unlink</button></div>
          : status.detected
            ? <button type="button" className="prov-row__add is-primary" disabled={busy} onClick={() => void act(() => post(`/api/factory/engines/accounts/${status.provider}/link`, { on: true }))}>{busy ? <LoaderCircle className="spin" size={14} /> : 'Use this sign-in'}</button>
            : <span className="eng-row__soon">Not signed in</span>}
      </div>
      {error && <p className="eng-panel__error">{error}</p>}
    </div>
  );
}

export function EngineCard() {
  const [data, setData] = useState<EnginesResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [building, setBuilding] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<EngineId | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('engines');
  const panel = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try { const response = await fetch('/api/factory/engines'); if (!response.ok) throw new Error(); setData(await response.json()); setFailed(false); }
    catch { setFailed(true); }
    // A build that is running right now proves the AI is not paused.
    try {
      const jobs = await fetch('/api/factory/jobs').then((r) => r.json()) as { jobs?: Array<{ running?: boolean }> } | Array<{ running?: boolean }>;
      setBuilding((Array.isArray(jobs) ? jobs : jobs.jobs ?? []).some((job) => job.running));
    } catch { setBuilding(false); }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    // Coming back to the window re-checks at once, so an old notice never lingers.
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [load]);
  useEffect(() => { const openPanel = () => { setTab('accounts'); setOpen(true); }; window.addEventListener('themebot:open-engines', openPanel); return () => window.removeEventListener('themebot:open-engines', openPanel); }, []);
  useEffect(() => {
    if (!open) return;
    void load();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, load]);

  const choose = async (id: EngineId) => {
    setSwitching(id); setError('');
    try {
      const response = await fetch('/api/factory/engines/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not switch.');
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not switch.'); }
    finally { setSwitching(null); }
  };

  const active = data?.engines.find((engine) => engine.id === data.active);
  const usage = data?.usage;
  const peak = Math.max(1, ...(usage?.days.map((day) => day.tokens) ?? [1]));
  // Recent, and nothing has run fine since (a finished session also clears it on the server).
  const limitRecent = !building && Boolean(usage?.lastLimit && Date.now() - usage.lastLimit.at < 12 * 3_600_000
    && !usage.builds.some((build) => build.lastAt > usage.lastLimit!.at));

  return (
    <>
      <button type="button" className={`eng-card${limitRecent ? ' is-limited' : ''}`} onClick={() => setOpen(true)} aria-haspopup="dialog" title="AI engine and usage">
        <span className="eng-card__logo">
          {/* A neutral "AI engine" icon here — the provider's own logo only appears inside the panel. */}
          <span className="eng-logo eng-logo--engine"><Cpu size={16} /></span>
          <i className={`eng-card__dot${active?.connected ? ' is-on' : ''}${limitRecent ? ' is-warn' : ''}`} aria-hidden />
        </span>
        <span className="eng-card__text">
          <b>AI engine</b>
          <small className={limitRecent ? 'is-warn' : ''}>{limitRecent ? 'Paused — limit reached' : !data ? (failed ? 'Status unknown' : ' ') : active?.connected ? 'Connected' : 'Not connected'}</small>
        </span>
      </button>

      {open && createPortal(
        <div className="eng-overlay" onMouseDown={(event) => { if (!panel.current?.contains(event.target as Node)) setOpen(false); }}>
          <div ref={panel} className="eng-panel" role="dialog" aria-modal="true" aria-label="AI engine and usage">
            <header className="eng-panel__head">
              <div><h3>AI engine</h3><p>Which AI builds your themes, and how much ThemeBot has used.</p></div>
              <button type="button" className="eng-panel__close" onClick={() => setOpen(false)} aria-label="Close"><X size={16} /></button>
            </header>

            {!data && !failed && <div className="eng-panel__loading"><LoaderCircle className="spin" size={18} /> Loading…</div>}
            {failed && !data && <p className="eng-panel__error">Could not reach ThemeBot. Try again in a moment.</p>}

            {data && <>
              <div className="eng-tabs" role="tablist" aria-label="AI engine sections">
                {([['engines', 'Engines'], ['accounts', 'Accounts'], ['keys', 'API keys'], ['usage', 'Usage']] as Array<[Tab, string]>).map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>
                    {label}{id === 'keys' && data.keys.some((key) => key.hasKey) ? <i>{data.keys.filter((key) => key.hasKey).length}</i> : null}
                  </button>
                ))}
              </div>

              {tab === 'engines' && <section>
                <p className="eng-label">Which AI builds your themes</p>
                <div className="eng-list" role="radiogroup" aria-label="Engine used for builds">
                  {data.engines.map((engine) => {
                    const isActive = engine.id === data.active;
                    return (
                      <div key={engine.id} className="eng-rowwrap">
                      <button type="button" role="radio" aria-checked={isActive} disabled={!engine.available || switching != null}
                        className={`eng-row${isActive ? ' is-on' : ''}${engine.available ? '' : ' is-soon'}`} onClick={() => { if (!isActive) void choose(engine.id); }}>
                        <EngineLogo id={engine.id} />
                        <span className="eng-row__text">
                          <b>{engine.name} <em>{engine.maker}</em></b>
                          {!engine.available ? <small>{engine.note}</small>
                            : engine.connected ? <>{engine.account && <small title={engine.account}>{engine.account}</small>}{engine.plan && <small className="eng-row__plan">{engine.plan} plan</small>}</>
                            : <small>Not signed in</small>}
                        </span>
                        {switching === engine.id ? <LoaderCircle className="spin" size={16} />
                          : isActive ? <span className="eng-row__badge"><Check size={13} /> In use</span>
                          : !engine.available ? <span className="eng-row__soon">Soon</span>
                          : <span className="eng-row__use">Use</span>}
                      </button>
                      </div>
                    );
                  })}
                </div>
                {error && <p className="eng-panel__error">{error}</p>}
                <p className="eng-note">Connect more providers in <button type="button" className="eng-link" onClick={() => setTab('accounts')}>Accounts</button> or <button type="button" className="eng-link" onClick={() => setTab('keys')}>API keys</button>.</p>
              </section>}

              {tab === 'accounts' && <section>
                <p className="eng-label">Sign in with an account you already have</p>
                <div className="prov-list">{data.accounts.map((account) => <AccountRow key={account.provider} status={account} onChange={() => void load()} />)}</div>
                <p className="eng-note">ThemeBot never sees your passwords or tokens. It only notices when a provider's own app is signed in on this computer, and uses that sign-in when you say so.</p>
              </section>}

              {tab === 'keys' && <section>
                <p className="eng-label">API keys</p>
                <div className="prov-list">{data.keys.map((key) => <KeyRow key={key.provider} status={key} onChange={() => void load()} />)}</div>
                <p className="eng-note">Each key is checked with its provider before it's saved, then stored encrypted on this computer. It's never shown again in full.</p>
              </section>}

              {tab === 'usage' && <><section>
                <p className="eng-label">ThemeBot's usage</p>
                {!data.usage.trackedSince ? (
                  <div className="eng-empty"><span><BarChart3 size={18} /></span><div><b>No usage yet</b><small>After your next build you'll see tokens, time and cost here, day by day.</small></div></div>
                ) : <>
                <div className="eng-stats">
                  <div><span>Today</span><b>{tokens(data.usage.today.tokens)}</b><small>{data.usage.today.sessions} session{data.usage.today.sessions === 1 ? '' : 's'}{data.usage.today.costUsd ? ` · ${money(data.usage.today.costUsd)}` : ''}</small></div>
                  <div><span>Last 7 days</span><b>{tokens(data.usage.week.tokens)}</b><small>{data.usage.week.sessions} session{data.usage.week.sessions === 1 ? '' : 's'}{data.usage.week.costUsd ? ` · ${money(data.usage.week.costUsd)}` : ''}</small></div>
                  <div title="Estimated at API list prices — your subscription is not billed per token"><span>Est. cost</span><b>{money(data.usage.week.estUsd || data.usage.week.costUsd)}</b><small>last 7 days · {data.usage.week.minutes >= 60 ? `${Math.floor(data.usage.week.minutes / 60)}h ${data.usage.week.minutes % 60}m` : `${data.usage.week.minutes}m`} AI time</small></div>
                </div>
                <div className="eng-bars" aria-label="Tokens per day, last 7 days">
                  {data.usage.days.map((day) => (
                    <div key={day.day} className="eng-bars__col" title={`${new Date(day.day).toLocaleDateString(undefined, { weekday: 'long' })}: ${tokens(day.tokens)} tokens`}>
                      <i style={{ height: `${Math.max(4, (day.tokens / peak) * 100)}%` }} className={day.tokens ? '' : 'is-empty'} />
                      <span>{new Date(day.day).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
                    </div>
                  ))}
                </div>
                <button type="button" className="eng-viewall" onClick={() => { setOpen(false); setShowUsage(true); }}>View all usage <ChevronRight size={15} /></button>
                </>}
              </section>

              {data.usage.lastLimit && (
                <p className={`eng-limit${limitRecent ? ' is-recent' : ''}`}><TriangleAlert size={15} />
                  Usage limit hit {ago(data.usage.lastLimit.at)}{data.usage.lastLimit.reset ? ` — Claude said it resets ${data.usage.lastLimit.reset}` : ''}. Waiting builds pause until then.</p>
              )}
              <p className="eng-note">ThemeBot's own use only — your plan's overall allowance is in your {active?.name ?? 'AI'} account.</p>
              </>}
            </>}
          </div>
        </div>,
        document.body,
      )}
      {showUsage && <UsageDetails onClose={() => setShowUsage(false)} />}
    </>
  );
}
