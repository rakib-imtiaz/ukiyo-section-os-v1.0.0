import type { HeroBuilderState, SectionManifest } from '../shared/types';

export const defaultHeroState: HeroBuilderState = {
  name: 'Cinematic Product Hero',
  handle: 'vso-cinematic-product-hero',
  eyebrow: 'THE NEW COLLECTION',
  heading: 'Objects with presence. Spaces with a point of view.',
  body: 'A cinematic Shopify hero built to feel editorial, move with intention, and remain completely editable.',
  primaryLabel: 'Explore the collection',
  primaryUrl: '/collections/all',
  secondaryLabel: 'Our story',
  secondaryUrl: '/pages/about',
  backgroundType: 'gradient',
  backgroundColor: '#171816',
  gradient: 'linear-gradient(135deg, #191a17 0%, #464136 52%, #111210 100%)',
  previewImageUrl: '',
  overlayColor: '#050505',
  overlayOpacity: 32,
  textColor: '#f4f0e8',
  accentColor: '#c8a96b',
  contentPosition: 'bottom-left',
  textAlignment: 'left',
  sectionHeight: 86,
  contentWidth: 760,
  headingSize: 76,
  mobileHeadingSize: 44,
  paddingX: 56,
  paddingY: 56,
  animation: 'reveal',
  animationDuration: 900,
  parallax: true,
};

const liquid = String.raw`<div
  class="vso-cinematic-hero vso-position--{{ settings.content_position }} vso-align--{{ settings.text_alignment }} vso-motion--{{ settings.animation }}"
  data-vso-section="vso-cinematic-product-hero"
  data-section-id="{{ section_id }}"
  data-parallax="{{ settings.enable_parallax }}"
  style="
    --vso-height: {{ settings.section_height }}vh;
    --vso-content-width: {{ settings.content_width }}px;
    --vso-heading-size: {{ settings.heading_size }}px;
    --vso-heading-size-mobile: {{ settings.mobile_heading_size }}px;
    --vso-pad-x: {{ settings.padding_x }}px;
    --vso-pad-y: {{ settings.padding_y }}px;
    --vso-text: {{ settings.text_color }};
    --vso-accent: {{ settings.accent_color }};
    --vso-background: {{ settings.background_color }};
    --vso-overlay: {{ settings.overlay_color }};
    --vso-overlay-opacity: {{ settings.overlay_opacity | divided_by: 100.0 }};
    --vso-duration: {{ settings.animation_duration }}ms;
  "
>
  <div class="vso-cinematic-hero__media" aria-hidden="true">
    {% if section.settings.background_video != blank %}
      {{ section.settings.background_video | video_tag: autoplay: true, loop: true, muted: true, controls: false, playsinline: true, class: 'vso-cinematic-hero__video' }}
    {% elsif section.settings.background_image != blank %}
      {{ section.settings.background_image | image_url: width: 2400 | image_tag: loading: 'eager', widths: '750, 1100, 1500, 2000, 2400', sizes: '100vw', class: 'vso-cinematic-hero__image' }}
    {% else %}
      <div class="vso-cinematic-hero__fallback"></div>
    {% endif %}
  </div>
  <div class="vso-cinematic-hero__overlay"></div>
  <div class="vso-cinematic-hero__grain" aria-hidden="true"></div>

  <div class="vso-cinematic-hero__inner">
    <div class="vso-cinematic-hero__content">
      {% if section.settings.eyebrow != blank %}
        <p class="vso-cinematic-hero__eyebrow" data-vso-reveal>{{ section.settings.eyebrow }}</p>
      {% endif %}
      {% if section.settings.heading != blank %}
        <h2 class="vso-cinematic-hero__heading" data-vso-reveal>{{ section.settings.heading }}</h2>
      {% endif %}
      {% if section.settings.body != blank %}
        <div class="vso-cinematic-hero__body" data-vso-reveal>{{ section.settings.body }}</div>
      {% endif %}

      <div class="vso-cinematic-hero__actions" data-vso-reveal>
        {% if section.settings.primary_label != blank %}
          <a class="vso-button vso-button--primary" href="{{ section.settings.primary_url | default: '#' }}">
            <span>{{ section.settings.primary_label }}</span><span aria-hidden="true">↗</span>
          </a>
        {% endif %}
        {% if section.settings.secondary_label != blank %}
          <a class="vso-button vso-button--secondary" href="{{ section.settings.secondary_url | default: '#' }}">
            <span>{{ section.settings.secondary_label }}</span>
          </a>
        {% endif %}
      </div>

      {% if section.blocks.size > 0 %}
        <div class="vso-cinematic-hero__stats" data-vso-reveal>
          {% for block in section.blocks %}
            {% case block.type %}
              {% when 'stat' %}
                <div class="vso-stat" data-vso-block="{{ block.type }}" {{ block.shopify_attributes }}>
                  <strong>{{ block.settings.value }}</strong>
                  <span>{{ block.settings.label }}</span>
                </div>
            {% endcase %}
          {% endfor %}
        </div>
      {% endif %}
    </div>
  </div>
  {% if section.settings.show_scroll_cue %}
    <div class="vso-cinematic-hero__scroll" aria-hidden="true"><span></span> Scroll</div>
  {% endif %}
</div>`;

const css = String.raw`.vso-cinematic-hero {
  position: relative;
  isolation: isolate;
  display: grid;
  min-height: max(520px, var(--vso-height));
  overflow: hidden;
  color: var(--vso-text);
  background: var(--vso-background);
  font-family: inherit;
}

.vso-cinematic-hero__media,
.vso-cinematic-hero__overlay,
.vso-cinematic-hero__grain { position: absolute; inset: 0; }
.vso-cinematic-hero__media { z-index: -4; overflow: hidden; }
.vso-cinematic-hero__image,
.vso-cinematic-hero__video { width: 100%; height: 112%; object-fit: cover; transform: translate3d(0, var(--vso-parallax-y, -3%), 0) scale(1.035); }
.vso-cinematic-hero__fallback { width: 100%; height: 100%; background: var(--vso-background); }
.vso-cinematic-hero__overlay { z-index: -3; background: var(--vso-overlay); opacity: var(--vso-overlay-opacity); }
.vso-cinematic-hero__grain { z-index: -2; opacity: .12; pointer-events: none; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.35'/%3E%3C/svg%3E"); mix-blend-mode: soft-light; }
.vso-cinematic-hero__inner { display: flex; width: 100%; min-height: inherit; padding: var(--vso-pad-y) var(--vso-pad-x); }
.vso-position--top-left .vso-cinematic-hero__inner { align-items: flex-start; justify-content: flex-start; }
.vso-position--top-center .vso-cinematic-hero__inner { align-items: flex-start; justify-content: center; }
.vso-position--center-left .vso-cinematic-hero__inner { align-items: center; justify-content: flex-start; }
.vso-position--center .vso-cinematic-hero__inner { align-items: center; justify-content: center; }
.vso-position--bottom-left .vso-cinematic-hero__inner { align-items: flex-end; justify-content: flex-start; }
.vso-position--bottom-center .vso-cinematic-hero__inner { align-items: flex-end; justify-content: center; }
.vso-cinematic-hero__content { width: min(100%, var(--vso-content-width)); text-align: left; }
.vso-align--center .vso-cinematic-hero__content { text-align: center; }
.vso-align--right .vso-cinematic-hero__content { text-align: right; }
.vso-cinematic-hero__eyebrow { margin: 0 0 18px; color: var(--vso-accent); font-size: 11px; font-weight: 700; letter-spacing: .22em; }
.vso-cinematic-hero__heading { margin: 0; max-width: 15ch; color: inherit; font-size: clamp(40px, 6.2vw, var(--vso-heading-size)); font-weight: 400; line-height: .96; letter-spacing: -.045em; text-wrap: balance; }
.vso-align--center .vso-cinematic-hero__heading { margin-inline: auto; }
.vso-align--right .vso-cinematic-hero__heading { margin-left: auto; }
.vso-cinematic-hero__body { max-width: 58ch; margin-top: 24px; font-size: clamp(15px, 1.3vw, 18px); line-height: 1.6; opacity: .78; }
.vso-align--center .vso-cinematic-hero__body { margin-inline: auto; }
.vso-align--right .vso-cinematic-hero__body { margin-left: auto; }
.vso-cinematic-hero__actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
.vso-align--center .vso-cinematic-hero__actions { justify-content: center; }
.vso-align--right .vso-cinematic-hero__actions { justify-content: flex-end; }
.vso-button { display: inline-flex; min-height: 50px; align-items: center; justify-content: center; gap: 24px; padding: 0 22px; border: 1px solid transparent; color: inherit; text-decoration: none; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; transition: transform .25s ease, background .25s ease, color .25s ease; }
.vso-button:hover { transform: translateY(-2px); }
.vso-button--primary { color: #111; background: var(--vso-accent); }
.vso-button--secondary { border-color: currentColor; background: color-mix(in srgb, var(--vso-text) 6%, transparent); backdrop-filter: blur(12px); }
.vso-cinematic-hero__stats { display: flex; flex-wrap: wrap; gap: 30px; margin-top: 38px; padding-top: 20px; border-top: 1px solid color-mix(in srgb, var(--vso-text) 22%, transparent); }
.vso-stat { display: grid; gap: 4px; min-width: 90px; }
.vso-stat strong { font-size: 20px; font-weight: 500; }
.vso-stat span { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; opacity: .55; }
.vso-cinematic-hero__scroll { position: absolute; right: 24px; bottom: 28px; display: flex; align-items: center; gap: 10px; font-size: 9px; letter-spacing: .18em; text-transform: uppercase; opacity: .62; writing-mode: vertical-rl; }
.vso-cinematic-hero__scroll span { width: 1px; height: 36px; background: currentColor; }
.vso-cinematic-hero [data-vso-reveal] { transition: opacity var(--vso-duration) cubic-bezier(.2,.7,.2,1), transform var(--vso-duration) cubic-bezier(.2,.7,.2,1), filter var(--vso-duration) ease; }
.vso-cinematic-hero:not(.is-visible).vso-motion--fade-up [data-vso-reveal] { opacity: 0; transform: translateY(24px); }
.vso-cinematic-hero:not(.is-visible).vso-motion--reveal [data-vso-reveal] { opacity: 0; transform: translateY(38px); clip-path: inset(0 0 100% 0); }
.vso-cinematic-hero:not(.is-visible).vso-motion--blur-in [data-vso-reveal] { opacity: 0; transform: scale(.98); filter: blur(12px); }
.vso-cinematic-hero [data-vso-reveal]:nth-child(2) { transition-delay: 90ms; }
.vso-cinematic-hero [data-vso-reveal]:nth-child(3) { transition-delay: 170ms; }
.vso-cinematic-hero [data-vso-reveal]:nth-child(4) { transition-delay: 240ms; }

@media (max-width: 749px) {
  .vso-cinematic-hero { min-height: max(520px, calc(var(--vso-height) * .92)); }
  .vso-cinematic-hero__inner { padding: calc(var(--vso-pad-y) * .65) max(20px, calc(var(--vso-pad-x) * .42)); }
  .vso-cinematic-hero__heading { font-size: var(--vso-heading-size-mobile); }
  .vso-cinematic-hero__actions { align-items: stretch; }
  .vso-button { flex: 1 1 180px; }
  .vso-cinematic-hero__scroll { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .vso-cinematic-hero *, .vso-cinematic-hero *::before, .vso-cinematic-hero *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
  .vso-cinematic-hero__image, .vso-cinematic-hero__video { transform: none !important; }
}`;

const javascript = String.raw`(() => {
  const SELECTOR = '[data-vso-section="vso-cinematic-product-hero"]';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function mount(root = document) {
    root.querySelectorAll(SELECTOR).forEach((section) => {
      if (section.dataset.vsoMounted === 'true') return;
      section.dataset.vsoMounted = 'true';

      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            section.classList.add('is-visible');
            observer.disconnect();
          }
        });
      }, { threshold: 0.12 });
      observer.observe(section);

      if (section.dataset.parallax === 'true' && !reducedMotion.matches) {
        let frame;
        const update = () => {
          frame = undefined;
          const rect = section.getBoundingClientRect();
          const progress = Math.max(-1, Math.min(1, (window.innerHeight / 2 - (rect.top + rect.height / 2)) / window.innerHeight));
          section.style.setProperty('--vso-parallax-y', (-3 + progress * 5) + '%');
        };
        const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
        window.addEventListener('scroll', onScroll, { passive: true });
        update();
        section._vsoDestroy = () => window.removeEventListener('scroll', onScroll);
      }
    });
  }

  mount();
  document.addEventListener('shopify:section:load', (event) => mount(event.target));
  document.addEventListener('shopify:section:unload', (event) => {
    event.target.querySelectorAll(SELECTOR).forEach((section) => section._vsoDestroy?.());
  });
})();`;

export function createCinematicHeroManifest(state: HeroBuilderState = defaultHeroState): SectionManifest {
  const instanceLiquid = liquid.replace(
    'data-vso-section="vso-cinematic-product-hero"',
    `data-vso-section="${state.handle}"`,
  );
  const instanceJavascript = javascript.replace(
    '[data-vso-section="vso-cinematic-product-hero"]',
    `[data-vso-section="${state.handle}"]`,
  );
  return {
    contractVersion: 1,
    name: state.name,
    handle: state.handle,
    description: 'A premium full-bleed hero with editable content, media, overlay, layout, mobile typography, calls to action, statistics, and motion.',
    tag: 'section',
    className: 'vso-shopify-wrapper vso-cinematic-hero-wrapper',
    maxBlocks: 6,
    settings: [
      { type: 'header', content: 'Content' },
      { type: 'text', id: 'eyebrow', label: 'Eyebrow', default: state.eyebrow },
      { type: 'inline_richtext', id: 'heading', label: 'Heading', default: state.heading },
      { type: 'richtext', id: 'body', label: 'Body', default: `<p>${state.body}</p>` },
      { type: 'text', id: 'primary_label', label: 'Primary button label', default: state.primaryLabel },
      { type: 'url', id: 'primary_url', label: 'Primary button link', default: state.primaryUrl },
      { type: 'text', id: 'secondary_label', label: 'Secondary button label', default: state.secondaryLabel },
      { type: 'url', id: 'secondary_url', label: 'Secondary button link', default: state.secondaryUrl },
      { type: 'header', content: 'Background' },
      { type: 'image_picker', id: 'background_image', label: 'Background image' },
      { type: 'video', id: 'background_video', label: 'Background video' },
      { type: 'color_background', id: 'background_color', label: 'Background color or gradient', default: state.backgroundType === 'gradient' ? state.gradient : state.backgroundColor },
      { type: 'color', id: 'overlay_color', label: 'Overlay color', default: state.overlayColor },
      { type: 'range', id: 'overlay_opacity', label: 'Overlay opacity', min: 0, max: 90, step: 1, unit: '%', default: state.overlayOpacity },
      { type: 'header', content: 'Layout' },
      { type: 'select', id: 'content_position', label: 'Content position', default: state.contentPosition, options: [
        { value: 'top-left', label: 'Top left' }, { value: 'top-center', label: 'Top center' },
        { value: 'center-left', label: 'Center left' }, { value: 'center', label: 'Center' },
        { value: 'bottom-left', label: 'Bottom left' }, { value: 'bottom-center', label: 'Bottom center' },
      ] },
      { type: 'text_alignment', id: 'text_alignment', label: 'Text alignment', default: state.textAlignment },
      { type: 'range', id: 'section_height', label: 'Section height', min: 50, max: 100, step: 1, unit: 'vh', default: state.sectionHeight },
      { type: 'range', id: 'content_width', label: 'Content width', min: 360, max: 1000, step: 10, unit: 'px', default: state.contentWidth },
      { type: 'range', id: 'padding_x', label: 'Horizontal padding', min: 0, max: 120, step: 4, unit: 'px', default: state.paddingX },
      { type: 'range', id: 'padding_y', label: 'Vertical padding', min: 0, max: 160, step: 4, unit: 'px', default: state.paddingY },
      { type: 'header', content: 'Typography and color' },
      { type: 'color', id: 'text_color', label: 'Text color', default: state.textColor },
      { type: 'color', id: 'accent_color', label: 'Accent color', default: state.accentColor },
      { type: 'range', id: 'heading_size', label: 'Heading size', min: 36, max: 120, step: 2, unit: 'px', default: state.headingSize },
      { type: 'range', id: 'mobile_heading_size', label: 'Mobile heading size', min: 28, max: 72, step: 2, unit: 'px', default: state.mobileHeadingSize },
      { type: 'header', content: 'Motion' },
      { type: 'select', id: 'animation', label: 'Entrance animation', default: state.animation, options: [
        { value: 'none', label: 'None' }, { value: 'fade-up', label: 'Fade up' },
        { value: 'reveal', label: 'Editorial reveal' }, { value: 'blur-in', label: 'Blur in' },
      ] },
      { type: 'range', id: 'animation_duration', label: 'Animation duration', min: 200, max: 2000, step: 50, unit: 'ms', default: state.animationDuration },
      { type: 'checkbox', id: 'enable_parallax', label: 'Enable subtle parallax', default: state.parallax },
      { type: 'checkbox', id: 'show_scroll_cue', label: 'Show scroll cue', default: true },
    ],
    blocks: [{
      type: 'stat',
      name: 'Statistic',
      limit: 6,
      settings: [
        { type: 'text', id: 'value', label: 'Value', default: '01' },
        { type: 'text', id: 'label', label: 'Label', default: 'Designed to move' },
      ],
    }],
    presets: [{
      name: state.name,
      category: 'ThemeBot',
      blocks: [
        { type: 'stat', settings: { value: '01', label: 'Modular by default' } },
        { type: 'stat', settings: { value: '02', label: 'Motion ready' } },
      ],
    }],
    source: { liquid: instanceLiquid, css, javascript: instanceJavascript },
  };
}

/**
 * Inverse of createCinematicHeroManifest: recover a builder state from a saved manifest so
 * opening a project hydrates the Visual builder controls (instead of silently discarding
 * customizations on the first edit). Unknown/missing settings fall back to the provided base.
 */
export function heroStateFromManifest(manifest: SectionManifest, fallback: HeroBuilderState): HeroBuilderState {
  const settings = Array.isArray(manifest.settings) ? manifest.settings : [];
  const get = (id: string) => settings.find((setting) => 'id' in setting && (setting as { id?: string }).id === id) as { default?: unknown } | undefined;
  const str = (id: string, fb: string) => { const value = get(id)?.default; return typeof value === 'string' ? value : fb; };
  const num = (id: string, fb: number) => { const value = get(id)?.default; return typeof value === 'number' ? value : fb; };
  const bool = (id: string, fb: boolean) => { const value = get(id)?.default; return typeof value === 'boolean' ? value : fb; };
  const background = str('background_color', fallback.backgroundColor);
  const isGradient = /gradient/i.test(background);
  const body = str('body', `<p>${fallback.body}</p>`).replace(/^\s*<p>/i, '').replace(/<\/p>\s*$/i, '');
  return {
    ...fallback,
    name: typeof manifest.name === 'string' ? manifest.name : fallback.name,
    handle: typeof manifest.handle === 'string' ? manifest.handle : fallback.handle,
    eyebrow: str('eyebrow', fallback.eyebrow),
    heading: str('heading', fallback.heading),
    body,
    primaryLabel: str('primary_label', fallback.primaryLabel),
    primaryUrl: str('primary_url', fallback.primaryUrl),
    secondaryLabel: str('secondary_label', fallback.secondaryLabel),
    secondaryUrl: str('secondary_url', fallback.secondaryUrl),
    backgroundType: isGradient ? 'gradient' : (fallback.backgroundType === 'gradient' ? 'color' : fallback.backgroundType),
    gradient: isGradient ? background : fallback.gradient,
    backgroundColor: isGradient ? fallback.backgroundColor : background,
    overlayColor: str('overlay_color', fallback.overlayColor),
    overlayOpacity: num('overlay_opacity', fallback.overlayOpacity),
    contentPosition: str('content_position', fallback.contentPosition) as HeroBuilderState['contentPosition'],
    textAlignment: str('text_alignment', fallback.textAlignment) as HeroBuilderState['textAlignment'],
    sectionHeight: num('section_height', fallback.sectionHeight),
    contentWidth: num('content_width', fallback.contentWidth),
    paddingX: num('padding_x', fallback.paddingX),
    paddingY: num('padding_y', fallback.paddingY),
    textColor: str('text_color', fallback.textColor),
    accentColor: str('accent_color', fallback.accentColor),
    headingSize: num('heading_size', fallback.headingSize),
    mobileHeadingSize: num('mobile_heading_size', fallback.mobileHeadingSize),
    animation: str('animation', fallback.animation) as HeroBuilderState['animation'],
    animationDuration: num('animation_duration', fallback.animationDuration),
    parallax: bool('enable_parallax', fallback.parallax),
  };
}
