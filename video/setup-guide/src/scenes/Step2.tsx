import React from 'react';
import {useCurrentFrame} from 'remotion';
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
  TypeText,
} from '../ui';

const APP_NAME = 'wild-sacred_bot';
const TYPE_START = 90;
const CPF = 0.3;

export const Step2: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const focused = frame >= 76;
  const typedChars = Math.min(
    APP_NAME.length,
    Math.max(0, Math.floor((frame - TYPE_START) * CPF))
  );
  return (
    <Panel duration={duration}>
      <StepHeader
        n={5}
        title="Create the app"
        sub="Name it wild-sacred_bot — after your project."
      />
      <Browser url="dev.shopify.com/dashboard/apps/create">
        <DashShell
          sidebar={
            <>
              <SideItem label="Apps" active icon="grid" />
              <SideItem label="Stores" icon="store" />
              <SideItem label="Catalogs" icon="catalog" />
            </>
          }
        >
          <div style={{padding: '30px 40px', fontFamily: FONT}}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                fontSize: 23,
                fontWeight: 750,
                color: C.text,
              }}
            >
              <span style={{color: C.dim, fontSize: 21}}>←</span> Create an app
            </div>
            <div style={{marginTop: 24, display: 'flex', alignItems: 'stretch', gap: 0}}>
              {/* Card: Start with Shopify CLI */}
              <div
                style={{
                  width: 450,
                  borderRadius: 14,
                  background: 'rgba(30,60,70,0.35)',
                  border: '1px solid rgba(110,170,185,0.25)',
                  padding: '20px 24px',
                }}
              >
                <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
                  <span style={{fontSize: 16.5, fontWeight: 750, color: C.text}}>
                    Start with Shopify CLI
                  </span>
                  <span style={{fontSize: 14, color: C.blue}}>Docs ↗</span>
                </div>
                <div style={{marginTop: 12, fontSize: 14.5, color: C.dim, lineHeight: 1.5}}>
                  Access all app capabilities and accelerate development with
                  Shopify CLI
                </div>
                <div
                  style={{
                    marginTop: 16,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    background: 'rgba(10,25,30,0.6)',
                    border: '1px solid rgba(110,170,185,0.25)',
                    borderRadius: 9,
                    padding: '10px 14px',
                    fontFamily: MONO,
                    fontSize: 14,
                    color: '#9fd0d8',
                  }}
                >
                  <span style={{color: C.faint}}>$</span>
                  npm init @shopify/app@latest
                  <svg width="15" height="15" viewBox="0 0 24 24" style={{marginLeft: 'auto'}}>
                    <rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke={C.dim} strokeWidth="2" />
                    <path d="M5 15V5a1 1 0 0 1 1-1h10" fill="none" stroke={C.dim} strokeWidth="2" />
                  </svg>
                </div>
              </div>
              {/* OR divider */}
              <div
                style={{
                  width: 60,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 0',
                }}
              >
                <div style={{flex: 1, width: 1, background: C.border}} />
                <span style={{fontSize: 13, color: C.faint, fontFamily: MONO}}>OR</span>
                <div style={{flex: 1, width: 1, background: C.border}} />
              </div>
              {/* Card: Start from Dev Dashboard */}
              <div
                style={{
                  width: 480,
                  borderRadius: 14,
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  padding: '20px 24px',
                }}
              >
                <div style={{fontSize: 16.5, fontWeight: 750, color: C.text}}>
                  Start from Dev Dashboard
                </div>
                <div style={{marginTop: 12, fontSize: 14.5, color: C.dim}}>
                  Add scopes to quickly generate API credentials
                </div>
                <div style={{marginTop: 16, fontSize: 14.5, fontWeight: 650, color: C.text}}>
                  App name
                </div>
                <div style={{marginTop: 8, display: 'flex', gap: 12}}>
                  <div
                    style={{
                      flex: 1,
                      height: 42,
                      borderRadius: 9,
                      background: C.panel,
                      border: `1.5px solid ${focused ? '#4a9eff' : C.border}`,
                      boxShadow: focused ? '0 0 0 4px rgba(74,158,255,0.18)' : 'none',
                      display: 'flex',
                      alignItems: 'center',
                      padding: '0 12px',
                      fontFamily: MONO,
                      fontSize: 15,
                      color: C.text,
                    }}
                  >
                    <TypeText
                      text={APP_NAME}
                      start={TYPE_START}
                      cpf={CPF}
                      caretColor={C.green}
                    />
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontSize: 13,
                        color: C.dim,
                        fontFamily: FONT,
                      }}
                    >
                      {typedChars} / 30
                    </span>
                  </div>
                  <Btn
                    label="Create"
                    kind="light"
                    pressedAt={230}
                    glow={frame > 160}
                    style={{height: 42}}
                  />
                </div>
              </div>
            </div>
          </div>
        </DashShell>
      </Browser>
      {/* Card2 abs: content x 790 + pad 40 = 830; card1 450 + divider 60 → card2 left 1340,
          right 1820. Input row y ≈ 429..471, center 450.
          Input center ≈ (1500, 450). Create btn ≈ (1737, 450) */}
      <Cursor
        path={[
          {f: 35, x: 1420, y: 950},
          {f: 70, x: 1500, y: 450},
          {f: 185, x: 1503, y: 452},
          {f: 218, x: 1737, y: 451},
        ]}
        clicks={[76, 230]}
      />
      <Caption
        text="Name the app after your project so you always know which store it belongs to"
        from={16}
      />
    </Panel>
  );
};
