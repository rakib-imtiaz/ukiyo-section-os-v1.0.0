import React from 'react';
import {Sequence, interpolate, useCurrentFrame} from 'remotion';
import {C, FONT, MONO} from '../theme';
import {
  Browser,
  Btn,
  Caption,
  Check,
  Cursor,
  DashShell,
  FadeIn,
  Panel,
  SideItem,
  StepHeader,
} from '../ui';

const RailCard: React.FC<{
  title: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}> = ({title, action, children}) => (
  <div
    style={{
      borderRadius: 12,
      border: `1px solid ${C.border}`,
      background: C.surface,
      padding: '16px 18px',
      marginBottom: 16,
      fontFamily: FONT,
    }}
  >
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <div style={{fontSize: 16, fontWeight: 700, color: C.text}}>{title}</div>
      {action}
    </div>
    {children}
  </div>
);

const OverviewPhase: React.FC = () => {
  const frame = useCurrentFrame();
  const menuOpen = frame >= 128;
  return (
    <>
      <Browser url="dev.shopify.com/dashboard/apps/wild-sacred_bot">
        <DashShell
          sidebar={
            <>
              <SideItem label="wild-sacred_bot" boxed icon="grid" active />
              <SideItem label="Monitoring" />
              <SideItem label="Logs" />
              <SideItem label="Versions" />
              <SideItem label="Settings" />
            </>
          }
        >
          <div style={{padding: '24px 28px', display: 'flex', gap: 22, fontFamily: FONT}}>
            <div style={{flex: 1}}>
              <div style={{fontSize: 24, fontWeight: 750, color: C.text}}>
                Overview
              </div>
              <div
                style={{
                  marginTop: 18,
                  borderRadius: 12,
                  border: `1px solid ${C.border}`,
                  background: C.surface,
                  padding: '16px 18px',
                }}
              >
                <div style={{fontSize: 16, fontWeight: 700, color: C.text}}>
                  API health
                </div>
                <div
                  style={{
                    marginTop: 12,
                    borderRadius: 10,
                    background: 'rgba(61,220,132,0.08)',
                    border: '1px solid rgba(61,220,132,0.35)',
                    padding: '14px 16px',
                    display: 'flex',
                    gap: 12,
                    alignItems: 'center',
                  }}
                >
                  <Check size={22} />
                  <div>
                    <div style={{color: C.success, fontWeight: 750, fontSize: 15}}>
                      OK
                    </div>
                    <div style={{color: C.success, fontSize: 14, opacity: 0.85}}>
                      No calls with breaking changes detected in the last 14 days
                    </div>
                  </div>
                </div>
              </div>
              <div
                style={{
                  marginTop: 16,
                  borderRadius: 12,
                  border: `1px solid ${C.border}`,
                  background: C.surface,
                  padding: '16px 18px',
                  display: 'flex',
                  gap: 34,
                }}
              >
                {[
                  ['Webhook failure rate', 'No data'],
                  ['Removed subscriptions', 'No data'],
                  ['Function error rate', 'No data'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <div style={{fontSize: 14, color: C.text, fontWeight: 650}}>{k}</div>
                    <div style={{fontSize: 14, color: C.faint, fontFamily: MONO, marginTop: 8}}>
                      {v}
                    </div>
                  </div>
                ))}
              </div>
              <div
                style={{
                  marginTop: 16,
                  borderRadius: 12,
                  border: `1px solid ${C.border}`,
                  background: C.surface,
                  padding: '16px 18px',
                }}
              >
                <div style={{fontSize: 16, fontWeight: 700, color: C.text}}>Activity</div>
                <div style={{marginTop: 10, fontSize: 14, color: C.dim}}>Today</div>
                <div style={{marginTop: 10, fontSize: 14, color: C.text, fontFamily: MONO}}>
                  <span style={{color: C.blue}}>wild-sacred_bot-1</span>{' '}
                  <span style={{color: C.dim, fontFamily: FONT}}>released · just now</span>
                </div>
              </div>
            </div>
            {/* Right rail */}
            <div style={{width: 300, flex: 'none', paddingTop: 44}}>
              <RailCard
                title="Installs"
                action={<Btn label="Install app" pressedAt={112} glow style={{height: 34, fontSize: 14}} />}
              >
                <div
                  style={{
                    marginTop: 12,
                    height: 38,
                    borderRadius: 9,
                    background: C.surface2,
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 14px',
                    color: C.dim,
                    fontSize: 14,
                    fontFamily: MONO,
                  }}
                >
                  0
                </div>
              </RailCard>
              <RailCard title="Versions" action={<Btn label="New version" kind="dark" style={{height: 32, fontSize: 13.5}} />}>
                <div
                  style={{
                    marginTop: 12,
                    height: 40,
                    borderRadius: 9,
                    background: C.surface2,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '0 14px',
                    fontSize: 14,
                  }}
                >
                  <span style={{color: C.text, fontFamily: MONO, fontSize: 13}}>wild-sacred_bot-1</span>
                  <span
                    style={{
                      color: C.success,
                      background: 'rgba(61,220,132,0.12)',
                      borderRadius: 6,
                      padding: '2px 8px',
                      fontSize: 12.5,
                      fontWeight: 700,
                    }}
                  >
                    Active
                  </span>
                </div>
              </RailCard>
            </div>
          </div>
          {/* Store picker dropdown */}
          {menuOpen ? (
            <FadeIn
              from={128}
              slide={8}
              style={{position: 'absolute', right: 32, top: 116}}
            >
              <div
                style={{
                  width: 280,
                  borderRadius: 10,
                  background: C.surface2,
                  border: `1px solid ${C.borderHi}`,
                  boxShadow: '0 18px 50px rgba(0,0,0,0.6)',
                  padding: 8,
                  fontFamily: FONT,
                }}
              >
                <div style={{fontSize: 12.5, color: C.faint, padding: '6px 10px'}}>
                  Choose a store
                </div>
                <div
                  style={{
                    borderRadius: 8,
                    background: frame >= 158 ? C.surface3 : 'transparent',
                    padding: '10px 10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 7,
                      background: C.greenSoft,
                      border: `1px solid ${C.green}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: C.green,
                      fontSize: 13,
                      fontWeight: 800,
                    }}
                  >
                    M
                  </div>
                  <div>
                    <div style={{fontSize: 14.5, color: C.text, fontWeight: 650}}>
                      wild-sacred
                    </div>
                    <div style={{fontSize: 12.5, color: C.dim, fontFamily: MONO}}>
                      wild-sacred.myshopify.com
                    </div>
                  </div>
                </div>
              </div>
            </FadeIn>
          ) : null}
        </DashShell>
      </Browser>
      {/* Install app btn abs ≈ rail x: content right 1850-28=1822, rail w 300 → rail left 1522.
          Card padding 18 → btn right edge ≈ 1804, w ~104 → center ≈ (1752, 315)?
          Rail paddingTop 44 + card padding 16 → header row y ≈ 224+24+44+16=308, btn center ≈ 317 */}
      <Cursor
        path={[
          {f: 30, x: 1200, y: 980},
          {f: 95, x: 1748, y: 330},
          {f: 148, x: 1680, y: 408},
        ]}
        clicks={[112, 162]}
      />
      <Caption text="Overview → Installs → Install app, then pick your store" from={16} />
    </>
  );
};

const ConsentPhase: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div style={{opacity: o}}>
      <Browser url="wild-sacred.myshopify.com/admin/oauth/install">
        <div style={{position: 'absolute', inset: 0, background: C.lightBg}}>
          <div style={{width: 640, margin: '44px auto 0', fontFamily: FONT}}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 20,
                fontWeight: 750,
                color: C.lightText,
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24">
                <path
                  d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"
                  fill="none"
                  stroke={C.lightText}
                  strokeWidth="2"
                />
              </svg>
              Install app
            </div>
            {/* Yellow banner */}
            <div
              style={{
                marginTop: 18,
                borderRadius: 12,
                overflow: 'hidden',
                boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
              }}
            >
              <div
                style={{
                  background: C.yellow,
                  padding: '11px 18px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 15,
                  fontWeight: 750,
                  color: '#1f1a00',
                }}
              >
                <svg width="17" height="17" viewBox="0 0 24 24">
                  <path
                    d="M12 3 L22 20 H2 Z"
                    fill="none"
                    stroke="#1f1a00"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                  <path d="M12 10v4M12 17.2v.2" stroke="#1f1a00" strokeWidth="2" strokeLinecap="round" />
                </svg>
                This app hasn&apos;t been reviewed
              </div>
              <div
                style={{
                  background: C.lightCard,
                  padding: '14px 18px',
                  fontSize: 14.5,
                  color: C.lightDim,
                  lineHeight: 1.5,
                }}
              >
                Shopify reviews apps to ensure your security is protected. Be sure
                you trust this app developer before installing.
              </div>
            </div>
            {/* App card */}
            <div
              style={{
                marginTop: 18,
                borderRadius: 12,
                background: C.lightCard,
                boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '16px 18px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  background: '#fafafa',
                  borderBottom: `1px solid ${C.lightBorder}`,
                }}
              >
                <div
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 10,
                    border: `1px solid ${C.lightBorder}`,
                    background: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24">
                    <path
                      d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"
                      fill="none"
                      stroke="#8a8d8f"
                      strokeWidth="2"
                    />
                  </svg>
                </div>
                <div>
                  <div style={{fontSize: 15.5, fontWeight: 750, color: C.lightText, fontFamily: MONO}}>
                    wild-sacred_bot
                  </div>
                  <div style={{fontSize: 13.5, color: C.lightDim}}>wild-sacred</div>
                </div>
              </div>
              <div style={{padding: '16px 18px'}}>
                <div style={{fontSize: 14.5, fontWeight: 700, color: C.lightText}}>
                  This app needs access to:
                </div>
                <div
                  style={{
                    marginTop: 12,
                    borderRadius: 10,
                    border: `1px solid ${C.lightBorder}`,
                    padding: '13px 16px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div style={{fontSize: 14.5, fontWeight: 650, color: C.lightText}}>
                      Themes, content, products and files
                    </div>
                    <div style={{fontSize: 13, color: C.lightDim, marginTop: 3}}>
                      Store owner
                    </div>
                  </div>
                  <span style={{color: C.lightDim}}>▾</span>
                </div>
              </div>
            </div>
            <div
              style={{
                marginTop: 20,
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 12,
              }}
            >
              <div
                style={{
                  height: 38,
                  padding: '0 18px',
                  borderRadius: 9,
                  background: '#fff',
                  border: `1px solid #c9ccce`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  fontSize: 14.5,
                  fontWeight: 650,
                  color: C.lightText,
                }}
              >
                Cancel
              </div>
              <Btn
                label={frame >= 152 ? 'Installing…' : 'Install'}
                kind="dark"
                pressedAt={140}
                glow={frame > 60 && frame < 140}
                style={{background: '#1a1c1a', border: 'none', color: '#fff'}}
              />
            </div>
          </div>
        </div>
      </Browser>
      {/* Install btn abs: column 640 wide centered in browser → left 540+(1310-640)/2=875, right 1515.
          Buttons row y ≈ 168+44+30(title)+18+~118(banner)+18+~168(card)+20 → ≈ 600; center ≈ (1478, 620) */}
      <Cursor
        path={[
          {f: 18, x: 1250, y: 940},
          {f: 95, x: 1478, y: 622},
          {f: 135, x: 1480, y: 620},
        ]}
        clicks={[140]}
      />
      <Caption text="Approve the consent screen — click Install" from={14} />
    </div>
  );
};

export const Step5: React.FC<{duration: number}> = ({duration}) => {
  return (
    <Panel duration={duration}>
      <StepHeader
        n={8}
        title="Install on your store"
        sub="Overview → Installs → Install app, then approve."
      />
      <Sequence durationInFrames={200}>
        <OverviewPhase />
      </Sequence>
      <Sequence from={200}>
        <ConsentPhase duration={duration - 200} />
      </Sequence>
    </Panel>
  );
};
