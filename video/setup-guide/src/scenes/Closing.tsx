import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {C, FONT} from '../theme';

export const Closing: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const pop = spring({
    frame: frame - 6,
    fps,
    config: {damping: 11, stiffness: 150, mass: 0.9},
  });
  const t1 = spring({
    frame: frame - 20,
    fps,
    config: {damping: 200, stiffness: 110},
    durationInFrames: 24,
  });
  const draw = interpolate(frame, [10, 34], [60, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const fadeOut = interpolate(frame, [duration - 16, duration - 2], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: FONT,
        opacity: fadeOut,
      }}
    >
      <div
        style={{
          width: 130,
          height: 130,
          borderRadius: 65,
          background: 'rgba(61,220,132,0.1)',
          border: `3px solid ${C.success}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `scale(${pop})`,
          boxShadow: '0 0 90px rgba(61,220,132,0.25)',
        }}
      >
        <svg width="64" height="64" viewBox="0 0 24 24">
          <path
            d="M5.5 12.5l4.5 4.5 9-10"
            fill="none"
            stroke={C.success}
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="60"
            strokeDashoffset={draw}
          />
        </svg>
      </div>
      <div
        style={{
          marginTop: 42,
          fontSize: 62,
          fontWeight: 800,
          color: C.text,
          opacity: t1,
          transform: `translateY(${(1 - t1) * 26}px)`,
        }}
      >
        You&apos;re all set
      </div>
      <div
        style={{
          marginTop: 24,
          fontSize: 28,
          color: C.dim,
          opacity: t1,
          transform: `translateY(${(1 - t1) * 26}px)`,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        Paste the keys into <span style={{color: C.green, fontWeight: 750}}>ThemeBot</span>
        <span style={{color: C.faint}}>→</span> Test connection
        <span style={{color: C.faint}}>→</span> done
      </div>
    </AbsoluteFill>
  );
};
