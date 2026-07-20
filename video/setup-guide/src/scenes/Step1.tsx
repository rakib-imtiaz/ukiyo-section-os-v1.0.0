import React from 'react';
import {C, FONT, MONO} from '../theme';
import {
  Browser,
  Btn,
  Caption,
  Cursor,
  DashShell,
  Panel,
  SideItem,
  StepHeader,
} from '../ui';

// Empty-state illustration: abstract stacked panels
const Illustration: React.FC = () => (
  <div style={{position: 'relative', width: 420, height: 190, margin: '0 auto'}}>
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 30,
        width: 200,
        height: 130,
        borderRadius: 10,
        background: 'rgba(60,110,120,0.18)',
        border: '1px solid rgba(120,180,190,0.25)',
        padding: 14,
      }}
    >
      {[120, 150, 100, 130].map((w, i) => (
        <div
          key={i}
          style={{
            width: w * 0.8,
            height: 8,
            borderRadius: 4,
            background: 'rgba(130,190,200,0.35)',
            marginBottom: 10,
          }}
        />
      ))}
    </div>
    <div
      style={{
        position: 'absolute',
        right: 0,
        top: 44,
        width: 150,
        height: 110,
        borderRadius: 10,
        background: 'rgba(60,110,120,0.18)',
        border: '1px solid rgba(120,180,190,0.25)',
        padding: 12,
      }}
    >
      <div style={{width: 70, height: 8, borderRadius: 4, background: 'rgba(130,190,200,0.35)'}} />
      <svg width="120" height="52" viewBox="0 0 120 52" style={{marginTop: 14}}>
        <path
          d="M0 44 L25 30 L45 38 L70 14 L95 26 L120 6"
          fill="none"
          stroke="rgba(130,190,200,0.5)"
          strokeWidth="3"
        />
      </svg>
    </div>
    <div
      style={{
        position: 'absolute',
        left: 90,
        top: 0,
        width: 240,
        height: 160,
        borderRadius: 12,
        background: 'rgba(30,70,80,0.55)',
        border: '1.5px solid rgba(140,200,210,0.45)',
        padding: 16,
        boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
      }}
    >
      <div style={{display: 'flex', justifyContent: 'space-between'}}>
        <div style={{width: 90, height: 9, borderRadius: 4, background: 'rgba(150,210,220,0.5)'}} />
        <div style={{width: 46, height: 12, borderRadius: 6, background: 'rgba(150,210,220,0.6)'}} />
      </div>
      <div
        style={{
          marginTop: 16,
          borderRadius: 8,
          background: 'rgba(90,150,165,0.25)',
          padding: 12,
        }}
      >
        {[150, 130, 60].map((w, i) => (
          <div
            key={i}
            style={{
              width: w,
              height: 8,
              borderRadius: 4,
              background: 'rgba(160,215,225,0.45)',
              marginBottom: 9,
            }}
          />
        ))}
      </div>
    </div>
  </div>
);

export const Step1: React.FC<{duration: number}> = ({duration}) => {
  return (
    <Panel duration={duration}>
      <StepHeader
        n={4}
        title="Open the Dev Dashboard"
        sub="Go to dev.shopify.com and open the Apps section."
      />
      <Browser url="dev.shopify.com">
        <DashShell
          sidebar={
            <>
              <SideItem label="Apps" active icon="grid" />
              <SideItem label="Stores" icon="store" />
              <SideItem label="Catalogs" icon="catalog" />
            </>
          }
        >
          {/* Empty state */}
          <div style={{paddingTop: 74, textAlign: 'center'}}>
            <Illustration />
            <div
              style={{
                marginTop: 34,
                fontSize: 18.5,
                color: C.text,
                lineHeight: 1.5,
                fontFamily: FONT,
              }}
            >
              Extend Shopify&apos;s functionality and access all
              <br />
              app capabilities using Shopify CLI.
            </div>
            <div
              style={{
                margin: '22px auto 0',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 14,
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                padding: '11px 20px',
                fontFamily: MONO,
                fontSize: 15,
                color: '#9fd0d8',
              }}
            >
              <span style={{color: C.faint}}>$</span>
              npm init @shopify/app@latest
            </div>
          </div>
          {/* Bottom "Get API credentials" bar */}
          <div
            style={{
              position: 'absolute',
              left: 26,
              right: 26,
              bottom: 24,
              height: 58,
              borderRadius: 12,
              background: C.surface,
              border: `1px solid ${C.border}`,
              display: 'flex',
              alignItems: 'center',
              padding: '0 22px',
              gap: 14,
              fontFamily: FONT,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <circle cx="8" cy="14" r="4.5" fill="none" stroke={C.text} strokeWidth="2" />
              <path d="M11.5 10.5 L19 3M16 6l3 3" fill="none" stroke={C.text} strokeWidth="2" />
            </svg>
            <span style={{fontSize: 15.5, fontWeight: 700, color: C.text}}>
              Get API credentials
            </span>
            <span style={{fontSize: 14.5, color: C.dim, flex: 1}}>
              Create an app and release an app version to get API access quickly
            </span>
            <Btn label="Create app" kind="light" pressedAt={150} glow />
          </div>
        </DashShell>
      </Browser>
      {/* Bottom bar sits at y ≈ 838..896 inside browser; button near right edge */}
      <Cursor
        path={[
          {f: 35, x: 1420, y: 1000},
          {f: 105, x: 1745, y: 878},
          {f: 145, x: 1748, y: 876},
        ]}
        clicks={[150]}
      />
      <Caption text="Open dev.shopify.com → Apps, then click Create app" from={20} />
    </Panel>
  );
};
