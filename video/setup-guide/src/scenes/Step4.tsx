import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C, FONT} from '../theme';
import {
  Browser,
  Btn,
  Caption,
  Cursor,
  DashShell,
  FadeIn,
  Panel,
  SideItem,
  StepHeader,
  Toast,
} from '../ui';

export const Step4: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  return (
    <Panel duration={duration}>
      <StepHeader
        n={7}
        title="Release it"
        sub="Leave the name and message blank — just click Release."
      />
      <Browser url="dev.shopify.com/dashboard/apps/wild-sacred_bot">
        <DashShell
          sidebar={
            <>
              <SideItem label="wild-sacred_bot" boxed icon="grid" />
              <SideItem label="Monitoring" />
              <SideItem label="Logs" />
              <SideItem label="Versions" active />
              <SideItem label="Settings" />
            </>
          }
        >
          <div style={{position: 'absolute', inset: 0}} />
        </DashShell>
        <div style={{position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)'}} />
        {/* Release dialog */}
        <div
          style={{
            position: 'absolute',
            left: (1310 - 700) / 2,
            top: 150,
            width: 700,
            height: 444,
            borderRadius: 14,
            background: C.surface,
            border: `1px solid ${C.borderHi}`,
            boxShadow: '0 30px 90px rgba(0,0,0,0.65)',
            padding: '24px 28px',
            fontFamily: FONT,
          }}
        >
          <div style={{display: 'flex', justifyContent: 'space-between'}}>
            <div style={{fontSize: 20, fontWeight: 750, color: C.text}}>
              Release this new version?
            </div>
            <div style={{fontSize: 20, color: C.dim}}>×</div>
          </div>
          <div style={{marginTop: 24, fontSize: 15, fontWeight: 600, color: C.text}}>
            Version name (optional)
          </div>
          <div
            style={{
              marginTop: 10,
              height: 44,
              borderRadius: 10,
              background: C.panel,
              border: `1px solid ${C.border}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              padding: '0 14px',
              color: C.dim,
              fontSize: 14,
            }}
          >
            0 / 100
          </div>
          <div style={{marginTop: 10, fontSize: 13.5, color: C.faint}}>
            If not provided, a name will be auto-generated
          </div>
          <div style={{marginTop: 20, fontSize: 15, fontWeight: 600, color: C.text}}>
            Version message (optional)
          </div>
          <div
            style={{
              marginTop: 10,
              height: 96,
              borderRadius: 10,
              background: C.panel,
              border: `1px solid ${C.border}`,
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'flex-end',
              padding: '0 14px 10px 0',
              color: C.dim,
              fontSize: 14,
            }}
          >
            0 / 200
          </div>
          <div
            style={{
              position: 'absolute',
              right: 26,
              bottom: 22,
              display: 'flex',
              gap: 12,
            }}
          >
            <Btn label="Cancel" kind="dark" />
            <Btn label="Release" kind="light" pressedAt={180} glow={frame > 90} />
          </div>
        </div>
        {/* "Leave blank" hint chip */}
        <FadeIn
          from={55}
          slide={12}
          style={{position: 'absolute', left: 1010, top: 250}}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: '#15200f',
              border: `1.5px solid ${C.green}`,
              color: C.green,
              borderRadius: 999,
              padding: '8px 16px',
              fontSize: 15,
              fontWeight: 700,
              fontFamily: FONT,
              boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            }}
          >
            Leave both fields blank
          </div>
        </FadeIn>
      </Browser>
      {/* Dialog abs: left 540+305=845, top 120+48+150=318, w 700 h 444 → bottom 762.
          Release btn: right edge 845+700-26=1519, center ≈ (1462, 721) */}
      <Cursor
        path={[
          {f: 40, x: 1480, y: 950},
          {f: 130, x: 1462, y: 720},
          {f: 175, x: 1464, y: 719},
        ]}
        clicks={[180]}
      />
      <Toast text="wild-sacred_bot-1 released" from={205} />
      <Caption
        text="Click Release — no version name or message needed"
        from={18}
      />
    </Panel>
  );
};
