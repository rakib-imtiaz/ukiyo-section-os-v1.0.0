// "Watch how it works" — the 1:44 store & app setup video. Three entry points share one modal:
// a compact button, a text link, and a preview card (a real frame of the video + play button).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, X } from 'lucide-react';

/** Vite's dev proxy stalls on video Range requests — stream straight from the API origin in
 *  dev (port 5173 → API on 8787); in production the app is served by the API itself. */
const VIDEO_SRC = window.location.port === '5173'
  ? `${window.location.protocol}//${window.location.hostname}:8787/api/setup-video`
  : '/api/setup-video';
const DURATION = '1:44';

// The video is a rendered file that isn't in every build (e.g. CI builds of the desktop app).
// Ask once; the entry points hide themselves rather than offer a video that isn't there.
let availability: Promise<boolean> | null = null;
function useVideoAvailable() {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    availability ??= fetch(VIDEO_SRC, { method: 'HEAD' }).then((response) => response.ok, () => false);
    let alive = true;
    void availability.then((ok) => { if (alive) setAvailable(ok); });
    return () => { alive = false; };
  }, []);
  return available;
}

function VideoModal({ onClose }: { onClose: () => void }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Portal to <body>: .glass-window's backdrop-filter would otherwise trap position:fixed.
  return createPortal(
    <div className="gvid__overlay" role="dialog" aria-modal="true" aria-label="Setup video" onClick={onClose}>
      <div className="gvid__panel" onClick={(event) => event.stopPropagation()}>
        <div className="gvid__head">
          <div>
            <b>Set up your Shopify store &amp; connection</b>
            <span>All the steps in under two minutes — from signing in to pasting the keys.</span>
          </div>
          <button type="button" className="gvid__close" onClick={onClose} aria-label="Close video"><X size={18} /></button>
        </div>
        {missing
          ? <p className="gvid__missing">The video has not been rendered on this computer yet. The written steps in the setup guide cover the same ground.</p>
          // eslint-disable-next-line jsx-a11y/media-has-caption -- silent video with burned-in captions
          : <video src={VIDEO_SRC} controls autoPlay muted playsInline className="gvid__video" onError={() => setMissing(true)} />}
      </div>
    </div>,
    document.body,
  );
}

export function WatchVideoButton({ label = 'Watch how it works', variant = 'outline' }: { label?: string; variant?: 'outline' | 'link' }) {
  const [open, setOpen] = useState(false);
  if (useVideoAvailable() === false) return null;
  return (
    <>
      <button type="button" className={variant === 'link' ? 'glink gvid__link' : 'gbtn gbtn--outline'} onClick={() => setOpen(true)}>
        <span className="gvid__play" aria-hidden><Play size={variant === 'link' ? 9 : 12} fill="currentColor" /></span>
        {label}
        {variant === 'outline' && <span className="gvid__len">{DURATION}</span>}
      </button>
      {open && <VideoModal onClose={() => setOpen(false)} />}
    </>
  );
}

/** Preview card: a still frame of the video (seeked to ~9s), a glass play button, title + length. */
export function WatchVideoCard() {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  if (useVideoAvailable() === false) return null;
  return (
    <>
      <button type="button" className="glass-card gvcard" onClick={() => setOpen(true)} aria-label={`Watch how ThemeBot works, ${DURATION}`}>
        <span className={`gvcard__frame${ready ? ' is-ready' : ''}`}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- decorative still frame */}
          <video src={`${VIDEO_SRC}#t=9`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden onLoadedData={() => setReady(true)} />
          <span className="gvcard__shade" />
          <span className="gvcard__play" aria-hidden><Play size={22} fill="currentColor" /></span>
          <span className="gvcard__time">{DURATION}</span>
        </span>
        <span className="gvcard__text">
          <span className="gvcard__eyebrow">Video guide</span>
          <b>See how ThemeBot works</b>
          <span>From signing in to your first build, step by step. No technical knowledge needed.</span>
        </span>
      </button>
      {open && <VideoModal onClose={() => setOpen(false)} />}
    </>
  );
}
