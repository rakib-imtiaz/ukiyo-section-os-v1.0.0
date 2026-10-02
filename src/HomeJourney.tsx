// Home illustration: website card -> a twisting DNA helix threaded with section chips -> the ThemeBot
// cube -> a second helix threaded with theme-file chips -> storefront card. Each connector is its own
// fixed-viewBox SVG that scales uniformly and meets the cards at their centre height (y=100).
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { BrandCube } from './BrandCube';
import { motionOff } from './motion';

type JourneyState = 'idle' | 'running' | 'done';
type Icon = 'doc' | 'image' | 'tag' | 'layout' | 'file';

const ICON: Record<Icon, ReactNode> = {
  doc: <><path d="M4 1.5h5.5L13 5v9.5H4z" /><path d="M9.5 1.5V5H13" /><path d="M6.5 8.5h4M6.5 11h4" /></>,
  image: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="6" cy="6.6" r="1.2" /><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" /></>,
  tag: <><path d="M8.6 2H14v5.4L7.4 14 2 8.6z" /><circle cx="11" cy="5" r="1" /></>,
  layout: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 6h12M6 6v7.5" /></>,
  file: <><path d="M4 1.5h5.5L13 5v9.5H4z" /><path d="M6.5 8.5h4M6.5 11h4" stroke="#fff" strokeWidth="1.3" /></>,
};

interface Chip { label: string; icon: Icon }

const W = 280;
/** Sections on the rolling barrel (8 around the drum). The file barrel on the other side rolls in
 *  sync, so every section always sits straight across from its .liquid file. */
const SECTIONS: Chip[] = [
  { label: 'Hero', icon: 'layout' }, { label: 'Gallery', icon: 'image' }, { label: 'Pricing', icon: 'tag' }, { label: 'FAQ', icon: 'doc' },
  { label: 'Reviews', icon: 'doc' }, { label: 'Team', icon: 'image' }, { label: 'Contact', icon: 'doc' }, { label: 'Footer', icon: 'layout' },
];
const fileOf = (chip: Chip): Chip => ({ label: `${chip.label.toLowerCase()}.liquid`, icon: 'file' });

const BEADS = 22;
const reducedMotion = motionOff;

/** A twisting DNA double helix from x0 to x1 around y=100. It pinches to a point at both ends,
 *  so it plugs straight into the card on one side and the cube on the other. Beads grow and
 *  brighten on the near side of the twist, rungs join the two strands, and the whole helix
 *  keeps turning (faster while a build runs). Pauses when off-screen or the tab is hidden. */
function Helix({ x0, x1, speed }: { x0: number; x1: number; speed: number }) {
  const strandA = useRef<SVGPathElement>(null);
  const strandB = useRef<SVGPathElement>(null);
  const beads = useRef<Array<SVGCircleElement | null>>([]);
  const rungs = useRef<Array<SVGLineElement | null>>([]);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    let frame = 0; let phase = 0; let last = performance.now(); let visible = true;
    const svg = strandA.current?.ownerSVGElement;
    const observer = svg && 'IntersectionObserver' in window ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }) : null;
    if (svg && observer) observer.observe(svg);
    const draw = () => {
      let pathA = ''; let pathB = '';
      for (let i = 0; i < BEADS; i += 1) {
        const t = i / (BEADS - 1);
        const x = x0 + (x1 - x0) * t;
        const envelope = Math.pow(Math.sin(Math.PI * t), 0.75); // 0 at both ends: the strands meet the card/cube
        const angle = t * Math.PI * 2.5 + phase;
        const amp = 38 * envelope;
        const yA = 100 + amp * Math.sin(angle);
        const yB = 100 - amp * Math.sin(angle);
        const nearA = (Math.cos(angle) + 1) / 2; // 1 = strand A is in front
        const nearB = 1 - nearA;
        pathA += `${i ? 'L' : 'M'}${x.toFixed(1)} ${yA.toFixed(1)}`;
        pathB += `${i ? 'L' : 'M'}${x.toFixed(1)} ${yB.toFixed(1)}`;
        const beadA = beads.current[i * 2]; const beadB = beads.current[i * 2 + 1]; const rung = rungs.current[i];
        if (beadA) { beadA.setAttribute('cx', x.toFixed(1)); beadA.setAttribute('cy', yA.toFixed(1)); beadA.setAttribute('r', (1.4 + 2.2 * nearA * envelope).toFixed(2)); beadA.style.opacity = (0.3 + 0.7 * nearA).toFixed(2); }
        if (beadB) { beadB.setAttribute('cx', x.toFixed(1)); beadB.setAttribute('cy', yB.toFixed(1)); beadB.setAttribute('r', (1.4 + 2.2 * nearB * envelope).toFixed(2)); beadB.style.opacity = (0.3 + 0.7 * nearB).toFixed(2); }
        if (rung) {
          rung.setAttribute('x1', x.toFixed(1)); rung.setAttribute('x2', x.toFixed(1));
          rung.setAttribute('y1', yA.toFixed(1)); rung.setAttribute('y2', yB.toFixed(1));
          rung.style.opacity = i % 2 ? '0' : (0.12 + 0.3 * envelope * Math.abs(Math.sin(angle))).toFixed(2);
        }
      }
      strandA.current?.setAttribute('d', pathA);
      strandB.current?.setAttribute('d', pathB);
    };
    const tick = (now: number) => {
      const dt = Math.min(64, now - last); last = now;
      if (visible && !document.hidden && !motionOff()) { phase -= (dt / 1000) * ((Math.PI * 2) / speedRef.current); draw(); }
      frame = requestAnimationFrame(tick);
    };
    draw();
    frame = requestAnimationFrame(tick); // idles (no drawing) while animations are off
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [x0, x1]);

  return (
    <g className="hx-helix">
      {Array.from({ length: BEADS }, (_, i) => <line key={`r${i}`} ref={(el) => { rungs.current[i] = el; }} className="hx-helix__rung" />)}
      <path ref={strandB} className="hx-helix__strand hx-helix__strand--b" />
      <path ref={strandA} className="hx-helix__strand hx-helix__strand--a" />
      {Array.from({ length: BEADS * 2 }, (_, i) => <circle key={`b${i}`} ref={(el) => { beads.current[i] = el; }} className={`hx-helix__bead hx-helix__bead--${i % 2 ? 'b' : 'a'}`} r="2" />)}
    </g>
  );
}

// Each side is ONE connected chain: card → twisting helix → axle → a rolling 3D barrel of chips →
// axle → a second helix → the cube. The helixes pinch to a point at every junction, so nothing
// floats free; the outer ends reach past the SVG edge into the cube's column and plug into it.
const REACH = 46;
const JOIN = 12; // how far the junction sits from the barrel

function Network({ tone, speed, spin }: { tone: 'in' | 'out'; speed: number; spin: number }) {
  const chipW = tone === 'in' ? 108 : 150;
  const x0 = (W - chipW) / 2;
  const x1 = x0 + chipW;
  const start = tone === 'in' ? 0 : -REACH;
  const end = tone === 'in' ? W + REACH : W;
  const jIn = x0 - JOIN;   // helix meets the barrel's axle here
  const jOut = x1 + JOIN;
  const chips = tone === 'in' ? SECTIONS : SECTIONS.map(fileOf);
  return (
    <div className={`hx-netwrap hx-netwrap--${tone}`}>
      <svg className={`hx-net hx-net--${tone}`} viewBox={`0 0 ${W} 200`} aria-hidden>
        <Helix x0={start} x1={jIn} speed={speed} />
        <Helix x0={jOut} x1={end} speed={speed} />
        <path className="hx-axle" d={`M ${jIn} 100 H ${x0 + 2} M ${x1 - 2} 100 H ${jOut}`} />
        <circle className="hx-junction" cx={jIn} cy="100" r="3.6" />
        <circle className="hx-junction" cx={jOut} cy="100" r="3.6" />
      </svg>
      <div className="hx-barrel" aria-hidden style={{ left: `${(x0 / W) * 100}%`, width: `${(chipW / W) * 100}%` }}>
        <div className="hx-barrel__drum" style={{ animationDuration: `${spin}s` }}>
          {chips.map((chip, index) => (
            <span key={chip.label} className="hx-barrel__chip" style={{ ['--a' as string]: `${index * (360 / chips.length)}deg` }}>
              <svg className="hx-chip__icon" viewBox="0 0 16 16">{ICON[chip.icon]}</svg>
              <b>{chip.label}</b>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function HomeJourney({ state, label }: { state: JourneyState; label?: string }) {
  const speed = state === 'running' ? 2.2 : 5; // seconds per full twist
  const spin = state === 'running' ? 12 : 22; // seconds per full turn (8 ticks with a pause on each chip)
  return (
    <div className={`hx hx--${state}`}>
      <div className="hx__row">
        <figure className="hx__col" style={{ '--d': '.05s' } as CSSProperties}>
          <div className="hx__card hx__site">
            <div className="hx__chrome"><i /><i /><i /><em /><em className="hx__chrome-end" /></div>
            <div className="hx__photo" />
            <b className="hx__bar hx__bar--1" /><b className="hx__bar hx__bar--2" />
            <div className="hx__tiles"><i /><i /><i /></div>
          </div>
          <figcaption>Your website</figcaption>
        </figure>

        <Network tone="in" speed={speed} spin={spin} />

        <figure className="hx__col hx__mid" style={{ '--d': '.35s' } as CSSProperties}>
          <div className="hx__orb hx__stage">
            <span className="hx__halo" />
            <BrandCube className="hx__cube" />
            <span className="hx__floor" />
            <span className="hx__spark hx__spark--1" /><span className="hx__spark hx__spark--2" /><span className="hx__spark hx__spark--3" />
          </div>
          <figcaption>ThemeBot</figcaption>
          {label && <p className="hx__caption">{state === 'running' && <i className="hx__live" />}{label}</p>}
        </figure>

        <Network tone="out" speed={speed} spin={spin} />

        <figure className="hx__col" style={{ '--d': '.65s' } as CSSProperties}>
          <div className="hx__card hx__store">
            <div className="hx__chrome"><i /><i /><i /><em />
              <svg className="hx__shopify" viewBox="0 0 24 24" aria-hidden><path d="M5 7.5h14l-1.3 13H6.3z" /><path d="M9 7.5V6.5a3 3 0 0 1 6 0v1" fill="none" /><text x="12" y="17.6" textAnchor="middle">S</text></svg>
            </div>
            <div className="hx__scene">
              <svg viewBox="0 0 120 60" preserveAspectRatio="xMidYMid slice" aria-hidden>
                <defs><linearGradient id="hx-room" x1="0" x2="1"><stop offset="0" stopColor="#f3eee8" /><stop offset="1" stopColor="#e7dccf" /></linearGradient></defs>
                <rect x="0" y="0" width="120" height="60" fill="url(#hx-room)" />
                <rect x="88" y="0" width="32" height="60" fill="#d8c3a5" opacity=".55" />
                <path d="M34 44h28v-8a4 4 0 0 0-4-4H38a4 4 0 0 0-4 4z" fill="#efe7dc" stroke="#cdbba6" />
                <path d="M36 44v8M60 44v8" stroke="#a88b6a" strokeWidth="1.6" />
                <path d="M96 52h10l-2-10h-6z" fill="#e9e1d6" stroke="#cdbba6" />
                <path d="M101 42c-6-8-10-10-12-18M101 42c2-9 6-13 9-20M101 42c-1-8-4-12-3-19" stroke="#6f9a6a" strokeWidth="2" fill="none" strokeLinecap="round" />
                <rect x="8" y="10" width="36" height="5" rx="2.5" fill="#fff" opacity=".85" />
                <rect x="8" y="19" width="22" height="5" rx="2.5" fill="#fff" opacity=".7" />
              </svg>
            </div>
            <div className="hx__products">
              <span><svg viewBox="0 0 24 24"><path d="M6 13h12v-3a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2zM7 13v6M17 13v6M6 16h12" /></svg></span>
              <span><svg viewBox="0 0 24 24"><path d="M9 4h6l2 7H7zM12 11v8M8.5 19h7" /></svg></span>
              <span><svg viewBox="0 0 24 24"><path d="M8 20h8l-1-6H9zM12 14c-3-3-5-4-5-8M12 14c0-4 2-6 5-8M12 14c0-3-1-5 0-8" /></svg></span>
            </div>
            <div className="hx__cart"><svg viewBox="0 0 24 24" aria-hidden><path d="M3 4h2l2.4 11h10.2L20 7H6.3" /><circle cx="9" cy="19" r="1.4" /><circle cx="17" cy="19" r="1.4" /></svg>Add to cart</div>
            {state === 'done' && <span className="hx__tick" aria-label="Built">✓</span>}
          </div>
          <figcaption>Your Shopify store</figcaption>
        </figure>
      </div>
    </div>
  );
}
