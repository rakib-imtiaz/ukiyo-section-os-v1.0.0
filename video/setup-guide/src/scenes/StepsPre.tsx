import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C, FONT, MONO} from '../theme';
import {
  Browser,
  Caption,
  Cursor,
  FadeIn,
  Panel,
  StepHeader,
  TypeText,
} from '../ui';

// Shopify bag logo (green bag, white S)
const BagLogo: React.FC<{size?: number}> = ({size = 64}) => (
  <svg width={size} height={size * 1.08} viewBox="0 0 40 44">
    <path
      d="M7 10 C7 10 14 8 20 8 C26 8 33 10 33 10 L36 37.5 C36.4 40.5 34.4 42 31.5 42 L8.5 42 C5.6 42 3.6 40.5 4 37.5 Z"
      fill={C.green}
    />
    <path
      d="M14.5 11.5 V9 a5.5 5.5 0 0 1 11 0 v2.5"
      stroke="#ffffff"
      strokeWidth="2.4"
      fill="none"
      strokeLinecap="round"
    />
    <text
      x="20"
      y="33"
      textAnchor="middle"
      fontSize="17"
      fontWeight="800"
      fill="#ffffff"
      fontFamily="Arial"
    >
      S
    </text>
  </svg>
);

const SocialBtn: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div
    style={{
      flex: 1,
      height: 44,
      borderRadius: 9,
      background: '#f1f2f3',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// NEW Step 1 — Log in to Shopify (accounts.shopify.com)
// ---------------------------------------------------------------------------
export const StepLogin: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const focused = frame >= 68;
  return (
    <Panel duration={duration}>
      <StepHeader
        n={1}
        title="Log in to Shopify"
        sub="accounts.shopify.com — use your existing account or create one."
      />
      <Browser url="accounts.shopify.com/lookup">
        <div style={{position: 'absolute', inset: 0, background: '#141715'}}>
          <div style={{display: 'flex', justifyContent: 'center', paddingTop: 22}}>
            <BagLogo size={58} />
          </div>
          {/* White login card */}
          <div
            style={{
              width: 440,
              margin: '14px auto 0',
              borderRadius: 18,
              background: '#ffffff',
              padding: '30px 36px 26px',
              fontFamily: FONT,
              boxShadow: '0 24px 70px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{fontSize: 27, fontWeight: 800, color: '#1a1c1a'}}>
              Log in
            </div>
            <div style={{marginTop: 6, fontSize: 15, color: C.lightDim}}>
              Continue to Shopify
            </div>
            <div style={{marginTop: 20, fontSize: 14, fontWeight: 650, color: '#1a1c1a'}}>
              Email
            </div>
            <div
              style={{
                marginTop: 8,
                height: 46,
                borderRadius: 9,
                border: `1.5px solid ${focused ? '#1a73e8' : '#8a8d8f'}`,
                display: 'flex',
                alignItems: 'center',
                padding: '0 14px',
                fontSize: 15.5,
                color: '#1a1c1a',
                boxShadow: focused ? '0 0 0 4px rgba(26,115,232,0.15)' : 'none',
              }}
            >
              <TypeText
                text="you@yourmail.com"
                start={80}
                cpf={0.35}
                caretColor="#1a1c1a"
              />
            </div>
            <div
              style={{
                marginTop: 16,
                height: 48,
                borderRadius: 10,
                background: '#1a1c1a',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 15.5,
                fontWeight: 700,
                transform:
                  frame >= 185 && frame <= 193
                    ? `scale(${1 - 0.06 * Math.sin(((frame - 185) / 8) * Math.PI)})`
                    : 'scale(1)',
              }}
            >
              Continue with email
            </div>
            <div
              style={{
                marginTop: 16,
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                color: C.lightDim,
                fontSize: 13.5,
              }}
            >
              <div style={{flex: 1, height: 1, background: C.lightBorder}} />
              or
              <div style={{flex: 1, height: 1, background: C.lightBorder}} />
            </div>
            <div
              style={{
                marginTop: 14,
                height: 44,
                borderRadius: 9,
                background: '#f1f2f3',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                fontSize: 14.5,
                fontWeight: 650,
                color: '#1a1c1a',
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24">
                <circle cx="9" cy="8" r="3.4" fill="none" stroke="#1a1c1a" strokeWidth="1.8" />
                <path d="M3.5 19c1-3.4 3-5 5.5-5s4.5 1.6 5.5 5" fill="none" stroke="#1a1c1a" strokeWidth="1.8" />
                <path d="M16 8.5l1.6 1.6 3-3.2" fill="none" stroke="#1a1c1a" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              Sign in with passkey
            </div>
            <div style={{marginTop: 12, display: 'flex', gap: 10}}>
              <SocialBtn>
                <span style={{fontSize: 19, fontWeight: 800, color: '#4285F4', fontFamily: 'Arial'}}>
                  G
                </span>
              </SocialBtn>
              <SocialBtn>
                <svg width="17" height="20" viewBox="0 0 24 28">
                  <path
                    d="M17.5 14.7c0-3 2.5-4.4 2.6-4.5-1.4-2-3.6-2.3-4.3-2.3-1.8-.2-3.6 1.1-4.5 1.1-.9 0-2.4-1.1-3.9-1-2 0-3.9 1.2-4.9 3-2.1 3.6-.5 9 1.5 11.9 1 1.4 2.2 3 3.7 3 1.5-.1 2.1-1 3.9-1s2.3 1 3.9.9c1.6 0 2.6-1.4 3.6-2.9 1.1-1.7 1.6-3.3 1.6-3.4-.1 0-3.2-1.2-3.2-4.8zM14.6 5.6c.8-1 1.4-2.4 1.2-3.8-1.2 0-2.7.8-3.5 1.8-.8.9-1.5 2.4-1.3 3.7 1.4.1 2.8-.7 3.6-1.7z"
                    fill="#1a1c1a"
                  />
                </svg>
              </SocialBtn>
              <SocialBtn>
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    background: '#1877F2',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 14,
                    fontWeight: 800,
                    fontFamily: 'Arial',
                  }}
                >
                  f
                </div>
              </SocialBtn>
              <SocialBtn>
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    background: '#25D366',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24">
                    <path
                      d="M6 15l1-3.5c-.6-1-1-2.2-1-3.5A6.5 6.5 0 1 1 9.5 14z"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="2.4"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              </SocialBtn>
            </div>
            <div style={{marginTop: 18, fontSize: 13.5, color: C.lightDim}}>
              New to Shopify?{' '}
              <span style={{color: '#1a73e8', fontWeight: 650}}>Get started →</span>
            </div>
          </div>
        </div>
      </Browser>
      {/* Card abs: left 1195-220=975, top ≈ 168+22+63+14=267. Email input center ≈ (1195, 430).
          Continue btn center ≈ (1195, 497) */}
      <Cursor
        path={[
          {f: 30, x: 1420, y: 950},
          {f: 62, x: 1195, y: 430},
          {f: 150, x: 1198, y: 432},
          {f: 178, x: 1195, y: 498},
        ]}
        clicks={[68, 185]}
      />
      <Caption text="Log in at accounts.shopify.com — or create a free account" from={18} />
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// NEW Step 2 — Create your store (name it after your project)
// ---------------------------------------------------------------------------
const Chip: React.FC<{label: string; selected?: boolean}> = ({label, selected}) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      height: 36,
      padding: '0 15px',
      borderRadius: 18,
      background: selected ? '#1a1c1a' : '#f1f2f3',
      color: selected ? '#fff' : '#1a1c1a',
      fontSize: 14,
      fontWeight: 600,
      fontFamily: FONT,
    }}
  >
    <span style={{fontSize: 13, opacity: 0.9}}>{selected ? '✓' : '+'}</span>
    {label}
  </div>
);

export const StepStore: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const focused = frame >= 72;
  return (
    <Panel duration={duration}>
      <StepHeader
        n={2}
        title="Create your store"
        sub="Name it after your ThemeBot project."
      />
      <Browser url="admin.shopify.com/signup">
        <div style={{position: 'absolute', inset: 0, background: '#101211', fontFamily: FONT}}>
          <div style={{textAlign: 'center', paddingTop: 36}}>
            <div style={{fontSize: 32, fontWeight: 750, color: '#fff'}}>
              Let&apos;s get started
            </div>
            <div style={{marginTop: 8, fontSize: 16.5, color: C.dim}}>
              Add some details to customize your setup
            </div>
          </div>
          {/* White card */}
          <div
            style={{
              width: 480,
              margin: '26px auto 0',
              borderRadius: 16,
              background: '#ffffff',
              padding: '26px 30px 24px',
              boxShadow: '0 24px 70px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{fontSize: 15, fontWeight: 700, color: '#1a1c1a'}}>
              What can we help you do?
            </div>
            <div style={{marginTop: 12, display: 'flex', gap: 9, flexWrap: 'wrap'}}>
              <Chip label="Sell online" selected />
              <Chip label="Sell in-store" />
              <Chip label="Dropshipping" />
            </div>
            <div style={{marginTop: 9, display: 'flex', gap: 9}}>
              <Chip label="Sell digital products" />
              <Chip label="Move existing store" />
            </div>
            <div style={{marginTop: 22, fontSize: 15, fontWeight: 700, color: '#1a1c1a'}}>
              What should we call your store?
            </div>
            <div
              style={{
                marginTop: 10,
                height: 48,
                borderRadius: 9,
                border: `1.5px solid ${focused ? '#1a73e8' : '#8a8d8f'}`,
                display: 'flex',
                alignItems: 'center',
                padding: '0 14px',
                fontSize: 16,
                color: '#1a1c1a',
                fontFamily: MONO,
                boxShadow: focused ? '0 0 0 4px rgba(26,115,232,0.15)' : 'none',
              }}
            >
              <TypeText text="wild-sacred" start={84} cpf={0.3} caretColor="#1a1c1a" />
            </div>
            <div
              style={{
                marginTop: 18,
                height: 48,
                borderRadius: 10,
                background: '#1a1c1a',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 15.5,
                fontWeight: 700,
                transform:
                  frame >= 220 && frame <= 228
                    ? `scale(${1 - 0.06 * Math.sin(((frame - 220) / 8) * Math.PI)})`
                    : 'scale(1)',
              }}
            >
              Continue
            </div>
            <div
              style={{
                marginTop: 14,
                textAlign: 'center',
                fontSize: 13.5,
                color: '#1a1c1a',
                textDecoration: 'underline',
              }}
            >
              I&apos;ll do this later
            </div>
          </div>
        </div>
      </Browser>
      {/* Card abs: left 1195-240=955, top ≈ 168+36+40+8+25+26=303.
          Store input center ≈ (1195, 512). Continue btn center ≈ (1195, 578) */}
      <Cursor
        path={[
          {f: 30, x: 1440, y: 950},
          {f: 66, x: 1195, y: 512},
          {f: 180, x: 1198, y: 514},
          {f: 212, x: 1195, y: 578},
        ]}
        clicks={[72, 220]}
      />
      <Caption
        text="This becomes wild-sacred.myshopify.com — use your ThemeBot project name"
        from={18}
      />
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// NEW Step 3 — Activate the $1/month starter plan (critical, do NOT skip)
// ---------------------------------------------------------------------------
const PlanCard: React.FC<{
  name: string;
  price: string;
  per: string;
  desc: string;
  hot?: boolean;
  pressedAt?: number;
}> = ({name, price, per, desc, hot, pressedAt}) => {
  const frame = useCurrentFrame();
  const pulse = 0.22 + 0.16 * Math.sin((frame / 18) * Math.PI * 2);
  const pressed =
    pressedAt !== undefined && frame >= pressedAt && frame <= pressedAt + 8
      ? 1 - 0.06 * Math.sin(((frame - pressedAt) / 8) * Math.PI)
      : 1;
  return (
    <div
      style={{
        width: 300,
        height: 320,
        borderRadius: 16,
        background: hot ? '#1c1707' : C.surface,
        border: hot ? `2px solid ${C.yellow}` : `1px solid ${C.border}`,
        boxShadow: hot ? `0 0 0 7px rgba(255,195,0,${pulse})` : 'none',
        padding: '22px 24px',
        position: 'relative',
        fontFamily: FONT,
      }}
    >
      {hot ? (
        <div
          style={{
            position: 'absolute',
            top: -17,
            left: '50%',
            transform: 'translateX(-50%)',
            background: C.yellow,
            color: '#1f1a00',
            borderRadius: 999,
            padding: '6px 16px',
            fontSize: 13.5,
            fontWeight: 800,
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24">
            <path d="M12 3 L22 20 H2 Z" fill="none" stroke="#1f1a00" strokeWidth="2.4" strokeLinejoin="round" />
            <path d="M12 10v4M12 17.2v.2" stroke="#1f1a00" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          REQUIRED — do NOT skip
        </div>
      ) : null}
      <div style={{fontSize: 17, fontWeight: 750, color: hot ? C.yellow : C.text}}>
        {name}
      </div>
      <div style={{marginTop: 16, display: 'flex', alignItems: 'baseline', gap: 6}}>
        <span style={{fontSize: 52, fontWeight: 800, color: hot ? '#ffd84d' : C.text}}>
          {price}
        </span>
        <span style={{fontSize: 16, color: hot ? '#c9a83a' : C.dim}}>{per}</span>
      </div>
      <div style={{marginTop: 10, fontSize: 14.5, color: hot ? '#d8c98f' : C.dim, lineHeight: 1.5}}>
        {desc}
      </div>
      <div
        style={{
          position: 'absolute',
          left: 22,
          right: 22,
          bottom: 22,
          height: 44,
          borderRadius: 10,
          background: hot ? C.yellow : C.surface3,
          color: hot ? '#1f1a00' : C.dim,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 15,
          fontWeight: 750,
          transform: `scale(${pressed})`,
        }}
      >
        {hot ? 'Activate plan' : 'Choose plan'}
      </div>
    </div>
  );
};

export const StepPlan: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const warnPulse = 0.75 + 0.25 * Math.sin((frame / 16) * Math.PI * 2);
  return (
    <Panel duration={duration}>
      <StepHeader
        n={3}
        title="Activate the $1/month plan"
        sub="The critical step — without a plan, apps cannot be installed."
      />
      <Browser url="admin.shopify.com/settings/plan">
        <div style={{position: 'absolute', inset: 0, background: C.bg, fontFamily: FONT}}>
          <div style={{textAlign: 'center', paddingTop: 34}}>
            <div style={{fontSize: 30, fontWeight: 750, color: C.text}}>
              Pick your plan
            </div>
            <div style={{marginTop: 8, fontSize: 16, color: C.dim}}>
              Your store needs an active plan before apps can be installed
            </div>
          </div>
          <div
            style={{
              marginTop: 44,
              display: 'flex',
              justifyContent: 'center',
              gap: 24,
            }}
          >
            <PlanCard name="Basic" price="$29" per="/month" desc="Everyday essentials for solo sellers" />
            <PlanCard
              name="Starter promo"
              price="$1"
              per="/month"
              desc="First 3 months, then standard pricing. Card required, cancel anytime."
              hot
              pressedAt={165}
            />
            <PlanCard name="Grow" price="$79" per="/month" desc="More tools for small teams" />
          </div>
          <FadeIn from={40} slide={12} style={{display: 'flex', justifyContent: 'center', marginTop: 40}}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: '#241c04',
                border: `1.5px solid ${C.yellow}`,
                color: C.yellow,
                borderRadius: 12,
                padding: '11px 22px',
                fontSize: 16.5,
                fontWeight: 750,
                opacity: warnPulse,
              }}
            >
              <svg width="19" height="19" viewBox="0 0 24 24">
                <path d="M12 3 L22 20 H2 Z" fill="none" stroke={C.yellow} strokeWidth="2.2" strokeLinejoin="round" />
                <path d="M12 10v4M12 17.2v.2" stroke={C.yellow} strokeWidth="2.2" strokeLinecap="round" />
              </svg>
              No plan = the Install app button stays greyed out
            </div>
          </FadeIn>
        </div>
      </Browser>
      {/* Center card: x 1045..1345, cards top ≈ 168+34+38+8+22+44=314? → 314..634.
          Activate btn: bottom 22 → y 568..612 center ≈ (1195, 590) */}
      <Cursor
        path={[
          {f: 35, x: 1460, y: 950},
          {f: 120, x: 1195, y: 590},
          {f: 158, x: 1197, y: 589},
        ]}
        clicks={[165]}
      />
      <Caption
        text="Skip this and 'Install app' stays disabled in the Dev Dashboard"
        from={16}
      />
    </Panel>
  );
};
