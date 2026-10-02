// StoryPath — the setup steps as one drawn line. On first view the connector draws itself top to
// bottom and each step's line icon traces itself as the line reaches it (SVG stroke-dashoffset
// with pathLength=1, so every path animates the same way). With `states` it becomes the live
// progress: done steps turn solid with a drawn tick, the active connector flows, pending stay
// faint. Pure SVG + CSS; reduced motion shows the finished drawing.
import type { ReactNode } from 'react';

export type StoryIcon = 'window' | 'bag' | 'plug' | 'key' | 'check' | 'compare' | 'layout';
export type StoryState = 'done' | 'active' | 'pending' | 'failed' | 'skipped';
export interface StoryStep { icon: StoryIcon; title: ReactNode; detail?: ReactNode }

const ICONS: Record<StoryIcon, string[]> = {
  window: ['M3 5h18v14H3z', 'M3 9h18', 'M6 7h.01', 'M9 7h.01'],
  bag: ['M5 8h14l-1.2 12H6.2L5 8z', 'M9 8V7a3 3 0 0 1 6 0v1'],
  plug: ['M9 3v5', 'M15 3v5', 'M6 8h12v3a6 6 0 0 1-12 0z', 'M12 17v4'],
  key: ['M14.5 9.5a4 4 0 1 1-1.2-2.8', 'M13.3 12.7 20 19.4', 'M17 16.4l2-2', 'M18.8 18.2l2-2'],
  check: ['M4 4h16v16H4z', 'M8 12.5l2.8 2.8L16.5 9'],
  compare: ['M3 5h11v9H3z', 'M10 10h11v9H10z'],
  layout: ['M3 4h18v16H3z', 'M3 9h18', 'M9 9v11'],
};
const TICK = 'M7.5 12.5l3 3 6-6.5';

export function StoryPath({ steps, states, animate = true, compact = false }: { steps: StoryStep[]; states?: StoryState[]; animate?: boolean; compact?: boolean }) {
  const live = Boolean(states);
  return (
    <ol className={`story${animate ? ' story--draw' : ''}${live ? ' story--live' : ''}${compact ? ' story--compact' : ''}`}>
      {steps.map((step, index) => {
        const state: StoryState = states?.[index] ?? 'pending';
        const last = index === steps.length - 1;
        return (
          <li key={index} className="story__row" data-state={live ? state : undefined} style={{ ['--i' as string]: index }}>
            <div className="story__rail" aria-hidden>
              <svg className="story__node" viewBox="0 0 44 44" width="44" height="44">
                <circle className="story__ring" cx="22" cy="22" r="20" pathLength={1} />
                <g transform="translate(10 10)">
                  {live && state === 'done'
                    ? <path className="story__icon story__tick" d={TICK} pathLength={1} />
                    : ICONS[step.icon].map((d) => <path key={d} className="story__icon" d={d} pathLength={1} />)}
                </g>
              </svg>
              {!last && (
                <svg className="story__link" viewBox="0 0 44 100" preserveAspectRatio="none">
                  <path className="story__line-bg" d="M22 0 C 34 30, 10 70, 22 100" pathLength={1} vectorEffect="non-scaling-stroke" />
                  <path className="story__line" d="M22 0 C 34 30, 10 70, 22 100" pathLength={1} />
                </svg>
              )}
            </div>
            <div className="story__text">
              <b>{step.title}</b>
              {step.detail && <span>{step.detail}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
