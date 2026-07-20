import React from 'react';
import {AbsoluteFill, Sequence} from 'remotion';
import {C} from './theme';
import {ProgressBar} from './ui';
import {Title} from './scenes/Title';
import {StepLogin, StepPlan, StepStore} from './scenes/StepsPre';
import {Step1} from './scenes/Step1';
import {Step2} from './scenes/Step2';
import {Step3} from './scenes/Step3';
import {Step4} from './scenes/Step4';
import {Step5} from './scenes/Step5';
import {Step6} from './scenes/Step6';
import {Closing} from './scenes/Closing';

// Timeline (frames @ 30fps)
export const T = {
  title: 120,
  login: 240, // step 1 — log in to Shopify
  store: 270, // step 2 — create your store
  plan: 270, // step 3 — $1/month plan
  s1: 240, // step 4 — open the Dev Dashboard
  s2: 300, // step 5 — create the app
  s3: 420, // step 6 — access scopes
  s4: 270, // step 7 — release
  s5: 420, // step 8 — install on store
  s6: 390, // step 9 — credentials + ThemeBot
  closing: 180,
};
export const TOTAL =
  T.title +
  T.login +
  T.store +
  T.plan +
  T.s1 +
  T.s2 +
  T.s3 +
  T.s4 +
  T.s5 +
  T.s6 +
  T.closing;

const b1 = T.title; // login
const b2 = b1 + T.login; // store
const b3 = b2 + T.store; // plan
const b4 = b3 + T.plan; // dashboard
const b5 = b4 + T.s1; // create app
const b6 = b5 + T.s2; // scopes
const b7 = b6 + T.s3; // release
const b8 = b7 + T.s4; // install
const b9 = b8 + T.s5; // credentials
const bEnd = b9 + T.s6; // closing start

const LABELS = [
  'Log in',
  'Store',
  '$1 plan',
  'Dashboard',
  'Create',
  'Scopes',
  'Release',
  'Install',
  'Keys',
];

export const SetupGuide: React.FC = () => {
  return (
    <AbsoluteFill style={{background: C.bg}}>
      {/* Ambient backdrop */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(1100px 700px at 72% 38%, rgba(149,191,71,0.07), transparent 60%),
                       radial-gradient(900px 600px at 15% 80%, rgba(60,110,120,0.06), transparent 60%)`,
        }}
      />
      <Sequence durationInFrames={T.title}>
        <Title duration={T.title} />
      </Sequence>
      <Sequence from={b1} durationInFrames={T.login}>
        <StepLogin duration={T.login} />
      </Sequence>
      <Sequence from={b2} durationInFrames={T.store}>
        <StepStore duration={T.store} />
      </Sequence>
      <Sequence from={b3} durationInFrames={T.plan}>
        <StepPlan duration={T.plan} />
      </Sequence>
      <Sequence from={b4} durationInFrames={T.s1}>
        <Step1 duration={T.s1} />
      </Sequence>
      <Sequence from={b5} durationInFrames={T.s2}>
        <Step2 duration={T.s2} />
      </Sequence>
      <Sequence from={b6} durationInFrames={T.s3}>
        <Step3 duration={T.s3} />
      </Sequence>
      <Sequence from={b7} durationInFrames={T.s4}>
        <Step4 duration={T.s4} />
      </Sequence>
      <Sequence from={b8} durationInFrames={T.s5}>
        <Step5 duration={T.s5} />
      </Sequence>
      <Sequence from={b9} durationInFrames={T.s6}>
        <Step6 duration={T.s6} />
      </Sequence>
      <Sequence from={bEnd} durationInFrames={T.closing}>
        <Closing duration={T.closing} />
      </Sequence>
      {/* Persistent 9-step progress bar */}
      <ProgressBar
        boundaries={[b1, b2, b3, b4, b5, b6, b7, b8, b9]}
        end={bEnd}
        labels={LABELS}
      />
    </AbsoluteFill>
  );
};
