import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeProjectsDir, effectiveModel, removeWorkspaceTranscripts, stepSignalPath, transcriptFolderName, transcriptSlug } from '../server/factory/runner';

let root: string;
beforeAll(async () => { root = await mkdtemp(path.join(tmpdir(), 'tb-transcripts-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("Claude Code's transcript folders", () => {
  it('uses the slug rule Claude Code uses: every non-alphanumeric character becomes "-"', () => {
    // Folder names observed under %USERPROFILE%\.claude\projects on the dev machine.
    expect(transcriptSlug('C:\\patrick_workspace\\shopify_works\\_easy-autopilot')).toBe('C--patrick-workspace-shopify-works--easy-autopilot');
    expect(transcriptSlug('C:\\Users\\USER\\Desktop\\TEMPPPPPPPPPPP CLAUDE CHAt')).toBe('C--Users-USER-Desktop-TEMPPPPPPPPPPP-CLAUDE-CHAt');
    expect(transcriptSlug('C:/patrick_workspace/shopify_works/CA89')).toBe('C--patrick-workspace-shopify-works-CA89');
    expect(transcriptSlug('/home/me/ThemeBot Builds/wild_sacred')).toBe('-home-me-ThemeBot-Builds-wild-sacred');
  });

  it.runIf(existsSync(path.join(homedir(), '.claude', 'projects', 'C--patrick-workspace-shopify-works-CA89')))('matches a real folder on this machine (read-only check)', () => {
    expect(existsSync(path.join(homedir(), '.claude', 'projects', transcriptSlug('C:\\patrick_workspace\\shopify_works\\CA89')))).toBe(true);
  });

  it('honours CLAUDE_CONFIG_DIR', () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: path.join(root, 'cfg') })).toBe(path.join(root, 'cfg', 'projects'));
    expect(claudeProjectsDir({})).toBe(path.join(homedir(), '.claude', 'projects'));
  });

  it("deletes one session's files, or the whole folder, of this workspace only", async () => {
    const config = path.join(root, 'cfg');
    const env = { CLAUDE_CONFIG_DIR: config };
    const projects = path.join(config, 'projects');
    const workspace = path.join(root, 'builds', 'wild_sacred');
    await mkdir(workspace, { recursive: true });
    const slug = transcriptSlug(path.resolve(workspace));
    const mine = path.join(projects, slug);
    const lookalike = path.join(projects, `${slug}-2`);
    const other = path.join(projects, 'C--somebody-else');
    for (const folder of [mine, lookalike, other]) {
      await mkdir(path.join(folder, 'sess-aaaa-1111', 'subagents'), { recursive: true });
      await writeFile(path.join(folder, 'sess-aaaa-1111.jsonl'), '{"prompt":"secret recipe"}');
      await writeFile(path.join(folder, 'sess-bbbb-2222.jsonl'), '{}');
    }

    const some = await removeWorkspaceTranscripts(workspace, { env, sessionIds: ['sess-aaaa-1111', '../../escape'] });
    expect(some.sort()).toEqual([path.join(mine, 'sess-aaaa-1111'), path.join(mine, 'sess-aaaa-1111.jsonl')].sort());
    expect(existsSync(path.join(mine, 'sess-bbbb-2222.jsonl'))).toBe(true);

    expect(await removeWorkspaceTranscripts(workspace, { env })).toEqual([mine]);
    expect(existsSync(mine)).toBe(false);
    for (const folder of [lookalike, other]) {
      expect(existsSync(path.join(folder, 'sess-aaaa-1111.jsonl')), folder).toBe(true);
      expect(existsSync(path.join(folder, 'sess-bbbb-2222.jsonl')), folder).toBe(true);
    }
    expect(await removeWorkspaceTranscripts(path.join(root, 'nothing-here'), { env })).toEqual([]);
    expect(await removeWorkspaceTranscripts(workspace, { env: { CLAUDE_CONFIG_DIR: path.join(root, 'missing') } })).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('matches the drive letter case-insensitively on Windows', async () => {
    const config = path.join(root, 'cfg-case');
    const workspace = path.join(root, 'builds', 'casey');
    await mkdir(workspace, { recursive: true });
    const slug = transcriptSlug(path.resolve(workspace));
    const lower = path.join(config, 'projects', slug.charAt(0).toLowerCase() + slug.slice(1));
    await mkdir(lower, { recursive: true });
    expect(await removeWorkspaceTranscripts(workspace, { env: { CLAUDE_CONFIG_DIR: config } })).toHaveLength(1);
  });

  it("shortens slugs over 200 characters with Claude Code's own hash of the full path", () => {
    // Values from the CLI's rule ((h << 5) - h + charCode | 0, Math.abs, base 36), computed independently.
    const windows = `C:\\builds\\${'x'.repeat(120)}\\${'y'.repeat(120)}`;
    expect(transcriptFolderName(windows)).toBe(`${transcriptSlug(windows).slice(0, 200)}-4lwwve`);
    const posix = `/home/me/${'z'.repeat(220)}`;
    expect(transcriptFolderName(posix)).toBe(`${transcriptSlug(posix).slice(0, 200)}-5h9n2u`);
    expect(transcriptFolderName('C:\\builds\\short')).toBe('C--builds-short');
  });

  it('handles slugs Claude Code shortened, and never a different folder that starts the same way', async () => {
    const config = path.join(root, 'cfg-long');
    const workspace = path.join(root, 'builds', 'x'.repeat(120), 'y'.repeat(120));
    const sibling = path.join(root, 'builds', 'x'.repeat(120), `${'y'.repeat(120)}-second-job`);
    await mkdir(workspace, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const slug = transcriptSlug(path.resolve(workspace));
    expect(slug.length).toBeGreaterThan(200);
    const shortened = path.join(config, 'projects', transcriptFolderName(path.resolve(workspace)));
    // Another job whose path shares the first 200 slug characters: same prefix, its own hash.
    const siblingFolder = path.join(config, 'projects', transcriptFolderName(path.resolve(sibling)));
    expect(path.basename(siblingFolder).slice(0, 201)).toBe(path.basename(shortened).slice(0, 201));
    expect(siblingFolder).not.toBe(shortened);
    const notOurs = path.join(config, 'projects', `${slug.slice(0, 200)}-other-folder`);
    const wrongHash = path.join(config, 'projects', `${slug.slice(0, 200)}-k3x9q1`);
    for (const folder of [shortened, siblingFolder, notOurs, wrongHash]) await mkdir(folder, { recursive: true });
    expect(await removeWorkspaceTranscripts(workspace, { env: { CLAUDE_CONFIG_DIR: config } })).toEqual([shortened]);
    for (const folder of [siblingFolder, notOurs, wrongHash]) expect(existsSync(folder), folder).toBe(true);
  });
});

describe('Cloud step plumbing', () => {
  it('never runs a step above the tier the user picked', () => {
    expect(effectiveModel('opus', 'opus')).toBe('opus');
    expect(effectiveModel('haiku', 'opus')).toBe('haiku');
    expect(effectiveModel('opus', 'sonnet')).toBe('sonnet');
    expect(effectiveModel('gpt-5', 'sonnet')).toBe('sonnet');
  });

  it('only accepts signal files inside factory/steps or the fix sentinel', () => {
    const ws = path.join(root, 'ws');
    expect(stepSignalPath(ws, 'factory/steps/page-about.done')).toBe(path.join(ws, 'factory', 'steps', 'page-about.done'));
    expect(stepSignalPath(ws, 'qa/reports/fix-complete-3.md')).toBe(path.join(ws, 'qa', 'reports', 'fix-complete-3.md'));
    for (const bad of ['../x.done', 'factory/steps/../../x.done', 'C:/Windows/x.done', 'factory/steps/x.md', 'qa/reports/final.md', '']) expect(stepSignalPath(ws, bad), bad).toBeNull();
  });
});
