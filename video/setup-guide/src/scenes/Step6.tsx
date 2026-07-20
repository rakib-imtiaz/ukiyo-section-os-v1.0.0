import React from 'react';
import {
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {C, FAKE_CLIENT_ID, FAKE_SECRET, FONT, MONO} from '../theme';
import {
  Browser,
  Caption,
  Check,
  Cursor,
  DashShell,
  FadeIn,
  Panel,
  SideItem,
  StepHeader,
} from '../ui';

// ---------------------------------------------------------------------------
// Phase A — Dev Dashboard Settings tab (dark)
// ---------------------------------------------------------------------------
const CredRow: React.FC<{
  label: string;
  value: string;
  masked?: boolean;
  revealAt?: number;
  copiedAt?: number;
  eye?: boolean;
}> = ({label, value, masked, revealAt = 0, copiedAt, eye}) => {
  const frame = useCurrentFrame();
  const revealed = !masked || frame >= revealAt;
  const copied = copiedAt !== undefined && frame >= copiedAt;
  return (
    <div style={{marginTop: 22}}>
      <div style={{fontSize: 15, fontWeight: 650, color: C.dim}}>{label}</div>
      <div
        style={{
          marginTop: 10,
          height: 50,
          borderRadius: 10,
          background: C.panel,
          border: `1px solid ${C.border}`,
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          gap: 14,
        }}
      >
        <span
          style={{
            flex: 1,
            fontFamily: MONO,
            fontSize: 16.5,
            color: revealed ? C.text : C.faint,
            letterSpacing: revealed ? 0.5 : 3,
          }}
        >
          {revealed ? value : '••••••••••••••••••••••••••••••••'}
        </span>
        {eye ? (
          <svg width="20" height="20" viewBox="0 0 24 24">
            <path
              d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"
              fill="none"
              stroke={revealed ? C.green : C.dim}
              strokeWidth="2"
            />
            <circle
              cx="12"
              cy="12"
              r="3"
              fill="none"
              stroke={revealed ? C.green : C.dim}
              strokeWidth="2"
            />
          </svg>
        ) : null}
        <div style={{position: 'relative'}}>
          <svg width="18" height="18" viewBox="0 0 24 24">
            <rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke={C.dim} strokeWidth="2" />
            <path d="M5 15V5a1 1 0 0 1 1-1h10" fill="none" stroke={C.dim} strokeWidth="2" />
          </svg>
          {copied ? (
            <div
              style={{
                position: 'absolute',
                right: -8,
                top: -34,
                background: '#12261a',
                border: `1px solid ${C.success}`,
                color: C.success,
                borderRadius: 7,
                padding: '3px 10px',
                fontSize: 12.5,
                fontWeight: 700,
                fontFamily: FONT,
              }}
            >
              Copied
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const SettingsPhase: React.FC = () => (
  <>
    <Browser url="dev.shopify.com/dashboard/apps/wild-sacred_bot/settings">
      <DashShell
        sidebar={
          <>
            <SideItem label="wild-sacred_bot" boxed icon="grid" />
            <SideItem label="Monitoring" />
            <SideItem label="Logs" />
            <SideItem label="Versions" />
            <SideItem label="Settings" active />
          </>
        }
      >
        <div style={{padding: '24px 40px', fontFamily: FONT}}>
          <div style={{fontSize: 24, fontWeight: 750, color: C.text}}>Settings</div>
          <div
            style={{
              marginTop: 18,
              borderRadius: 12,
              border: `1px solid ${C.border}`,
              background: C.surface,
              padding: '20px 26px 28px',
            }}
          >
            <div style={{fontSize: 17, fontWeight: 750, color: C.text}}>
              Client credentials
            </div>
            <div style={{marginTop: 6, fontSize: 14, color: C.faint}}>
              Use these to authenticate API requests from ThemeBot.
            </div>
            <CredRow label="Client ID" value={FAKE_CLIENT_ID} copiedAt={165} />
            <CredRow
              label="Client secret"
              value={FAKE_SECRET}
              masked
              revealAt={98}
              eye
              copiedAt={999999}
            />
          </div>
        </div>
      </DashShell>
    </Browser>
    <Cursor
      path={[
        {f: 30, x: 1350, y: 960},
        {f: 85, x: 1722, y: 546},
        {f: 140, x: 1758, y: 444},
      ]}
      clicks={[98, 165]}
    />
    <Caption text="Settings → copy the Client ID and Client secret" from={16} />
  </>
);

// ---------------------------------------------------------------------------
// Phase B — the real ThemeBot wizard (light UI)
// ---------------------------------------------------------------------------
const LB = {
  bg: '#f5f6f8',
  side: '#fbfbfc',
  card: '#ffffff',
  border: '#e4e6e9',
  inputBorder: '#cdd1d6',
  text: '#17191c',
  dim: '#6b7077',
  faint: '#9aa0a8',
  blue: '#2563eb',
  green: '#1e8e3e',
  greenBg: '#e7f5eb',
  greenBorder: '#7fce97',
};

const LightPaste: React.FC<{value: string; at: number}> = ({value, at}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({
    frame: frame - at,
    fps,
    config: {damping: 16, stiffness: 220, mass: 0.6},
  });
  const flash = interpolate(frame, [at, at + 20], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  if (frame < at) return null;
  return (
    <span
      style={{
        display: 'inline-block',
        fontFamily: MONO,
        fontSize: 14.5,
        color: LB.text,
        transform: `scale(${0.96 + 0.04 * Math.min(s, 1)})`,
        transformOrigin: 'left center',
        background: `rgba(52,168,83,${0.22 * flash})`,
        borderRadius: 4,
        padding: '1px 4px',
      }}
    >
      {value}
    </span>
  );
};

const MenuIcon: React.FC<{kind: string; color: string}> = ({kind, color}) => (
  <svg width="15" height="15" viewBox="0 0 24 24">
    {kind === 'home' ? (
      <path d="M4 11l8-7 8 7v9h-6v-6h-4v6H4z" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    ) : kind === 'projects' ? (
      <path d="M3 7h7l2 2h9v11H3z" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    ) : kind === 'connections' ? (
      <path d="M8 12h8M6 8a4 4 0 1 0 0 8M18 8a4 4 0 1 1 0 8" fill="none" stroke={color} strokeWidth="2" />
    ) : kind === 'factory' ? (
      <path d="M4 20V9l5 3V9l5 3V6h6v14z" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    ) : kind === 'terminal' ? (
      <path d="M4 5h16v14H4zM7 9l3 3-3 3M12 15h5" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    ) : (
      <>
        <circle cx="12" cy="12" r="8" fill="none" stroke={color} strokeWidth="2" />
        <path d="M4 12h16M12 4c3 3 3 13 0 16-3-3-3-13 0-16" fill="none" stroke={color} strokeWidth="2" />
      </>
    )}
  </svg>
);

const SIDE_ITEMS: {label: string; kind: string}[] = [
  {label: 'Home', kind: 'home'},
  {label: 'Projects', kind: 'projects'},
  {label: 'Connections', kind: 'connections'},
  {label: 'Factory', kind: 'factory'},
  {label: 'Terminal', kind: 'terminal'},
  {label: 'Browser', kind: 'browser'},
];

const StepDot: React.FC<{n: number; label: string; state: 'done' | 'active' | 'todo'}> = ({
  n,
  label,
  state,
}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
    <div
      style={{
        width: 30,
        height: 30,
        borderRadius: 15,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
        fontWeight: 750,
        background: state === 'todo' ? '#eceef1' : '#17191c',
        color: state === 'todo' ? LB.faint : '#fff',
      }}
    >
      {state === 'done' ? '✓' : n}
    </div>
    <span
      style={{
        fontSize: 15,
        fontWeight: state === 'active' ? 750 : 600,
        color: state === 'todo' ? LB.faint : LB.text,
      }}
    >
      {label}
    </span>
  </div>
);

const ThemeBotPhase: React.FC = () => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const testing = frame >= 100 && frame < 135;
  const connected = frame >= 135;
  const spinner = ((frame * 18) % 360).toFixed(0);
  return (
    <div style={{opacity: o, fontFamily: FONT}}>
      {/* ThemeBot app window (light) */}
      <div
        style={{
          position: 'absolute',
          left: 540,
          top: 120,
          width: 1310,
          height: 800,
          borderRadius: 16,
          background: LB.bg,
          border: '1px solid #d8dbdf',
          boxShadow: '0 34px 90px rgba(0,0,0,0.55)',
          overflow: 'hidden',
          display: 'flex',
        }}
      >
        {/* Sidebar */}
        <div
          style={{
            width: 230,
            flex: 'none',
            background: LB.side,
            borderRight: `1px solid ${LB.border}`,
            padding: '18px 14px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{display: 'flex', alignItems: 'center', gap: 10, padding: '0 6px'}}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                background: LB.blue,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path
                  d="M12 3l7 4v10l-7 4-7-4V7z"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="12" r="2.4" fill="#fff" />
              </svg>
            </div>
            <div>
              <div style={{fontSize: 12.5, fontWeight: 800, letterSpacing: 2, color: LB.text}}>
                THEMEBOT
              </div>
              <div style={{fontSize: 8, letterSpacing: 1.4, color: LB.faint, marginTop: 2}}>
                AUTONOMOUS BUILDER
              </div>
            </div>
          </div>
          <div style={{marginTop: 22, fontSize: 9.5, letterSpacing: 2, color: LB.faint, padding: '0 6px'}}>
            MENU
          </div>
          <div style={{marginTop: 8}}>
            {SIDE_ITEMS.map((it) => {
              const active = it.label === 'Factory';
              return (
                <div
                  key={it.label}
                  style={{
                    height: 38,
                    borderRadius: 9,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 11,
                    padding: '0 12px',
                    marginBottom: 2,
                    background: active ? LB.blue : 'transparent',
                    color: active ? '#fff' : LB.dim,
                    fontSize: 14,
                    fontWeight: active ? 700 : 550,
                  }}
                >
                  <MenuIcon kind={it.kind} color={active ? '#fff' : LB.dim} />
                  {it.label}
                </div>
              );
            })}
          </div>
          <div style={{flex: 1}} />
          <div
            style={{
              borderRadius: 10,
              border: `1px solid ${LB.border}`,
              background: '#f4f7f5',
              padding: '10px 12px',
            }}
          >
            <div style={{fontSize: 8.5, letterSpacing: 1.6, color: LB.faint}}>
              SYSTEM STATUS
            </div>
            <div
              style={{
                marginTop: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 12.5,
                fontWeight: 700,
                color: LB.text,
              }}
            >
              <div style={{width: 8, height: 8, borderRadius: 4, background: '#34a853'}} />
              Production ready
            </div>
          </div>
        </div>
        {/* Main */}
        <div style={{flex: 1, position: 'relative'}}>
          <div style={{padding: '16px 28px', borderBottom: `1px solid ${LB.border}`}}>
            <div style={{fontSize: 10, letterSpacing: 1.6, color: LB.faint}}>
              THEMEBOT / PRODUCTION
            </div>
            <div style={{marginTop: 4, fontSize: 19, fontWeight: 750, color: LB.text}}>
              Factory
            </div>
          </div>
          <div style={{width: 640, margin: '22px auto 0'}}>
            <div style={{fontSize: 25, fontWeight: 800, color: LB.text}}>
              Create a clone job
            </div>
            <div style={{marginTop: 6, fontSize: 13.5, color: LB.dim}}>
              Point the factory at a React site and a Shopify store — it clones,
              QAs, and fixes until they match.
            </div>
            {/* Stepper */}
            <div style={{marginTop: 18, display: 'flex', alignItems: 'center', gap: 14}}>
              <StepDot n={1} label="Sources" state="done" />
              <div style={{width: 54, height: 2, background: '#17191c'}} />
              <StepDot n={2} label="Credentials" state="active" />
              <div style={{width: 54, height: 2, background: '#dfe2e6'}} />
              <StepDot n={3} label="Options & launch" state="todo" />
              <span style={{marginLeft: 'auto', fontSize: 13, color: LB.dim}}>
                Step 2 of 3
              </span>
            </div>
            {/* Credentials card */}
            <div
              style={{
                marginTop: 20,
                borderRadius: 12,
                background: LB.card,
                border: `1px solid ${LB.border}`,
                padding: '24px 28px',
                boxShadow: '0 1px 3px rgba(20,24,28,0.05)',
              }}
            >
              <div style={{fontSize: 17, fontWeight: 750, color: LB.text}}>
                Shopify custom-app credentials
              </div>
              <div style={{marginTop: 8, fontSize: 13, color: LB.dim, lineHeight: 1.55}}>
                From the Dev Dashboard (dev.shopify.com): your app → Settings tab
                → Client ID &amp; Client Secret. The factory mints short-lived
                tokens from these; they are stored encrypted and never leave this
                machine.
              </div>
              <div style={{marginTop: 18, fontSize: 13, fontWeight: 700, color: LB.text}}>
                Client ID
              </div>
              <div
                style={{
                  marginTop: 7,
                  height: 44,
                  borderRadius: 9,
                  border: `1.5px solid ${frame >= 35 ? '#17191c' : LB.inputBorder}`,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 12px',
                  background: '#fff',
                }}
              >
                <LightPaste value={FAKE_CLIENT_ID} at={35} />
              </div>
              <div style={{marginTop: 14, fontSize: 13, fontWeight: 700, color: LB.text}}>
                Client Secret
              </div>
              <div
                style={{
                  marginTop: 7,
                  height: 44,
                  borderRadius: 9,
                  border: `1.5px solid ${frame >= 58 ? '#17191c' : LB.inputBorder}`,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 12px',
                  background: '#fff',
                }}
              >
                <LightPaste value={FAKE_SECRET} at={58} />
              </div>
              {/* Test connection + success */}
              <div style={{marginTop: 20, display: 'flex', alignItems: 'center', gap: 16}}>
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 9,
                    height: 40,
                    padding: '0 20px',
                    borderRadius: 9,
                    background: '#fff',
                    border: `1.5px solid ${LB.inputBorder}`,
                    color: LB.text,
                    fontSize: 14,
                    fontWeight: 700,
                    transform:
                      frame >= 95 && frame <= 103
                        ? `scale(${1 - 0.06 * Math.sin(((frame - 95) / 8) * Math.PI)})`
                        : 'scale(1)',
                  }}
                >
                  {testing ? (
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      style={{transform: `rotate(${spinner}deg)`}}
                    >
                      <path
                        d="M12 3a9 9 0 1 1-9 9"
                        fill="none"
                        stroke={LB.text}
                        strokeWidth="3"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : null}
                  {testing ? 'Testing…' : 'Test connection'}
                </div>
                {connected ? (
                  <FadeIn
                    from={135}
                    style={{
                      flex: 1,
                      borderRadius: 10,
                      background: LB.greenBg,
                      border: `1.5px solid ${LB.greenBorder}`,
                      padding: '9px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      fontSize: 12.5,
                      fontWeight: 650,
                      color: LB.green,
                    }}
                  >
                    <Check size={16} color={LB.green} />
                    Connected to wild-sacred.myshopify.com — required scopes
                    granted
                  </FadeIn>
                ) : null}
              </div>
            </div>
            {/* Bottom nav */}
            <div style={{marginTop: 18, display: 'flex', alignItems: 'center'}}>
              <span style={{fontSize: 14, fontWeight: 650, color: LB.text}}>Cancel</span>
              <span style={{marginLeft: 26, fontSize: 14, color: LB.dim}}>← Back</span>
              <div
                style={{
                  marginLeft: 'auto',
                  height: 42,
                  padding: '0 24px',
                  borderRadius: 10,
                  background: '#17191c',
                  color: '#fff',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 14.5,
                  fontWeight: 700,
                  opacity: connected ? 1 : 0.45,
                }}
              >
                Next →
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Test connection btn abs: main col left = 540+230+((1080-640)/2)=990; card pad 28 → btn
          left 1018, w ~175 → center ≈ (1105, ?). Vertical: window 120 + header 62 + 22 + title 30
          + 6+20 + stepper 30+20 + card top ≈ 120+62+22+31+27+48 ≈ 310; card pad 24 →
          title 340, desc ~365..420, CID label 438, input 445..489, label 503, input 510..554,
          row 574..614 center ≈ 594. Target (1105, 594) */}
      <Cursor
        path={[
          {f: 20, x: 1550, y: 950},
          {f: 80, x: 1105, y: 659},
          {f: 92, x: 1107, y: 657},
        ]}
        clicks={[95]}
      />
      <Caption
        text="Paste both keys into ThemeBot → Credentials, then Test connection"
        from={12}
      />
    </div>
  );
};

export const Step6: React.FC<{duration: number}> = ({duration}) => {
  return (
    <Panel duration={duration}>
      <StepHeader
        n={9}
        title="Copy the credentials"
        sub="Client ID + Client secret → ThemeBot wizard, Credentials step."
      />
      <Sequence durationInFrames={195}>
        <SettingsPhase />
      </Sequence>
      <Sequence from={195}>
        <ThemeBotPhase />
      </Sequence>
    </Panel>
  );
};
