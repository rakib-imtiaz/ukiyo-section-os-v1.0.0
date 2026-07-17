import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../server/db';
import { encrypt } from '../server/security';
import { FactoryScheduler } from '../server/factory/scheduler';
import { updateFactorySettings } from '../server/factory/settings';
import type { DriveControl } from '../server/factory/convergence';

function jobInput(suffix: string) {
  return {
    name: `Sched ${suffix}`, slug: `sched_${suffix}`, workspace_path: `C:/tmp/factory/sched_${suffix}`,
    react_url: 'https://example.com', store_url: `https://sched-${suffix}.myshopify.com`,
    client_id_cipher: encrypt('a'.repeat(32)), client_secret_cipher: encrypt('shpss_x'), storefront_password_cipher: null,
    prefix: 'sc', dev_theme_name: 'dev', autoswap: false, auto_qa: true, qa_mode: 'both', qa_engine: 'playwright',
    max_iterations: 5, score_threshold: 0.92,
  };
}

class FakeDriver {
  started: string[] = [];
  private resolvers = new Map<string, () => void>();
  controls = new Map<string, DriveControl>();
  drive = async (jobId: string, control: DriveControl) => {
    this.started.push(jobId);
    this.controls.set(jobId, control);
    await new Promise<void>((resolve) => this.resolvers.set(jobId, resolve));
  };
  finish(jobId: string) { this.resolvers.get(jobId)?.(); this.resolvers.delete(jobId); }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('FactoryScheduler', () => {
  beforeEach(async () => {
    await updateFactorySettings({ concurrency: 2, launchStaggerSec: 0 });
    for (const job of await db.listFactoryJobs()) await db.deleteFactoryJob(job.id);
  });

  it('fills slots FIFO up to the concurrency limit and refills as jobs finish', async () => {
    const driver = new FakeDriver();
    const scheduler = new FactoryScheduler(driver.drive);
    const jobs = [];
    // created_at is FIFO's sort key (ms precision) — space creations so order is deterministic
    for (let index = 0; index < 4; index++) { jobs.push(await db.createFactoryJob(jobInput(`fifo${index}_${Math.random().toString(36).slice(2, 6)}`))); await new Promise((resolve) => setTimeout(resolve, 3)); }
    await scheduler.tick(); await flush();
    expect(driver.started).toEqual([jobs[0].id, jobs[1].id]);

    driver.finish(jobs[0].id); await flush();
    expect(driver.started).toEqual([jobs[0].id, jobs[1].id, jobs[2].id]);
    expect(scheduler.isRunning(jobs[1].id)).toBe(true);
    expect(scheduler.isRunning(jobs[0].id)).toBe(false);
  });

  it('respects a raised concurrency immediately and never kills on lowering', async () => {
    const driver = new FakeDriver();
    const scheduler = new FactoryScheduler(driver.drive);
    const jobs = [];
    for (let index = 0; index < 3; index++) jobs.push(await db.createFactoryJob(jobInput(`conc${index}_${Math.random().toString(36).slice(2, 6)}`)));
    await scheduler.tick(); await flush();
    expect(driver.started).toHaveLength(2);

    await updateFactorySettings({ concurrency: 1 });
    await scheduler.tick(); await flush();
    expect(scheduler.isRunning(jobs[0].id)).toBe(true); // still running, not killed

    await updateFactorySettings({ concurrency: 3 });
    await scheduler.tick(); await flush();
    expect(driver.started).toHaveLength(3);
  });

  it('pause/cancel free the slot, abort the driver, and set the right status', async () => {
    const driver = new FakeDriver();
    const scheduler = new FactoryScheduler(driver.drive);
    const jobA = await db.createFactoryJob(jobInput(`pa_${Math.random().toString(36).slice(2, 6)}`));
    const jobB = await db.createFactoryJob(jobInput(`pb_${Math.random().toString(36).slice(2, 6)}`));
    const jobC = await db.createFactoryJob(jobInput(`pc_${Math.random().toString(36).slice(2, 6)}`));
    await scheduler.tick(); await flush();
    expect(driver.started).toEqual([jobA.id, jobB.id]);

    await scheduler.stop(jobA.id, 'paused'); await flush();
    expect(driver.controls.get(jobA.id)!.signal.aborted).toBe(true);
    expect((await db.getFactoryJob(jobA.id))!.status).toBe('paused');
    expect(driver.started).toContain(jobC.id); // freed slot refilled

    await scheduler.stop(jobB.id, 'canceled');
    expect((await db.getFactoryJob(jobB.id))!.status).toBe('canceled');
    expect((await db.getFactoryJob(jobB.id))!.finished_at).toBeTruthy();
  });

  it('retry re-queues resumable statuses only', async () => {
    const driver = new FakeDriver();
    const scheduler = new FactoryScheduler(driver.drive);
    await updateFactorySettings({ concurrency: 1 });
    const job = await db.createFactoryJob(jobInput(`re_${Math.random().toString(36).slice(2, 6)}`));
    await db.updateFactoryJob(job.id, { status: 'blocked', status_detail: 'x' });
    await scheduler.retry(job.id); await flush();
    expect(driver.started).toContain(job.id);
    expect((await db.getFactoryJob(job.id))!.status).not.toBe('blocked');

    const done = await db.createFactoryJob(jobInput(`rd_${Math.random().toString(36).slice(2, 6)}`));
    await db.updateFactoryJob(done.id, { status: 'converged' });
    await expect(scheduler.retry(done.id)).rejects.toThrow(/Cannot retry/);
  });

  it('boot recovery marks interrupted jobs blocked and leaves terminal ones alone', async () => {
    const driver = new FakeDriver();
    const scheduler = new FactoryScheduler(driver.drive);
    await updateFactorySettings({ concurrency: 0 as never }); // clamped to 1; keeps launches minimal
    const interrupted = await db.createFactoryJob(jobInput(`bi_${Math.random().toString(36).slice(2, 6)}`));
    await db.updateFactoryJob(interrupted.id, { status: 'cloning' });
    const finished = await db.createFactoryJob(jobInput(`bf_${Math.random().toString(36).slice(2, 6)}`));
    await db.updateFactoryJob(finished.id, { status: 'converged' });
    await scheduler.boot(); await flush();
    expect((await db.getFactoryJob(interrupted.id))!.status).toBe('blocked');
    expect((await db.getFactoryJob(interrupted.id))!.status_detail).toMatch(/restart/i);
    expect((await db.getFactoryJob(finished.id))!.status).toBe('converged');
  });

  it('queue pause holds launches; resume releases them', async () => {
    const driver = new FakeDriver();
    const scheduler = new FactoryScheduler(driver.drive);
    scheduler.setQueuePaused(true, 'test');
    await db.createFactoryJob(jobInput(`qp_${Math.random().toString(36).slice(2, 6)}`));
    await scheduler.tick(); await flush();
    expect(driver.started).toHaveLength(0);
    scheduler.setQueuePaused(false); await flush();
    expect(driver.started).toHaveLength(1);
  });
});
