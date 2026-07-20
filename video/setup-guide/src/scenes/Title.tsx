import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {C, FONT} from '../theme';
import {SBadge} from '../ui';

export const Title: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const logo = spring({
    frame: frame - 4,
    fps,
    config: {damping: 12, stiffness: 140, mass: 0.8},
  });
  const t1 = spring({
    frame: frame - 14,
    fps,
    config: {damping: 200, stiffness: 110},
    durationInFrames: 26,
  });
  const t2 = spring({
    frame: frame - 26,
    fps,
    config: {damping: 200, stiffness: 110},
    durationInFrames: 26,
  });
  const exit = interpolate(frame, [duration - 14, duration - 1], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: FONT,
        opacity: exit,
      }}
    >
      <div style={{transform: `scale(${logo})`}}>
        <SBadge size={96} />
      </div>
      <div
        style={{
          marginTop: 44,
          fontSize: 68,
          fontWeight: 800,
          color: C.text,
          opacity: t1,
          transform: `translateY(${(1 - t1) * 30}px)`,
          letterSpacing: -1,
        }}
      >
        Set up your Shopify store &amp; app
      </div>
      <div
        style={{
          marginTop: 22,
          fontSize: 32,
          color: C.dim,
          opacity: t2,
          transform: `translateY(${(1 - t2) * 24}px)`,
          display: 'flex',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <span style={{color: C.green, fontWeight: 700}}>9 steps</span>
        <span style={{color: C.faint}}>·</span>
        <span>$1/month</span>
        <span style={{color: C.faint}}>·</span>
        <span>about 5 minutes</span>
      </div>
      <div
        style={{
          marginTop: 46,
          fontSize: 19,
          color: C.faint,
          opacity: t2,
          border: `1px solid ${C.border}`,
          borderRadius: 999,
          padding: '8px 22px',
          background: C.panel,
        }}
      >
        ThemeBot — manual setup guide
      </div>
    </AbsoluteFill>
  );
};
