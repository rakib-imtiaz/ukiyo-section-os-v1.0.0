// SIDEBAR — glass navigation rail. Four destinations (Home, Builds, Projects, Connections),
// developer tools only when developer mode is on, and Settings + a light/dark switch pinned
// to the bottom. Server health lives in the top-bar status pill (useHealth below).
import { useEffect, useState } from 'react';
import { Moon, Settings, Sun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { EngineCard } from './EngineCard';

export interface SidebarNavItem<V extends string> {
  id: V;
  label: string;
  icon: LucideIcon;
}

interface Health { ok: boolean; version: string; database: string; uptimeSec: number }

/** Live server health for the top-bar status pill — polls every 30s, pauses when hidden. */
export function useHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  const [state, setState] = useState<'checking' | 'online' | 'offline'>('checking');
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const response = await fetch('/api/health');
        if (!alive) return;
        if (response.ok) { setHealth(await response.json() as Health); setState('online'); }
        else setState('offline');
      } catch { if (alive) setState('offline'); }
    };
    void tick();
    const timer = setInterval(() => { if (!document.hidden) void tick(); }, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return { health, state };
}

export default function Sidebar<V extends string>({ items, view, onNavigate, settingsActive, onOpenSettings, dark, onToggleTheme }: {
  items: ReadonlyArray<SidebarNavItem<V>>;
  view: V;
  onNavigate: (view: V) => void;
  settingsActive: boolean;
  onOpenSettings: () => void;
  dark: boolean;
  onToggleTheme: () => void;
}) {
  return (
    <aside className="gs-sidebar">
      <div className="gs-brand">
        <span className="gs-brand__mark" aria-hidden><span /></span>
        <strong>ThemeBot</strong>
      </div>
      <nav className="gs-nav" aria-label="Primary">
        {items.map((item) => {
          const Icon = item.icon;
          const active = view === item.id && !settingsActive;
          return (
            <button key={item.id} type="button" className={`gs-nav__item${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => onNavigate(item.id)}>
              <Icon size={17} strokeWidth={1.8} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="gs-sidebar__bottom">
        <EngineCard />
        <button type="button" className={`gs-nav__item${settingsActive ? ' is-active' : ''}`} aria-current={settingsActive ? 'page' : undefined} onClick={onOpenSettings}>
          <Settings size={17} strokeWidth={1.8} />
          <span>Settings</span>
        </button>
        <button type="button" role="switch" aria-checked={dark} className="gs-nav__item gs-theme" onClick={onToggleTheme}>
          {dark ? <Moon size={17} strokeWidth={1.8} /> : <Sun size={17} strokeWidth={1.8} />}
          <span>Dark mode</span>
          <i className={`gs-switch${dark ? ' is-on' : ''}`} aria-hidden><b /></i>
        </button>
      </div>
    </aside>
  );
}
