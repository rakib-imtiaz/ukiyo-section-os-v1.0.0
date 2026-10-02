// Live code — watch the AI write the theme. Polls the project folder for changed theme files and
// replays each change in an editor-style window: a new file types itself out, an edited file keeps
// its unchanged lines and types only the part that changed. Pure React + CSS; with animations
// off (or the build idle) the finished code shows at once.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Braces, ChevronRight, Code2, FileCode2, FileJson, FileText, Folder, FolderOpen, Palette, Pause, Play } from 'lucide-react';
import { api } from './api';
import { motionOff } from '../motion';
import type { LiveCodeFile } from './types';

interface Replay { path: string; before: string[]; typed: string; prefix: string[]; suffix: string[]; mtime: number; truncated: boolean }

const TYPE_SECONDS = 3;          // longest a single replay takes, however big the change
const MAX_LINES = 1200;          // rendering cap per file

function fileIcon(file: string) {
  if (/\.json$/i.test(file)) return <FileJson className="size-3.5" />;
  if (/\.css$/i.test(file)) return <Palette className="size-3.5" />;
  if (/\.(js|mjs)$/i.test(file)) return <Braces className="size-3.5" />;
  if (/\.liquid$/i.test(file)) return <FileCode2 className="size-3.5" />;
  return <FileText className="size-3.5" />;
}

function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

/** Lines unchanged at the top and bottom → only the middle is "written". */
function diffRegion(before: string[], after: string[]) {
  let top = 0;
  while (top < before.length && top < after.length && before[top] === after[top]) top += 1;
  let bottom = 0;
  while (bottom < before.length - top && bottom < after.length - top && before[before.length - 1 - bottom] === after[after.length - 1 - bottom]) bottom += 1;
  return { prefix: after.slice(0, top), middle: after.slice(top, after.length - bottom), suffix: after.slice(after.length - bottom) };
}

// --- tiny highlighter: Liquid tags/output, HTML tags, strings, comments, numbers, CSS props ---
const TOKEN = /(\{%-?[^%]*?-?%\}|\{\{-?[^}]*?-?\}\}|<!--.*?-->|\/\*.*?\*\/|\/\/.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|<\/?[a-zA-Z][\w-]*|\/?>|\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|ms|s)?\b|[a-z-]+(?=\s*:\s*[^;{]*;))/g;
function highlight(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(TOKEN)) {
    const token = match[0];
    const at = match.index ?? 0;
    if (at > last) parts.push(line.slice(last, at));
    const kind = token.startsWith('{%') ? 'tag' : token.startsWith('{{') ? 'out'
      : token.startsWith('<!--') || token.startsWith('/*') || token.startsWith('//') ? 'com'
      : token.startsWith('"') || token.startsWith("'") ? 'str'
      : token.startsWith('<') || token.endsWith('>') ? 'html'
      : /^\d/.test(token) ? 'num' : 'prop';
    parts.push(<span key={at} className={`lc-${kind}`}>{token}</span>);
    last = at + token.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

const Line = memo(function Line({ n, text, fresh, cursor }: { n: number; text: string; fresh?: boolean; cursor?: boolean }) {
  return <div className={`lc-line${fresh ? ' is-fresh' : ''}`}><span className="lc-gutter">{n}</span><span className="lc-code">{text ? highlight(text) : cursor ? null : '​'}{cursor && <span className="lc-cursor" aria-hidden />}</span></div>;
});

/** The AI's raw steps, readable: short file names, no shell commands, no repeats, last 4. */
function friendlySteps(texts: string[]): string[] {
  const out: string[] = [];
  for (const raw of texts) {
    let text = raw.trim();
    if (!text) continue;
    if (/^\$\s/.test(text)) text = /pull|push/i.test(text) ? 'Syncing with the store' : 'Running a check';
    else if (/^Searching/i.test(text)) text = 'Searching the website code';
    else text = text.replace(/^(Reading|Writing|Editing)\s+(\S+)/i, (_m, verb: string, file: string) => `${verb} ${file.split(/[\\/]/).pop()}`);
    text = text.replace(/`/g, '').replace(/\s+/g, ' ');
    if (text.length > 90) text = `${text.slice(0, 88).trimEnd()}…`;
    if (out[out.length - 1] !== text) out.push(text);
  }
  return out.slice(-4);
}

export function LiveCode({ jobId, running }: { jobId: string; running: boolean }) {
  const known = useRef(new Map<string, { content: string; mtime: number }>());
  const queue = useRef<Replay[]>([]);
  const since = useRef(0);
  const primed = useRef(false);
  const [recent, setRecent] = useState<Array<{ path: string; mtime: number; size: number }>>([]);
  const [current, setCurrent] = useState<Replay | null>(null);
  const [shown, setShown] = useState(0);            // characters of current.typed revealed
  const [paused, setPaused] = useState(false);
  const [written, setWritten] = useState({ files: 0, lines: 0 });
  const [pinned, setPinned] = useState<string | null>(null);   // a file the user clicked to read
  const [error, setError] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set());   // folders the user collapsed
  const [doing, setDoing] = useState<string[]>([]);   // latest steps, shown while no code is on screen
  const body = useRef<HTMLDivElement>(null);
  const instant = motionOff() || !running;

  // Poll for changes. First load: remember everything, replay only the newest file.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const data = await api.code(jobId, since.current);
        if (!alive) return;
        setError(false);
        setRecent(data.recent);
        since.current = data.now - 1500;
        const incoming = data.files.filter((file) => (known.current.get(file.path)?.mtime ?? 0) < file.mtime);
        const toReplay = primed.current ? incoming : incoming.slice(-1);
        for (const file of incoming) {
          if (!toReplay.includes(file)) known.current.set(file.path, { content: file.content, mtime: file.mtime });
        }
        for (const file of toReplay) enqueue(file);
        primed.current = true;
        // What the AI is doing right now — shown while waiting, and under the code between files.
        if (running) {
          const activity = await api.activity(jobId).catch(() => null);
          if (alive && activity) setDoing(friendlySteps(activity.events.map((event) => event.text)));
        }
      } catch { if (alive) setError(true); }
    };
    const enqueue = (file: LiveCodeFile) => {
      const before = known.current.get(file.path)?.content ?? '';
      known.current.set(file.path, { content: file.content, mtime: file.mtime });
      if (before === file.content) return;
      const after = file.content.split('\n').slice(0, MAX_LINES);
      const { prefix, middle, suffix } = diffRegion(before ? before.split('\n') : [], after);
      queue.current = queue.current.filter((item) => item.path !== file.path);
      queue.current.push({ path: file.path, before: before.split('\n'), typed: middle.join('\n'), prefix, suffix, mtime: file.mtime, truncated: file.truncated });
      setWritten((value) => ({ files: value.files + (before ? 0 : 1), lines: value.lines + middle.length }));
    };
    void tick();
    const timer = window.setInterval(() => { if (!document.hidden) void tick(); }, running ? 2500 : 15000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [jobId, running]);

  // Replay loop: take the next change, type it out, hold a moment, move on.
  useEffect(() => {
    if (paused || pinned) return;
    if (!current) {
      const next = queue.current.shift();
      if (next) { setCurrent(next); setShown(instant ? next.typed.length : 0); return; }
      const idle = window.setInterval(() => { const item = queue.current.shift(); if (item) { setCurrent(item); setShown(instant ? item.typed.length : 0); } }, 400);
      return () => window.clearInterval(idle);
    }
    if (shown < current.typed.length) {
      const step = Math.max(2, Math.ceil(current.typed.length / (TYPE_SECONDS * 60)));
      const frame = requestAnimationFrame(() => setShown((value) => Math.min(current.typed.length, value + step)));
      return () => cancelAnimationFrame(frame);
    }
    if (!queue.current.length) return;   // keep the finished file on screen until something new arrives
    const hold = window.setTimeout(() => setCurrent(null), 900);
    return () => window.clearTimeout(hold);
  }, [current, shown, paused, pinned, instant]);

  // Waiting for new files while the finished one is on screen.
  useEffect(() => {
    if (!current || shown < current.typed.length || paused || pinned) return;
    const timer = window.setInterval(() => { if (queue.current.length) setCurrent(null); }, 500);
    return () => window.clearInterval(timer);
  }, [current, shown, paused, pinned]);

  // Follow the cursor while typing.
  useEffect(() => {
    if (!body.current || pinned) return;
    const cursor = body.current.querySelector('.lc-cursor');
    if (cursor) (cursor as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    body.current.scrollLeft = 0;
  }, [shown, current, pinned]);

  const view = useMemo(() => {
    if (pinned) {
      const content = known.current.get(pinned)?.content;
      return { path: pinned, lines: (content ?? '').split('\n').slice(0, MAX_LINES), typingFrom: -1, typingTo: -1, writing: false, cursorLine: -1 };
    }
    if (!current) return null;
    const typedLines = current.typed.slice(0, shown).split('\n');
    const lines = [...current.prefix, ...(current.typed ? typedLines : []), ...(shown >= current.typed.length ? current.suffix : [])];
    return { path: current.path, lines, typingFrom: current.prefix.length, typingTo: current.prefix.length + typedLines.length, writing: shown < current.typed.length, cursorLine: current.prefix.length + typedLines.length - 1 };
  }, [current, shown, pinned]);

  // Folder tree in the theme's own order; newest file first inside each folder.
  const tree = useMemo(() => {
    const ORDER = ['layout', 'sections', 'blocks', 'snippets', 'templates', 'config', 'locales', 'assets'];
    const groups = new Map<string, typeof recent>();
    for (const file of recent) {
      const dir = file.path.replace(/^\//, '').split('/')[0];
      groups.set(dir, [...(groups.get(dir) ?? []), { ...file, path: file.path.replace(/^\//, '') }]);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (ORDER.indexOf(a) + 99 * Number(!ORDER.includes(a))) - (ORDER.indexOf(b) + 99 * Number(!ORDER.includes(b))))
      .map(([dir, files]) => ({ dir, files: files.sort((x, y) => y.mtime - x.mtime) }));
  }, [recent]);

  const openFile = async (file: string) => {
    if (!known.current.has(file)) {
      try { const data = await api.codeFile(jobId, file); for (const item of data.files) known.current.set(item.path, { content: item.content, mtime: item.mtime }); } catch { /* keep going */ }
    }
    setPinned(file);
  };

  return (
    <div className="lc">
      <div className="lc-head">
        <div>
          <p className="text-[14px] font-bold">Live code</p>
          <p className="text-[12.5px] font-medium text-muted-foreground">
            {running ? 'Every theme file the AI writes, typed out as it happens.' : 'The theme files this build wrote. Start the build to watch it write live.'}
          </p>
        </div>
        {running && (
          <button type="button" className="lc-toggle" onClick={() => setPaused((value) => !value)}>
            {paused ? <><Play className="size-3.5" /> Resume replay</> : <><Pause className="size-3.5" /> Pause replay</>}
          </button>
        )}
      </div>

      <div className="lc-window">
        <div className="lc-bar">
          <span className="lc-dots"><i /><i /><i /></span>
          <span className="lc-tab">
            <Code2 className="size-3.5" />
            {view ? view.path.replace(/^\//, '') : 'waiting for the first file…'}
            {view?.writing && <em className="lc-writing">writing</em>}
          </span>
          <span className="lc-stats">{written.files} new · {written.lines.toLocaleString()} lines</span>
        </div>
        <div className="lc-main">
          <aside className="lc-files" aria-label="Theme files">
            {recent.length === 0 && <p className="lc-empty">{error ? 'Not available yet.' : 'No theme files yet.'}</p>}
            {tree.map((group) => {
              const isOpen = !closed.has(group.dir) || group.files.some((file) => file.path === view?.path);
              return (
                <div key={group.dir} className="lc-dir">
                  <button type="button" className="lc-dir__head" aria-expanded={isOpen} onClick={() => setClosed((set) => { const next = new Set(set); if (next.has(group.dir)) next.delete(group.dir); else next.add(group.dir); return next; })}>
                    <ChevronRight className={`lc-dir__chev${isOpen ? ' is-open' : ''}`} />
                    {isOpen ? <FolderOpen className="lc-dir__icon" /> : <Folder className="lc-dir__icon" />}
                    <span>{group.dir}</span>
                    <small>{group.files.length}</small>
                  </button>
                  {isOpen && group.files.map((file) => (
                    <button key={file.path} type="button" title={`${file.path} — written ${ago(file.mtime)}`}
                      className={`lc-file lc-file--nested${view?.path === file.path ? ' is-active' : ''}${Date.now() - file.mtime < 120_000 ? ' is-new' : ''}`}
                      onClick={() => void openFile(file.path)}>
                      {fileIcon(file.path)}
                      <span>{file.path.split('/').slice(1).join('/')}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </aside>
          <div className="lc-body" ref={body}>
            {!view && (
              <div className="lc-waiting">
                {running ? <>
                  <p className="lc-waiting__title">The AI is studying your website before it writes the theme</p>
                  {doing.map((text, index) => (
                    <p key={`${index}-${text}`} className={`lc-waiting__step${index === doing.length - 1 ? ' is-now' : ''}`}>
                      <span className="lc-gutter">›</span>{text}{index === doing.length - 1 && <span className="lc-cursor" />}
                    </p>
                  ))}
                  {!doing.length && <p className="lc-waiting__step is-now"><span className="lc-gutter">›</span>Getting started<span className="lc-cursor" /></p>}
                </> : 'Nothing written yet.'}
              </div>
            )}
            {view?.lines.map((text, index) => (
              <Line key={index} n={index + 1} text={text} fresh={index >= view.typingFrom && index < view.typingTo} cursor={view.writing && index === view.cursorLine} />
            ))}
          </div>
        </div>
        {running && view && !view.writing && !pinned && doing.length > 0 && (
          <div className="lc-now" aria-live="polite">
            <span className="lc-now__dot" />
            <span className="lc-now__label">Now</span>
            <span className="lc-now__text">{doing[doing.length - 1]}</span>
          </div>
        )}
        {pinned && (
          <div className="lc-foot">
            Reading <b>{pinned.split('/').pop()}</b>. <button type="button" onClick={() => setPinned(null)}>Back to live</button>
          </div>
        )}
      </div>
    </div>
  );
}
