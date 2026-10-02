// Homepage picture for a project or build card. The SERVER takes the pictures in the background
// (at startup, then weekly); cards only read them. One shared status list is fetched for all
// cards, re-checked every few seconds only while some picture is still being taken. Ready
// pictures use a versioned URL, so the browser keeps them and switching tabs shows them instantly.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ImageOff, RefreshCw } from 'lucide-react';

type ThumbStatus = { status: 'ready'; v: number; busy?: boolean } | { status: 'pending' } | { status: 'failed' };

/** Same key the server uses: resolved path, lower-cased, Windows separators. */
const keyOf = (path: string) => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

// ---- shared store ----
let statuses: Record<string, ThumbStatus> = {};
let loaded = false;
let timer: number | undefined;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

async function refreshStatuses() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await fetch('/api/workspace/thumbs');
      if (response.ok) { statuses = ((await response.json()) as { thumbs: Record<string, ThumbStatus> }).thumbs ?? {}; loaded = true; emit(); }
    } catch { /* keep what we have */ }
    finally { inflight = null; schedule(); }
  })();
  return inflight;
}
function schedule() {
  window.clearTimeout(timer);
  const waiting = Object.values(statuses).some((entry) => entry.status === 'pending' || (entry.status === 'ready' && entry.busy));
  if (listeners.size && waiting) timer = window.setTimeout(() => { void refreshStatuses(); }, 5000);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loaded) void refreshStatuses(); else schedule();
  return () => { listeners.delete(listener); if (!listeners.size) window.clearTimeout(timer); };
}
const snapshot = () => statuses;

async function retake(path: string) {
  const current = statuses[keyOf(path)];
  statuses = { ...statuses, [keyOf(path)]: current?.status === 'ready' ? { ...current, busy: true } : { status: 'pending' } };
  emit();
  await fetch('/api/workspace/thumb/retake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).catch(() => undefined);
  window.setTimeout(() => { void refreshStatuses(); }, 2500);
}

export function ProjectThumb({ path, name }: { path: string; name: string }) {
  const all = useSyncExternalStore(subscribe, snapshot);
  const entry: ThumbStatus = all[keyOf(path)] ?? (loaded ? { status: 'failed' } : { status: 'pending' });
  const src = entry.status === 'ready' ? `/api/workspace/thumb?path=${encodeURIComponent(path)}&v=${entry.v}` : null;
  // The <img> fades in once decoded; a cached one decodes instantly, so no skeleton flash.
  const [shown, setShown] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [src]);
  const visible = src != null && shown === src && !broken;
  const state = broken ? 'failed' : entry.status === 'failed' ? 'failed' : visible ? 'ready' : 'loading';
  const retaking = entry.status === 'pending' || (entry.status === 'ready' && Boolean(entry.busy));

  const onRetake = (event: React.MouseEvent) => { event.stopPropagation(); setBroken(false); void retake(path); };

  return (
    <div className={`proj-thumb is-${state}`}>
      {src && !broken && <img key={src} src={src} alt="" aria-hidden decoding="async" onLoad={() => setShown(src)} onError={() => setBroken(true)} />}
      {state === 'loading' && <span className="proj-skel" role="img" aria-label={`Picture of ${name} is being taken`}>
        <span className="proj-skel__nav"><i /><b /><b /><b /><em /></span>
        <span className="proj-skel__hero"><b className="w70" /><b className="w50" /><b className="w35 thin" /><i /></span>
        <span className="proj-skel__tiles"><i /><i /><i /></span>
        {retaking && <span className="proj-skel__note"><span className="proj-skel__cam" />Taking a picture…</span>}
      </span>}
      {state === 'ready' && retaking && <span className="proj-thumb__busy"><span className="proj-skel__cam" />Retaking…</span>}
      {state === 'failed' && <span className="proj-thumb__none"><ImageOff size={26} /><em>No preview</em></span>}
      {state !== 'loading' && !retaking && <button type="button" className="proj-thumb__refresh" onClick={onRetake} title="Retake the picture" aria-label={`Retake the picture of ${name}`}><RefreshCw size={14} />{state === 'failed' && <span>Try again</span>}</button>}
    </div>
  );
}
