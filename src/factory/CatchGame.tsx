// "Play while you wait" — a tiny catch game layered over the BuildScene while a slow step runs.
// Packages fall; click them to catch. Golden ones are worth 5, bugs cost 3 and break the combo.
// Deliberately light: DOM + CSS transforms, at most ~7 items alive, one spawn timer.
import { useCallback, useEffect, useRef, useState } from 'react';

type Kind = 'crate' | 'gold' | 'bug';
interface Drop { id: number; kind: Kind; x: number; duration: number; spin: number }
interface Pop { id: number; x: number; y: number; text: string; kind: Kind }

const BEST_KEY = 'themebot-catch-best';
const readBest = () => { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } };

export function CatchGame({ onExit }: { onExit: () => void }) {
  const [drops, setDrops] = useState<Drop[]>([]);
  const [pops, setPops] = useState<Pop[]>([]);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [best, setBest] = useState(readBest);
  const nextId = useRef(1);
  const started = useRef(Date.now());
  const fieldRef = useRef<HTMLDivElement>(null);

  // Spawner: speeds up gently over the first two minutes.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const spawn = () => {
      const age = (Date.now() - started.current) / 1000;
      const pace = Math.max(0.55, 1 - age / 240);            // 1 → 0.55
      const roll = Math.random();
      const kind: Kind = roll < 0.12 ? 'gold' : roll < 0.3 ? 'bug' : 'crate';
      setDrops((current) => current.length >= 7 ? current : [...current, {
        id: nextId.current++, kind, x: 6 + Math.random() * 86,
        duration: (kind === 'gold' ? 2.3 : 3.2) * pace + Math.random() * 0.8, spin: (Math.random() - 0.5) * 540,
      }]);
      timer = setTimeout(spawn, (650 + Math.random() * 500) * pace);
    };
    timer = setTimeout(spawn, 300);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (score > best) { setBest(score); try { localStorage.setItem(BEST_KEY, String(score)); } catch { /* private mode */ } }
  }, [score, best]);

  const pop = useCallback((x: number, y: number, text: string, kind: Kind) => {
    const id = nextId.current++;
    setPops((current) => [...current.slice(-6), { id, x, y, text, kind }]);
    setTimeout(() => setPops((current) => current.filter((entry) => entry.id !== id)), 700);
  }, []);

  const hit = (drop: Drop, event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const field = fieldRef.current?.getBoundingClientRect();
    const x = field ? event.clientX - field.left : 0;
    const y = field ? event.clientY - field.top : 0;
    setDrops((current) => current.filter((entry) => entry.id !== drop.id));
    if (drop.kind === 'bug') {
      setScore((value) => Math.max(0, value - 3)); setCombo(0); pop(x, y, '−3', 'bug');
      return;
    }
    const multiplier = 1 + Math.floor(combo / 5);
    const gained = (drop.kind === 'gold' ? 5 : 1) * multiplier;
    setScore((value) => value + gained); setCombo((value) => value + 1);
    pop(x, y, `+${gained}${multiplier > 1 ? ` ×${multiplier}` : ''}`, drop.kind);
  };

  // A package that reaches the floor uncaught breaks the combo (bugs falling through are fine).
  const landed = (drop: Drop) => {
    setDrops((current) => current.filter((entry) => entry.id !== drop.id));
    if (drop.kind !== 'bug') setCombo(0);
  };

  const multiplier = 1 + Math.floor(combo / 5);
  return (
    <div className="cgame" ref={fieldRef}>
      <div className="cgame__hud">
        <span><b>{score}</b> caught</span>
        {combo >= 3 && <span className="cgame__combo">combo {combo}{multiplier > 1 ? ` · ×${multiplier}` : ''}</span>}
        <span className="cgame__best">best {best}</span>
        <button type="button" className="cgame__exit" onClick={onExit}>Stop playing</button>
      </div>
      {drops.map((drop) => (
        <button
          key={drop.id}
          type="button"
          tabIndex={-1}
          aria-label={drop.kind === 'bug' ? 'Bug — avoid it' : 'Catch the package'}
          className={`cgame__drop cgame__drop--${drop.kind}`}
          style={{ left: `${drop.x}%`, animationDuration: `${drop.duration}s`, ['--spin' as string]: `${drop.spin}deg` }}
          onPointerDown={(event) => hit(drop, event)}
          onAnimationEnd={() => landed(drop)}
        >
          <i />
        </button>
      ))}
      {pops.map((entry) => <span key={entry.id} className={`cgame__pop cgame__pop--${entry.kind}`} style={{ left: entry.x, top: entry.y }}>{entry.text}</span>)}
      {score === 0 && drops.length > 0 && <p className="cgame__hint">Click the boxes to catch them · golden = 5 · avoid the red bugs</p>}
    </div>
  );
}
