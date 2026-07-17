import { describe, expect, it } from 'vitest';
import { createCinematicHeroManifest } from '../src/compiler/cinematicHero';
import { compileSection } from '../src/compiler/compile';
import { db } from '../server/db';
import { encrypt, sha256 } from '../server/security';

describe('project and deployment repository', () => {
  it('persists a store, project, immutable version, API key, and deployment ledger entry', async () => {
    const suffix = Math.random().toString(36).slice(2, 9);
    const shop = await db.upsertShop({
      shop_domain: `test-${suffix}.myshopify.com`, access_token_cipher: encrypt('token'), refresh_token_cipher: null,
      token_expires_at: null, refresh_token_expires_at: null, scopes: 'read_themes,write_themes',
    });
    const manifest = createCinematicHeroManifest({ ...createCinematicHeroManifestDefaults(), handle: `test-${suffix}` });
    const compiled = compileSection(manifest);
    const project = await db.createProject(shop.id, manifest);
    const version = await db.createVersion(project.id, manifest, compiled.files, sha256(JSON.stringify(manifest)));
    const key = await db.createApiKey(shop.id, 'Test key', suffix, sha256(`key-${suffix}`));
    const deployment = await db.createDeployment({ shop_id: shop.id, project_id: project.id, version_id: version.id, theme_id: 'gid://shopify/OnlineStoreTheme/1', theme_name: 'Draft', status: 'installing', snapshot: [], installed_files: [] });
    await db.finishDeployment(deployment.id, 'succeeded', compiled.files.map((file) => file.path));

    expect((await db.listProjects(shop.id))[0].id).toBe(project.id);
    expect((await db.listVersions(project.id))[0].version_number).toBe(1);
    expect((await db.findApiKey(key.secret_hash))?.id).toBe(key.id);
    expect((await db.listDeployments(shop.id))[0].status).toBe('succeeded');
  });
});

function createCinematicHeroManifestDefaults() {
  return {
    name: 'Cinematic Product Hero', handle: 'vso-cinematic-product-hero', eyebrow: 'NEW', heading: 'Designed to move.', body: 'Modular by default.',
    primaryLabel: 'Explore', primaryUrl: '/collections/all', secondaryLabel: 'Story', secondaryUrl: '/pages/about', backgroundType: 'gradient' as const,
    backgroundColor: '#171816', gradient: 'linear-gradient(135deg,#191a17,#111210)', previewImageUrl: '', overlayColor: '#050505', overlayOpacity: 32,
    textColor: '#f4f0e8', accentColor: '#c8a96b', contentPosition: 'bottom-left' as const, textAlignment: 'left' as const, sectionHeight: 86,
    contentWidth: 760, headingSize: 76, mobileHeadingSize: 44, paddingX: 56, paddingY: 56, animation: 'reveal' as const, animationDuration: 900, parallax: true,
  };
}
