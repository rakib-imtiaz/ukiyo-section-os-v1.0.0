import { rename } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db';
import { driveJob, type DriveControl, type RunMode } from './convergence';
import { getFactorySettings } from './settings';
import { ACTIVE_STATUSES } from './types';

type Driver = (jobId: string, control: DriveControl) => Promise<void>;

interface RunningSlot { abort: AbortController; kill: ((reason?: string) => void) | null; mode?: RunMode; }

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
  /** Check / fix runs waiting for a slot (kept in settings too, so a restart doesn't turn them
   *  into a full build that would redo the first step). */
  private modes = new Map<string, RunMode>();
  private async saveModes() { await db.setSetting('factory_run_modes', JSON.stringify(Object.fromEntries(this.modes))).catch(() => {}); }

  constructor(private driver: Driver = driveJob) {}

  /** Best-effort clone-project mirror update for statuses set outside the driver (pause/cancel/retry/boot). */
  private async syncMirror(jobId: string) {
    const job = await db.getFactoryJob(jobId).catch(() => null);
    if (job) await db.syncCloneProjectFromJob(job).catch(() => {});
  }

  get status() {
    return { running: [...this.running.keys()], queuePaused: this.queuePaused, queuePausedReason: this.queuePausedReason };
  }

  /** Builds cut off by a restart go straight back in the queue (the driver resumes from disk
   *  state), so a restart never leaves a build waiting for someone to press Resume. A build that
   *  keeps getting cut off (3 restarts within 30 minutes) is parked as blocked instead, so a crash
   *  loop cannot spin forever. */
  async boot() {
    // Restart history per build lives in settings, so it survives the restarts it is counting.
    const KEY = 'factory_restart_history';
    let history: Record<string, number[]> = {};
    try { for (const [id, mode] of Object.entries(JSON.parse(String((await db.getSetting('factory_run_modes')) ?? '{}')) as Record<string, RunMode>)) this.modes.set(id, mode); } catch { /* none */ }
    try { history = JSON.parse(String((await db.getSetting(KEY)) ?? '{}')) as Record<string, number[]>; } catch { history = {}; }
    for (const job of await db.listFactoryJobs()) {
      if (ACTIVE_STATUSES.includes(job.status as typeof ACTIVE_STATUSES[number])) {
        const recent = [...(history[job.id] ?? []).filter((at) => Date.now() - at < 30 * 60_000), Date.now()];
        history[job.id] = recent;
        if (recent.length > 3) {
          await db.updateFactoryJob(job.id, { status: 'blocked', status_detail: 'Interrupted by several server restarts — press Resume when ThemeBot is stable' });
        } else {
          await db.updateFactoryJob(job.id, { status: 'queued', status_detail: 'Carrying on after ThemeBot restarted' });
        }
        await this.syncMirror(job.id);
      }
    }
    await db.setSetting(KEY, JSON.stringify(history)).catch(() => {});
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
    const mode = this.modes.get(jobId);
    const slot: RunningSlot = { abort, kill: null, mode };
    this.running.set(jobId, slot);
    const control: DriveControl = {
      signal: abort.signal,
      registerKill: (kill) => { slot.kill = kill; },
      onUsageLimit: () => this.pauseQueueOnUsageLimit(),
      mode,
    };
    // Claim the job BEFORE the driver runs: a job must never look 'queued' while (or after)
    // its driver executes, or a tick could relaunch it.
    void db.updateFactoryJob(jobId, { status: 'scaffolding', status_detail: 'Starting' })
      .then(() => this.driver(jobId, control))
      .catch(() => {})
      // Only free OUR slot: a stopped run can finish after a resumed run of the same job took the
      // slot, and deleting that one would hide the new run and let a tick launch the job twice.
      .finally(() => { if (this.running.get(jobId) === slot) this.running.delete(jobId); if (this.modes.get(jobId) === mode) { this.modes.delete(jobId); void this.saveModes(); } void this.tick(); });
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
    const mode = slot?.mode ?? this.modes.get(jobId);
    this.modes.delete(jobId); void this.saveModes();
    // Stopping a hand-started check / fix run just ends it — the build keeps its last score.
    if (mode && status === 'paused') {
      await db.updateFactoryJob(jobId, { status: 'checked', status_detail: `Stopped by you — ${mode.kind === 'check' ? 'check' : 'fix rounds'} not finished` });
      await this.syncMirror(jobId);
      void this.tick();
      return;
    }
    await db.updateFactoryJob(jobId, {
      status, status_detail: status === 'paused' ? 'Paused by user — press Retry to resume' : 'Canceled by user',
      ...(status === 'canceled' ? { finished_at: new Date().toISOString() } : {}),
    });
    await this.syncMirror(jobId);
    void this.tick();
  }

  /** Start a finished or cancelled build over from the first step, on the same store and project.
   *  The old run's reports and logs are moved aside (kept, not deleted); theme files stay so the new
   *  run can build on them. */
  async rebuild(jobId: string) {
    const job = await db.getFactoryJob(jobId);
    if (!job) throw new Error('Job not found.');
    if (this.running.has(jobId)) throw new Error('Job is currently running.');
    if (!['canceled', 'converged', 'exhausted', 'failed', 'aborted', 'blocked', 'paused', 'checked'].includes(job.status)) throw new Error(`Cannot rebuild a job in status '${job.status}'.`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reports = path.join(job.workspace_path, 'qa', 'reports');
    const logs = path.join(job.workspace_path, 'factory', 'logs');
    for (const dir of [reports, logs]) await rename(dir, `${dir}-before-rebuild-${stamp}`).catch(() => {});
    await db.clearFactoryIterations(jobId);
    await db.updateFactoryJob(jobId, { status: 'queued', status_detail: 'Rebuilding from the start', error: null, finished_at: null, started_at: null, score_history: [], last_score: null, iteration: 0 });
    await this.syncMirror(jobId);
    void this.tick();
  }

  /** One check, or N fix rounds (each followed by a check), from what is on disk. */
  async runMode(jobId: string, mode: RunMode) {
    const job = await db.getFactoryJob(jobId);
    if (!job) throw new Error('Job not found.');
    if (this.running.has(jobId) || ['queued', ...ACTIVE_STATUSES].includes(job.status as typeof ACTIVE_STATUSES[number])) throw new Error('This build is busy — stop it first.');
    if (job.status === 'draft') throw new Error('Start the build first.');
    this.modes.set(jobId, mode); await this.saveModes();
    await db.updateFactoryJob(jobId, { status: 'queued', status_detail: mode.kind === 'check' ? 'Check starting' : `Fixing differences — up to ${mode.rounds} round${mode.rounds === 1 ? '' : 's'}`, error: null, finished_at: null });
    await this.syncMirror(jobId);
    void this.tick();
  }

  /** Re-queue a blocked/paused/exhausted/failed job; the driver resumes from disk state. */
  async retry(jobId: string) {
    const job = await db.getFactoryJob(jobId);
    if (!job) throw new Error('Job not found.');
    if (this.running.has(jobId)) throw new Error('Job is currently running.');
    if (!['blocked', 'paused', 'exhausted', 'failed', 'aborted'].includes(job.status)) throw new Error(`Cannot retry a job in status '${job.status}'.`);
    await db.updateFactoryJob(jobId, { status: 'queued', status_detail: 'Re-queued', error: null, finished_at: null });
    await this.syncMirror(jobId);
    void this.tick();
  }

  async shutdown() {
    if (this.staggerTimer) clearTimeout(this.staggerTimer);
    for (const [jobId, slot] of this.running) {
      slot.abort.abort(); slot.kill?.('killed');
      await db.updateFactoryJob(jobId, { status: 'blocked', status_detail: 'Interrupted by server shutdown — press Retry to resume' });
      await this.syncMirror(jobId);
    }
    this.running.clear();
  }
}

export const factoryScheduler = new FactoryScheduler();
