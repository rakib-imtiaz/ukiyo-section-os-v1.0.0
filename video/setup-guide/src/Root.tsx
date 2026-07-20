import React from 'react';
import {Composition} from 'remotion';
import {SetupGuide, TOTAL} from './SetupGuide';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="SetupGuide"
      component={SetupGuide}
      durationInFrames={TOTAL}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
