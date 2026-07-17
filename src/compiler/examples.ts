import type { SectionManifest } from '../shared/types';
import { templates } from './templates';

/**
 * GOLDEN CONTRACTS — one known-good SectionManifest per registry template.
 *
 * These exist for docs, agent onboarding ("here is what a valid contract looks
 * like"), and as fixtures for tests. They are generated LIVE from the template
 * registry — each entry is `template.buildManifest(template.defaultState)` — so
 * they can never drift from the source of truth: a new template registered in
 * ./templates.ts automatically gains a golden contract, and any change to a
 * template's builder or defaults flows through on the next import.
 *
 * Every entry is expected to pass `validateManifest` with zero errors and
 * `migratedFrom: null` (they are authored at the current contract version);
 * tests should assert exactly that.
 */
export const exampleContracts: { id: string; name: string; manifest: SectionManifest }[] = templates.map(
  (template) => ({
    id: template.id,
    name: template.name,
    manifest: template.buildManifest(template.defaultState),
  }),
);
