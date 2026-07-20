import React from 'react';
import {
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {C, FONT, MONO, SCOPES} from '../theme';
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
} from '../ui';

// ---------------------------------------------------------------------------
// Timing (scene-local frames)
// ---------------------------------------------------------------------------
const FORM_AT = 110; // New version form appears
const LINK_CLICK = 135; // click "Select scopes"
const MODAL_AT = 150; // modal fades in
const SCROLL_START = 285;
const SCROLL_END = 305;
const SCROLL_PX = 180;
const DONE_CLICK = 360;
const MODAL_OUT = 366; // modal starts fading
const FIELD_FILLED = 384; // scopes field shows list

// Ticked scope → scene frame at which it gets checked
const TICKS: Record<string, number> = {
  write_content: 185,
  write_online_store_pages: 212,
  read_products: 240,
  write_products: 265,
  read_themes: 318,
  write_themes: 342,
};

const ROWS: {cat: string; scopes: string[]}[] = [
  {cat: 'Analytics', scopes: ['read_analytics']},
  {cat: 'Content', scopes: ['read_content', 'write_content']},
  {cat: 'Files', scopes: ['read_files', 'write_files']},
  {
    cat: 'Online Store pages',
    scopes: ['read_online_store_pages', 'write_online_store_pages'],
  },
  {cat: 'Products', scopes: ['read_products', 'write_products']},
  {cat: 'Publications', scopes: ['read_publications', 'write_publications']},
  {cat: 'Themes', scopes: ['read_themes', 'write_themes', 'write_theme_code']},
  {cat: 'Metaobjects', scopes: ['read_metaobjects', 'write_metaobjects']},
];

const CheckBox: React.FC<{checkedAt?: number}> = ({checkedAt}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const checked = checkedAt !== undefined && frame >= checkedAt;
  const pop = checked
    ? spring({
        frame: frame - (checkedAt as number),
        fps,
        config: {damping: 12, stiffness: 260, mass: 0.5},
      })
    : 0;
  return (
    <div
      style={{
        width: 18,
        height: 18,
        borderRadius: 4,
        flex: 'none',
        border: `1.5px solid ${checked ? C.green : C.borderHi}`,
        background: checked ? C.green : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transform: `scale(${checked ? 0.9 + 0.1 * Math.min(pop, 1) : 1})`,
      }}
    >
      {checked ? (
        <svg width="12" height="12" viewBox="0 0 24 24">
          <path
            d="M5 12.5l4.5 4.5 9-10"
            fill="none"
            stroke="#101410"
            strokeWidth="3.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </div>
  );
};

const ScopeModal: React.FC = () => {
  const frame = useCurrentFrame();
  const inO = interpolate(frame, [MODAL_AT, MODAL_AT + 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const outO = interpolate(frame, [MODAL_OUT, MODAL_OUT + 14], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const scroll = interpolate(
    frame,
    [SCROLL_START, SCROLL_END],
    [0, -SCROLL_PX],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
  );
  if (frame < MODAL_AT || frame > MODAL_OUT + 14) return null;
  return (
    <div style={{position: 'absolute', inset: 0, opacity: inO * outO}}>
      <div style={{position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)'}} />
      <div
        style={{
          position: 'absolute',
          left: (1310 - 760) / 2,
          top: 40,
          width: 760,
          height: 640,
          borderRadius: 14,
          background: C.surface,
          border: `1px solid ${C.borderHi}`,
          boxShadow: '0 30px 90px rgba(0,0,0,0.65)',
          padding: 24,
          fontFamily: FONT,
        }}
      >
        <div style={{display: 'flex', justifyContent: 'space-between'}}>
          <div style={{fontSize: 19, fontWeight: 750, color: C.text}}>
            Select scopes
          </div>
          <div style={{fontSize: 19, color: C.dim}}>×</div>
        </div>
        {/* Controls row */}
        <div style={{marginTop: 16, display: 'flex', gap: 14}}>
          <div
            style={{
              width: 170,
              height: 36,
              borderRadius: 8,
              background: C.surface3,
              border: `1px solid ${C.borderHi}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 12px',
              fontSize: 14.5,
              fontWeight: 650,
              color: C.text,
            }}
          >
            All APIs <span style={{color: C.dim, fontSize: 12}}>⇅</span>
          </div>
          <div
            style={{
              flex: 1,
              height: 36,
              borderRadius: 8,
              background: C.panel,
              border: `1px solid ${C.border}`,
              display: 'flex',
              alignItems: 'center',
              padding: '0 12px',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24">
              <circle cx="10" cy="10" r="6.5" fill="none" stroke={C.faint} strokeWidth="2" />
              <path d="M15 15l5 5" stroke={C.faint} strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        </div>
        {/* Scrollable list */}
        <div
          style={{
            marginTop: 16,
            height: 424,
            overflow: 'hidden',
            position: 'relative',
            borderTop: `1px solid ${C.border}`,
          }}
        >
          <div style={{transform: `translateY(${scroll}px)`}}>
            {ROWS.map((row) => (
              <div
                key={row.cat}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  padding: '8px 0',
                  borderBottom: `1px solid ${C.border}`,
                }}
              >
                <div style={{width: 130, fontSize: 14, color: C.dim, paddingTop: 6}}>
                  Admin API
                </div>
                <div
                  style={{
                    width: 210,
                    fontSize: 14.5,
                    fontWeight: 650,
                    color: C.text,
                    paddingTop: 5,
                  }}
                >
                  {row.cat}
                </div>
                <div style={{flex: 1}}>
                  {row.scopes.map((s) => (
                    <div
                      key={s}
                      style={{
                        height: 30,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                      }}
                    >
                      <CheckBox checkedAt={TICKS[s]} />
                      <span style={{fontFamily: MONO, fontSize: 14, color: C.text}}>
                        {s}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {/* Scrollbar */}
          <div
            style={{
              position: 'absolute',
              right: 0,
              top: (-scroll / SCROLL_PX) * 140 + 8,
              width: 6,
              height: 150,
              borderRadius: 3,
              background: C.surface3,
            }}
          />
        </div>
        {/* Footer */}
        <div
          style={{
            position: 'absolute',
            right: 24,
            bottom: 20,
            display: 'flex',
            gap: 12,
          }}
        >
          <Btn label="Cancel" kind="dark" />
          <Btn label="Done" kind="light" pressedAt={DONE_CLICK} />
        </div>
      </div>
    </div>
  );
};

export const Step3: React.FC<{duration: number}> = ({duration}) => {
  const frame = useCurrentFrame();
  const formVisible = frame >= FORM_AT;
  const filled = frame >= FIELD_FILLED;
  return (
    <Panel duration={duration}>
      <StepHeader
        n={6}
        title="Add the access scopes"
        sub="Versions → New version → Select scopes → tick what ThemeBot needs."
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
          {!formVisible ? (
            <div style={{padding: '26px 40px', fontFamily: FONT}}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div style={{fontSize: 24, fontWeight: 750, color: C.text}}>
                  Versions
                </div>
                <Btn label="New version" kind="light" pressedAt={92} glow />
              </div>
              <div
                style={{
                  marginTop: 26,
                  borderRadius: 12,
                  border: `1px solid ${C.border}`,
                  background: C.surface,
                  padding: '44px 0',
                  textAlign: 'center',
                  color: C.dim,
                  fontSize: 16,
                }}
              >
                No versions yet — create one to configure your app.
              </div>
            </div>
          ) : (
            <FadeIn from={FORM_AT} slide={16} style={{height: '100%'}}>
              <div style={{padding: '22px 40px', fontFamily: FONT}}>
                <div style={{fontSize: 22, fontWeight: 750, color: C.text}}>
                  New version
                </div>
                <div
                  style={{
                    marginTop: 16,
                    borderRadius: 12,
                    border: `1px solid ${C.border}`,
                    background: C.surface,
                    padding: '20px 24px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{fontSize: 16, fontWeight: 700, color: C.text}}>
                      Access scopes
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        color: C.blue,
                        fontWeight: 650,
                        padding: '4px 8px',
                        borderRadius: 6,
                        background:
                          frame >= LINK_CLICK - 8 && frame <= LINK_CLICK + 10
                            ? 'rgba(111,183,255,0.15)'
                            : 'transparent',
                      }}
                    >
                      Select scopes
                    </div>
                  </div>
                  <div
                    style={{
                      marginTop: 12,
                      minHeight: 300,
                      borderRadius: 10,
                      background: C.panel,
                      border: `1.5px solid ${filled ? C.green : C.border}`,
                      boxShadow: filled ? `0 0 0 4px ${C.greenSoft}` : 'none',
                      padding: '14px 16px',
                      fontFamily: MONO,
                      fontSize: 15,
                      lineHeight: 1.75,
                      color: filled ? '#b9d98a' : C.faint,
                      wordBreak: 'break-all',
                    }}
                  >
                    {filled ? SCOPES : ''}
                  </div>
                  <div style={{marginTop: 12, fontSize: 14, color: C.faint}}>
                    Enter scopes as a comma-separated list
                  </div>
                </div>
              </div>
            </FadeIn>
          )}
        </DashShell>
        <ScopeModal />
      </Browser>
      {/* Abs positions:
          Sidebar Versions ≈ (655, 388). New version btn ≈ (1740, 274).
          "Select scopes" link ≈ (1758, 344).
          Modal abs: left 540+275=815, top 168+40=208. Checkbox col x ≈ 1195.
          List top abs ≈ 324. Scope-line centers: write_content 423, write_online_store_pages 575,
          read_products 621, write_products 651; post-scroll: read_themes 593, write_themes 623.
          Done btn ≈ (1512, 790) */}
      <Cursor
        path={[
          {f: 25, x: 1350, y: 980},
          {f: 50, x: 655, y: 388},
          {f: 80, x: 1740, y: 274},
          {f: 125, x: 1758, y: 344},
          {f: 172, x: 1195, y: 425},
          {f: 202, x: 1195, y: 577},
          {f: 230, x: 1195, y: 623},
          {f: 256, x: 1195, y: 653},
          {f: 310, x: 1195, y: 595},
          {f: 316, x: 1195, y: 596},
          {f: 334, x: 1195, y: 625},
          {f: 346, x: 1196, y: 626},
          {f: 358, x: 1512, y: 790},
        ]}
        clicks={[
          56,
          92,
          LINK_CLICK,
          TICKS.write_content,
          TICKS.write_online_store_pages,
          TICKS.read_products,
          TICKS.write_products,
          TICKS.read_themes,
          TICKS.write_themes,
          DONE_CLICK,
        ]}
      />
      <Sequence durationInFrames={140} layout="none">
        <Caption text="Open Versions and click New version" from={16} />
      </Sequence>
      <Sequence from={140} layout="none">
        <Caption
          text="Tick the scopes ThemeBot needs — or paste the list from the wizard checklist"
          from={10}
        />
      </Sequence>
    </Panel>
  );
};
