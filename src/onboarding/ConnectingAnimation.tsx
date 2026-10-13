// The "checking your AI sign-in" animation (Remotion, played live with @remotion/player).
// ThemeBot's tile sends a "ping" along an arc to the AI; the AI lights up and a "pong" comes back
// with a tick — which is literally what the check does (a tiny test message). Loops seamlessly:
// every periodic motion is a whole number of cycles per loop, and both trips finish inside it.
import { Player } from '@remotion/player';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

const W = 640;
const H = 240;
const FPS = 30;
const LOOP = 150; // 5 s
const TAU = Math.PI * 2;

const A = { x: 150, y: 128 }; // ThemeBot
const B = { x: 490, y: 128 }; // the AI
const UP = { x: 320, y: 30 }; // control point of the outgoing arc
const DOWN = { x: 320, y: 226 }; // control point of the return arc

const quad = (p0: typeof A, c: typeof A, p1: typeof A, t: number) => ({
  x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * c.x + t ** 2 * p1.x,
  y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * c.y + t ** 2 * p1.y,
});
const arc = (p0: typeof A, c: typeof A, p1: typeof A) => `M ${p0.x} ${p0.y} Q ${c.x} ${c.y} ${p1.x} ${p1.y}`;
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const ease = Easing.bezier(0.45, 0, 0.2, 1);

// Floating motes: fixed seeds so every render is identical.
const MOTES = Array.from({ length: 22 }, (_, i) => ({
  x: (i * 97) % W, y: 20 + ((i * 53) % (H - 40)), r: 1.5 + (i % 3), speed: 1 + (i % 2), phase: (i * 0.7) % TAU,
}));

const SPARKLE = 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z';

function Packet({ t, from, via, to, label, color, tick }: { t: number; from: typeof A; via: typeof A; to: typeof A; label: string; color: string; tick?: boolean }) {
  if (t <= 0 || t >= 1) return null;
  const head = quad(from, via, to, t);
  const trail = [0.05, 0.1, 0.15, 0.2].map((lag) => quad(from, via, to, Math.max(0, t - lag)));
  const fade = interpolate(t, [0, 0.07, 0.93, 1], [0, 1, 1, 0], clamp);
  return (
    <g opacity={fade}>
      {trail.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={6 - i * 1.2} fill={color} opacity={0.35 - i * 0.07} />)}
      <circle cx={head.x} cy={head.y} r={11} fill={color} opacity={0.18} />
      <circle cx={head.x} cy={head.y} r={6.5} fill={color} />
      <g transform={`translate(${head.x} ${head.y - 34})`}>
        <rect x={-38} y={-16} width={76} height={30} rx={15} fill="#fff" stroke={color} strokeWidth={2} />
        <text x={tick ? -8 : 0} y={5.5} textAnchor="middle" fontSize={16} fontWeight={800} fontFamily="Inter, system-ui, sans-serif" fill={color}>{label}</text>
        {tick && <path d="M 13 -1 l 4.5 4.5 l 8 -9" stroke={color} strokeWidth={2.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
      </g>
    </g>
  );
}

/** A little burst of sparks flying out from a point, starting at frame `start`. */
function Burst({ frame, start, at, color }: { frame: number; start: number; at: typeof A; color: string }) {
  const t = interpolate(frame, [start, start + 26], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  if (t <= 0 || t >= 1) return null;
  return (
    <g opacity={1 - t}>
      {Array.from({ length: 10 }, (_, i) => {
        const angle = (i / 10) * TAU + 0.3;
        const dist = 44 + t * (40 + (i % 3) * 14);
        const x = at.x + Math.cos(angle) * dist;
        const y = at.y + Math.sin(angle) * dist;
        const size = 4.5 * (1 - t * 0.6);
        return <path key={i} d={`M ${x} ${y - size} L ${x + size * 0.35} ${y - size * 0.35} L ${x + size} ${y} L ${x + size * 0.35} ${y + size * 0.35} L ${x} ${y + size} L ${x - size * 0.35} ${y + size * 0.35} L ${x - size} ${y} L ${x - size * 0.35} ${y - size * 0.35} Z`} fill={i % 2 ? color : '#ffd166'} />;
      })}
    </g>
  );
}

function ConnectingScene() {
  const raw = useCurrentFrame();
  const { fps } = useVideoConfig();
  const frame = raw % LOOP;
  const cycle = (frame / LOOP) * TAU;

  const outT = interpolate(frame, [8, 58], [0, 1], { ...clamp, easing: ease });
  const backT = interpolate(frame, [82, 132], [0, 1], { ...clamp, easing: ease });
  const aiHit = spring({ frame: frame - 58, fps, config: { damping: 9, mass: 0.6 } });
  const tbHit = spring({ frame: frame - 132, fps, config: { damping: 9, mass: 0.6 } });
  const aiGlow = interpolate(frame, [56, 66, 100, 120], [0, 1, 1, 0], clamp);
  const ripple = (start: number) => interpolate(frame, [start, start + 40], [0, 1], clamp);

  const breathe = 1 + 0.025 * Math.sin(cycle * 2);
  const tbScale = breathe + 0.12 * Math.sin(Math.PI * Math.min(1, Math.max(0, tbHit)));
  const aiScale = breathe + 0.12 * Math.sin(Math.PI * Math.min(1, Math.max(0, aiHit)));
  const tilt = 6 * Math.sin(cycle);

  return (
    <AbsoluteFill>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <linearGradient id="tb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5a86ff" /><stop offset="1" stopColor="#2a55d0" /></linearGradient>
          <radialGradient id="ai" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stopColor="#c4b5fd" /><stop offset="1" stopColor="#7c5cd6" /></radialGradient>
          <radialGradient id="halo"><stop offset="0" stopColor="#7c5cd6" stopOpacity="0.45" /><stop offset="1" stopColor="#7c5cd6" stopOpacity="0" /></radialGradient>
        </defs>

        {MOTES.map((m, i) => {
          const y = m.y + 10 * Math.sin(cycle * m.speed + m.phase);
          const x = m.x + 6 * Math.cos(cycle * m.speed + m.phase);
          const o = 0.18 + 0.14 * Math.sin(cycle * m.speed * 2 + m.phase);
          return <circle key={i} cx={x} cy={y} r={m.r} fill={i % 3 === 0 ? '#7c5cd6' : '#2f6bff'} opacity={o} />;
        })}

        {/* the two routes; dashes drift along them */}
        <path d={arc(A, UP, B)} stroke="#2f6bff" strokeOpacity={0.28} strokeWidth={2} strokeDasharray="2 9" strokeDashoffset={-frame * 0.9} strokeLinecap="round" fill="none" />
        <path d={arc(B, DOWN, A)} stroke="#15a36b" strokeOpacity={0.28} strokeWidth={2} strokeDasharray="2 9" strokeDashoffset={-frame * 0.9} strokeLinecap="round" fill="none" />

        {/* ripples where each trip lands */}
        {[58, 70].map((s) => { const r = ripple(s); return r > 0 && r < 1 ? <circle key={s} cx={B.x} cy={B.y} r={40 + r * 60} fill="none" stroke="#7c5cd6" strokeWidth={2} opacity={(1 - r) * 0.5} /> : null; })}
        {[132, 140].map((s) => { const r = ripple(s); return r > 0 && r < 1 ? <circle key={s} cx={A.x} cy={A.y} r={40 + r * 60} fill="none" stroke="#15a36b" strokeWidth={2} opacity={(1 - r) * 0.5} /> : null; })}

        {/* ThemeBot */}
        <g transform={`translate(${A.x} ${A.y}) scale(${tbScale}) rotate(${tilt})`}>
          <rect x={-38} y={-38} width={76} height={76} rx={20} fill="url(#tb)" />
          <rect x={-38} y={-38} width={76} height={38} rx={20} fill="#fff" opacity={0.12} />
          <g transform="translate(-19 -19) scale(1.6)"><path d={SPARKLE} fill="#fff" /></g>
        </g>

        {/* the AI */}
        <circle cx={B.x} cy={B.y} r={70} fill="url(#halo)" opacity={0.35 + aiGlow * 0.65} />
        <g transform={`translate(${B.x} ${B.y}) scale(${aiScale})`}>
          <circle r={38} fill="url(#ai)" />
          {[0, 1, 2].map((i) => {
            const bounce = -6 * Math.max(0, Math.sin(cycle * 10 - i * 0.9)) * aiGlow;
            return <circle key={i} cx={-14 + i * 14} cy={bounce} r={5} fill="#fff" opacity={0.95} />;
          })}
        </g>

        <Burst frame={frame} start={58} at={B} color="#7c5cd6" />
        <Burst frame={frame} start={132} at={A} color="#15a36b" />
        <Packet t={outT} from={A} via={UP} to={B} label="ping" color="#2f6bff" />
        <Packet t={backT} from={B} via={DOWN} to={A} label="pong" color="#15a36b" tick />
      </svg>
    </AbsoluteFill>
  );
}

export default function ConnectingAnimation() {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return (
    <Player
      component={ConnectingScene}
      durationInFrames={LOOP}
      fps={FPS}
      compositionWidth={W}
      compositionHeight={H}
      loop
      autoPlay={!reduced}
      initialFrame={reduced ? 90 : 0}
      controls={false}
      clickToPlay={false}
      doubleClickToFullscreen={false}
      spaceKeyToPlayOrPause={false}
      acknowledgeRemotionLicense
      numberOfSharedAudioTags={0}
      style={{ width: '100%', aspectRatio: `${W} / ${H}`, background: 'transparent' }}
    />
  );
}
