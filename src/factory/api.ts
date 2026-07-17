import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job, Iteration, SchedulerStatus, SettingsResponse, FactorySettings, QaSelftestResult } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/factory${path}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
  return body as T;
}

export const api = {
  listJobs: () => request<{ jobs: Job[]; scheduler: SchedulerStatus }>('/jobs'),
  getJob: (id: string) => request<{ job: Job; iterations: Iteration[]; reports: string[] }>(`/jobs/${id}`),
  createJob: (input: Record<string, unknown>) => request<{ job: Job }>('/jobs', { method: 'POST', body: JSON.stringify(input) }),
  retry: (id: string) => request<{ job: Job }>(`/jobs/${id}/retry`, { method: 'POST' }),
  start: (id: string) => request<{ job: Job }>(`/jobs/${id}/start`, { method: 'POST' }),
  pause: (id: string) => request<{ job: Job }>(`/jobs/${id}/pause`, { method: 'POST' }),
  cancel: (id: string) => request<{ job: Job }>(`/jobs/${id}/cancel`, { method: 'POST' }),
  remove: (id: string, purge: boolean) => fetch(`/api/factory/jobs/${id}${purge ? '?purgeWorkspace=1' : ''}`, { method: 'DELETE' }).then((response) => { if (!response.ok && response.status !== 204) throw new Error(`HTTP ${response.status}`); }),
  log: (id: string, kind: string, iter: number, tail = 300) => request<{ log: string; exists: boolean }>(`/jobs/${id}/log?kind=${kind}&iter=${iter}&tail=${tail}`),
  report: async (id: string, name: string) => {
    const response = await fetch(`/api/factory/jobs/${id}/reports/${name}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  },
  /** Fetch a QA report that contains JSON (the route serves everything as text/markdown). */
  reportJson: async <T>(id: string, name: string): Promise<T> => {
    const response = await fetch(`/api/factory/jobs/${id}/reports/${name}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return JSON.parse(await response.text()) as T;
  },
  listScreenshots: (id: string) => request<{ screenshots: string[] }>(`/jobs/${id}/screenshots`),
  screenshotUrl: (id: string, name: string) => `/api/factory/jobs/${id}/screenshots/${name}`,
  settings: () => request<SettingsResponse>('/settings'),
  saveSettings: (patch: Partial<FactorySettings>) => request<SettingsResponse>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  pauseQueue: () => request<{ scheduler: SchedulerStatus }>('/queue/pause', { method: 'POST' }),
  resumeQueue: () => request<{ scheduler: SchedulerStatus }>('/queue/resume', { method: 'POST' }),
  browserStatus: () => request<{ hasPlaywright: boolean; hasChromium: boolean; ready: boolean; playwrightRoot: string; installing: boolean }>('/browser'),
  installBrowser: () => request<{ installing: boolean; detail?: string }>('/browser/install', { method: 'POST' }),
  /** Long-running (up to ~5 min server-side) — runs the QA calibration fixture through the full scoring pipeline. */
  qaSelftest: () => request<QaSelftestResult>('/qa-selftest', { method: 'POST' }),
  validate: (kind: string, value: string) => request<{ ok: boolean; detail?: string }>('/validate', { method: 'POST', body: JSON.stringify({ kind, value }) }),
  validateCreds: (storeUrl: string, clientId: string, clientSecret: string) =>
    request<{ ok: boolean; detail?: string; shopName?: string | null; scopes?: { required: Array<{ scope: string; granted: boolean }>; recommended: Array<{ scope: string; granted: boolean }> } }>('/validate-creds', { method: 'POST', body: JSON.stringify({ storeUrl, clientId, clientSecret }) }),
};

/** Poll a fetcher on an interval while the component is mounted (and the tab visible). */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const savedFetcher = useRef(fetcher);
  savedFetcher.current = fetcher;

  const refresh = useCallback(async () => {
    try { setData(await savedFetcher.current()); setError(null); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Request failed'); } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, refresh, ...deps]);

  return { data, error, loading, refresh };
}
