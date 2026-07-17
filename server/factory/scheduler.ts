import { db } from '../db';
import { driveJob, type DriveControl } from './convergence';
import { getFactorySettings } from './settings';
import { ACTIVE_STATUSES } from './types';

type Driver = (jobId: string, control: DriveControl) => Promise<void>;

interface RunningSlot { abort: AbortController; kill: ((reason?: string) => void) | null; }

/**
 * In-process slot manager: fills free slots FIFO from queued jobs, staggers launches,
 * pauses the whole queue on usage limits, and recovers interrupted jobs on boot.
 */
export class FactoryScheduler {
  private running = new Map<string, RunningSlot>();
  private queuePaused = false;
  private queuePausedReason: string | null = null;
  private lastLaunchAt = 0;
  private ticking = false;
  private staggerTimer: NodeJS.Timeout | null = null;

  constructor(private driver: Driver = driveJob) {}

  get status() {
    return { running: [...this.running.keys()], queuePaused: this.queuePaused, queuePausedReason: this.queuePausedReason };
  }

  /** Mark jobs interrupted by a restart as blocked (resumable), then start filling slots. */
  async boot() {
    for (const job of await db.listFactoryJobs()) {
      if (ACTIVE_STATUSES.includes(job.status as typeof ACTIVE_STATUSES[number])) {
        await db.updateFactoryJob(job.id, { status: 'blocked', status_detail: 'Interrupted by server restart — press Retry to resume' });
      }
    }
    void this.tick();
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.queuePaused) return;
      const settings = await getFactorySettings();
      while (this.running.size < settings.concurrency) {
        // String()-wrap created_at: Postgres returns it as a Date, so .localeCompare would throw.
        const queued = (await db.listFactoryJobs()).filter((job) => job.status === 'queued').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        const next = queued.find((job) => !this.running.has(job.id));
        if (!next) return;
        const wait = this.lastLaunchAt + settings.launchStaggerSec * 1000 - Date.now();
        if (wait > 0 && this.running.size > 0) { this.scheduleTick(wait); return; }
        this.launch(next.id);
      }
    } finally {
      this.ticking = false;
    }
  }

  private scheduleTick(delayMs: number) {
    if (this.staggerTimer) clearTimeout(this.staggerTimer);
    this.staggerTimer = setTimeout(() => { this.staggerTimer = null; void this.tick(); }, delayMs);
  }

  private launch(jobId: string) {
    this.lastLaunchAt = Date.now();
    const abort = new AbortController();
    const slot: RunningSlot = { abort, kill: null };
    this.running.set(jobId, slot);
    const control: DriveControl = {
      signal: abort.signal,
      registerKill: (kill) => { slot.kill = kill; },
      onUsageLimit: () => this.pauseQueueOnUsageLimit(),
    };
    // Claim the job BEFORE the driver runs: a job must never look 'queued' while (or after)
    // its driver executes, or a tick could relaunch it.
    void db.updateFactoryJob(jobId, { status: 'scaffolding', status_detail: 'Starting' })
      .then(() => this.driver(jobId, control))
      .catch(() => {})
      .finally(() => { this.running.delete(jobId); void this.tick(); });
  }

  private pauseQueueOnUsageLimit() {
    void getFactorySettings().then((settings) => {
      if (settings.pauseQueueOnUsageLimit && !this.queuePaused) {
        this.queuePaused = true;
        this.queuePausedReason = 'Usage limit detected — queue paused. Resume from the Factory settings.';
      }
    });
  }

  setQueuePaused(paused: boolean, reason: string | null = null) {
    this.queuePaused = paused;
    this.queuePausedReason = paused ? reason : null;
    if (!paused) void this.tick();
  }

  isRunning(jobId: string) { return this.running.has(jobId); }

  /** Kill the job's active CLI/QA process and free its slot. */
  async stop(jobId: string, status: 'paused' | 'canceled') {
    const slot = this.running.get(jobId);
    if (slot) { slot.abort.abort(); slot.kill?.(status === 'paused' ? 'killed' : 'killed'); this.running.delete(jobId); }
    await db.updateFactoryJob(jobId, {
      status, status_detail: status === 'paused' ? 'Paused by user — press Retry to resume' : 'Canceled by user',
      ...(status === 'canceled' ? { finished_at: new Date().toISOString() } : {}),
    });
    void this.tick();
  }

  /** Re-queue a blocked/paused/exhausted/failed job; the driver resumes from disk state. */
  async retry(jobId: string) {
    const job = await db.getFactoryJob(jobId);
    if (!job) throw new Error('Job not found.');
    if (this.running.has(jobId)) throw new Error('Job is currently running.');
    if (!['blocked', 'paused', 'exhausted', 'failed', 'aborted'].includes(job.status)) throw new Error(`Cannot retry a job in status '${job.status}'.`);
    await db.updateFactoryJob(jobId, { status: 'queued', status_detail: 'Re-queued', error: null, finished_at: null });
    void this.tick();
  }

  async shutdown() {
    if (this.staggerTimer) clearTimeout(this.staggerTimer);
    for (const [jobId, slot] of this.running) {
      slot.abort.abort(); slot.kill?.('killed');
      await db.updateFactoryJob(jobId, { status: 'blocked', status_detail: 'Interrupted by server shutdown — press Retry to resume' });
    }
    this.running.clear();
  }
}

export const factoryScheduler = new FactoryScheduler();
