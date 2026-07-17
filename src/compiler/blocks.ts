import type { BlockInstance, SectionManifest } from '../shared/types';

/**
 * Recover authored block instances from a manifest's first preset. Template
 * builders write the builder's block instances into `presets[0].blocks`, so the
 * round trip is: state.blocks → buildManifest → presets[0].blocks →
 * stateFromManifest → state.blocks.
 *
 * Returns null when the manifest carries no preset blocks so callers can fall
 * back to their template defaults.
 */
export function blocksFromManifest(manifest: SectionManifest): BlockInstance[] | null {
  const presetBlocks = manifest.presets?.[0]?.blocks;
  if (!Array.isArray(presetBlocks) || presetBlocks.length === 0) return null;
  return presetBlocks.map((block) => ({ type: block.type, settings: { ...(block.settings ?? {}) } }));
}

/** Deep-copy a block instance list so state mutations never leak into shared defaults. */
export function cloneBlocks(blocks: BlockInstance[]): BlockInstance[] {
  return blocks.map((block) => ({ type: block.type, settings: { ...block.settings } }));
}
