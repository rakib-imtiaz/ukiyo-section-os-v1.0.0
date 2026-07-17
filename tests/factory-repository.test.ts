import { describe, expect, it } from 'vitest';
import { db } from '../server/db';
import { encrypt } from '../server/security';

function jobInput(suffix: string) {
  return {
    name: `Test Store ${suffix}`, slug: `test_store_${suffix}`, workspace_path: `C:/tmp/factory/test_store_${suffix}`,
    react_url: 'https://example.com', store_url: `https://test-${suffix}.myshopify.com`,
    client_id_cipher: encrypt('a'.repeat(32)), client_secret_cipher: encrypt('shpss_secret'), storefront_password_cipher: null,
    prefix: 'ts', dev_theme_name: 'Test Clone (dev)', autoswap: false, auto_qa: true, qa_mode: 'both', qa_engine: 'playwright',
    max_iterations: 5, score_threshold: 0.92,
  };
}

describe('factory job repository', () => {
  it('persists a job through its full lifecycle with iterations and score history', async () => {
    const suffix = Math.random().toString(36).slice(2, 9);
    const job = await db.createFactoryJob(jobInput(suffix));
    expect(job.status).toBe('queued');
    expect(job.iteration).toBe(0);

    const cloneRow = await db.createFactoryIteration({ job_id: job.id, iteration: 0, kind: 'clone', status: 'running', score: null, breakdown: null, report_path: null, log_path: 'factory/logs/clone-0.log' });
    await db.finishFactoryIteration(cloneRow.id, 'succeeded', { report_path: 'qa/reports/final.md' });

    await db.updateFactoryJob(job.id, { status: 'qa_running', iteration: 1 });
    const qaRow = await db.createFactoryIteration({ job_id: job.id, iteration: 1, kind: 'qa', status: 'running', score: null, breakdown: null, report_path: null, log_path: null });
    await db.finishFactoryIteration(qaRow.id, 'succeeded', { score: 0.78, breakdown: { issues: 12 } });
    const history = [{ iter: 1, score: 0.78, at: new Date().toISOString() }];
    await db.updateFactoryJob(job.id, { last_score: 0.78, score_history: history });

    const updated = (await db.getFactoryJob(job.id))!;
    expect(updated.last_score).toBe(0.78);
    expect(updated.score_history).toHaveLength(1);

    const iterations = await db.listFactoryIterations(job.id);
    expect(iterations).toHaveLength(2);
    expect(iterations[0].kind).toBe('clone');
    expect(iterations[1].score).toBe(0.78);

    // Duplicate-store guard sees the active job; terminal statuses release it.
    expect((await db.findActiveFactoryJobByStore(job.store_url))?.id).toBe(job.id);
    await db.updateFactoryJob(job.id, { status: 'converged' });
    expect(await db.findActiveFactoryJobByStore(job.store_url)).toBeNull();

    // Delete cascades iterations (memory mode).
    expect(await db.deleteFactoryJob(job.id)).toBe(true);
    expect(await db.listFactoryIterations(job.id)).toHaveLength(0);
  });

  it('rejects duplicate slugs and ignores non-whitelisted update columns', async () => {
    const suffix = Math.random().toString(36).slice(2, 9);
    const job = await db.createFactoryJob(jobInput(suffix));
    await expect(db.createFactoryJob(jobInput(suffix))).rejects.toThrow(/slug/i);
    const untouched = await db.updateFactoryJob(job.id, { id: 'hax', client_id_cipher: 'hax' } as never);
    expect(untouched!.id).toBe(job.id);
    expect(untouched!.client_id_cipher).toBe(job.client_id_cipher);
  });

  it('stores and merges app settings', async () => {
    const key = `test_setting_${Math.random().toString(36).slice(2, 9)}`;
    expect(await db.getSetting(key)).toBeNull();
    await db.setSetting(key, { concurrency: 3 });
    expect(await db.getSetting(key)).toEqual({ concurrency: 3 });
    await db.setSetting(key, { concurrency: 1 });
    expect(await db.getSetting(key)).toEqual({ concurrency: 1 });
  });
});
