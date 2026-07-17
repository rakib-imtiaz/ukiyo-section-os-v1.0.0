// Integrated terminal surface — real PTY shells (xterm.js) over WebSocket
// (/terminal, proxied by Vite). Multi-session: each tab is an independent shell
// (its own PTY on the server). Because they run in the project directory against
// the same backend, anything you do — git, npm, factory scripts, file edits — is
// reflected in the app on its next poll.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, TerminalSquare, Trash2, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type Status = 'connecting' | 'connected' | 'closed';

const TERMINAL_THEME = {
  background: '#0b0b0e', foreground: '#e4e4e7', cursor: '#4f7cff',
  selectionBackground: 'rgba(79,124,255,0.28)', black: '#18181b', brightBlack: '#52525b',
};

/** One independent PTY session. Kept mounted (hidden) when its tab is inactive so the shell persists. */
function TerminalInstance({ active, onStatus, onActivity }: { active: boolean; onStatus: (status: Status) => void; onActivity?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [generation, setGeneration] = useState(0); // bump → reconnect
  const activityTimer = useRef<number | undefined>(undefined);

  const flagActivity = useCallback(() => {
    if (!onActivity) return;
    window.clearTimeout(activityTimer.current);
    activityTimer.current = window.setTimeout(onActivity, 1200); // refresh app ~1.2s after output settles
  }, [onActivity]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13, lineHeight: 1.35, cursorBlink: true, theme: TERMINAL_THEME, scrollback: 5000, allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try { fit.fit(); } catch { /* not laid out */ }
    termRef.current = term;
    fitRef.current = fit;
    onStatus('connecting');

    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/terminal`);
    const sendResize = () => {
      try { fit.fit(); } catch { return; }
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    socket.onopen = () => { onStatus('connected'); sendResize(); if (active) term.focus(); };
    socket.onmessage = (event) => { term.write(typeof event.data === 'string' ? event.data : ''); flagActivity(); };
    socket.onclose = () => { onStatus('closed'); term.write('\r\n\x1b[90m[disconnected — press Reconnect]\x1b[0m\r\n'); };
    socket.onerror = () => onStatus('closed');
    const onData = term.onData((data) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'in', data })); });

    const resizeObserver = new ResizeObserver(() => sendResize());
    resizeObserver.observe(host);
    window.addEventListener('resize', sendResize);

    return () => {
      window.clearTimeout(activityTimer.current);
      resizeObserver.disconnect();
      window.removeEventListener('resize', sendResize);
      onData.dispose();
      try { socket.close(); } catch { /* ignore */ }
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  // Refit + focus whenever this tab becomes active (it was display:none before).
  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(() => { try { fitRef.current?.fit(); } catch { /* ignore */ } termRef.current?.focus(); }, 30);
    return () => window.clearTimeout(id);
  }, [active]);

  return (
    <div className={`term-pane${active ? ' is-active' : ''}`}>
      <div className="term-pane__actions">
        <button type="button" onClick={() => termRef.current?.clear()} title="Clear"><Trash2 size={13} /> Clear</button>
        <button type="button" onClick={() => setGeneration((value) => value + 1)} title="Reconnect this shell"><RefreshCw size={13} /> Reconnect</button>
      </div>
      <div className="term-host" ref={hostRef} onClick={() => termRef.current?.focus()} />
    </div>
  );
}

interface Session { id: number; status: Status }

export default function TerminalPane({ onActivity }: { onActivity?: () => void }) {
  const nextId = useRef(2);
  const [sessions, setSessions] = useState<Session[]>([{ id: 1, status: 'connecting' }]);
  const [active, setActive] = useState(1);

  const setStatus = useCallback((id: number, status: Status) => {
    setSessions((current) => current.map((session) => (session.id === id ? { ...session, status } : session)));
  }, []);

  const addSession = () => {
    const id = nextId.current++;
    setSessions((current) => [...current, { id, status: 'connecting' }]);
    setActive(id);
  };

  const closeSession = (id: number) => {
    setSessions((current) => {
      const remaining = current.filter((session) => session.id !== id);
      if (!remaining.length) { const fresh = nextId.current++; setActive(fresh); return [{ id: fresh, status: 'connecting' as Status }]; }
      if (active === id) setActive(remaining[remaining.length - 1].id);
      return remaining;
    });
  };

  const dotClass = (status: Status) => `term-tab__dot term-tab__dot--${status}`;

  return (
    <div className="term-surface">
      <div className="term-tabbar">
        <span className="term-tabbar__brand"><TerminalSquare size={15} /> Terminal</span>
        <div className="term-tabbar__tabs">
          {sessions.map((session, index) => (
            <div key={session.id} className={`term-tab${session.id === active ? ' is-active' : ''}`}>
              <button type="button" className="term-tab__main" onClick={() => setActive(session.id)}>
                <i className={dotClass(session.status)} aria-hidden /> Shell {index + 1}
              </button>
              <button type="button" className="term-tab__close" title="Close shell" onClick={() => closeSession(session.id)}><X size={12} /></button>
            </div>
          ))}
          <button type="button" className="term-tab__add" title="New shell" onClick={addSession}><Plus size={15} /></button>
        </div>
      </div>
      <div className="term-body">
        {sessions.map((session) => (
          // Kept mounted (hidden) so each shell survives tab switches.
          <div key={session.id} className="term-slot" style={{ display: session.id === active ? 'flex' : 'none' }}>
            <TerminalInstance active={session.id === active} onStatus={(status) => setStatus(session.id, status)} onActivity={onActivity} />
          </div>
        ))}
      </div>
      <div className="term-foot">Real shells in the project directory · localhost-only · each tab is an independent session · changes sync to the app automatically.</div>
    </div>
  );
}
