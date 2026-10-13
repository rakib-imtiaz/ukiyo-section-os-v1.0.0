import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { derivePrefix, scaffoldWorkspace, slugify } from '../server/factory/scaffolder';
import type { FactoryJobRecord } from '../server/db';

const exists = (target: string) => access(target).then(() => true, () => false);

let root: string;
let reactSource: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'factory-scaffold-'));
  reactSource = path.join(root, 'react-src');
  await mkdir(path.join(reactSource, 'src'), { recursive: true });
  await writeFile(path.join(reactSource, 'package.json'), '{"name":"demo"}');
  await writeFile(path.join(reactSource, 'src', 'App.tsx'), 'export default () => null;');
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function job(workspace: string): FactoryJobRecord {
  return {
    id: 'job-1', name: 'Wild & Sacred', slug: 'wild_sacred', workspace_path: workspace,
    react_url: 'https://wild-sacred.example.com', store_url: 'https://wild-sacred.myshopify.com',
    client_id_cipher: 'x', client_secret_cipher: 'x', storefront_password_cipher: null,
    prefix: 'ws', dev_theme_name: 'Wild & Sacred Clone (dev)', autoswap: false, auto_qa: true, qa_mode: 'both', qa_engine: 'playwright',
    status: 'queued', status_detail: null, iteration: 0, max_iterations: 5, score_threshold: 0.92,
    last_score: null, score_history: [], error: null, created_at: '', updated_at: '', started_at: null, finished_at: null,
    best_iteration: null, best_score: null,
  };
}

describe('helpers', () => {
  it('slugifies names safely and caps length', () => {
    expect(slugify('Wild & Sacred')).toBe('wild_sacred');
    expect(slugify('Crystal Empire Gems Revamp!!')).toBe('crystal_empire_gems_revamp');
    expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(40);
    expect(() => slugify('***')).toThrow();
  });
  it('derives 2-3 char prefixes', () => {
    expect(derivePrefix('Wild & Sacred')).toBe('ws');
    expect(derivePrefix('Back To Earth')).toBe('bte');
    expect(derivePrefix('Gallactic')).toBe('gal');
  });
});

describe('scaffoldWorkspace', () => {
  it('creates the complete clone-theme workspace contract', async () => {
    const workspace = path.join(root, 'ws1');
    const result = await scaffoldWorkspace({ job: job(workspace), clientId: 'a'.repeat(32), clientSecret: 'shpss_test_secret', reactFilesPath: reactSource, storefrontPassword: 'pw123' });
    expect(result.adopted).toBe(false);

    // clone-theme inputs
    const target = await readFile(path.join(workspace, 'TARGET_SITE_INFO.txt'), 'utf8');
    expect(target).toContain('https://wild-sacred.example.com');
    expect(target).toContain('https://wild-sacred.myshopify.com');
    expect(target).toContain('pw123');
    const api = await readFile(path.join(workspace, 'API.txt'), 'utf8');
    expect(api).toContain('a'.repeat(32)); // Client ID (a public app identifier) is kept for reference
    expect(api).not.toContain('shpss_test_secret'); // SECURITY: the Client Secret must never be written to disk
    const jobJson = JSON.parse(await readFile(path.join(workspace, 'job.json'), 'utf8'));
    expect(jobJson).toMatchObject({ factory: true, approved: true, name: 'Wild & Sacred', prefix: 'ws', autoswap: false, dev_theme_name: 'Wild & Sacred Clone (dev)' });
    // token-mint wiring replaces the on-disk secret
    expect(jobJson.job_id).toBe('job-1');
    expect(jobJson.mint_url).toContain('/api/factory/jobs/job-1/mint-token');
    expect(typeof jobJson.mint_key).toBe('string');
    expect(jobJson.mint_key.length).toBeGreaterThan(0);
    // the /clone-theme command is bundled into the workspace so headless runs are self-contained
    expect(await exists(path.join(workspace, '.claude/commands/clone-theme.md'))).toBe(true);

    // six pre-placed headless scaffold files
    for (const file of ['push.mjs', 'pull.mjs', 'preflight.mjs', 'qa/lib.mjs', 'qa/bootstrap-theme.mjs', 'seed/CONVENTIONS.md']) {
      expect(await exists(path.join(workspace, file)), file).toBe(true);
    }
    const conventions = await readFile(path.join(workspace, 'seed/CONVENTIONS.md'), 'utf8');
    expect(conventions).toContain('ws-');
    expect(conventions).not.toContain('{{PREFIX}}');

    // scoped allowlist with substituted domains
    const settings = JSON.parse(await readFile(path.join(workspace, '.claude/settings.json'), 'utf8'));
    expect(settings.permissions.allow).toContain('WebFetch(domain:wild-sacred.example.com)');
    expect(settings.permissions.allow).toContain('WebFetch(domain:wild-sacred.myshopify.com)');
    expect(settings.permissions.allow).not.toContain(expect.stringContaining('{{'));
    expect(settings.permissions.deny).toContain('Bash(git push:*)');

    // react_files ingested
    expect(await exists(path.join(workspace, 'react_files/package.json'))).toBe(true);
    expect(await exists(path.join(workspace, 'react_files/src/App.tsx'))).toBe(true);

    // standard dirs
    for (const dir of ['sections', 'templates', 'snippets', 'assets', 'layout', 'config', 'qa/state', 'qa/reports', 'qa/screenshots', 'factory/logs']) {
      expect(await exists(path.join(workspace, dir)), dir).toBe(true);
    }
  });

  it('is idempotent on retry and reports adoption of an existing workspace', async () => {
    const workspace = path.join(root, 'ws1');
    // simulate a prior run's customization that must NOT be clobbered
    await writeFile(path.join(workspace, 'push.mjs'), '// customized');
    const result = await scaffoldWorkspace({ job: job(workspace), clientId: 'b'.repeat(32), clientSecret: 'shpss_other', reactFilesPath: reactSource });
    expect(result.adopted).toBe(true);
    expect(await readFile(path.join(workspace, 'push.mjs'), 'utf8')).toBe('// customized');
    // but job inputs are refreshed — and the Client Secret is still never written to disk
    const apiTxt = await readFile(path.join(workspace, 'API.txt'), 'utf8');
    expect(apiTxt).not.toContain('shpss_other');
    expect(apiTxt).toContain('b'.repeat(32));
  });

  it('places no recipe in the workspace when the recipe comes from ThemeBot Cloud', async () => {
    const workspace = path.join(root, 'ws-cloud');
    await scaffoldWorkspace({ job: job(workspace), clientId: 'a'.repeat(32), clientSecret: 'shpss_x', reactFilesPath: reactSource, recipe: 'cloud' });
    // Generic plumbing is there…
    for (const file of ['push.mjs', 'pull.mjs', 'preflight.mjs', 'qa/lib.mjs', 'qa/bootstrap-theme.mjs', 'qa/snapshot.mjs', '.claude/settings.json', 'job.json', 'TARGET_SITE_INFO.txt', 'API.txt']) {
      expect(await exists(path.join(workspace, file)), file).toBe(true);
    }
    expect(await exists(path.join(workspace, 'factory/steps'))).toBe(true);
    // …the recipe is not: no /clone-theme command, no conventions, no scoring scripts.
    for (const file of ['.claude/commands/clone-theme.md', '.claude/commands', 'seed/CONVENTIONS.md', 'qa/factory']) {
      expect(await exists(path.join(workspace, file)), file).toBe(false);
    }
  });

  it('removes the recipe an older local scaffold left in an adopted workspace (but not the user\'s own files)', async () => {
    const workspace = path.join(root, 'ws-adopted');
    await scaffoldWorkspace({ job: job(workspace), clientId: 'a'.repeat(32), clientSecret: 'shpss_x', recipe: 'local' });
    expect(await exists(path.join(workspace, '.claude/commands/clone-theme.md'))).toBe(true);
    expect(await exists(path.join(workspace, 'seed/CONVENTIONS.md'))).toBe(true);
    await writeFile(path.join(workspace, 'qa/factory/my-notes.mjs'), '// mine');
    await scaffoldWorkspace({ job: job(workspace), clientId: 'a'.repeat(32), clientSecret: 'shpss_x', recipe: 'cloud' });
    for (const file of ['.claude/commands/clone-theme.md', 'seed/CONVENTIONS.md', 'qa/factory/section-compare.mjs', 'qa/factory/qa-shared.mjs']) {
      expect(await exists(path.join(workspace, file)), file).toBe(false);
    }
    expect(await readFile(path.join(workspace, 'qa/factory/my-notes.mjs'), 'utf8')).toBe('// mine');
    // A conventions file the user wrote themselves stays.
    await writeFile(path.join(workspace, 'seed/CONVENTIONS.md'), '# My own notes\n');
    await scaffoldWorkspace({ job: job(workspace), clientId: 'a'.repeat(32), clientSecret: 'shpss_x', recipe: 'cloud' });
    expect(await readFile(path.join(workspace, 'seed/CONVENTIONS.md'), 'utf8')).toBe('# My own notes\n');
  });

  it('fails clearly when the react_files source is missing', async () => {
    const workspace = path.join(root, 'ws2');
    await expect(scaffoldWorkspace({ job: job(workspace), clientId: 'a'.repeat(32), clientSecret: 'shpss_x', reactFilesPath: path.join(root, 'nope') })).rejects.toThrow(/not found/i);
  });
});
