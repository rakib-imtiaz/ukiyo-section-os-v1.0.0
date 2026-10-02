// "Animations" setting (Settings → Speed). Off = every animation in the app stops, for slow
// machines. Stored per browser; also off when the computer asks for reduced motion. The choice is
// stamped on <html data-motion="off"> so CSS can freeze everything, and JS animations check
// motionOff() before starting.
const KEY = 'themebot-animations';

export function systemReducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/** The user's own choice: true = animations on (default), false = off. */
export function animationsEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}

let cached: boolean | null = null;
/** True when nothing should move: the setting is off, or the system asks for reduced motion.
 *  Cached (cheap enough to call every animation frame); refreshed when the setting changes. */
export function motionOff(): boolean {
  if (cached === null) cached = !animationsEnabled() || systemReducedMotion();
  return cached;
}

export function applyMotionSetting() {
  if (typeof document === 'undefined') return;
  if (motionOff()) document.documentElement.setAttribute('data-motion', 'off');
  else document.documentElement.removeAttribute('data-motion');
}

export function setAnimationsEnabled(on: boolean) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* this visit only */ }
  cached = !on || systemReducedMotion();
  applyMotionSetting();
  window.dispatchEvent(new Event('themebot:motion'));
}
