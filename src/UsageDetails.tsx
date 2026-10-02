// "View all usage" — the full picture behind the AI engine card's small Usage tab: totals for a
// chosen range, tokens per day, and breakdowns by model, by build and by session. Built from the
// raw feed (GET /api/factory/engines/usage); sessions saved in parts are merged by session id.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';

interface ModelTokens { input: number; output: number; cacheRead: number; cacheWrite: number; estUsd?: number | null; reportedUsd?: number | null }
interface SessionEntry {
  type: 'session'; at: number; kind?: string; jobId?: string | null; jobName?: string | null; sessionId?: string | null;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  models?: Record<string, ModelTokens>; costUsd?: number | null; estUsd?: number | null; durationMs?: number | null; partial?: boolean; isError?: boolean;
}
type Range = 7 | 30 | 0;

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const money = (n: number) => `$${n.toFixed(2)}`;
const minutes = (ms: number) => { const m = Math.round(ms / 60_000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const cost = (entry: { costUsd?: number | null; estUsd?: number | null }) => entry.costUsd ?? entry.estUsd ?? 0;
const total = (entry: SessionEntry) => entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens;

export function UsageDetails({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<SessionEntry[] | null>(null);
  const [range, setRange] = useState<Range>(7);
  useEffect(() => {
    void fetch('/api/factory/engines/usage').then((r) => r.json()).then((data: { entries: Array<{ type: string }> }) => setEntries(data.entries.filter((e): e is SessionEntry => e.type === 'session'))).catch(() => setEntries([]));
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const view = useMemo(() => {
    const since = range ? Date.now() - range * 86_400_000 : 0;
    const list = (entries ?? []).filter((entry) => entry.at >= since);
    // Sessions (parts merged)
    const sessions = new Map<string, SessionEntry & { parts: number }>();
    for (const entry of list) {
      const key = entry.sessionId ?? `at-${entry.at}`;
      const existing = sessions.get(key);
      if (!existing) { sessions.set(key, { ...entry, parts: 1 }); continue; }
      existing.inputTokens += entry.inputTokens; existing.outputTokens += entry.outputTokens; existing.cacheReadTokens += entry.cacheReadTokens; existing.cacheWriteTokens += entry.cacheWriteTokens;
      existing.estUsd = (existing.estUsd ?? 0) + (entry.estUsd ?? 0); existing.costUsd = existing.costUsd != null || entry.costUsd != null ? (existing.costUsd ?? 0) + (entry.costUsd ?? 0) : null;
      existing.durationMs = Math.max(existing.durationMs ?? 0, entry.durationMs ?? 0); existing.at = Math.max(existing.at, entry.at);
      existing.partial = Boolean(existing.partial && entry.partial); existing.parts += 1;
    }
    const merged = [...sessions.values()].sort((a, b) => b.at - a.at);
    // Models
    const models = new Map<string, Required<Pick<ModelTokens, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>> & { usd: number }>();
    for (const entry of list) for (const [id, m] of Object.entries(entry.models ?? {})) {
      const row = models.get(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
      row.input += m.input; row.output += m.output; row.cacheRead += m.cacheRead; row.cacheWrite += m.cacheWrite; row.usd += m.reportedUsd ?? m.estUsd ?? 0;
      models.set(id, row);
    }
    // Builds
    const builds = new Map<string, { name: string; sessions: number; tokens: number; usd: number; ms: number; last: number }>();
    for (const session of merged) {
      const key = session.jobId ?? session.jobName ?? 'other';
      const row = builds.get(key) ?? { name: session.jobName ?? 'Other', sessions: 0, tokens: 0, usd: 0, ms: 0, last: 0 };
      row.sessions += 1; row.tokens += total(session); row.usd += cost(session); row.ms += session.durationMs ?? 0; row.last = Math.max(row.last, session.at);
      builds.set(key, row);
    }
    // Days
    const dayCount = range || Math.max(7, Math.ceil((Date.now() - Math.min(Date.now(), ...list.map((e) => e.at))) / 86_400_000));
    const days = Array.from({ length: Math.min(dayCount, 60) }, (_, index) => {
      const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (Math.min(dayCount, 60) - 1 - index));
      const end = start.getTime() + 86_400_000;
      const inDay = list.filter((entry) => entry.at >= start.getTime() && entry.at < end);
      return { day: start, tokens: inDay.reduce((sum, e) => sum + total(e), 0), usd: inDay.reduce((sum, e) => sum + cost(e), 0) };
    });
    return {
      merged, days,
      models: [...models.entries()].sort((a, b) => b[1].usd - a[1].usd),
      builds: [...builds.values()].sort((a, b) => b.last - a.last),
      totals: { tokens: list.reduce((s, e) => s + total(e), 0), usd: list.reduce((s, e) => s + cost(e), 0), ms: merged.reduce((s, e) => s + (e.durationMs ?? 0), 0), sessions: merged.length, output: list.reduce((s, e) => s + e.outputTokens, 0) },
    };
  }, [entries, range]);

  const peak = Math.max(1, ...view.days.map((day) => day.tokens));

  return createPortal(
    <div className="ud-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ud" role="dialog" aria-modal="true" aria-label="AI usage">
        <header className="ud-head">
          <div>
            <h2>AI usage</h2>
            <p>Everything ThemeBot's builds used, by day, model, build and session.</p>
          </div>
          <div className="ud-head__tools">
            <div className="ud-range" role="group" aria-label="Range">
              {([7, 30, 0] as Range[]).map((value) => (
                <button key={value} type="button" className={range === value ? 'is-on' : ''} onClick={() => setRange(value)}>{value ? `${value} days` : 'All time'}</button>
              ))}
            </div>
            <a className="ud-csv" href="/api/factory/engines/usage.csv" download><Download size={15} /> CSV</a>
            <button type="button" className="ud-close" aria-label="Close" onClick={onClose}><X size={18} /></button>
          </div>
        </header>

        {!entries ? <p className="ud-empty">Loading…</p> : !view.merged.length ? <p className="ud-empty">No AI usage in this range yet.</p> : (
          <div className="ud-body">
            <div className="ud-kpis">
              <div><span>Tokens</span><b>{tokens(view.totals.tokens)}</b><small>{tokens(view.totals.output)} written by the AI</small></div>
              <div title="Estimated at API list prices — a subscription is not billed per token"><span>Est. cost</span><b>{money(view.totals.usd)}</b><small>at API list prices</small></div>
              <div><span>AI time</span><b>{minutes(view.totals.ms)}</b><small>across all sessions</small></div>
              <div><span>Sessions</span><b>{view.totals.sessions}</b><small>{view.builds.length} build{view.builds.length === 1 ? '' : 's'}</small></div>
            </div>

            <section className="ud-card">
              <h3>Tokens per day</h3>
              <div className="ud-bars">
                {view.days.map((day) => (
                  <div key={day.day.toISOString()} className="ud-bars__col" title={`${day.day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${tokens(day.tokens)} tokens · ${money(day.usd)}`}>
                    <i style={{ height: `${Math.max(3, (day.tokens / peak) * 100)}%` }} className={day.tokens ? '' : 'is-empty'} />
                    {view.days.length <= 10 && <span>{day.day.toLocaleDateString(undefined, { weekday: 'narrow' })}</span>}
                  </div>
                ))}
              </div>
            </section>

            <div className="ud-grid">
              <section className="ud-card">
                <h3>By model</h3>
                <table className="ud-table">
                  <thead><tr><th>Model</th><th>Read</th><th>Written</th><th>Est. cost</th></tr></thead>
                  <tbody>{view.models.map(([id, m]) => (
                    <tr key={id}><td><b>{id.replace(/^claude-/, '').replace(/-\d{8}$/, '')}</b></td><td title={`${m.input.toLocaleString()} new · ${m.cacheRead.toLocaleString()} from cache · ${m.cacheWrite.toLocaleString()} cached`}>{tokens(m.input + m.cacheRead + m.cacheWrite)}</td><td>{tokens(m.output)}</td><td>{money(m.usd)}</td></tr>
                  ))}</tbody>
                </table>
              </section>
              <section className="ud-card">
                <h3>By build</h3>
                <table className="ud-table">
                  <thead><tr><th>Build</th><th>Sessions</th><th>Tokens</th><th>Est. cost</th></tr></thead>
                  <tbody>{view.builds.map((build) => (
                    <tr key={build.name + build.last}><td><b>{build.name}</b><small>{minutes(build.ms)} AI time</small></td><td>{build.sessions}</td><td>{tokens(build.tokens)}</td><td>{money(build.usd)}</td></tr>
                  ))}</tbody>
                </table>
              </section>
            </div>

            <section className="ud-card">
              <h3>Sessions</h3>
              <table className="ud-table ud-table--sessions">
                <thead><tr><th>When</th><th>Build</th><th>Step</th><th>Tokens</th><th>Time</th><th>Est. cost</th></tr></thead>
                <tbody>{view.merged.slice(0, 60).map((session) => (
                  <tr key={(session.sessionId ?? '') + session.at}>
                    <td>{new Date(session.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                    <td>{session.jobName ?? '—'}</td>
                    <td>{session.kind === 'build' ? 'First build' : session.kind ?? '—'}{session.partial && <em title="This session was stopped before it finished (pause, cancel or restart); its numbers are estimated from what it did.">cut short</em>}</td>
                    <td>{tokens(total(session))}</td>
                    <td>{session.durationMs ? minutes(session.durationMs) : '—'}</td>
                    <td>{money(cost(session))}</td>
                  </tr>
                ))}</tbody>
              </table>
            </section>

            <p className="ud-note">Costs are estimates at API list prices, useful for comparing builds. Sessions marked "cut short" were stopped before they finished, so their numbers are estimated from what the AI had done by then.</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
