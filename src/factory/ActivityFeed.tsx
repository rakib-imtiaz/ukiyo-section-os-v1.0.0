// "What's happening" — a live, timestamped feed of the real work behind a step: stages, the
// commands ThemeBot runs, every network call, and raw program output (hidden unless asked for).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { ActivityEvent, ActivityKind } from './types';

type Filter = 'all' | 'calls' | 'raw';
const FILTERS: Array<{ id: Filter; label: string; title: string }> = [
  { id: 'all', label: 'Steps', title: 'Stages, commands and results' },
  { id: 'calls', label: 'Network calls', title: 'Every request ThemeBot makes' },
  { id: 'raw', label: 'Everything', title: 'Also the raw program output' },
];
const MARK: Record<ActivityKind, string> = { step: '▸', cmd: '$', net: '⇄', out: '·', ok: '✓', err: '✗', info: '•' };

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

function visible(filter: Filter, kind: ActivityKind) {
  if (filter === 'raw') return true;
  if (filter === 'calls') return kind === 'net' || kind === 'cmd' || kind === 'err';
  return kind !== 'out' && kind !== 'net';
}

export function ActivityFeed({ events, live, title = "What's happening", emptyText = 'Waiting for the first step…' }: {
  events: ActivityEvent[]; live: boolean; title?: string; emptyText?: string;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);   // follow new lines unless the user scrolled up to read

  const shown = useMemo(() => events.filter((entry) => visible(filter, entry.kind)).slice(-250), [events, filter]);
  const calls = useMemo(() => events.filter((entry) => entry.kind === 'net').length, [events]);

  useEffect(() => {
    const body = bodyRef.current;
    if (body && stick.current) body.scrollTop = body.scrollHeight;
  }, [shown.length, filter]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(events.map((entry) => `${clock(entry.at)} ${MARK[entry.kind]} ${entry.text}`).join('\n'));
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  return (
    <div className="afeed">
      <div className="afeed__head">
        <span className="afeed__title">
          <i className={`afeed__dot${live ? ' is-live' : ''}`} aria-hidden />
          {title}
          {calls > 0 && <em>{calls} call{calls === 1 ? '' : 's'}</em>}
        </span>
        <span className="afeed__tools">
          {FILTERS.map((option) => (
            <button key={option.id} type="button" title={option.title} className={`afeed__chip${filter === option.id ? ' is-on' : ''}`} onClick={() => setFilter(option.id)}>{option.label}</button>
          ))}
          <button type="button" className="afeed__chip" onClick={() => void copy()} title="Copy the whole log" aria-label="Copy the whole log">
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </span>
      </div>
      <div
        ref={bodyRef}
        className="afeed__body"
        role="log"
        aria-live="polite"
        onScroll={(event) => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
      >
        {shown.length === 0 && <p className="afeed__empty">{emptyText}</p>}
        {shown.map((entry, index) => (
          <p key={`${entry.at}-${index}`} className={`afeed__line afeed__line--${entry.kind}`}>
            <time>{clock(entry.at)}</time>
            <b aria-hidden>{MARK[entry.kind]}</b>
            <span>{entry.text}</span>
          </p>
        ))}
        {live && <p className="afeed__line afeed__cursor"><time>{clock(Date.now())}</time><b aria-hidden>›</b><span><i /></span></p>}
      </div>
    </div>
  );
}
