// A calm, stage-aware animation for the "Is this your website?" check. A little web page
// assembles itself block by block as the real stages complete; each stage adds its own touch:
// files scanned (prepare), packages dropping in (install), a power pulse (start), a signal
// ping (check), a camera flash (capture). Pure CSS — no blur stacking, respects reduced motion.
import { useState } from 'react';
import { Gamepad2 } from 'lucide-react';
import { CatchGame } from './CatchGame';
import type { PreviewStage, PreviewStageId } from './types';

const ORDER: PreviewStageId[] = ['prepare', 'install', 'start', 'check', 'capture'];
const CAPTION: Record<PreviewStageId, string> = {
  prepare: 'Reading your project files',
  install: 'Installing what your project needs',
  start: 'Switching your website on',
  check: 'Waiting for your website to answer',
  capture: 'Taking a picture of the home page',
};

const bestScore = () => { try { return Number(localStorage.getItem('themebot-catch-best')) || 0; } catch { return 0; } };
const fmt = (sec: number) => (sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`);

export function BuildScene({ stages, elapsedSec, packages }: { stages: PreviewStage[]; elapsedSec: number; packages: number | null }) {
  const [playing, setPlaying] = useState(false);
  const active = stages.find((stage) => stage.state === 'active') ?? null;
  const activeId: PreviewStageId = active?.id ?? 'prepare';
  // How much of the page is "built": finished stages fill blocks, the active one is shimmering.
  const doneCount = stages.filter((stage) => stage.state === 'done' || stage.state === 'skipped').length;
  const progress = stages.length ? (doneCount + (active ? 0.5 : 0)) / stages.length : 0;
  const blocks = 7;
  const built = Math.round(progress * blocks);

  return (
    <div className={`bscene bscene--${activeId}${playing ? ' is-playing' : ''}`}>
      {playing ? <CatchGame onExit={() => setPlaying(false)} /> : (
        <button type="button" className="bscene__play" onClick={() => setPlaying(true)} aria-label="Play a mini-game while you wait">
          <span className="bscene__play-icon" aria-hidden><Gamepad2 size={16} /><i /></span>
          <span className="bscene__play-text"><b>Play while you wait</b><small>{bestScore() > 0 ? `Beat your best: ${bestScore()}` : 'Catch the boxes, dodge the bugs'}</small></span>
        </button>
      )}
      <div className="bscene__sky" aria-hidden><i /><i /><i /><i /><i /><i /></div>

      <div className="bscene__stage" aria-hidden>
        {/* the page being assembled */}
        <div className="bscene__browser">
          <div className="bscene__chrome"><span /><span /><span /><em /></div>
          <div className="bscene__page">
            {Array.from({ length: blocks }, (_, index) => (
              <b key={index} className={`bscene__block bscene__block--${index}${index < built ? ' is-built' : index === built ? ' is-building' : ''}`} />
            ))}
            <span className="bscene__scan" />
          </div>
          <span className="bscene__flash" />
        </div>

        {/* stage-specific props */}
        <div className="bscene__props">
          <span className="bscene__files"><i /><i /><i /></span>
          <span className="bscene__crates"><i /><i /><i /><i /></span>
          <span className="bscene__power"><i /><i /><i /></span>
          <span className="bscene__ping"><i /><i /></span>
        </div>
      </div>

      <div className="bscene__caption">
        <b>{CAPTION[activeId]}<span className="bscene__dots"><i>.</i><i>.</i><i>.</i></span></b>
        <span>
          {activeId === 'install' && packages ? <>{packages} packages in place · </> : null}
          {fmt(elapsedSec)} so far
        </span>
      </div>

      <ol className="bscene__steps">
        {ORDER.filter((id) => stages.some((stage) => stage.id === id)).map((id) => {
          const stage = stages.find((entry) => entry.id === id)!;
          const secs = stage.startedAt ? Math.max(0, Math.round(((stage.endedAt ?? Date.now()) - stage.startedAt) / 1000)) : null;
          return (
            <li key={id} data-state={stage.state}>
              <i />
              <span>{stage.label}</span>
              <em>{stage.state === 'skipped' ? 'not needed' : secs !== null && stage.state !== 'pending' ? fmt(secs) : ''}</em>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
