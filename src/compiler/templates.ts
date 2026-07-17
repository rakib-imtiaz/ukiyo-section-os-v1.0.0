import type { BlockInstance, FeatureGridState, HeroBuilderState, SectionManifest } from '../shared/types';
import {
  createCinematicHeroManifest,
  defaultHeroBlocks,
  defaultHeroState,
  heroStateFromManifest,
} from './cinematicHero';
import {
  createFeatureGridManifest,
  defaultFeatureGridState,
  featureGridStateFromManifest,
} from './featureGrid';
import { cloneBlocks } from './blocks';

export type { BlockInstance } from '../shared/types';

/**
 * TEMPLATE REGISTRY — the coordination surface between the compiler and the UI.
 *
 * Each TemplateDef describes one section archetype: its builder state, the
 * declarative controls the frontend renders (grouped, typed), the repeatable
 * block types the merchant can author, and the two directions of the pipeline:
 *
 *   state --buildManifest--> SectionManifest --compileSection--> theme files
 *   SectionManifest --stateFromManifest--> state   (re-open a saved project)
 *
 * Control ids are exactly the keys of the template's state object, so a generic
 * UI can bind `state[control.id]` without per-template code. Block instances
 * live on `state.blocks` as `{ type, settings }[]`; buildManifest folds them
 * into the manifest's first preset, and stateFromManifest reads them back.
 * stateFromManifest returns null when a manifest was not produced by that
 * template (each template embeds a stable marker class in its Liquid), which is
 * what templateForManifest uses to route saved manifests.
 */

export type ControlType = 'text' | 'textarea' | 'select' | 'color' | 'range' | 'toggle' | 'url';

export interface ControlDef {
  id: string;
  label: string;
  type: ControlType;
  group: string;
  help?: string;
  options?: { label: string; value: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface TemplateDef<S = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  controls: ControlDef[];
  defaultState: S;
  buildManifest(state: S): SectionManifest;
  stateFromManifest(manifest: SectionManifest): S | null;
  blockTypes?: { type: string; name: string; fields: ControlDef[] }[];
}

/* ------------------------------------------------------------------ */
/* Cinematic Hero                                                      */
/* ------------------------------------------------------------------ */

const heroControls: ControlDef[] = [
  // Content
  { id: 'name', label: 'Section name', type: 'text', group: 'Content' },
  { id: 'handle', label: 'File handle', type: 'text', group: 'Content', help: 'Lowercase letters, numbers, and hyphens' },
  { id: 'eyebrow', label: 'Eyebrow', type: 'text', group: 'Content' },
  { id: 'heading', label: 'Heading', type: 'textarea', group: 'Content' },
  { id: 'body', label: 'Body', type: 'textarea', group: 'Content' },
  { id: 'primaryLabel', label: 'Primary label', type: 'text', group: 'Content' },
  { id: 'primaryUrl', label: 'Primary URL', type: 'url', group: 'Content' },
  { id: 'secondaryLabel', label: 'Secondary label', type: 'text', group: 'Content' },
  { id: 'secondaryUrl', label: 'Secondary URL', type: 'url', group: 'Content' },
  // Background
  { id: 'previewImageUrl', label: 'Preview image URL', type: 'url', group: 'Background', help: 'The Shopify section uses a native image picker.' },
  { id: 'backgroundType', label: 'Background type', type: 'select', group: 'Background', options: [
    { label: 'Gradient', value: 'gradient' }, { label: 'Solid color', value: 'color' },
    { label: 'Image', value: 'image' }, { label: 'Shopify video', value: 'video' },
  ] },
  { id: 'gradient', label: 'Gradient', type: 'text', group: 'Background' },
  { id: 'backgroundColor', label: 'Background', type: 'color', group: 'Background' },
  { id: 'overlayColor', label: 'Overlay', type: 'color', group: 'Background' },
  { id: 'overlayOpacity', label: 'Overlay opacity', type: 'range', group: 'Background', min: 0, max: 90, step: 1, unit: '%' },
  // Layout
  { id: 'contentPosition', label: 'Content position', type: 'select', group: 'Layout', options: [
    { label: 'Top left', value: 'top-left' }, { label: 'Top center', value: 'top-center' },
    { label: 'Center left', value: 'center-left' }, { label: 'Center', value: 'center' },
    { label: 'Bottom left', value: 'bottom-left' }, { label: 'Bottom center', value: 'bottom-center' },
  ] },
  { id: 'textAlignment', label: 'Text alignment', type: 'select', group: 'Layout', options: [
    { label: 'Left', value: 'left' }, { label: 'Center', value: 'center' }, { label: 'Right', value: 'right' },
  ] },
  { id: 'sectionHeight', label: 'Section height', type: 'range', group: 'Layout', min: 50, max: 100, step: 1, unit: 'vh' },
  { id: 'contentWidth', label: 'Content width', type: 'range', group: 'Layout', min: 360, max: 1000, step: 10, unit: 'px' },
  { id: 'paddingX', label: 'Horizontal padding', type: 'range', group: 'Layout', min: 0, max: 120, step: 4, unit: 'px' },
  { id: 'paddingY', label: 'Vertical padding', type: 'range', group: 'Layout', min: 0, max: 160, step: 4, unit: 'px' },
  // Typography
  { id: 'textColor', label: 'Text', type: 'color', group: 'Typography' },
  { id: 'accentColor', label: 'Accent', type: 'color', group: 'Typography' },
  { id: 'headingSize', label: 'Desktop heading', type: 'range', group: 'Typography', min: 36, max: 120, step: 2, unit: 'px' },
  { id: 'mobileHeadingSize', label: 'Mobile heading', type: 'range', group: 'Typography', min: 28, max: 72, step: 2, unit: 'px' },
  // Motion
  { id: 'animation', label: 'Entrance animation', type: 'select', group: 'Motion', options: [
    { label: 'None', value: 'none' }, { label: 'Fade up', value: 'fade-up' },
    { label: 'Editorial reveal', value: 'reveal' }, { label: 'Blur in', value: 'blur-in' },
  ] },
  { id: 'animationDuration', label: 'Duration', type: 'range', group: 'Motion', min: 200, max: 2000, step: 50, unit: 'ms' },
  { id: 'parallax', label: 'Subtle scroll parallax', type: 'toggle', group: 'Motion' },
];

export const cinematicHeroTemplate: TemplateDef<HeroBuilderState> = {
  id: 'cinematic-hero',
  name: 'Cinematic Hero',
  description: 'A premium full-bleed hero with editable content, media, overlay, layout, mobile typography, calls to action, statistics, and motion.',
  controls: heroControls,
  defaultState: { ...defaultHeroState, blocks: cloneBlocks(defaultHeroBlocks) },
  buildManifest: (state) => createCinematicHeroManifest(state),
  stateFromManifest: (manifest) => {
    // Stable marker: the hero's root class / wrapper class survive handle renames.
    const liquidSource = manifest?.source?.liquid ?? '';
    const wrapper = manifest?.className ?? '';
    if (!/vso-cinematic-hero/.test(liquidSource) && !/vso-cinematic-hero-wrapper/.test(wrapper)) return null;
    return heroStateFromManifest(manifest, defaultHeroState);
  },
  blockTypes: [{
    type: 'stat',
    name: 'Statistic',
    fields: [
      { id: 'value', label: 'Value', type: 'text', group: 'Block' },
      { id: 'label', label: 'Label', type: 'text', group: 'Block' },
    ],
  }],
};

/* ------------------------------------------------------------------ */
/* Feature Grid                                                        */
/* ------------------------------------------------------------------ */

const featureGridControls: ControlDef[] = [
  // Content
  { id: 'name', label: 'Section name', type: 'text', group: 'Content' },
  { id: 'handle', label: 'File handle', type: 'text', group: 'Content', help: 'Lowercase letters, numbers, and hyphens' },
  { id: 'eyebrow', label: 'Eyebrow', type: 'text', group: 'Content' },
  { id: 'heading', label: 'Heading', type: 'textarea', group: 'Content' },
  { id: 'intro', label: 'Intro text', type: 'textarea', group: 'Content' },
  // Layout
  { id: 'columnsDesktop', label: 'Columns (desktop)', type: 'range', group: 'Layout', min: 2, max: 4, step: 1 },
  { id: 'columnsMobile', label: 'Columns (mobile)', type: 'range', group: 'Layout', min: 1, max: 2, step: 1 },
  { id: 'gap', label: 'Card gap', type: 'range', group: 'Layout', min: 8, max: 64, step: 4, unit: 'px' },
  { id: 'maxWidth', label: 'Max content width', type: 'range', group: 'Layout', min: 800, max: 1600, step: 20, unit: 'px' },
  { id: 'paddingX', label: 'Horizontal padding', type: 'range', group: 'Layout', min: 0, max: 120, step: 4, unit: 'px' },
  { id: 'paddingY', label: 'Vertical padding', type: 'range', group: 'Layout', min: 0, max: 200, step: 8, unit: 'px' },
  { id: 'textAlignment', label: 'Text alignment', type: 'select', group: 'Layout', options: [
    { label: 'Left', value: 'left' }, { label: 'Center', value: 'center' },
  ] },
  // Cards
  { id: 'sectionBackground', label: 'Section background', type: 'color', group: 'Cards' },
  { id: 'cardBackground', label: 'Card background', type: 'color', group: 'Cards' },
  { id: 'cardRadius', label: 'Card corner radius', type: 'range', group: 'Cards', min: 0, max: 32, step: 2, unit: 'px' },
  { id: 'cardPadding', label: 'Card padding', type: 'range', group: 'Cards', min: 12, max: 56, step: 4, unit: 'px' },
  { id: 'iconSize', label: 'Icon size', type: 'range', group: 'Cards', min: 16, max: 56, step: 2, unit: 'px' },
  { id: 'showIndex', label: 'Show card numbers', type: 'toggle', group: 'Cards' },
  { id: 'hoverLift', label: 'Lift cards on hover', type: 'toggle', group: 'Cards' },
  // Typography
  { id: 'textColor', label: 'Text', type: 'color', group: 'Typography' },
  { id: 'accentColor', label: 'Accent', type: 'color', group: 'Typography' },
  { id: 'headingSize', label: 'Heading size', type: 'range', group: 'Typography', min: 24, max: 72, step: 2, unit: 'px' },
  // Motion
  { id: 'animation', label: 'Entrance animation', type: 'select', group: 'Motion', options: [
    { label: 'None', value: 'none' }, { label: 'Fade up', value: 'fade-up' }, { label: 'Staggered cards', value: 'stagger' },
  ] },
];

export const featureGridTemplate: TemplateDef<FeatureGridState> = {
  id: 'feature-grid',
  name: 'Feature Grid',
  description: 'A responsive grid of feature cards driven by repeatable blocks — icons, titles, descriptions, and optional links — with staggered reveal motion.',
  controls: featureGridControls,
  defaultState: defaultFeatureGridState,
  buildManifest: (state) => createFeatureGridManifest(state),
  stateFromManifest: (manifest) => featureGridStateFromManifest(manifest, defaultFeatureGridState),
  blockTypes: [{
    type: 'feature',
    name: 'Feature card',
    fields: [
      { id: 'icon', label: 'Icon or emoji', type: 'text', group: 'Block', help: 'A short glyph or emoji shown above the title.' },
      { id: 'title', label: 'Title', type: 'text', group: 'Block' },
      { id: 'description', label: 'Description', type: 'textarea', group: 'Block' },
      { id: 'link_label', label: 'Link label', type: 'text', group: 'Block' },
      { id: 'link_url', label: 'Link', type: 'url', group: 'Block' },
    ],
  }],
};

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const templates: TemplateDef[] = [
  cinematicHeroTemplate,
  featureGridTemplate,
];

export function getTemplate(id: string): TemplateDef | undefined {
  return templates.find((template) => template.id === id);
}

/**
 * Route a saved manifest back to the template that authored it. Each template's
 * stateFromManifest checks a stable marker (its root class in source.liquid or
 * its wrapper className — both survive handle renames) and returns null on a
 * miss, so the first template that successfully hydrates wins. Manifests pasted
 * from external agents that match no template return undefined; the caller
 * should treat those as raw-contract projects.
 */
export function templateForManifest(manifest: SectionManifest): TemplateDef | undefined {
  return templates.find((template) => template.stateFromManifest(manifest) !== null);
}
