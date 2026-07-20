import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {C, FONT, MONO} from './theme';

// ---------------------------------------------------------------------------
// Layout constants — the mock browser window position on the 1920x1080 canvas
// ---------------------------------------------------------------------------
export const BW = {
  left: 540,
  top: 120,
  width: 1310,
  height: 800,
  chrome: 48, // browser chrome bar height
  topbar: 56, // dashboard top bar height
  sidebar: 250, // dashboard sidebar width
};
// Content origin inside the browser (below chrome bar)
export const CX = BW.left; // 540
export const CY = BW.top + BW.chrome; // 168
// Dashboard main-content origin (right of sidebar, below dashboard topbar)
export const MX = CX + BW.sidebar; // 790
export const MY = CY + BW.topbar; // 224
export const CR = BW.left + BW.width; // 1850 right edge
export const CB = BW.top + BW.height; // 920 bottom edge

// ---------------------------------------------------------------------------
// Scene wrapper: spring entrance + fade exit
// ---------------------------------------------------------------------------
export const Panel: React.FC<{
  duration: number;
  children: React.ReactNode;
}> = ({duration, children}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    config: {damping: 200, stiffness: 130},
    durationInFrames: 22,
  });
  const exit = interpolate(frame, [duration - 12, duration - 1], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill
      style={{
        opacity: Math.min(enter, exit),
        transform: `translateY(${(1 - enter) * 42}px)`,
        fontFamily: FONT,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Step header (big number + title) on the left rail
// ---------------------------------------------------------------------------
export const StepHeader: React.FC<{
  n: number;
  title: string;
  sub?: string;
}> = ({n, title, sub}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const pop = spring({
    frame: frame - 4,
    fps,
    config: {damping: 14, stiffness: 160, mass: 0.7},
  });
  const slide = spring({
    frame: frame - 10,
    fps,
    config: {damping: 200, stiffness: 120},
    durationInFrames: 22,
  });
  return (
    <div style={{position: 'absolute', left: 70, top: 200, width: 420}}>
      <div
        style={{
          fontSize: 34,
          fontWeight: 700,
          letterSpacing: 6,
          color: C.green,
          opacity: 0.9,
          transform: `scale(${pop})`,
          transformOrigin: 'left center',
        }}
      >
        STEP
      </div>
      <div
        style={{
          fontSize: 170,
          lineHeight: 1,
          fontWeight: 800,
          color: C.text,
          marginTop: 6,
          transform: `scale(${pop})`,
          transformOrigin: 'left top',
          textShadow: `0 0 60px ${C.greenSoft}`,
        }}
      >
        {n}
        <span style={{color: C.green, fontSize: 100}}>.</span>
      </div>
      <div
        style={{
          marginTop: 26,
          fontSize: 46,
          fontWeight: 750,
          color: C.text,
          lineHeight: 1.18,
          opacity: slide,
          transform: `translateY(${(1 - slide) * 24}px)`,
        }}
      >
        {title}
      </div>
      {sub ? (
        <div
          style={{
            marginTop: 16,
            fontSize: 23,
            color: C.dim,
            lineHeight: 1.45,
            opacity: slide,
            transform: `translateY(${(1 - slide) * 24}px)`,
          }}
        >
          {sub}
        </div>
      ) : null}
      <div
        style={{
          marginTop: 26,
          width: 120 * slide,
          height: 4,
          borderRadius: 2,
          background: C.green,
        }}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Shopify-ish badge (green rounded square with bag glyph)
// ---------------------------------------------------------------------------
export const SBadge: React.FC<{size?: number}> = ({size = 30}) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.24,
      background: C.green,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none',
    }}
  >
    <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24">
      <path
        d="M6.2 8.2h11.6l-1 11.6a1.6 1.6 0 0 1-1.6 1.4H8.8a1.6 1.6 0 0 1-1.6-1.4z"
        fill="#0d130e"
      />
      <path
        d="M9 10.2V7a3 3 0 0 1 6 0v3.2"
        stroke="#0d130e"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  </div>
);

// ---------------------------------------------------------------------------
// Browser window frame
// ---------------------------------------------------------------------------
export const Browser: React.FC<{
  url: string;
  children: React.ReactNode;
}> = ({url, children}) => (
  <div
    style={{
      position: 'absolute',
      left: BW.left,
      top: BW.top,
      width: BW.width,
      height: BW.height,
      borderRadius: 14,
      background: C.panel,
      border: `1px solid ${C.border}`,
      boxShadow: '0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.4)',
      overflow: 'hidden',
    }}
  >
    <div
      style={{
        height: BW.chrome,
        background: '#0d100e',
        borderBottom: `1px solid ${C.border}`,
        display: 'flex',
        alignItems: 'center',
        padding: '0 18px',
        gap: 14,
      }}
    >
      <div style={{display: 'flex', gap: 8}}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
          <div
            key={c}
            style={{width: 12, height: 12, borderRadius: 6, background: c, opacity: 0.85}}
          />
        ))}
      </div>
      <div
        style={{
          flex: 1,
          maxWidth: 560,
          margin: '0 auto',
          height: 30,
          borderRadius: 15,
          background: C.surface,
          border: `1px solid ${C.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          color: C.dim,
          fontSize: 15,
          fontFamily: FONT,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24">
          <path
            d="M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z"
            stroke={C.dim}
            strokeWidth="2"
            fill="none"
          />
        </svg>
        {url}
      </div>
      <div style={{width: 60}} />
    </div>
    <div style={{position: 'relative', height: BW.height - BW.chrome}}>
      {children}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Dev-dashboard shell: top bar + sidebar
// ---------------------------------------------------------------------------
export const DashTopBar: React.FC = () => (
  <div
    style={{
      height: BW.topbar,
      display: 'flex',
      alignItems: 'center',
      padding: '0 20px',
      borderBottom: `1px solid ${C.border}`,
      background: '#0c0f0d',
      justifyContent: 'space-between',
    }}
  >
    <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
      <SBadge size={28} />
      <span style={{fontSize: 17, color: C.text}}>
        <b>dev</b> <span style={{color: C.dim}}>dashboard</span>
      </span>
    </div>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: C.surface2,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: '6px 14px',
        color: C.text,
        fontSize: 14,
      }}
    >
      <span style={{color: C.dim, fontFamily: MONO, fontSize: 12}}>{'</>'}</span>
      wild-sacred
    </div>
  </div>
);

export const SideItem: React.FC<{
  label: string;
  active?: boolean;
  boxed?: boolean;
  icon?: 'grid' | 'store' | 'catalog' | 'none';
}> = ({label, active, boxed, icon = 'none'}) => (
  <div
    style={{
      height: 40,
      margin: boxed ? '10px 10px 6px' : '0 10px',
      padding: boxed ? '0 12px' : '0 12px 0 40px',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      borderRadius: 8,
      background: active ? C.surface3 : 'transparent',
      border: boxed ? `1px solid ${C.borderHi}` : '1px solid transparent',
      color: active ? C.text : C.dim,
      fontSize: 15.5,
      fontWeight: active ? 650 : 450,
    }}
  >
    {icon !== 'none' ? (
      <svg width="16" height="16" viewBox="0 0 24 24">
        {icon === 'grid' ? (
          <path
            d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"
            fill="none"
            stroke={active ? C.green : C.dim}
            strokeWidth="2"
          />
        ) : icon === 'store' ? (
          <path
            d="M4 9l1.5-5h13L20 9v11H4zM4 9h16"
            fill="none"
            stroke={C.dim}
            strokeWidth="2"
          />
        ) : (
          <path
            d="M4 6h16M4 12h16M4 18h10"
            fill="none"
            stroke={C.dim}
            strokeWidth="2"
            strokeLinecap="round"
          />
        )}
      </svg>
    ) : null}
    {label}
  </div>
);

export const DashShell: React.FC<{
  sidebar: React.ReactNode;
  children: React.ReactNode;
}> = ({sidebar, children}) => (
  <div style={{position: 'absolute', inset: 0, background: C.bg}}>
    <DashTopBar />
    <div style={{display: 'flex', height: BW.height - BW.chrome - BW.topbar}}>
      <div
        style={{
          width: BW.sidebar,
          flex: 'none',
          background: '#0e1210',
          borderRight: `1px solid ${C.border}`,
          paddingTop: 8,
        }}
      >
        {sidebar}
      </div>
      <div style={{position: 'relative', flex: 1, overflow: 'hidden'}}>
        {children}
      </div>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Buttons / inputs
// ---------------------------------------------------------------------------
export const Btn: React.FC<{
  label: string;
  kind?: 'light' | 'dark' | 'green';
  pressedAt?: number; // frame at which the button is clicked (local)
  glow?: boolean;
  style?: React.CSSProperties;
}> = ({label, kind = 'light', pressedAt, glow, style}) => {
  const frame = useCurrentFrame();
  let scale = 1;
  if (pressedAt !== undefined && frame >= pressedAt && frame <= pressedAt + 8) {
    scale = 1 - 0.08 * Math.sin(((frame - pressedAt) / 8) * Math.PI);
  }
  const glowOpacity = glow
    ? 0.35 + 0.3 * Math.sin((frame / 22) * Math.PI * 2)
    : 0;
  const bg =
    kind === 'light' ? '#e8eae8' : kind === 'green' ? C.green : C.surface3;
  const fg = kind === 'dark' ? C.text : '#111411';
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 38,
        padding: '0 18px',
        borderRadius: 9,
        background: bg,
        color: fg,
        fontSize: 15,
        fontWeight: 650,
        border: kind === 'dark' ? `1px solid ${C.borderHi}` : 'none',
        transform: `scale(${scale})`,
        boxShadow: glow ? `0 0 0 5px rgba(149,191,71,${glowOpacity})` : 'none',
        fontFamily: FONT,
        ...style,
      }}
    >
      {label}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Typewriter text
// ---------------------------------------------------------------------------
export const TypeText: React.FC<{
  text: string;
  start: number; // local frame typing starts
  cpf?: number; // characters per frame
  style?: React.CSSProperties;
  caretColor?: string;
  caret?: boolean;
}> = ({text, start, cpf = 0.32, style, caretColor, caret = true}) => {
  const frame = useCurrentFrame();
  const n = Math.max(0, Math.floor((frame - start) * cpf));
  const shown = text.slice(0, Math.min(n, text.length));
  const done = n >= text.length;
  const typingEnds = start + text.length / cpf;
  const caretVisible =
    caret &&
    frame >= start - 12 &&
    frame <= typingEnds + 70 &&
    (!done || frame % 30 < 18);
  return (
    <span style={style}>
      {shown}
      {caretVisible ? (
        <span
          style={{
            display: 'inline-block',
            width: 2.5,
            height: '1.05em',
            background: caretColor ?? C.text,
            verticalAlign: '-0.15em',
            marginLeft: 2,
          }}
        />
      ) : null}
    </span>
  );
};

// ---------------------------------------------------------------------------
// Animated cursor with click ripples
// ---------------------------------------------------------------------------
export type CursorMove = {f: number; x: number; y: number};

const posAt = (frame: number, path: CursorMove[]) => {
  const fs = path.map((p) => p.f);
  const ease = Easing.bezier(0.35, 0, 0.22, 1);
  const x = interpolate(frame, fs, path.map((p) => p.x), {
    easing: ease,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const y = interpolate(frame, fs, path.map((p) => p.y), {
    easing: ease,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return {x, y};
};

export const Cursor: React.FC<{
  path: CursorMove[];
  clicks?: number[];
}> = ({path, clicks = []}) => {
  const frame = useCurrentFrame();
  const {x, y} = posAt(frame, path);
  const appear = interpolate(
    frame,
    [path[0].f - 10, path[0].f],
    [0, 1],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
  );
  let scale = 1;
  for (const c of clicks) {
    if (frame >= c && frame <= c + 10) {
      scale = 1 - 0.22 * Math.sin(((frame - c) / 10) * Math.PI);
    }
  }
  return (
    <>
      {clicks.map((c) => {
        if (frame < c || frame > c + 18) return null;
        const p = posAt(c, path);
        const r = interpolate(frame, [c, c + 18], [8, 46]);
        const o = interpolate(frame, [c, c + 18], [0.75, 0]);
        return (
          <div
            key={c}
            style={{
              position: 'absolute',
              left: p.x - r,
              top: p.y - r,
              width: r * 2,
              height: r * 2,
              borderRadius: r,
              border: `3px solid ${C.green}`,
              opacity: o,
            }}
          />
        );
      })}
      <div
        style={{
          position: 'absolute',
          left: x,
          top: y,
          opacity: appear,
          transform: `scale(${scale})`,
          transformOrigin: '4px 3px',
          filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.6))',
        }}
      >
        <svg width="30" height="30" viewBox="0 0 24 24">
          <path
            d="M5.2 2.8 L5.2 19.8 L9.5 15.9 L12.1 21.6 L15.1 20.2 L12.5 14.7 L18.4 14.2 Z"
            fill="#ffffff"
            stroke="#1a1a1a"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// Caption (bottom center) — fades in at `from`, optional out at `to`
// ---------------------------------------------------------------------------
export const Caption: React.FC<{
  text: string;
  from?: number;
  to?: number;
}> = ({text, from = 8, to}) => {
  const frame = useCurrentFrame();
  const inO = interpolate(frame, [from, from + 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const outO =
    to === undefined
      ? 1
      : interpolate(frame, [to - 10, to], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 952,
        display: 'flex',
        justifyContent: 'center',
        opacity: inO * outO,
        transform: `translateY(${(1 - inO) * 14}px)`,
      }}
    >
      <div
        style={{
          background: 'rgba(16,20,18,0.92)',
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: '12px 26px',
          fontSize: 24,
          fontWeight: 550,
          color: C.text,
          fontFamily: FONT,
          boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
        }}
      >
        {text}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Progress bar of the 6 steps (rendered as a global overlay)
// ---------------------------------------------------------------------------
export const ProgressBar: React.FC<{
  boundaries: number[]; // global start frame of each step
  end: number; // global frame where the last step ends
  labels: string[];
}> = ({boundaries, end, labels}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const n = boundaries.length;
  const visible =
    interpolate(frame, [boundaries[0] - 15, boundaries[0]], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }) *
    interpolate(frame, [end, end + 15], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  const fill = interpolate(
    frame,
    [...boundaries, end],
    Array.from({length: n + 1}, (_, i) => i / n),
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
  );
  const width = 1150;
  const left = (1920 - width) / 2;
  return (
    <div style={{position: 'absolute', left, top: 1014, width, opacity: visible}}>
      <div
        style={{
          position: 'absolute',
          top: 13,
          left: 14,
          right: 14,
          height: 4,
          borderRadius: 2,
          background: C.surface3,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 13,
          left: 14,
          width: (width - 28) * fill,
          height: 4,
          borderRadius: 2,
          background: C.green,
        }}
      />
      <div style={{display: 'flex', justifyContent: 'space-between'}}>
        {labels.map((label, i) => {
          const active = frame >= boundaries[i];
          const pop = spring({
            frame: frame - boundaries[i],
            fps,
            config: {damping: 12, stiffness: 200, mass: 0.6},
          });
          const s = active ? 1 + 0.18 * (1 - Math.min(pop, 1)) : 1;
          return (
            <div
              key={label}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 5,
                width: 100,
              }}
            >
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 15,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 15,
                  fontWeight: 750,
                  fontFamily: FONT,
                  background: active ? C.green : C.surface2,
                  color: active ? '#101410' : C.faint,
                  border: `1px solid ${active ? C.green : C.border}`,
                  transform: `scale(${s})`,
                }}
              >
                {i + 1}
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontFamily: FONT,
                  color: active ? C.dim : C.faint,
                  fontWeight: active ? 600 : 400,
                }}
              >
                {label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Small helpers used across scenes
// ---------------------------------------------------------------------------
export const FadeIn: React.FC<{
  from: number;
  children: React.ReactNode;
  slide?: number;
  style?: React.CSSProperties;
}> = ({from, children, slide = 0, style}) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [from, from + 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        opacity: o,
        transform: slide ? `translateY(${(1 - o) * slide}px)` : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const Toast: React.FC<{
  text: string;
  from: number;
}> = ({text, from}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({
    frame: frame - from,
    fps,
    config: {damping: 15, stiffness: 180, mass: 0.7},
  });
  if (frame < from) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: BW.left + BW.width / 2 - 160,
        top: BW.top + 64,
        width: 320,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        background: '#12261a',
        border: `1px solid ${C.success}`,
        color: C.success,
        borderRadius: 10,
        padding: '10px 18px',
        fontSize: 17,
        fontWeight: 650,
        fontFamily: FONT,
        opacity: Math.min(s, 1),
        transform: `translateY(${(1 - s) * -18}px)`,
        boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
      }}
    >
      <Check size={18} /> {text}
    </div>
  );
};

export const Check: React.FC<{size?: number; color?: string}> = ({
  size = 16,
  color = C.success,
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="10" fill="none" stroke={color} strokeWidth="2" />
    <path
      d="M7.5 12.5l3 3 6-6.5"
      fill="none"
      stroke={color}
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
