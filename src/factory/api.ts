import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job, Iteration, SchedulerStatus, SettingsResponse, FactorySettings, QaSelftestResult, CredCheckResult, FactoryStore, CollectionMethod, LoginStatus, UploadResult, ProjectInfo, PreviewRun, EasyStatus, StoreAccess } from './types';

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
  check: (id: string) => request<{ job: Job }>(`/jobs/${id}/check`, { method: 'POST' }),
  fix: (id: string, rounds: number) => request<{ job: Job }>(`/jobs/${id}/fix`, { method: 'POST', body: JSON.stringify({ rounds }) }),
  syncStatus: (id: string, force = false) => request<{ ok: boolean; error?: string; themeId: number | null; missing: string[]; changed: string[]; total: number }>(`/jobs/${id}/sync${force ? '?force=1' : ''}`),
  syncUpload: (id: string) => request<{ uploaded: string[]; failed: Array<{ key: string; error: string }> }>(`/jobs/${id}/sync`, { method: 'POST' }),
  rebuild: (id: string) => request<{ job: Job; alreadyBuilt?: { done: number; total: number } }>(`/jobs/${id}/rebuild`, { method: 'POST' }),
  pause: (id: string) => request<{ job: Job }>(`/jobs/${id}/pause`, { method: 'POST' }),
  cancel: (id: string) => request<{ job: Job }>(`/jobs/${id}/cancel`, { method: 'POST' }),
  remove: (id: string, purge: boolean) => fetch(`/api/factory/jobs/${id}${purge ? '?purgeWorkspace=1' : ''}`, { method: 'DELETE' }).then((response) => { if (!response.ok && response.status !== 204) throw new Error(`HTTP ${response.status}`); }),
  codeFile: (id: string, file: string) => request<import('./types').LiveCodeResponse>(`/jobs/${id}/code?file=${encodeURIComponent(file)}`),
  progress: (id: string) => request<import('./types').BuildProgress>(`/jobs/${id}/progress`),
  code: (id: string, since = 0) => request<import('./types').LiveCodeResponse>(`/jobs/${id}/code?since=${since}`),
  activity: (id: string) => request<{ events: import('./types').ActivityEvent[]; streaming: boolean }>(`/jobs/${id}/activity`),
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
  /** Detection for the wizard's "use your own Chrome" credential helper. */
  chromeStatus: () => request<{ chrome: { installed: boolean }; edge: { installed: boolean }; claudeExtension: { installed: boolean } }>('/chrome-status'),
  /** Open a Shopify admin/accounts page in the user's real Chrome/Edge (their profile, their logins). */
  openInChrome: (url: string) => request<{ ok: boolean; opened: string; browser: string }>('/open-in-chrome', { method: 'POST', body: JSON.stringify({ url }) }),
  // Key collectors: 'llm' (Claude agent drives Chrome), 'scripted' (deterministic Playwright),
  // 'partnerapi' (headless GraphQL secret-read). All report through the same status endpoint.
  collectKeysStart: (storeUrl: string, projectName?: string, method: CollectionMethod = 'llm', extra?: { partnerToken?: string; orgId?: string; clientId?: string; chromeProfile?: string }) =>
    request<{ started: boolean }>('/collect-keys/start', { method: 'POST', body: JSON.stringify({ storeUrl, projectName, method, ...extra }) }),
  /** Chrome profiles for the scripted collector's profile picker (which is signed into Shopify). */
  chromeProfiles: () => request<{ profiles: Array<{ dir: string; label: string }> }>('/chrome-profiles'),
  collectKeysStatus: (take = false) => request<{ status: 'idle' | 'working' | 'delivered' | 'partial' | 'failed'; method: CollectionMethod | null; running: boolean; elapsedSec: number | null; finishedAgoSec: number | null; note: string | null; log: Array<{ at: number; text: string; kind?: 'thought' | 'action' | 'system' }>; clientId: string | null; clientSecret: string | null; hasSecret: boolean }>(`/collect-keys/status${take ? '?take=1' : ''}`),
  collectKeysStop: () => request<{ stopped: boolean }>('/collect-keys/stop', { method: 'POST' }),
  /** Persist keys the user obtained themselves (manual paste or bookmarklet): encrypted saved store + wizard hand-off. */
  saveKeys: (body: { storeUrl: string; projectName?: string; clientId: string; clientSecret: string }) => request<{ ok: boolean }>('/keys/save', { method: 'POST', body: JSON.stringify(body) }),
  /** Remove a store's credentials from everywhere: saved stores, job ciphers, API.txt, collector memory. */
  purgeKeys: (storeUrl: string) => request<{ ok: boolean; stores: number; jobs: number; files: number }>('/keys/purge', { method: 'POST', body: JSON.stringify({ storeUrl }) }),
  installBrowser: () => request<{ installing: boolean; detail?: string }>('/browser/install', { method: 'POST' }),
  /** Long-running (up to ~5 min server-side) — runs the QA calibration fixture through the full scoring pipeline. */
  qaSelftest: () => request<QaSelftestResult>('/qa-selftest', { method: 'POST' }),
  validate: (kind: string, value: string) => request<{ ok: boolean; detail?: string }>('/validate', { method: 'POST', body: JSON.stringify({ kind, value }) }),
  validateCreds: (storeUrl: string, clientId: string, clientSecret: string, canary = false) =>
    request<CredCheckResult>('/validate-creds', { method: 'POST', body: JSON.stringify({ storeUrl, clientId, clientSecret, canary }) }),
  // Saved stores (lazy onboarding): credentials entered once, reused on every job.
  listStores: () => request<{ stores: FactoryStore[] }>('/stores'),
  saveStore: (input: { label?: string; storeUrl: string; clientId: string; clientSecret: string; storefrontPassword?: string }) =>
    request<{ store: FactoryStore }>('/stores', { method: 'POST', body: JSON.stringify(input) }),
  deleteStore: (id: string) => fetch(`/api/factory/stores/${id}`, { method: 'DELETE' }).then((response) => { if (!response.ok && response.status !== 204) throw new Error(`HTTP ${response.status}`); }),
  /** Test a saved store using its server-side stored secret (never round-trips to the browser). */
  testStore: (id: string, canary = false) => request<CredCheckResult>(`/stores/${id}/test`, { method: 'POST', body: JSON.stringify({ canary }) }),

  // ---------- Easy mode ----------
  /** Is the built-in browser signed in to Shopify? (`fresh` skips the 45s server cache.) */
  shopifyLogin: (fresh = false) => request<LoginStatus>(`/shopify-login${fresh ? '?fresh=1' : ''}`),
  /** Open the Shopify sign-in page in a visible tab of the built-in browser. */
  openShopifySignIn: () => request<{ ok: boolean }>('/shopify-login/open', { method: 'POST' }),
  /** Upload a project .zip (raw body, with progress) — the server extracts + inspects it. */
  uploadProject: (file: File, onProgress?: (fraction: number) => void) => new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/factory/intake/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.upload.onprogress = (event) => { if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total); };
    xhr.onerror = () => reject(new Error('The upload failed — check that ThemeBot is still running.'));
    xhr.onload = () => {
      let body: { error?: string } & Partial<UploadResult> = {};
      try { body = JSON.parse(xhr.responseText) as typeof body; } catch { /* non-JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadResult);
      else reject(new Error(body.error ?? `Upload failed (HTTP ${xhr.status}).`));
    };
    xhr.send(file);
  }),
  inspectProject: (path: string) => request<{ reactFilesPath: string; info: ProjectInfo }>('/intake/inspect', { method: 'POST', body: JSON.stringify({ path }) }),
  startPreview: (source: { path?: string; url?: string }) => request<{ preview: PreviewRun }>('/intake/preview', { method: 'POST', body: JSON.stringify(source) }),
  previewStatus: (id: string) => request<{ preview: PreviewRun }>(`/intake/preview/${id}`),
  previewScreenshotUrl: (id: string) => `/api/factory/intake/preview/${id}/screenshot?t=${Date.now()}`,
  stopPreview: (id: string) => request<{ stopped: boolean }>(`/intake/preview/${id}/stop`, { method: 'POST' }),
  easyStart: (body: { storeName: string; siteUrl?: string; reactFilesPath?: string; intakeId?: string; qaEngine?: string; shop?: string; newStore?: boolean; rightsConfirmed?: boolean }) => request<EasyStatus>('/easy/start', { method: 'POST', body: JSON.stringify(body) }),
  easyStatus: () => request<EasyStatus>('/easy/status'),
  easySigninWindow: (page?: 'shopify' | 'shopify-accounts' | 'google-add' | 'google-manage', shop?: string, adminPath?: string) => request<{ ok: boolean; browser: string }>('/easy/signin-window', { method: 'POST', body: JSON.stringify({ ...(page ? { page } : {}), ...(shop ? { shop } : {}), ...(adminPath ? { adminPath } : {}) }) }),
  easyRememberedStore: (name: string) => request<{ shop: string | null }>(`/easy/remembered-store?name=${encodeURIComponent(name)}`),
  easyStoreCheck: (shop: string, force = false) => request<StoreAccess>('/easy/store-check', { method: 'POST', body: JSON.stringify({ shop, force }) }),
  easyProfile: () => request<{ exists: boolean; path: string; inUse: boolean }>('/easy/profile'),
  easyProfileReset: () => request<{ ok: boolean; backup: string | null }>('/easy/profile-reset', { method: 'POST' }),
  easyResume: (method?: 'scripted' | 'llm') => request<EasyStatus>('/easy/resume', { method: 'POST', body: JSON.stringify(method ? { method } : {}) }),
  easyCancel: () => request<{ canceled: boolean }>('/easy/cancel', { method: 'POST' }),
  easyDismiss: () => request<{ ok: boolean }>('/easy/dismiss', { method: 'POST' }),
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
