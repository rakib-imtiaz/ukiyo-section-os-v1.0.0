// INTRO — a short branded splash the first time ThemeBot opens in a browser session:
// the ThemeBot cube assembles face by face and spins in, "ThemeBot" rises letter by letter, the tagline fades up, then it fades
// away by itself (~3.4s). Skip, Escape, or a click end it early. Reduced motion = no splash.
import { useEffect, useState } from 'react';
import { BrandCube } from './BrandCube';
import { motionOff } from './motion';

const SEEN_KEY = 'themebot-intro-seen';
const WORD = 'ThemeBot';

function shouldShow() {
  try {
    if (motionOff()) return false;
    return sessionStorage.getItem(SEEN_KEY) !== '1';
  } catch { return false; }
}

export default function IntroSplash() {
  const [phase, setPhase] = useState<'open' | 'closing' | 'gone'>(() => (shouldShow() ? 'open' : 'gone'));

  useEffect(() => {
    if (phase !== 'open') return;
    try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode — show again next time */ }
    const close = () => setPhase('closing');
    const timer = window.setTimeout(close, 3400);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') close(); };
    window.addEventListener('keydown', onKey);
    return () => { window.clearTimeout(timer); window.removeEventListener('keydown', onKey); };
  }, [phase]);

  useEffect(() => {
    if (phase !== 'closing') return;
    const timer = window.setTimeout(() => setPhase('gone'), 520);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (phase === 'gone') return null;
  return (
    <div className={`gintro${phase === 'closing' ? ' is-closing' : ''}`} onClick={() => setPhase('closing')} role="presentation">
      <div className="gintro__center">
        <div className="gintro__stage"><BrandCube size={104} assemble /><span className="gintro__floor" /></div>
        <h1 className="gintro__word" aria-label={WORD}>
          {WORD.split('').map((letter, index) => (
            <span key={index} aria-hidden style={{ ['--i' as string]: index }}>{letter}</span>
          ))}
        </h1>
        <p className="gintro__tagline">Your website, turned into a real Shopify store.</p>
      </div>
      <button type="button" className="gintro__skip" onClick={(event) => { event.stopPropagation(); setPhase('closing'); }}>Skip</button>
    </div>
  );
}
