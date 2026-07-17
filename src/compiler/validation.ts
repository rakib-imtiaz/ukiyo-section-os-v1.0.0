import { z } from 'zod';
import type {
  BlockDefinition,
  EditorEntry,
  SectionManifest,
  SettingDefinition,
  ValidationIssue,
} from '../shared/types';

const idPattern = /^[a-z][a-z0-9_]*$/;
const handlePattern = /^[a-z0-9][a-z0-9-]*$/;

const manifestBaseSchema = z.object({
  contractVersion: z.literal(1),
  name: z.string().min(1).max(50),
  handle: z.string().regex(handlePattern),
  description: z.string().max(500),
  tag: z.enum(['section', 'div', 'aside', 'header', 'footer']).optional(),
  className: z.string().max(100).optional(),
  limit: z.union([z.literal(1), z.literal(2)]).optional(),
  maxBlocks: z.number().int().min(1).max(50).optional(),
  enabledTemplates: z.array(z.string()).optional(),
  settings: z.array(z.unknown()),
  blocks: z.array(z.unknown()),
  presets: z.array(z.unknown()).min(1),
  source: z.object({
    liquid: z.string().min(1),
    css: z.string(),
    javascript: z.string().optional(),
  }),
});

function isSetting(entry: EditorEntry): entry is SettingDefinition {
  return entry.type !== 'header' && entry.type !== 'paragraph';
}

function validateEntries(entries: EditorEntry[], path: string, issues: ValidationIssue[]) {
  const ids = new Set<string>();
  entries.forEach((entry, index) => {
    if (!isSetting(entry)) return;
    const itemPath = `${path}[${index}]`;
    if (!idPattern.test(entry.id)) {
      issues.push({ severity: 'error', path: `${itemPath}.id`, message: 'Setting IDs must use snake_case and begin with a letter.' });
    }
    if (ids.has(entry.id)) {
      issues.push({ severity: 'error', path: `${itemPath}.id`, message: `Duplicate setting ID: ${entry.id}.` });
    }
    ids.add(entry.id);

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
    }

    if (entry.type === 'select' && (!entry.options || entry.options.length < 1)) {
      issues.push({ severity: 'error', path: `${itemPath}.options`, message: 'Select settings require at least one option.' });
    }

    if (entry.type === 'video_url' && (!entry.accept || entry.accept.length < 1)) {
      issues.push({ severity: 'error', path: `${itemPath}.accept`, message: 'Video URL settings must accept YouTube, Vimeo, or both.' });
    }
  });
}

function validateBlocks(blocks: BlockDefinition[], issues: ValidationIssue[]) {
  const types = new Set<string>();
  blocks.forEach((block, index) => {
    if (!idPattern.test(block.type)) {
      issues.push({ severity: 'error', path: `blocks[${index}].type`, message: 'Block types must use snake_case.' });
    }
    if (types.has(block.type)) {
      issues.push({ severity: 'error', path: `blocks[${index}].type`, message: `Duplicate block type: ${block.type}.` });
    }
    types.add(block.type);
    validateEntries(block.settings, `blocks[${index}].settings`, issues);
  });
}

export function validateManifest(input: unknown): { manifest?: SectionManifest; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const parsed = manifestBaseSchema.safeParse(input);
  if (!parsed.success) {
    parsed.error.issues.forEach((issue) => {
      issues.push({ severity: 'error', path: issue.path.join('.') || 'manifest', message: issue.message });
    });
    return { issues };
  }

  const manifest = input as SectionManifest;
  validateEntries(manifest.settings, 'settings', issues);
  validateBlocks(manifest.blocks, issues);

  if (manifest.maxBlocks && manifest.maxBlocks > 50) {
    issues.push({ severity: 'error', path: 'maxBlocks', message: 'Shopify permits at most 50 dynamic blocks per section.' });
  }

  const liquidReferences = [...manifest.source.liquid.matchAll(/(?<![a-zA-Z0-9_.])settings\.([a-zA-Z0-9_]+)/g)].map((match) => match[1]);
  const settingIds = new Set(manifest.settings.filter(isSetting).map((setting) => setting.id));
  liquidReferences.forEach((reference) => {
    if (!settingIds.has(reference)) {
      issues.push({ severity: 'warning', path: 'source.liquid', message: `Liquid references settings.${reference}, but no matching section setting exists.` });
    }
  });

  if (/<script\b/i.test(manifest.source.liquid)) {
    issues.push({ severity: 'warning', path: 'source.liquid', message: 'Move inline scripts into source.javascript so they can be shared and loaded with defer.' });
  }
  if (/\beval\s*\(/.test(manifest.source.javascript ?? '')) {
    issues.push({ severity: 'error', path: 'source.javascript', message: 'eval() is not allowed in generated section code.' });
  }
  if (!/prefers-reduced-motion/.test(manifest.source.css) && manifest.source.javascript) {
    issues.push({ severity: 'warning', path: 'source.css', message: 'Animated sections should include a prefers-reduced-motion fallback.' });
  }

  return { manifest, issues };
}
