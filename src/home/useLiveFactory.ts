// Live factory feed for the HOME dashboard terminal + operations log.
// Polls the factory API (read-only) while a job is actively running:
//   - GET /api/factory/jobs         every 4s  (job list + active job pick)
//   - GET /api/factory/jobs/:id/log every 2.5s (tail of the current phase log)
//   - GET /api/factory/jobs/:id     every 5s  (iteration timeline)
// All polling pauses while document.hidden and every interval is cleared on
// unmount. Any error (401/404/network) degrades to nulls so the dashboard
// falls back to its demo typing loop.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../factory/api';
import type { Iteration, Job, JobStatus } from '../factory/types';

const ACTIVE_STATUSES: JobStatus[] = ['queued', 'scaffolding', 'cloning', 'qa_running', 'fixing'];

/** Which log file matches the job's current phase. */
export function logTargetFor(job: Job): { kind: 'clone' | 'fix' | 'qa'; iter: number } {
  switch (job.status) {
    case 'qa_running': return { kind: 'qa', iter: job.iteration };
    case 'fixing': return { kind: 'fix', iter: job.iteration };
    default: return { kind: 'clone', iter: 0 }; // queued / scaffolding / cloning
  }
}

function pickActive(jobs: Job[] | null): Job | null {
  if (!jobs?.length) return null;
  const active = jobs.filter((job) => ACTIVE_STATUSES.includes(job.status));
  if (!active.length) return null;
  return [...active].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
}

export interface LiveFactory {
  /** Last successful job list (null when the API is unreachable/unauthorized). */
  jobs: Job[] | null;
  /** Most recently updated non-terminal job, if any. */
  activeJob: Job | null;
  /** Tail lines of the active job's current phase log (null → use demo). */
  lines: string[] | null;
  /** Active job's iteration timeline (null → use demo). */
  iterations: Iteration[] | null;
}

export function useLiveFactory(): LiveFactory {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [lines, setLines] = useState<string[] | null>(null);
  const [iterations, setIterations] = useState<Iteration[] | null>(null);

  // Job list poll — every 4s, paused while hidden.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const payload = await api.listJobs();
        if (alive) setJobs(Array.isArray(payload.jobs) ? payload.jobs : []);
      } catch {
        if (alive) setJobs(null);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  const activeJob = useMemo(() => pickActive(jobs), [jobs]);
  const activeId = activeJob?.id ?? null;
  const target = activeJob ? logTargetFor(activeJob) : null;
  const kind = target?.kind ?? null;
  const iter = target?.iter ?? null;

  // Log tail (2.5s) + iteration timeline (5s) polls — only while a job is active.
  useEffect(() => {
    if (!activeId || !kind || iter === null) { setLines(null); setIterations(null); return; }
    let alive = true;
    const logTick = async () => {
      if (document.hidden) return;
      try {
        const payload = await api.log(activeId, kind, iter, 40);
        if (!alive) return;
        if (!payload.exists || !payload.log) { setLines(null); return; }
        const parsed = payload.log.replace(/\r/g, '').split('\n').filter((line) => line.trim().length > 0);
        setLines(parsed.length ? parsed : null);
      } catch {
        if (alive) setLines(null);
      }
    };
    const jobTick = async () => {
      if (document.hidden) return;
      try {
        const payload = await api.getJob(activeId);
        if (alive) setIterations(Array.isArray(payload.iterations) ? payload.iterations : []);
      } catch {
        if (alive) setIterations(null);
      }
    };
    void logTick();
    void jobTick();
    const logTimer = setInterval(() => void logTick(), 2500);
    const jobTimer = setInterval(() => void jobTick(), 5000);
    return () => { alive = false; clearInterval(logTimer); clearInterval(jobTimer); };
  }, [activeId, kind, iter]);

  return {
    jobs,
    activeJob,
    lines: activeJob ? lines : null,
    iterations: activeJob ? iterations : null,
  };
}
