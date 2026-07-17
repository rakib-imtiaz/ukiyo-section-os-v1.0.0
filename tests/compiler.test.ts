import { describe, expect, it } from 'vitest';
import { compileSection } from '../src/compiler/compile';
import { createCinematicHeroManifest, defaultHeroState } from '../src/compiler/cinematicHero';
import { migrateContract } from '../src/compiler/migrate';
import { locateIssue } from '../src/compiler/inspect';
import { exampleContracts } from '../src/compiler/examples';
import { validateManifest } from '../src/compiler/validation';

function extractSchema(liquid: string) {
  const match = liquid.match(/\{% schema %\}\n([\s\S]*?)\n\{% endschema %\}/);
  if (!match) throw new Error('Generated section has no schema.');
  return JSON.parse(match[1]);
}

describe('Section OS compiler', () => {
  it('generates a complete native Shopify section package', () => {
    const result = compileSection(createCinematicHeroManifest());
    expect(result.valid).toBe(true);
    expect(result.files.map((file) => file.path)).toEqual([
      'sections/vso-cinematic-product-hero.liquid',
      'assets/vso-cinematic-product-hero.css',
      'assets/vso-cinematic-product-hero.js',
      'section-os.manifest.json',
      'README.md',
    ]);
    expect(result.stats.settings).toBeGreaterThanOrEqual(25);
    expect(result.stats.blockTypes).toBe(1);
  });

  it('emits valid JSON schema and converts setting aliases to native Liquid', () => {
    const result = compileSection(createCinematicHeroManifest());
    const section = result.files.find((file) => file.language === 'liquid');
    expect(section).toBeDefined();
    expect(section!.content).toContain('{{ section.settings.eyebrow }}');
    expect(section!.content).not.toContain('{{ settings.eyebrow }}');
    const schema = extractSchema(section!.content);
    expect(schema.name).toBe('Cinematic Product Hero');
    expect(schema.presets[0].category).toBe('ThemeBot');
    expect(schema.blocks[0].type).toBe('stat');
  });

  it('namespaces runtime selectors when the merchant changes the handle', () => {
    const manifest = createCinematicHeroManifest({
      ...defaultHeroState,
      handle: 'ukiyo-luxe-hero',
    });
    const result = compileSection(manifest);
    expect(result.files[0].path).toBe('sections/ukiyo-luxe-hero.liquid');
    expect(result.files[0].content).toContain('data-vso-section="ukiyo-luxe-hero"');
    expect(result.files.find((file) => file.language === 'javascript')!.content).toContain('[data-vso-section="ukiyo-luxe-hero"]');
  });

  it('rejects invalid handles and unsafe JavaScript', () => {
    const invalid = createCinematicHeroManifest();
    invalid.handle = 'Not Valid';
    invalid.source.javascript = 'eval("bad")';
    const result = compileSection(invalid);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.path === 'handle')).toBe(true);
  });
});

describe('contract migration', () => {
  it('returns v1 manifests untouched (same reference, no migration)', () => {
    const manifest = createCinematicHeroManifest();
    const { manifest: out, migratedFrom } = migrateContract(manifest);
    expect(out).toBe(manifest);
    expect(migratedFrom).toBeNull();
  });

  it('upgrades a versionless manifest to v1 without mutating the input', () => {
    const manifest = createCinematicHeroManifest();
    const versionless: Record<string, unknown> = { ...manifest };
    delete versionless.contractVersion;
    const { manifest: out, migratedFrom } = migrateContract(versionless);
    expect(migratedFrom).toBe(0);
    expect((out as { contractVersion: number }).contractVersion).toBe(1);
    expect('contractVersion' in versionless).toBe(false);
    // compiling the RAW versionless input reports the upgrade; the migrated copy is already v1
    const compiled = compileSection(versionless);
    expect(compiled.valid).toBe(true);
    expect(compiled.migratedFrom).toBe(0);
    expect(compileSection(out).migratedFrom).toBeNull();
  });
});

describe('issue location (locateIssue)', () => {
  const json = JSON.stringify(createCinematicHeroManifest(), null, 2);

  it('locates top-level keys, nested setting paths, and block types', () => {
    // settings[0] is a header entry (no id) — use a real setting's id plus other shapes
    const manifest = createCinematicHeroManifest();
    const settingIndex = manifest.settings.findIndex((entry) => 'id' in entry && (entry as { id?: string }).id);
    expect(settingIndex).toBeGreaterThanOrEqual(0);
    for (const path of ['handle', `settings.${settingIndex}.id`, 'blocks.0.type']) {
      const hit = locateIssue(json, path);
      expect(hit, path).not.toBeNull();
      expect(hit!.line, path).toBeGreaterThan(1);
    }
  });

  it('returns null for missing keys and malformed JSON', () => {
    expect(locateIssue(json, 'settings.9999.id')).toBeNull();
    expect(locateIssue('{ not json', 'settings.0.id')).toBeNull();
  });

  it('every validation issue path from a broken manifest is locatable', () => {
    const broken = createCinematicHeroManifest();
    broken.handle = 'Not Valid';
    (broken.settings[3] as { id: string }).id = 'Bad Id';
    const { issues } = validateManifest(broken);
    const text = JSON.stringify(broken, null, 2);
    for (const issue of issues.filter((entry) => entry.path && entry.path !== 'manifest')) {
      expect(issue.path).toMatch(/^[a-zA-Z0-9_.]+$/);
      expect(locateIssue(text, issue.path)).not.toBeNull();
    }
  });
});

describe('golden example contracts', () => {
  it('ships one valid contract per registry template', () => {
    expect(exampleContracts.length).toBeGreaterThanOrEqual(2);
    const ids = exampleContracts.map((entry) => entry.id);
    expect(ids).toContain('cinematic-hero');
    expect(ids).toContain('feature-grid');
    for (const entry of exampleContracts) {
      const result = compileSection(entry.manifest);
      expect(result.valid, `${entry.id} should compile`).toBe(true);
      expect(result.migratedFrom).toBeNull();
    }
  });
});
