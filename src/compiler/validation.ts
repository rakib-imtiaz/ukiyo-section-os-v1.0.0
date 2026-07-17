import { z } from 'zod';
import { migrateContract } from './migrate';
import { SETTING_TYPES } from '../shared/types';
import type {
  BlockDefinition,
  EditorEntry,
  SectionManifest,
  SectionPreset,
  SettingDefinition,
  ValidationIssue,
} from '../shared/types';

const idPattern = /^[a-z][a-z0-9_]*$/;
const handlePattern = /^[a-z0-9][a-z0-9-]*$/;

// Shopify allows at most 50 dynamic blocks per section.
const SHOPIFY_MAX_BLOCKS = 50;

/**
 * Deep zod schemas for the SectionManifest "design contract".
 *
 * These replace the previous `z.array(z.unknown())` placeholders so the structure
 * of every setting, block, and preset is checked before compilation — and so the
 * same schema can be exported as JSON Schema (see ./schema.ts) for downstream
 * consumers (the CORE backend serves it at GET /v1/schema).
 *
 * Structural facts (type ∈ union, label required, option/accept shape, preset
 * shape) are enforced here. Cross-cutting rules that need friendlier, path-anchored
 * messages (id uniqueness, preset→block references, range bounds, visible_if
 * targets) are folded into the hand-rolled passes below so a single manifest can
 * surface every actionable problem at once.
 */

// Every value in SETTING_TYPES is a valid native Shopify input setting type, so a
// `type` that passes this enum is guaranteed Shopify-valid.
const settingTypeEnum = z.enum(SETTING_TYPES as unknown as [string, ...string[]]);

const settingOptionSchema = z.object({
  value: z.string(),
  label: z.string().min(1, 'Select options require a label.'),
});

const defaultValueSchema = z.union([z.string(), z.number(), z.boolean()]);

// Sidebar-only entries (labels/instructions that render no input).
const sidebarEntrySchema = z
  .object({
    type: z.enum(['header', 'paragraph']),
    content: z.string().min(1, 'Sidebar header/paragraph entries require content.'),
    visible_if: z.string().min(1).optional(),
  })
  .passthrough();

// A real, editable setting.
const settingEntrySchema = z
  .object({
    type: settingTypeEnum,
    id: z.string().min(1, 'Settings require an id.'),
    label: z.string().min(1, 'Settings require a label.'),
    default: defaultValueSchema.optional(),
    info: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    unit: z.string().optional(),
    options: z.array(settingOptionSchema).optional(),
    accept: z.array(z.enum(['youtube', 'vimeo'])).optional(),
    visible_if: z.string().min(1).optional(),
  })
  .passthrough();

// Header/paragraph are disjoint from real setting types, so a plain union
// resolves cleanly: sidebar entries never satisfy settingEntrySchema (no id) and
// vice versa. The hand-rolled passes add the crisp per-field messaging.
const editorEntrySchema = z.union([sidebarEntrySchema, settingEntrySchema]);

const blockSchema = z
  .object({
    type: z.string().min(1, 'Blocks require a type.'),
    name: z.string().min(1, 'Blocks require a name.'),
    limit: z.number().int().positive().optional(),
    settings: z.array(editorEntrySchema),
  })
  .passthrough();

const presetBlockSchema = z
  .object({
    type: z.string().min(1, 'Preset blocks require a type.'),
    settings: z.record(defaultValueSchema).optional(),
  })
  .passthrough();

const presetSchema = z
  .object({
    name: z.string().min(1, 'Presets require a name.'),
    category: z.string().optional(),
    settings: z.record(defaultValueSchema).optional(),
    blocks: z.array(presetBlockSchema).optional(),
  })
  .passthrough();

/**
 * The full, deep contract schema. Exported so ./schema.ts can convert it to JSON
 * Schema without re-declaring anything.
 */
export const manifestSchema = z.object({
  contractVersion: z.literal(1),
  name: z.string().min(1).max(50),
  handle: z.string().regex(handlePattern, 'Handles must be lowercase, digits, and dashes.'),
  description: z.string().max(500),
  tag: z.enum(['section', 'div', 'aside', 'header', 'footer']).optional(),
  className: z.string().max(100).optional(),
  limit: z.union([z.literal(1), z.literal(2)]).optional(),
  maxBlocks: z.number().int().min(1).max(SHOPIFY_MAX_BLOCKS).optional(),
  enabledTemplates: z.array(z.string()).optional(),
  settings: z.array(editorEntrySchema),
  blocks: z.array(blockSchema),
  presets: z.array(presetSchema).min(1),
  source: z.object({
    liquid: z.string().min(1),
    css: z.string(),
    javascript: z.string().optional(),
  }),
});

function isSetting(entry: EditorEntry): entry is SettingDefinition {
  return entry.type !== 'header' && entry.type !== 'paragraph';
}

// A visible_if expression should reference a real setting so the editor toggle works.
// We accept `section.settings.<id>` and `block.settings.<id>` (and the bare
// `settings.<id>` alias the compiler normalizes). Returns the referenced ids.
function visibleIfReferences(expression: string): string[] {
  return [...expression.matchAll(/(?:section\.|block\.)?settings\.([a-zA-Z0-9_]+)/g)].map((m) => m[1]);
}

function validateVisibleIf(
  entry: EditorEntry,
  itemPath: string,
  knownIds: Set<string>,
  issues: ValidationIssue[],
) {
  const raw = (entry as { visible_if?: unknown }).visible_if;
  if (raw === undefined) return;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    issues.push({ severity: 'error', path: `${itemPath}.visible_if`, message: 'visible_if must be a non-empty Liquid expression string.' });
    return;
  }
  const references = visibleIfReferences(raw);
  if (references.length === 0) {
    issues.push({ severity: 'warning', path: `${itemPath}.visible_if`, message: 'visible_if should reference a setting, e.g. "{{ section.settings.enable_x }}".' });
    return;
  }
  references.forEach((reference) => {
    if (!knownIds.has(reference)) {
      issues.push({ severity: 'warning', path: `${itemPath}.visible_if`, message: `visible_if references settings.${reference}, which is not declared in this scope.` });
    }
  });
}

function validateEntries(
  entries: EditorEntry[],
  path: string,
  issues: ValidationIssue[],
  visibilityScope: Set<string>,
) {
  const ids = new Set<string>();
  entries.forEach((entry, index) => {
    // Dot notation (`settings.3`, not `settings[3]`) so every emitted path is
    // machine-usable by locateIssue (./inspect.ts) and matches zod's join('.').
    const itemPath = `${path}.${index}`;
    validateVisibleIf(entry, itemPath, visibilityScope, issues);
    if (!isSetting(entry)) return;
    if (!idPattern.test(entry.id)) {
      issues.push({ severity: 'error', path: `${itemPath}.id`, message: 'Setting IDs must use snake_case and begin with a letter.' });
    }
    if (ids.has(entry.id)) {
      issues.push({ severity: 'error', path: `${itemPath}.id`, message: `Duplicate setting ID: ${entry.id}.` });
    }
    ids.add(entry.id);

    // Setting `type` is already constrained to a Shopify-valid value by the zod
    // enum; these checks add the per-type structural rules Shopify requires.
    if (entry.type === 'range') {
      if (typeof entry.min !== 'number' || typeof entry.max !== 'number' || typeof entry.step !== 'number') {
        issues.push({ severity: 'error', path: itemPath, message: 'Range settings require numeric min, max, and step values.' });
      }
      if (typeof entry.default !== 'number') {
        issues.push({ severity: 'error', path: `${itemPath}.default`, message: 'Range defaults must be numbers.' });
      }
      if (typeof entry.default === 'number' && typeof entry.min === 'number' && typeof entry.max === 'number' && (entry.default < entry.min || entry.default > entry.max)) {
        issues.push({ severity: 'error', path: `${itemPath}.default`, message: 'Range default must fall between min and max.' });
      }
      if (typeof entry.min === 'number' && typeof entry.max === 'number' && entry.min >= entry.max) {
        issues.push({ severity: 'error', path: itemPath, message: 'Range min must be less than max.' });
      }
    }

    if (entry.type === 'select' && (!entry.options || entry.options.length < 1)) {
      issues.push({ severity: 'error', path: `${itemPath}.options`, message: 'Select settings require at least one option.' });
    }

    if (entry.type === 'video_url' && (!entry.accept || entry.accept.length < 1)) {
      issues.push({ severity: 'error', path: `${itemPath}.accept`, message: 'Video URL settings must accept YouTube, Vimeo, or both.' });
    }
  });
}

function collectSettingIds(entries: EditorEntry[]): Set<string> {
  return new Set(entries.filter(isSetting).map((entry) => (entry as SettingDefinition).id));
}

function validateBlocks(blocks: BlockDefinition[], sectionSettingIds: Set<string>, issues: ValidationIssue[]) {
  const types = new Set<string>();
  blocks.forEach((block, index) => {
    if (!idPattern.test(block.type)) {
      issues.push({ severity: 'error', path: `blocks.${index}.type`, message: 'Block types must use snake_case.' });
    }
    if (types.has(block.type)) {
      issues.push({ severity: 'error', path: `blocks.${index}.type`, message: `Duplicate block type: ${block.type}.` });
    }
    types.add(block.type);
    // Within a block, visible_if may target the block's own settings; fall back to
    // section settings for shared toggles.
    const scope = new Set<string>([...sectionSettingIds, ...collectSettingIds(block.settings)]);
    validateEntries(block.settings, `blocks.${index}.settings`, issues, scope);
    if (typeof block.limit === 'number' && block.limit > SHOPIFY_MAX_BLOCKS) {
      issues.push({ severity: 'error', path: `blocks.${index}.limit`, message: `Block limit may not exceed ${SHOPIFY_MAX_BLOCKS}.` });
    }
  });
}

function validatePresets(
  presets: SectionPreset[],
  blocks: BlockDefinition[],
  sectionSettingIds: Set<string>,
  issues: ValidationIssue[],
) {
  const declaredBlockTypes = new Set(blocks.map((block) => block.type));
  const blockSettingIds = new Map<string, Set<string>>();
  blocks.forEach((block) => blockSettingIds.set(block.type, collectSettingIds(block.settings)));

  presets.forEach((preset, index) => {
    const presetPath = `presets.${index}`;
    (preset.settings ? Object.keys(preset.settings) : []).forEach((key) => {
      if (!sectionSettingIds.has(key)) {
        issues.push({ severity: 'warning', path: `${presetPath}.settings.${key}`, message: `Preset sets "${key}", which is not a declared section setting.` });
      }
    });
    (preset.blocks ?? []).forEach((presetBlock, blockIndex) => {
      const blockPath = `${presetPath}.blocks.${blockIndex}`;
      if (!declaredBlockTypes.has(presetBlock.type)) {
        issues.push({ severity: 'error', path: `${blockPath}.type`, message: `Preset block references undeclared block type "${presetBlock.type}".` });
        return;
      }
      const allowed = blockSettingIds.get(presetBlock.type) ?? new Set<string>();
      Object.keys(presetBlock.settings ?? {}).forEach((key) => {
        if (!allowed.has(key)) {
          issues.push({ severity: 'warning', path: `${blockPath}.settings.${key}`, message: `Preset block "${presetBlock.type}" sets "${key}", which is not a declared block setting.` });
        }
      });
    });
  });
}

/**
 * Validate a design contract.
 *
 * Runs `migrateContract` (./migrate.ts) FIRST, so versionless or older-version
 * manifests are upgraded to the current contract before any checks run — the
 * returned `manifest` is the upgraded document. `migratedFrom` reports the
 * version the input arrived at (0 = versionless) so callers can show
 * "upgraded from vX"; it is null when no migration was needed. Current-version
 * manifests pass through migration by reference, byte-identical.
 *
 * Every issue carries a machine-usable dot-notation `path` (e.g.
 * `settings.3.type`, `blocks.0.settings.1.id`) that `locateIssue`
 * (./inspect.ts) can resolve to a line/column in the raw JSON text. Root-level
 * issues use the sentinel path `manifest`, which locateIssue maps to the start
 * of the document.
 */
export function validateManifest(input: unknown): {
  manifest?: SectionManifest;
  issues: ValidationIssue[];
  migratedFrom: number | null;
} {
  const { manifest: migrated, migratedFrom } = migrateContract(input);
  const issues: ValidationIssue[] = [];
  const parsed = manifestSchema.safeParse(migrated);
  if (!parsed.success) {
    parsed.error.issues.forEach((issue) => {
      issues.push({ severity: 'error', path: issue.path.join('.') || 'manifest', message: issue.message });
    });
  }

  // Best-effort deep checks: run even when the zod pass failed so a broken manifest
  // surfaces every actionable problem at once. Each access is guarded because the
  // shape is not yet trusted.
  const candidate = (migrated && typeof migrated === 'object' ? migrated : {}) as Partial<SectionManifest>;
  const sectionSettings = Array.isArray(candidate.settings) ? (candidate.settings as EditorEntry[]) : [];
  const blocks = Array.isArray(candidate.blocks) ? (candidate.blocks as BlockDefinition[]) : [];
  const presets = Array.isArray(candidate.presets) ? (candidate.presets as SectionPreset[]) : [];
  const sectionSettingIds = collectSettingIds(sectionSettings);

  validateEntries(sectionSettings, 'settings', issues, sectionSettingIds);
  validateBlocks(blocks, sectionSettingIds, issues);
  validatePresets(presets, blocks, sectionSettingIds, issues);

  if (typeof candidate.maxBlocks === 'number' && candidate.maxBlocks > SHOPIFY_MAX_BLOCKS) {
    issues.push({ severity: 'error', path: 'maxBlocks', message: `Shopify permits at most ${SHOPIFY_MAX_BLOCKS} dynamic blocks per section.` });
  }

  const source = (candidate.source ?? {}) as Partial<SectionManifest['source']>;
  if (typeof source.liquid === 'string') {
    const liquidReferences = [...source.liquid.matchAll(/(?<![a-zA-Z0-9_.])settings\.([a-zA-Z0-9_]+)/g)].map((match) => match[1]);
    liquidReferences.forEach((reference) => {
      if (!sectionSettingIds.has(reference)) {
        issues.push({ severity: 'warning', path: 'source.liquid', message: `Liquid references settings.${reference}, but no matching section setting exists.` });
      }
    });
    if (/<script\b/i.test(source.liquid)) {
      issues.push({ severity: 'warning', path: 'source.liquid', message: 'Move inline scripts into source.javascript so they can be shared and loaded with defer.' });
    }
  }
  if (/\beval\s*\(/.test(source.javascript ?? '')) {
    issues.push({ severity: 'error', path: 'source.javascript', message: 'eval() is not allowed in generated section code.' });
  }
  if (typeof source.css === 'string' && !/prefers-reduced-motion/.test(source.css) && source.javascript) {
    issues.push({ severity: 'warning', path: 'source.css', message: 'Animated sections should include a prefers-reduced-motion fallback.' });
  }

  if (!parsed.success) {
    return { issues, migratedFrom };
  }
  return { manifest: migrated as SectionManifest, issues, migratedFrom };
}
