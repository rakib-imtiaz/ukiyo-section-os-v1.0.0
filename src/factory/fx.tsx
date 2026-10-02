// Hand-rolled react-bits-style effects, adapted to the monochrome design system.
// SpotlightCard, CountUp, Sparkline (animated draw), ScoreRing — all respect
// prefers-reduced-motion and both themes.
import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/utils';
import { motionOff } from '../motion';
import type { Job } from './types';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && motionOff());
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Card with a cursor-tracking monochrome radial highlight + hover lift.
    Add `live` for the animated running border on in-progress jobs. */
export function SpotlightCard({ className, children, live, onMouseMove: onMove, ...props }: HTMLAttributes<HTMLDivElement> & { live?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    onMove?.(event);
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    element.style.setProperty('--spot-x', `${event.clientX - rect.left}px`);
    element.style.setProperty('--spot-y', `${event.clientY - rect.top}px`);
  };
  return (
    <div ref={ref} {...props} onMouseMove={onMouseMove}
      className={cn('spotlight-card rounded-xl border border-border bg-card text-card-foreground shadow-sm', live && 'live-border', className)}>
      {children}
    </div>
  );
}

/** Animated number — counts up from the previously shown value (0 on mount). */
export function CountUp({ value, decimals = 0, duration = 900, suffix = '', className }: {
  value: number; decimals?: number; duration?: number; suffix?: string; className?: string;
}) {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(reduced ? value : 0);
  const previous = useRef(reduced ? value : 0);

  useEffect(() => {
    if (reduced) { previous.current = value; setDisplay(value); return; }
    const from = previous.current;
    const to = value;
    previous.current = to;
    if (from === to) { setDisplay(to); return; }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, reduced]);

  return <span className={cn('tabular-nums', className)}>{display.toFixed(decimals)}{suffix}</span>;
}

/** Monochrome sparkline with draw-on animation and soft area fill. */
export function Sparkline({ history, width = 96, height = 28, className }: {
  history: Job['score_history']; width?: number; height?: number; className?: string;
}) {
  if (!history?.length) return null;
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const coords = history.map((entry, index) => {
    const x = pad + (history.length === 1 ? innerW : (index / (history.length - 1)) * innerW);
    const y = pad + innerH - Math.min(1, Math.max(0, entry.score)) * innerH;
    return { x, y };
  });
  const points = coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = `${pad},${height - pad} ${points} ${coords[coords.length - 1].x.toFixed(1)},${height - pad}`;
  const last = coords[coords.length - 1];
  return (
    <svg width={width} height={height} className={cn('shrink-0 text-foreground', className)} aria-label="score history" role="img">
      <polygon points={area} fill="currentColor" opacity={0.08} className="spark-fill" />
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" pathLength={1} className="spark-draw" />
      <circle cx={last.x} cy={last.y} r={2.25} fill="currentColor" className="spark-fill" />
    </svg>
  );
}

/** Circular score gauge with an animated stroke and counted-up percentage. */
export function ScoreRing({ value, size = 52, stroke = 4.5, className }: { value: number; size?: number; stroke?: number; className?: string }) {
  const clamped = Math.min(1, Math.max(0, value));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }} role="img" aria-label={`score ${(clamped * 100).toFixed(0)}%`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--foreground)" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={circumference * (1 - clamped)}
          style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.165, 0.84, 0.44, 1)' }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-bold tabular-nums">
        <CountUp value={clamped * 100} decimals={0} />
      </span>
    </div>
  );
}

/** One flip-clock digit: when it changes, the old digit folds away and the new one flips down. */
function FlipDigit({ digit }: { digit: string }) {
  const [shown, setShown] = useState({ prev: '0', cur: '0', flips: 0 });
  useEffect(() => {
    setShown((state) => (state.cur === digit ? state : { prev: state.cur, cur: digit, flips: state.flips + 1 }));
  }, [digit]);
  return (
    <span className="flipd">
      <span className="flipd__sizer" aria-hidden>{shown.cur}</span>
      {shown.flips > 0 && <span key={`out-${shown.flips}`} className="flipd__out" aria-hidden>{shown.prev}</span>}
      <span key={`in-${shown.flips}`} className={`flipd__in${shown.flips > 0 ? ' is-flipping' : ''}`} aria-hidden>{shown.cur}</span>
    </span>
  );
}

/** A number shown as flip-clock digits (flips from 0 on first show, then on every change). */
export function FlipNumber({ value, className }: { value: number; className?: string }) {
  const digits = String(Math.max(0, Math.round(value))).split('');
  return (
    <span className={cn('flipn', className)} role="img" aria-label={String(value)}>
      {digits.map((digit, index) => <FlipDigit key={digits.length - index} digit={digit} />)}
    </span>
  );
}
