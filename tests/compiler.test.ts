import { describe, expect, it } from 'vitest';
import { compileSection } from '../src/compiler/compile';
import { createCinematicHeroManifest, defaultHeroState } from '../src/compiler/cinematicHero';

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
