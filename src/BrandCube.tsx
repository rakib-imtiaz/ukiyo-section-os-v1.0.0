// ThemeBot's 3D cube, a picture on all six sides: ThemeBot, your site's builder (React, Lovable,
// Bolt, v0, Replit or Kimi — changes every loop), Liquid (the theme
// code), Shopify, Checked (compared with your site) and Live (the finished store). Used in the Home
// picture (spinning a full 360°) and in the intro splash, where the faces fly in one by one.
import type { ReactNode } from 'react';

// The "your website" side shows a different site builder on each loop of the cube (it swaps while
// that side is turned away). Simple drawn marks, not the official logo files.
const PLATFORMS: Array<{ id: string; name: string; mark: ReactNode }> = [
  { id: 'react', name: 'React', mark: <svg viewBox="-12 -12 24 24"><circle r="2.1" fill="#61dafb" /><g fill="none" stroke="#61dafb" strokeWidth="1.1"><ellipse rx="10" ry="3.9" /><ellipse rx="10" ry="3.9" transform="rotate(60)" /><ellipse rx="10" ry="3.9" transform="rotate(120)" /></g></svg> },
  { id: 'lovable', name: 'Lovable', mark: <svg viewBox="0 0 24 24"><defs><linearGradient id="bc-lov" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ff8a3d" /><stop offset=".55" stopColor="#ff4f8b" /><stop offset="1" stopColor="#8b5cf6" /></linearGradient></defs><path d="M12 20.5s-7.5-4.6-7.5-10.1A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.8c0 5.5-7.5 10.1-7.5 10.1z" fill="url(#bc-lov)" /></svg> },
  { id: 'bolt', name: 'Bolt', mark: <svg viewBox="0 0 24 24"><path d="M13.5 2.5 5 13.5h6l-1.5 8 8.5-11h-6z" fill="#fff" /></svg> },
  { id: 'v0', name: 'v0', mark: <svg viewBox="0 0 24 24"><text x="12" y="16.5" textAnchor="middle" fill="#fff" fontSize="13" fontWeight="800" fontFamily="Inter, system-ui, sans-serif" letterSpacing="-.5">v0</text></svg> },
  { id: 'replit', name: 'Replit', mark: <svg viewBox="0 0 24 24" fill="#fff"><path d="M6 4.5h5.5a1 1 0 0 1 1 1v4.5H7a1 1 0 0 1-1-1z" /><path d="M12.5 10H18a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-5.5z" /><path d="M7 14.5h5.5V19a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-3.5a1 1 0 0 1 1-1z" /></svg> },
  { id: 'kimi', name: 'Kimi', mark: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="#fff" strokeWidth="1.8" /><path d="M9.5 7.8v8.4M9.5 12.4l4.6-4.6M11.2 11l3.4 5.2" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" fill="none" /></svg> },
];

export function BrandCube({ size = 88, assemble = false, className = '' }: { size?: number; assemble?: boolean; className?: string }) {
  return (
    <div className={`bcube${assemble ? ' bcube--assemble' : ''} ${className}`} style={{ ['--s' as string]: `${size}px` }} aria-hidden>
      {/* A slightly smaller solid core fills the corners behind the rounded faces, so no hollow shows. */}
      {(['front', 'right', 'back', 'left', 'top', 'bottom'] as const).map((side) => <span key={side} className={`bcube__core bcube__face--${side}`} />)}
      <span className="bcube__face bcube__face--front" style={{ ['--n' as string]: 0 }}><span className="bcube__mark"><i /></span></span>
      <span className="bcube__face bcube__face--right bcube__face--src" style={{ ['--n' as string]: 1 }}>
        {PLATFORMS.map((platform, index) => (
          <span key={platform.name} className={`bcube__src bcube__src--${platform.id}`} style={{ ['--k' as string]: index }}>
            {platform.mark}
            <em>{platform.name}</em>
          </span>
        ))}
      </span>
      <span className="bcube__face bcube__face--back" style={{ ['--n' as string]: 2 }}><b>{'{% %}'}</b><em>Liquid</em></span>
      <span className="bcube__face bcube__face--left" style={{ ['--n' as string]: 3 }}>
        <svg viewBox="0 0 24 24"><path d="M5 7.5h14l-1.3 13H6.3z" fill="#fff" /><path d="M9 7.5V6.5a3 3 0 0 1 6 0v1" fill="none" stroke="#fff" strokeWidth="1.8" /><text x="12" y="17.6" textAnchor="middle" fill="#5e8e3e" fontSize="9" fontWeight="800">S</text></svg>
        <em>Shopify</em>
      </span>
      <span className="bcube__face bcube__face--top" style={{ ['--n' as string]: 4 }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="6.5" /><path d="M20.5 20.5 16 16" /><path d="m8.2 11.2 2 2 3.8-4" /></svg>
        <em>Checked</em>
      </span>
      <span className="bcube__face bcube__face--bottom" style={{ ['--n' as string]: 5 }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2.5c3.5 2.2 5.3 5.8 5 10.2l-2.4 2.8H9.4L7 12.7c-.3-4.4 1.5-8 5-10.2z" /><circle cx="12" cy="9.5" r="1.8" /><path d="M9.4 15.5 7 19l3.2-.8M14.6 15.5 17 19l-3.2-.8M12 17.5v4" /></svg>
        <em>Live</em>
      </span>
    </div>
  );
}
