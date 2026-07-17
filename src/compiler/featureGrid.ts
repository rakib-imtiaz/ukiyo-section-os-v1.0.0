import type { BlockInstance, FeatureGridState, SectionManifest } from '../shared/types';
import { blocksFromManifest, cloneBlocks } from './blocks';

/**
 * Feature Grid — the second ThemeBot section archetype.
 *
 * A responsive card grid driven almost entirely by repeatable "feature" blocks,
 * proving the registry generalizes beyond the Cinematic Hero: different layout
 * model (CSS grid vs full-bleed hero), different motion (staggered card reveal),
 * and block-first content authoring.
 */

/** Preset blocks emitted when the builder state carries no authored blocks. */
export const defaultFeatureGridBlocks: BlockInstance[] = [
  { type: 'feature', settings: { icon: '◈', title: 'Native by design', description: 'Every control compiles to a real Shopify theme setting — no app blocks, no lock-in.', link_label: '', link_url: '' } },
  { type: 'feature', settings: { icon: '◇', title: 'Motion with restraint', description: 'Staggered reveals that respect prefers-reduced-motion out of the box.', link_label: '', link_url: '' } },
  { type: 'feature', settings: { icon: '◆', title: 'Editable everywhere', description: 'Merchants reorder, add, and remove cards straight from the theme editor.', link_label: 'Learn more', link_url: '/pages/about' } },
];

export const defaultFeatureGridState: FeatureGridState = {
  name: 'Feature Grid',
  handle: 'vso-feature-grid',
  eyebrow: 'WHY IT WORKS',
  heading: 'Built for merchants. Designed for humans.',
  intro: 'A modular grid of feature cards. Every card is a repeatable Shopify block the merchant can add, remove, and reorder.',
  columnsDesktop: 3,
  columnsMobile: 1,
  gap: 24,
  maxWidth: 1200,
  paddingX: 40,
  paddingY: 96,
  textAlignment: 'left',
  sectionBackground: '#101110',
  cardBackground: '#1a1b19',
  textColor: '#f4f0e8',
  accentColor: '#c8a96b',
  cardRadius: 14,
  cardPadding: 28,
  iconSize: 28,
  headingSize: 44,
  showIndex: true,
  hoverLift: true,
  animation: 'stagger',
  blocks: cloneBlocks(defaultFeatureGridBlocks),
};

const liquid = String.raw`<div
  class="vso-feature-grid vso-grid-align--{{ settings.text_alignment }} vso-grid-motion--{{ settings.animation }}{% if settings.hover_lift %} vso-grid--lift{% endif %}{% if settings.show_index %} vso-grid--indexed{% endif %}"
  data-vso-section="vso-feature-grid"
  data-section-id="{{ section_id }}"
  style="
    --vso-grid-cols: {{ settings.columns_desktop }};
    --vso-grid-cols-mobile: {{ settings.columns_mobile }};
    --vso-grid-gap: {{ settings.gap }}px;
    --vso-grid-max: {{ settings.max_width }}px;
    --vso-grid-pad-x: {{ settings.padding_x }}px;
    --vso-grid-pad-y: {{ settings.padding_y }}px;
    --vso-grid-bg: {{ settings.section_background }};
    --vso-card-bg: {{ settings.card_background }};
    --vso-grid-text: {{ settings.text_color }};
    --vso-grid-accent: {{ settings.accent_color }};
    --vso-card-radius: {{ settings.card_radius }}px;
    --vso-card-pad: {{ settings.card_padding }}px;
    --vso-icon-size: {{ settings.icon_size }}px;
    --vso-grid-heading: {{ settings.heading_size }}px;
  "
>
  <div class="vso-feature-grid__inner">
    <header class="vso-feature-grid__head">
      {% if section.settings.eyebrow != blank %}
        <p class="vso-feature-grid__eyebrow" data-vso-reveal>{{ section.settings.eyebrow }}</p>
      {% endif %}
      {% if section.settings.heading != blank %}
        <h2 class="vso-feature-grid__heading" data-vso-reveal>{{ section.settings.heading }}</h2>
      {% endif %}
      {% if section.settings.intro != blank %}
        <div class="vso-feature-grid__intro" data-vso-reveal>{{ section.settings.intro }}</div>
      {% endif %}
    </header>

    <div class="vso-feature-grid__grid">
      {% for block in section.blocks %}
        {% case block.type %}
          {% when 'feature' %}
            <article class="vso-feature-card" data-vso-block="{{ block.type }}" {{ block.shopify_attributes }} style="--vso-card-i: {{ forloop.index0 }};">
              <div class="vso-feature-card__top">
                {% if block.settings.icon != blank %}
                  <span class="vso-feature-card__icon" aria-hidden="true">{{ block.settings.icon }}</span>
                {% endif %}
                <span class="vso-feature-card__index">{{ forloop.index }}</span>
              </div>
              {% if block.settings.title != blank %}
                <h3 class="vso-feature-card__title">{{ block.settings.title }}</h3>
              {% endif %}
              {% if block.settings.description != blank %}
                <div class="vso-feature-card__description">{{ block.settings.description }}</div>
              {% endif %}
              {% if block.settings.link_label != blank %}
                <a class="vso-feature-card__link" href="{{ block.settings.link_url | default: '#' }}">
                  <span>{{ block.settings.link_label }}</span><span aria-hidden="true">→</span>
                </a>
              {% endif %}
            </article>
        {% endcase %}
      {% endfor %}
    </div>
  </div>
</div>`;

const css = String.raw`.vso-feature-grid {
  position: relative;
  color: var(--vso-grid-text);
  background: var(--vso-grid-bg);
  font-family: inherit;
}
.vso-feature-grid__inner { width: min(100%, var(--vso-grid-max)); margin-inline: auto; padding: var(--vso-grid-pad-y) var(--vso-grid-pad-x); }
.vso-feature-grid__head { max-width: 64ch; margin-bottom: 44px; }
.vso-grid-align--center .vso-feature-grid__head { margin-inline: auto; text-align: center; }
.vso-feature-grid__eyebrow { margin: 0 0 14px; color: var(--vso-grid-accent); font-size: 11px; font-weight: 700; letter-spacing: .22em; }
.vso-feature-grid__heading { margin: 0; font-size: clamp(28px, 4.4vw, var(--vso-grid-heading)); font-weight: 400; line-height: 1.05; letter-spacing: -.035em; text-wrap: balance; }
.vso-feature-grid__intro { margin-top: 18px; font-size: clamp(14px, 1.2vw, 17px); line-height: 1.65; opacity: .74; }
.vso-feature-grid__grid { display: grid; grid-template-columns: repeat(var(--vso-grid-cols), minmax(0, 1fr)); gap: var(--vso-grid-gap); }
.vso-feature-card { position: relative; display: flex; flex-direction: column; gap: 14px; padding: var(--vso-card-pad); border: 1px solid color-mix(in srgb, var(--vso-grid-text) 10%, transparent); border-radius: var(--vso-card-radius); background: var(--vso-card-bg); transition: transform .3s cubic-bezier(.2,.7,.2,1), border-color .3s ease, box-shadow .3s ease; }
.vso-grid--lift .vso-feature-card:hover { transform: translateY(-6px); border-color: color-mix(in srgb, var(--vso-grid-accent) 55%, transparent); box-shadow: 0 18px 40px -18px rgb(0 0 0 / .55); }
.vso-feature-card__top { display: flex; align-items: center; justify-content: space-between; }
.vso-feature-card__icon { display: inline-flex; color: var(--vso-grid-accent); font-size: var(--vso-icon-size); line-height: 1; }
.vso-feature-card__index { font-size: 10px; font-weight: 700; letter-spacing: .18em; opacity: 0; }
.vso-grid--indexed .vso-feature-card__index { opacity: .4; }
.vso-feature-card__title { margin: 0; font-size: 19px; font-weight: 500; letter-spacing: -.01em; }
.vso-feature-card__description { font-size: 14px; line-height: 1.6; opacity: .72; }
.vso-feature-card__link { display: inline-flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 6px; color: var(--vso-grid-accent); text-decoration: none; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.vso-feature-card__link:hover span:first-child { text-decoration: underline; }
.vso-grid-align--center .vso-feature-card { text-align: center; align-items: center; }

.vso-feature-grid [data-vso-reveal],
.vso-grid-motion--stagger .vso-feature-card,
.vso-grid-motion--fade-up .vso-feature-card { transition: opacity .7s cubic-bezier(.2,.7,.2,1), transform .7s cubic-bezier(.2,.7,.2,1), border-color .3s ease, box-shadow .3s ease; }
.vso-feature-grid:not(.is-visible) [data-vso-reveal] { opacity: 0; transform: translateY(18px); }
.vso-grid-motion--fade-up:not(.is-visible) .vso-feature-card { opacity: 0; transform: translateY(26px); }
.vso-grid-motion--stagger:not(.is-visible) .vso-feature-card { opacity: 0; transform: translateY(26px) scale(.985); }
.vso-grid-motion--stagger.is-visible .vso-feature-card { transition-delay: calc(var(--vso-card-i, 0) * 90ms); }
.vso-grid-motion--none [data-vso-reveal],
.vso-grid-motion--none .vso-feature-card { opacity: 1 !important; transform: none !important; }

@media (max-width: 749px) {
  .vso-feature-grid__inner { padding: calc(var(--vso-grid-pad-y) * .7) max(18px, calc(var(--vso-grid-pad-x) * .5)); }
  .vso-feature-grid__grid { grid-template-columns: repeat(var(--vso-grid-cols-mobile), minmax(0, 1fr)); }
}

@media (prefers-reduced-motion: reduce) {
  .vso-feature-grid *, .vso-feature-grid *::before, .vso-feature-grid *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; transition-delay: 0ms !important; }
  .vso-feature-grid [data-vso-reveal], .vso-feature-card { opacity: 1 !important; transform: none !important; }
}`;

const javascript = String.raw`(() => {
  const SELECTOR = '[data-vso-section="vso-feature-grid"]';

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
      }, { threshold: 0.15 });
      observer.observe(section);
    });
  }

  mount();
  document.addEventListener('shopify:section:load', (event) => mount(event.target));
})();`;

export function createFeatureGridManifest(state: FeatureGridState = defaultFeatureGridState): SectionManifest {
  const instanceLiquid = liquid.replace(
    'data-vso-section="vso-feature-grid"',
    `data-vso-section="${state.handle}"`,
  );
  const instanceJavascript = javascript.replace(
    '[data-vso-section="vso-feature-grid"]',
    `[data-vso-section="${state.handle}"]`,
  );
  const blocks = (state.blocks && state.blocks.length > 0 ? state.blocks : defaultFeatureGridBlocks)
    .filter((block) => block.type === 'feature')
    .map((block) => ({ type: block.type, settings: { ...block.settings } }));
  return {
    contractVersion: 1,
    name: state.name,
    handle: state.handle,
    description: 'A responsive grid of feature cards driven by repeatable blocks — icons, titles, descriptions, and optional links — with staggered reveal motion.',
    tag: 'section',
    className: `vso-shopify-wrapper vso-feature-grid-wrapper`,
    maxBlocks: 12,
    settings: [
      { type: 'header', content: 'Content' },
      { type: 'text', id: 'eyebrow', label: 'Eyebrow', default: state.eyebrow },
      { type: 'inline_richtext', id: 'heading', label: 'Heading', default: state.heading },
      { type: 'richtext', id: 'intro', label: 'Intro text', default: `<p>${state.intro}</p>` },
      { type: 'header', content: 'Layout' },
      { type: 'range', id: 'columns_desktop', label: 'Columns (desktop)', min: 2, max: 4, step: 1, default: state.columnsDesktop },
      { type: 'range', id: 'columns_mobile', label: 'Columns (mobile)', min: 1, max: 2, step: 1, default: state.columnsMobile },
      { type: 'range', id: 'gap', label: 'Card gap', min: 8, max: 64, step: 4, unit: 'px', default: state.gap },
      { type: 'range', id: 'max_width', label: 'Max content width', min: 800, max: 1600, step: 20, unit: 'px', default: state.maxWidth },
      { type: 'range', id: 'padding_x', label: 'Horizontal padding', min: 0, max: 120, step: 4, unit: 'px', default: state.paddingX },
      { type: 'range', id: 'padding_y', label: 'Vertical padding', min: 0, max: 200, step: 8, unit: 'px', default: state.paddingY },
      { type: 'select', id: 'text_alignment', label: 'Text alignment', default: state.textAlignment, options: [
        { value: 'left', label: 'Left' }, { value: 'center', label: 'Center' },
      ] },
      { type: 'header', content: 'Cards' },
      { type: 'color', id: 'section_background', label: 'Section background', default: state.sectionBackground },
      { type: 'color', id: 'card_background', label: 'Card background', default: state.cardBackground },
      { type: 'range', id: 'card_radius', label: 'Card corner radius', min: 0, max: 32, step: 2, unit: 'px', default: state.cardRadius },
      { type: 'range', id: 'card_padding', label: 'Card padding', min: 12, max: 56, step: 4, unit: 'px', default: state.cardPadding },
      { type: 'range', id: 'icon_size', label: 'Icon size', min: 16, max: 56, step: 2, unit: 'px', default: state.iconSize },
      { type: 'checkbox', id: 'show_index', label: 'Show card numbers', default: state.showIndex },
      { type: 'checkbox', id: 'hover_lift', label: 'Lift cards on hover', default: state.hoverLift },
      { type: 'header', content: 'Typography' },
      { type: 'color', id: 'text_color', label: 'Text color', default: state.textColor },
      { type: 'color', id: 'accent_color', label: 'Accent color', default: state.accentColor },
      { type: 'range', id: 'heading_size', label: 'Heading size', min: 24, max: 72, step: 2, unit: 'px', default: state.headingSize },
      { type: 'header', content: 'Motion' },
      { type: 'select', id: 'animation', label: 'Entrance animation', default: state.animation, options: [
        { value: 'none', label: 'None' }, { value: 'fade-up', label: 'Fade up' }, { value: 'stagger', label: 'Staggered cards' },
      ] },
    ],
    blocks: [{
      type: 'feature',
      name: 'Feature card',
      limit: 12,
      settings: [
        { type: 'text', id: 'icon', label: 'Icon or emoji', default: '◈', info: 'A short glyph or emoji shown above the title.' },
        { type: 'text', id: 'title', label: 'Title', default: 'Feature title' },
        { type: 'textarea', id: 'description', label: 'Description', default: 'Describe this feature in a sentence or two.' },
        { type: 'text', id: 'link_label', label: 'Link label' },
        { type: 'url', id: 'link_url', label: 'Link' },
      ],
    }],
    presets: [{
      name: state.name,
      category: 'ThemeBot',
      blocks,
    }],
    source: { liquid: instanceLiquid, css, javascript: instanceJavascript },
  };
}

/**
 * Inverse of createFeatureGridManifest. Returns null when the manifest was not
 * produced by this template (stable marker: the `vso-feature-grid` root class /
 * wrapper class), so the registry can route saved manifests to the right template.
 */
export function featureGridStateFromManifest(
  manifest: SectionManifest,
  fallback: FeatureGridState = defaultFeatureGridState,
): FeatureGridState | null {
  const liquidSource = manifest?.source?.liquid ?? '';
  const wrapper = manifest?.className ?? '';
  if (!/vso-feature-grid/.test(liquidSource) && !/vso-feature-grid-wrapper/.test(wrapper)) return null;

  const settings = Array.isArray(manifest.settings) ? manifest.settings : [];
  const get = (id: string) => settings.find((setting) => 'id' in setting && (setting as { id?: string }).id === id) as { default?: unknown } | undefined;
  const str = (id: string, fb: string) => { const value = get(id)?.default; return typeof value === 'string' ? value : fb; };
  const num = (id: string, fb: number) => { const value = get(id)?.default; return typeof value === 'number' ? value : fb; };
  const bool = (id: string, fb: boolean) => { const value = get(id)?.default; return typeof value === 'boolean' ? value : fb; };
  const intro = str('intro', `<p>${fallback.intro}</p>`).replace(/^\s*<p>/i, '').replace(/<\/p>\s*$/i, '');
  return {
    ...fallback,
    name: typeof manifest.name === 'string' ? manifest.name : fallback.name,
    handle: typeof manifest.handle === 'string' ? manifest.handle : fallback.handle,
    eyebrow: str('eyebrow', fallback.eyebrow),
    heading: str('heading', fallback.heading),
    intro,
    columnsDesktop: num('columns_desktop', fallback.columnsDesktop),
    columnsMobile: num('columns_mobile', fallback.columnsMobile),
    gap: num('gap', fallback.gap),
    maxWidth: num('max_width', fallback.maxWidth),
    paddingX: num('padding_x', fallback.paddingX),
    paddingY: num('padding_y', fallback.paddingY),
    textAlignment: str('text_alignment', fallback.textAlignment) as FeatureGridState['textAlignment'],
    sectionBackground: str('section_background', fallback.sectionBackground),
    cardBackground: str('card_background', fallback.cardBackground),
    textColor: str('text_color', fallback.textColor),
    accentColor: str('accent_color', fallback.accentColor),
    cardRadius: num('card_radius', fallback.cardRadius),
    cardPadding: num('card_padding', fallback.cardPadding),
    iconSize: num('icon_size', fallback.iconSize),
    headingSize: num('heading_size', fallback.headingSize),
    showIndex: bool('show_index', fallback.showIndex),
    hoverLift: bool('hover_lift', fallback.hoverLift),
    animation: str('animation', fallback.animation) as FeatureGridState['animation'],
    blocks: blocksFromManifest(manifest) ?? cloneBlocks(fallback.blocks),
  };
}
