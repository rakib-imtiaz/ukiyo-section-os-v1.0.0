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

  it('boot recovery requeues interrupted jobs (and relaunches them), leaving terminal ones alone', async () => {
    const driver = new FakeDriver();
    const scheduler = new FactoryScheduler(driver.drive);
    await updateFactorySettings({ concurrency: 0 as never }); // clamped to 1; keeps launches minimal
    const interrupted = await db.createFactoryJob(jobInput(`bi_${Math.random().toString(36).slice(2, 6)}`));
    await db.updateFactoryJob(interrupted.id, { status: 'cloning' });
    const finished = await db.createFactoryJob(jobInput(`bf_${Math.random().toString(36).slice(2, 6)}`));
    await db.updateFactoryJob(finished.id, { status: 'converged' });
    await scheduler.boot(); await flush();
    expect((await db.getFactoryJob(interrupted.id))!.status).not.toBe('blocked');
    expect(driver.started).toContain(interrupted.id); // picked straight back up — no Resume needed
    expect(driver.started).not.toContain(finished.id);
    expect((await db.getFactoryJob(finished.id))!.status).toBe('converged');
    driver.finish(interrupted.id);
  });

  it('a clean shutdown puts running builds back in the queue (they carry on at the next start)', async () => {
    const driver = new FakeDriver();
    const scheduler = new FactoryScheduler(driver.drive);
    const job = await db.createFactoryJob(jobInput(`sd_${Math.random().toString(36).slice(2, 6)}`));
    await scheduler.tick(); await flush();
    expect(driver.started).toContain(job.id);
    // The running session's kill takes a moment (Windows: taskkill /T): shutdown waits for it, since
    // the server exits right after and a cut-off taskkill leaves the AI's child processes running.
    let treeStopped = false;
    driver.controls.get(job.id)!.registerKill(() => new Promise<void>((resolve) => setTimeout(() => { treeStopped = true; resolve(); }, 100)));
    const waiting = await db.createFactoryJob(jobInput(`sw_${Math.random().toString(36).slice(2, 6)}`));
    await updateFactorySettings({ concurrency: 1 });
    await scheduler.shutdown(50); // the fake driver never ends by itself: shutdown waits 50 ms at most
    expect(treeStopped).toBe(true);
    expect(driver.controls.get(job.id)!.signal.aborted).toBe(true);
    const after = (await db.getFactoryJob(job.id))!;
    expect(after.status).toBe('queued');
    expect(after.status_detail).toMatch(/carries on/i);
    driver.finish(job.id); await flush();
    // The freed slot is not refilled while the server is closing.
    expect(driver.started).not.toContain(waiting.id);
  });

  it('Resume right after Pause waits for the stopped run to finish up, so two runs never share a folder', async () => {
    const driver = new FakeDriver();
    const scheduler = new FactoryScheduler(driver.drive);
    const job = await db.createFactoryJob(jobInput(`pr_${Math.random().toString(36).slice(2, 6)}`));
    await scheduler.tick(); await flush();
    expect(driver.started.filter((id) => id === job.id)).toHaveLength(1);
    await scheduler.stop(job.id, 'paused'); // the old run is still killing its sessions / saving its steps
    await scheduler.retry(job.id); await flush();
    expect(scheduler.isRunning(job.id)).toBe(true); // the new run holds the slot…
    expect(driver.started.filter((id) => id === job.id)).toHaveLength(1); // …but hasn't started yet
    driver.finish(job.id); await flush(); // the old run ends
    expect(driver.started.filter((id) => id === job.id)).toHaveLength(2);
    expect((await db.getFactoryJob(job.id))!.status).toBe('scaffolding');
    driver.finish(job.id); await flush();
  });

  it('boot recovery parks a job as blocked after more than 3 restarts within 30 minutes', async () => {
    const driver = new FakeDriver();
    const scheduler = new FactoryScheduler(driver.drive);
    await updateFactorySettings({ concurrency: 0 as never });
    const looping = await db.createFactoryJob(jobInput(`bl_${Math.random().toString(36).slice(2, 6)}`));
    await db.updateFactoryJob(looping.id, { status: 'cloning' });
    const now = Date.now();
    await db.setSetting('factory_restart_history', JSON.stringify({ [looping.id]: [now - 3000, now - 2000, now - 1000] }));
    await scheduler.boot(); await flush();
    expect((await db.getFactoryJob(looping.id))!.status).toBe('blocked');
    expect((await db.getFactoryJob(looping.id))!.status_detail).toMatch(/restart/i);
    expect(driver.started).not.toContain(looping.id);
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
