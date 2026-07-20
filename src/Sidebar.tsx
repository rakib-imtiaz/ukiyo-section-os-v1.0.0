// SIDEBAR — premium animated navigation rail (blue-accent restyle).
// The active state is a single measured "indicator" pill — now a blue gradient
// pill with a soft glow — that glides between nav items (transform/width/height
// are measured from the active button and animated in CSS). Works across all
// three layouts: expanded rail, collapsed icon rail (manual + <=1050px auto),
// and the <=780px mobile bottom bar — the same indicator follows the button in
// every mode. A ResizeObserver on the <nav> keeps it glued during
// collapse/expand and breakpoint changes.
// SYSTEM STATUS is live: it polls /api/health for server health, database mode,
// and uptime; both bottom cards navigate to Connections.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, FolderOpen, LogOut, MoreHorizontal, PanelLeftClose } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface SidebarNavItem<V extends string> {
  id: V;
  label: string;
  icon: LucideIcon;
  number: string;
}

interface IndicatorBox { x: number; y: number; w: number; h: number }

interface Health { ok: boolean; version: string; database: string; uptimeSec: number }

function formatUptime(seconds: number) {
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function relative(from: number | null) {
  if (from == null) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - from) / 1000));
  return seconds < 5 ? 'just now' : seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

/** Live server health for the SYSTEM STATUS card — polls every 30s, pauses when hidden.
 *  state: 'checking' before the first result, then 'online'/'offline'. */
function useHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  const [state, setState] = useState<'checking' | 'online' | 'offline'>('checking');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const response = await fetch('/api/health');
        if (!alive) return;
        if (response.ok) { setHealth(await response.json() as Health); setCheckedAt(Date.now()); setState('online'); }
        else setState('offline');
      } catch { if (alive) setState('offline'); }
    };
    void tick(); // first check runs immediately, even if the tab starts hidden
    // Subsequent polls skip while hidden to save cycles.
    const timer = setInterval(() => { if (!document.hidden) void tick(); }, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return { health, state, checkedAt };
}

export default function Sidebar<V extends string>({ items, view, onNavigate, collapsed, onToggleCollapsed, settingsView, account }: {
  items: ReadonlyArray<SidebarNavItem<V>>;
  view: V;
  onNavigate: (view: V) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Where the status/user cards navigate (the Connections view id). */
  settingsView: V;
  /** Claude/workspace connection controls shown in the account area. */
  account?: { workspaceName?: string | null; claudeMethod?: string | null; onSwitchWorkspace?: () => void; onLogoutClaude?: () => void };
}) {
  const navRef = useRef<HTMLElement>(null);
  const [accountMenu, setAccountMenu] = useState(false);
  const [indicator, setIndicator] = useState<IndicatorBox | null>(null);
  const { health, state, checkedAt } = useHealth();

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const active = nav.querySelector<HTMLButtonElement>('button.is-active');
      if (!active) { setIndicator(null); return; }
      const next = { x: active.offsetLeft, y: active.offsetTop, w: active.offsetWidth, h: active.offsetHeight };
      // Skip the state update (and re-render) when the box hasn't moved.
      setIndicator((prev) => (prev && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h ? prev : next));
    };
    measure();
    // Fires continuously while the rail collapses/expands and on breakpoint
    // changes, so the pill tracks the active button instead of drifting.
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    // The rail width animates (.3s) on collapse/expand and across the <=1050px
    // breakpoint; a single RO sample can land mid-transition and leave the pill
    // at the 235px expanded width on the 72px rail. Re-measure every frame for
    // the transition window, once more on transitionend, and on breakpoint flips.
    let raf = 0;
    const track = () => {
      cancelAnimationFrame(raf);
      const start = performance.now();
      const step = (now: number) => { measure(); if (now - start < 450) raf = requestAnimationFrame(step); };
      raf = requestAnimationFrame(step);
    };
    track();
    const media = window.matchMedia('(max-width: 1050px)');
    media.addEventListener('change', track);
    nav.addEventListener('transitionend', measure, true);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      media.removeEventListener('change', track);
      nav.removeEventListener('transitionend', measure, true);
    };
  }, [view, collapsed, items]);

  // Close the account menu on Escape (basic menu a11y).
  useEffect(() => {
    if (!accountMenu) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setAccountMenu(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [accountMenu]);

  const statusLabel = state === 'online' ? 'Production ready' : state === 'offline' ? 'Server offline' : 'Checking status…';
  const statusSub = state === 'online' ? 'All systems normal' : state === 'offline' ? 'API is not responding' : 'Connecting to the server';

  return (
    <aside className="sidebar">
      <div className="sidebar__top">
        <div className="brand">
          <img className="brand__mark" src="/home-assets/glass_stack_icon_on_blue_background.png" alt="" width={34} height={34} />
          <div className="brand__text"><strong>THEMEBOT</strong><span>AUTONOMOUS BUILDER</span></div>
        </div>
        <button
          className="sidebar__collapse"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <PanelLeftClose size={15} />
        </button>
      </div>
      <nav ref={navRef} aria-label="Primary">
        <span
          className="sidebar__indicator"
          aria-hidden
          style={indicator
            ? { opacity: 1, width: indicator.w, height: indicator.h, transform: `translate(${indicator.x}px, ${indicator.y}px)` }
            : { opacity: 0 }}
        />
        <div className="sidebar__nav-label" aria-hidden>Menu</div>
        {items.map((item) => {
          const Icon = item.icon;
          const active = view === item.id;
          return (
            <button
              key={item.id}
              className={`sidebar__link${active ? ' is-active' : ''}`}
              data-tooltip={item.label}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              onClick={() => onNavigate(item.id)}
            >
              <em className="sidebar__link-num">{item.number}</em>
              <span className="sidebar__link-icon"><Icon size={15} /></span>
              <span className="sidebar__link-label">{item.label}</span>
            </button>
          );
        })}
      </nav>
      <button
        className={`sidebar__meta${state === 'offline' ? ' is-offline' : ''}${state === 'checking' ? ' is-checking' : ''}`} type="button"
        title={`${statusLabel} — open Connections`}
        data-tooltip={statusLabel}
        onClick={() => onNavigate(settingsView)}
      >
        <span>SYSTEM STATUS</span>
        <p><i className="status-dot" /><b>{statusLabel}</b></p>
        <small>{statusSub}</small>
        <div className="sidebar__meta-rows">
          <div><span>Platform</span><b>{health ? `v${health.version}` : '—'}</b></div>
          <div><span>Storage</span><b>{health ? (health.database === 'postgres' ? 'PostgreSQL' : 'Memory') : '—'}</b></div>
          <div><span>Uptime</span><b>{health ? formatUptime(health.uptimeSec) : '—'}</b></div>
          <div><span>Last sync</span><b>{relative(checkedAt)}</b></div>
        </div>
      </button>
      <div className="sidebar__account">
        <button className="sidebar__user" type="button" title="ThemeBot · Admin — open Connections" onClick={() => onNavigate(settingsView)}>
          <span className="sidebar__user-avatar" aria-hidden>UO</span>
          <span className="sidebar__user-text"><b>ThemeBot</b><small>{account?.workspaceName ? account.workspaceName : 'Admin'}</small></span>
          <ChevronRight size={14} className="sidebar__user-chevron" aria-hidden />
        </button>
        {account && (
          <button className="sidebar__account-more" type="button" title="Account actions" aria-label="Account actions" aria-haspopup="true" aria-expanded={accountMenu} onClick={() => setAccountMenu((value) => !value)}><MoreHorizontal size={15} /></button>
        )}
        {account && accountMenu && (
          <>
            <div className="sidebar__account-scrim" onClick={() => setAccountMenu(false)} />
            <div className="sidebar__account-menu" role="menu">
              <div className="sidebar__account-head"><span>Claude</span><b>{account.claudeMethod === 'api-key' ? 'API key' : account.claudeMethod === 'oauth-cli' ? 'Signed in' : 'Connected'}</b></div>
              <button role="menuitem" onClick={() => { setAccountMenu(false); account.onSwitchWorkspace?.(); }}><FolderOpen size={14} /> Switch workspace</button>
              <button role="menuitem" className="is-danger" onClick={() => { setAccountMenu(false); account.onLogoutClaude?.(); }}><LogOut size={14} /> Log out Claude</button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
