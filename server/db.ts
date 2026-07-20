import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config';
import type { GeneratedFile, SectionManifest } from '../src/shared/types';

const { Pool } = pg;

export interface ShopRecord {
  id: string; shop_domain: string; access_token_cipher: string; refresh_token_cipher: string | null;
  token_expires_at: string | null; refresh_token_expires_at: string | null; scopes: string; status: string;
}
export type ProjectKind = 'section' | 'clone';
/** Badge-friendly clone payload mirrored from the factory job. Never contains ciphers/secrets. */
export interface CloneProjectMeta { react_url: string; store_url: string; status: string; status_detail: string | null; last_score: number | null; }
// shop_id is null for kind='clone' rows: a factory clone job may have no connected OAuth shop,
// so clone-projects live in a shopless "local" scope (see migrations/003_clone_projects.sql).
// last_theme_id / last_deployed_at (004): the last theme this project successfully deployed
// to — set by the deploy flow on success, null until the first successful deploy.
export interface ProjectRecord { id: string; shop_id: string | null; name: string; handle: string; description: string; manifest: SectionManifest; kind: ProjectKind; factory_job_id: string | null; clone_meta: CloneProjectMeta | null; last_theme_id: string | null; last_deployed_at: string | null; created_at: string; updated_at: string; }
export interface VersionRecord { id: string; project_id: string; version_number: number; manifest: SectionManifest; compiled_files: GeneratedFile[]; checksum: string; created_at: string; }
export interface DeploymentRecord { id: string; shop_id: string; project_id: string | null; version_id: string | null; theme_id: string; theme_name: string; status: string; snapshot: unknown[]; installed_files: string[]; error: string | null; rolled_back_at: string | null; created_at: string; updated_at: string; }
export interface ApiKeyRecord { id: string; shop_id: string; label: string; key_prefix: string; secret_hash: string; last_used_at: string | null; revoked_at: string | null; created_at: string; }
export interface FactoryJobRecord {
  id: string; name: string; slug: string; workspace_path: string; react_url: string; store_url: string;
  client_id_cipher: string; client_secret_cipher: string; storefront_password_cipher: string | null;
  prefix: string; dev_theme_name: string; autoswap: boolean; auto_qa: boolean; qa_mode: string; qa_engine: string;
  status: string; status_detail: string | null; iteration: number; max_iterations: number; score_threshold: number;
  last_score: number | null; score_history: Array<{ iter: number; score: number; at: string }>; error: string | null;
  // Best QA iteration so far (005): written by the convergence loop; null until the first scored iteration.
  best_iteration: number | null; best_score: number | null;
  created_at: string; updated_at: string; started_at: string | null; finished_at: string | null;
}
export interface FactoryIterationRecord { id: string; job_id: string; iteration: number; kind: string; status: string; score: number | null; breakdown: Record<string, unknown> | null; report_path: string | null; log_path: string | null; started_at: string; finished_at: string | null; }
export interface AppSettingRecord { key: string; value: unknown; updated_at: string; }
// Saved store credentials for the wizard (006): secrets are ciphers, client_id is public.
export interface FactoryStoreRecord { id: string; label: string; shop_domain: string; client_id: string; client_secret_cipher: string; storefront_password_cipher: string | null; created_at: string; updated_at: string; }

const now = () => new Date().toISOString();
const memory = {
  shops: new Map<string, ShopRecord>(), states: new Map<string, { shop: string; expires: number }>(), projects: new Map<string, ProjectRecord>(),
  versions: new Map<string, VersionRecord>(), deployments: new Map<string, DeploymentRecord>(), apiKeys: new Map<string, ApiKeyRecord>(),
  factoryJobs: new Map<string, FactoryJobRecord>(), factoryIterations: new Map<string, FactoryIterationRecord>(), settings: new Map<string, AppSettingRecord>(),
  factoryStores: new Map<string, FactoryStoreRecord>(),
};

const FACTORY_JOB_COLUMNS = new Set(['status','status_detail','iteration','max_iterations','score_threshold','last_score','score_history','error','started_at','finished_at','autoswap','auto_qa','qa_mode','qa_engine','dev_theme_name','prefix','workspace_path','best_iteration','best_score']);

// Factory state survives dev-server restarts even without Postgres: memory-mode factory
// tables are mirrored to a JSON file (long-running clone jobs must not vanish on reload).
// Disabled under vitest so tests stay hermetic.
const factoryStatePersistence = !config.databaseUrl && config.factory.enabled && !process.env.VITEST;
const factoryStatePath = path.join(config.factory.workspaceRoot, '.factory', 'state.json');

function hydrateFactoryMemory() {
  if (!factoryStatePersistence) return;
  try {
    const state = JSON.parse(readFileSync(factoryStatePath, 'utf8')) as { jobs?: FactoryJobRecord[]; iterations?: FactoryIterationRecord[]; settings?: AppSettingRecord[]; cloneProjects?: ProjectRecord[]; stores?: FactoryStoreRecord[] };
    // Coalesce the 005 best-iteration fields so records persisted before 005 hydrate as null.
    for (const job of state.jobs ?? []) memory.factoryJobs.set(job.id, { ...job, best_iteration: job.best_iteration ?? null, best_score: job.best_score ?? null });
    for (const iteration of state.iterations ?? []) memory.factoryIterations.set(iteration.id, iteration);
    for (const setting of state.settings ?? []) memory.settings.set(setting.key, setting);
    for (const store of state.stores ?? []) memory.factoryStores.set(store.id, store);
    // Clone-projects mirror factory jobs, so they ride the same persistence file (section
    // projects stay ephemeral in memory mode, matching pre-existing behavior).
    // Coalesce the 004 deploy-target fields so records persisted before 004 hydrate as null.
    for (const project of state.cloneProjects ?? []) if (project.kind === 'clone') memory.projects.set(project.id, { ...project, last_theme_id: project.last_theme_id ?? null, last_deployed_at: project.last_deployed_at ?? null });
  } catch { /* first run or unreadable — start empty */ }
}

function writeFactoryState() {
  const state = JSON.stringify({ jobs: [...memory.factoryJobs.values()], iterations: [...memory.factoryIterations.values()], settings: [...memory.settings.values()], cloneProjects: [...memory.projects.values()].filter((project) => project.kind === 'clone'), stores: [...memory.factoryStores.values()] });
  mkdirSync(path.dirname(factoryStatePath), { recursive: true });
  // Atomic write: a crash mid-write must not corrupt the file and wipe all job history.
  const tmp = `${factoryStatePath}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, state);
  renameSync(tmp, factoryStatePath);
}

let persistTimer: NodeJS.Timeout | null = null;
function persistFactoryMemory() {
  if (!factoryStatePersistence) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try { writeFactoryState(); } catch { /* best-effort; boot recovery heals the rest */ }
  }, 300);
  persistTimer.unref?.();
}

/** Flush pending factory state synchronously (called on graceful shutdown so the last write isn't lost). */
export function flushFactoryState() {
  if (!factoryStatePersistence) return;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try { writeFactoryState(); } catch { /* ignore */ }
}

hydrateFactoryMemory();

class Repository {
  private pool = config.databaseUrl ? new Pool({ connectionString: config.databaseUrl, ssl: config.production ? { rejectUnauthorized: false } : undefined }) : null;
  get persistent() { return Boolean(this.pool); }

  async init() {
    if (!this.pool) return;
    const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) await this.pool.query(await readFile(path.join(migrationsDir, file), 'utf8'));
  }

  async close() { await this.pool?.end(); }

  async upsertShop(input: Omit<ShopRecord, 'id' | 'status'>) {
    if (this.pool) {
      const result = await this.pool.query<ShopRecord>(`INSERT INTO shops (id, shop_domain, access_token_cipher, refresh_token_cipher, token_expires_at, refresh_token_expires_at, scopes, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'active') ON CONFLICT (shop_domain) DO UPDATE SET access_token_cipher=EXCLUDED.access_token_cipher, refresh_token_cipher=EXCLUDED.refresh_token_cipher, token_expires_at=EXCLUDED.token_expires_at, refresh_token_expires_at=EXCLUDED.refresh_token_expires_at, scopes=EXCLUDED.scopes, status='active', uninstalled_at=NULL, updated_at=NOW() RETURNING *`,
      [randomUUID(), input.shop_domain, input.access_token_cipher, input.refresh_token_cipher, input.token_expires_at, input.refresh_token_expires_at, input.scopes]);
      return result.rows[0];
    }
    const existing = [...memory.shops.values()].find((shop) => shop.shop_domain === input.shop_domain);
    const record: ShopRecord = { id: existing?.id ?? randomUUID(), ...input, status: 'active' };
    memory.shops.set(record.id, record); return record;
  }

  async getShop(domain: string) {
    if (this.pool) return (await this.pool.query<ShopRecord>('SELECT * FROM shops WHERE shop_domain=$1 LIMIT 1', [domain])).rows[0] ?? null;
    return [...memory.shops.values()].find((shop) => shop.shop_domain === domain) ?? null;
  }

  async getShopById(id: string) {
    if (this.pool) return (await this.pool.query<ShopRecord>('SELECT * FROM shops WHERE id=$1 LIMIT 1', [id])).rows[0] ?? null;
    return memory.shops.get(id) ?? null;
  }

  async updateShopTokens(id: string, input: Pick<ShopRecord, 'access_token_cipher'|'refresh_token_cipher'|'token_expires_at'|'refresh_token_expires_at'|'scopes'>) {
    if (this.pool) {
      await this.pool.query('UPDATE shops SET access_token_cipher=$2, refresh_token_cipher=$3, token_expires_at=$4, refresh_token_expires_at=$5, scopes=$6, updated_at=NOW() WHERE id=$1', [id, input.access_token_cipher, input.refresh_token_cipher, input.token_expires_at, input.refresh_token_expires_at, input.scopes]); return;
    }
    const current = memory.shops.get(id); if (current) memory.shops.set(id, { ...current, ...input });
  }

  async markUninstalled(domain: string) {
    if (this.pool) { await this.pool.query("UPDATE shops SET status='uninstalled', uninstalled_at=NOW(), updated_at=NOW() WHERE shop_domain=$1", [domain]); return; }
    const shop = await this.getShop(domain); if (shop) memory.shops.set(shop.id, { ...shop, status: 'uninstalled' });
  }

  async purgeShop(domain:string){
    if(this.pool){await this.pool.query('DELETE FROM shops WHERE shop_domain=$1',[domain]);return;}
    const shop=await this.getShop(domain);if(!shop)return;
    memory.shops.delete(shop.id);
    const projectIds=[...memory.projects.values()].filter((item)=>item.shop_id===shop.id).map((item)=>item.id);
    for(const [id,item] of memory.projects)if(item.shop_id===shop.id)memory.projects.delete(id);
    for(const [id,item] of memory.versions)if(projectIds.includes(item.project_id))memory.versions.delete(id);
    for(const [id,item] of memory.deployments)if(item.shop_id===shop.id)memory.deployments.delete(id);
    for(const [id,item] of memory.apiKeys)if(item.shop_id===shop.id)memory.apiKeys.delete(id);
  }

  async createOAuthState(hash: string, shop: string) {
    const expires = Date.now() + 10 * 60_000;
    if (this.pool) { await this.pool.query('INSERT INTO oauth_states (state_hash,shop_domain,expires_at) VALUES ($1,$2,$3) ON CONFLICT (state_hash) DO NOTHING', [hash, shop, new Date(expires)]); return; }
    memory.states.set(hash, { shop, expires });
  }

  async consumeOAuthState(hash: string, shop: string) {
    if (this.pool) {
      const result = await this.pool.query('DELETE FROM oauth_states WHERE state_hash=$1 AND shop_domain=$2 AND expires_at>NOW() RETURNING state_hash', [hash, shop]); return Boolean(result.rowCount);
    }
    const state = memory.states.get(hash); memory.states.delete(hash); return Boolean(state && state.shop === shop && state.expires > Date.now());
  }

  /** Shop-scoped section projects; pass includeClones to also return shopless clone-kind projects. */
  async listProjects(shopId: string, options: { includeClones?: boolean } = {}) {
    const includeClones = Boolean(options.includeClones);
    if (this.pool) return (await this.pool.query<ProjectRecord>("SELECT * FROM projects WHERE shop_id=$1 OR ($2::boolean AND kind='clone' AND shop_id IS NULL) ORDER BY updated_at DESC", [shopId, includeClones])).rows;
    return [...memory.projects.values()].filter((item) => item.shop_id === shopId || (includeClones && item.kind === 'clone' && item.shop_id === null)).sort((a,b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  // Read access covers the shop's own projects plus shopless clone-projects (clones have no
  // shop scope by nature). Writes (update/delete below) stay strictly shop-scoped, so clone
  // rows remain read-only through the section CRUD — the factory owns their lifecycle.
  async getProject(id: string, shopId: string) {
    if (this.pool) return (await this.pool.query<ProjectRecord>("SELECT * FROM projects WHERE id=$1 AND (shop_id=$2 OR (kind='clone' AND shop_id IS NULL))", [id, shopId])).rows[0] ?? null;
    const project = memory.projects.get(id); return project && (project.shop_id === shopId || (project.kind === 'clone' && project.shop_id === null)) ? project : null;
  }

  async createProject(shopId: string, manifest: SectionManifest) {
    const id = randomUUID(); const timestamp = now();
    const record: ProjectRecord = { id, shop_id: shopId, name: manifest.name, handle: manifest.handle, description: manifest.description, manifest, kind: 'section', factory_job_id: null, clone_meta: null, last_theme_id: null, last_deployed_at: null, created_at: timestamp, updated_at: timestamp };
    if (this.pool) return (await this.pool.query<ProjectRecord>('INSERT INTO projects (id,shop_id,name,handle,description,manifest) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [id,shopId,record.name,record.handle,record.description,manifest])).rows[0];
    if ([...memory.projects.values()].some((item) => item.shop_id === shopId && item.handle === manifest.handle)) throw new Error('A project with this handle already exists.');
    memory.projects.set(id, record); return record;
  }

  async updateProject(id: string, shopId: string, manifest: SectionManifest) {
    if (this.pool) return (await this.pool.query<ProjectRecord>('UPDATE projects SET name=$3,handle=$4,description=$5,manifest=$6,updated_at=NOW() WHERE id=$1 AND shop_id=$2 RETURNING *', [id,shopId,manifest.name,manifest.handle,manifest.description,manifest])).rows[0] ?? null;
    const current = memory.projects.get(id); if (!current || current.shop_id !== shopId) return null;
    const next = { ...current, name: manifest.name, handle: manifest.handle, description: manifest.description, manifest, updated_at: now() }; memory.projects.set(id,next); return next;
  }

  async deleteProject(id: string, shopId: string) {
    if (this.pool) return Boolean((await this.pool.query('DELETE FROM projects WHERE id=$1 AND shop_id=$2', [id,shopId])).rowCount);
    const current = memory.projects.get(id); return current?.shop_id === shopId ? memory.projects.delete(id) : false;
  }

  /**
   * Remember the last theme a project successfully deployed to (004). Called by the deploy
   * flow AFTER a deployment succeeds; best-effort — deploy success never depends on it.
   * Intentionally does not bump updated_at (a deploy is not a content edit).
   */
  async setProjectDeployTarget(id: string, themeId: string) {
    if (this.pool) { await this.pool.query('UPDATE projects SET last_theme_id=$2, last_deployed_at=NOW() WHERE id=$1', [id, themeId]); return; }
    const current = memory.projects.get(id); if (!current) return;
    memory.projects.set(id, { ...current, last_theme_id: themeId, last_deployed_at: now() });
    if (current.kind === 'clone') persistFactoryMemory();
  }

  /**
   * Register/update the clone-project mirror for a factory job (kind='clone', shop_id=NULL,
   * linked by factory_job_id). Idempotent upsert keyed on factory_job_id, safe to call on
   * every job status change. The manifest is a minimal valid stub so section tooling that
   * reads it never explodes; the clone payload lives in clone_meta.
   */
  async upsertCloneProject(input: { jobId: string; name: string; handle: string; description?: string; reactUrl: string; storeUrl: string; status: string; statusDetail?: string | null; lastScore?: number | null }) {
    const cloneMeta: CloneProjectMeta = { react_url: input.reactUrl, store_url: input.storeUrl, status: input.status, status_detail: input.statusDetail ?? null, last_score: input.lastScore ?? null };
    const description = input.description ?? `Cloned store — ${input.storeUrl}`;
    const manifest: SectionManifest = { contractVersion: 1, name: input.name, handle: input.handle, description, settings: [], blocks: [], presets: [], source: { liquid: '', css: '' } };
    if (this.pool) {
      return (await this.pool.query<ProjectRecord>(`INSERT INTO projects (id,shop_id,name,handle,description,manifest,kind,factory_job_id,clone_meta)
        VALUES ($1,NULL,$2,$3,$4,$5,'clone',$6,$7)
        ON CONFLICT (factory_job_id) WHERE factory_job_id IS NOT NULL
        DO UPDATE SET name=EXCLUDED.name, handle=EXCLUDED.handle, description=EXCLUDED.description, clone_meta=EXCLUDED.clone_meta, updated_at=NOW() RETURNING *`,
      [randomUUID(), input.name, input.handle, description, manifest, input.jobId, cloneMeta])).rows[0];
    }
    const existing = [...memory.projects.values()].find((item) => item.factory_job_id === input.jobId);
    const record: ProjectRecord = existing
      ? { ...existing, name: input.name, handle: input.handle, description, clone_meta: cloneMeta, updated_at: now() }
      : { id: randomUUID(), shop_id: null, name: input.name, handle: input.handle, description, manifest, kind: 'clone', factory_job_id: input.jobId, clone_meta: cloneMeta, last_theme_id: null, last_deployed_at: null, created_at: now(), updated_at: now() };
    memory.projects.set(record.id, record); persistFactoryMemory(); return record;
  }

  /** Canonical FactoryJobRecord → clone-project mapping (single place both routes and convergence use). */
  async syncCloneProjectFromJob(job: FactoryJobRecord) {
    return this.upsertCloneProject({ jobId: job.id, name: job.name, handle: job.slug, reactUrl: job.react_url, storeUrl: job.store_url, status: job.status, statusDetail: job.status_detail, lastScore: job.last_score });
  }

  async getProjectByFactoryJob(jobId: string) {
    if (this.pool) return (await this.pool.query<ProjectRecord>('SELECT * FROM projects WHERE factory_job_id=$1', [jobId])).rows[0] ?? null;
    return [...memory.projects.values()].find((item) => item.factory_job_id === jobId) ?? null;
  }

  async createVersion(projectId: string, manifest: SectionManifest, files: GeneratedFile[], checksum: string) {
    const number = this.pool ? Number((await this.pool.query<{ next: string }>('SELECT COALESCE(MAX(version_number),0)+1 AS next FROM project_versions WHERE project_id=$1', [projectId])).rows[0].next) : Math.max(0,...[...memory.versions.values()].filter((item)=>item.project_id===projectId).map((item)=>item.version_number))+1;
    const record: VersionRecord = { id: randomUUID(), project_id: projectId, version_number: number, manifest, compiled_files: files, checksum, created_at: now() };
    if (this.pool) return (await this.pool.query<VersionRecord>('INSERT INTO project_versions (id,project_id,version_number,manifest,compiled_files,checksum) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [record.id,projectId,number,manifest,JSON.stringify(files),checksum])).rows[0];
    memory.versions.set(record.id,record); return record;
  }

  async listVersions(projectId: string) {
    if (this.pool) return (await this.pool.query<VersionRecord>('SELECT * FROM project_versions WHERE project_id=$1 ORDER BY version_number DESC', [projectId])).rows;
    return [...memory.versions.values()].filter((item)=>item.project_id===projectId).sort((a,b)=>b.version_number-a.version_number);
  }

  async getVersion(id: string, projectId: string) {
    if (this.pool) return (await this.pool.query<VersionRecord>('SELECT * FROM project_versions WHERE id=$1 AND project_id=$2', [id, projectId])).rows[0] ?? null;
    const version = memory.versions.get(id); return version?.project_id === projectId ? version : null;
  }

  async createDeployment(input: Omit<DeploymentRecord,'id'|'created_at'|'updated_at'|'error'|'rolled_back_at'>) {
    const record: DeploymentRecord = { id: randomUUID(), ...input, error:null, rolled_back_at:null, created_at:now(), updated_at:now() };
    if (this.pool) return (await this.pool.query<DeploymentRecord>('INSERT INTO deployments (id,shop_id,project_id,version_id,theme_id,theme_name,status,snapshot,installed_files) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [record.id,input.shop_id,input.project_id,input.version_id,input.theme_id,input.theme_name,input.status,JSON.stringify(input.snapshot),JSON.stringify(input.installed_files)])).rows[0];
    memory.deployments.set(record.id,record); return record;
  }

  async finishDeployment(id: string, status: string, installedFiles: string[], error: string|null = null) {
    if (this.pool) return (await this.pool.query<DeploymentRecord>('UPDATE deployments SET status=$2,installed_files=$3,error=$4,updated_at=NOW() WHERE id=$1 RETURNING *', [id,status,JSON.stringify(installedFiles),error])).rows[0];
    const current=memory.deployments.get(id)!; const next={...current,status,installed_files:installedFiles,error,updated_at:now()}; memory.deployments.set(id,next); return next;
  }

  async listDeployments(shopId: string) {
    if (this.pool) return (await this.pool.query<DeploymentRecord>('SELECT * FROM deployments WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 100', [shopId])).rows;
    return [...memory.deployments.values()].filter((item)=>item.shop_id===shopId).sort((a,b)=>b.created_at.localeCompare(a.created_at));
  }

  async getDeployment(id: string, shopId: string) {
    if (this.pool) return (await this.pool.query<DeploymentRecord>('SELECT * FROM deployments WHERE id=$1 AND shop_id=$2', [id,shopId])).rows[0]??null;
    const item=memory.deployments.get(id); return item?.shop_id===shopId?item:null;
  }

  async markRolledBack(id: string) {
    if (this.pool) { await this.pool.query("UPDATE deployments SET status='rolled_back',rolled_back_at=NOW(),updated_at=NOW() WHERE id=$1",[id]); return; }
    const item=memory.deployments.get(id); if(item) memory.deployments.set(id,{...item,status:'rolled_back',rolled_back_at:now(),updated_at:now()});
  }

  async createApiKey(shopId:string,label:string,prefix:string,hash:string){ const record:ApiKeyRecord={id:randomUUID(),shop_id:shopId,label,key_prefix:prefix,secret_hash:hash,last_used_at:null,revoked_at:null,created_at:now()}; if(this.pool)return(await this.pool.query<ApiKeyRecord>('INSERT INTO api_keys (id,shop_id,label,key_prefix,secret_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *',[record.id,shopId,label,prefix,hash])).rows[0]; memory.apiKeys.set(record.id,record);return record; }
  async findApiKey(hash:string){ if(this.pool)return(await this.pool.query<ApiKeyRecord>('SELECT * FROM api_keys WHERE secret_hash=$1 AND revoked_at IS NULL',[hash])).rows[0]??null; return [...memory.apiKeys.values()].find((item)=>item.secret_hash===hash&&!item.revoked_at)??null; }
  async listApiKeys(shopId:string){ if(this.pool)return(await this.pool.query<ApiKeyRecord>('SELECT * FROM api_keys WHERE shop_id=$1 ORDER BY created_at DESC',[shopId])).rows; return [...memory.apiKeys.values()].filter((item)=>item.shop_id===shopId).sort((a,b)=>b.created_at.localeCompare(a.created_at)); }
  async touchApiKey(id:string){ if(this.pool){await this.pool.query('UPDATE api_keys SET last_used_at=NOW() WHERE id=$1',[id]);return;} const item=memory.apiKeys.get(id);if(item)memory.apiKeys.set(id,{...item,last_used_at:now()}); }
  async revokeApiKey(id:string,shopId:string){ if(this.pool)return Boolean((await this.pool.query('UPDATE api_keys SET revoked_at=NOW() WHERE id=$1 AND shop_id=$2',[id,shopId])).rowCount); const item=memory.apiKeys.get(id);if(item?.shop_id!==shopId)return false;memory.apiKeys.set(id,{...item,revoked_at:now()});return true; }
  async audit(shopId:string|null,eventType:string,actor:string,metadata:Record<string,unknown>={}){ if(this.pool)await this.pool.query('INSERT INTO audit_events (id,shop_id,event_type,actor,metadata) VALUES ($1,$2,$3,$4,$5)',[randomUUID(),shopId,eventType,actor,metadata]); }

  async createFactoryJob(input: Omit<FactoryJobRecord,'id'|'status'|'status_detail'|'iteration'|'last_score'|'score_history'|'error'|'best_iteration'|'best_score'|'created_at'|'updated_at'|'started_at'|'finished_at'>, initialStatus = 'queued') {
    const record: FactoryJobRecord = { id: randomUUID(), ...input, status: initialStatus, status_detail: null, iteration: 0, last_score: null, score_history: [], error: null, best_iteration: null, best_score: null, created_at: now(), updated_at: now(), started_at: null, finished_at: null };
    if (this.pool) return (await this.pool.query<FactoryJobRecord>(`INSERT INTO factory_jobs (id,name,slug,workspace_path,react_url,store_url,client_id_cipher,client_secret_cipher,storefront_password_cipher,prefix,dev_theme_name,autoswap,auto_qa,qa_mode,qa_engine,max_iterations,score_threshold,status,score_history)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'[]') RETURNING *`,
      [record.id,input.name,input.slug,input.workspace_path,input.react_url,input.store_url,input.client_id_cipher,input.client_secret_cipher,input.storefront_password_cipher,input.prefix,input.dev_theme_name,input.autoswap,input.auto_qa,input.qa_mode,input.qa_engine,input.max_iterations,input.score_threshold,initialStatus])).rows[0];
    if ([...memory.factoryJobs.values()].some((job) => job.slug === input.slug)) throw new Error('A factory job with this slug already exists.');
    memory.factoryJobs.set(record.id, record); persistFactoryMemory(); return record;
  }

  async listFactoryJobs() {
    if (this.pool) return (await this.pool.query<FactoryJobRecord>('SELECT * FROM factory_jobs ORDER BY created_at DESC')).rows;
    return [...memory.factoryJobs.values()].sort((a,b) => b.created_at.localeCompare(a.created_at));
  }

  async getFactoryJob(id: string) {
    if (this.pool) return (await this.pool.query<FactoryJobRecord>('SELECT * FROM factory_jobs WHERE id=$1', [id])).rows[0] ?? null;
    return memory.factoryJobs.get(id) ?? null;
  }

  async findActiveFactoryJobByStore(storeUrl: string, excludeId: string | null = null) {
    const terminal = ['converged','exhausted','aborted','failed','canceled'];
    if (this.pool) return (await this.pool.query<FactoryJobRecord>('SELECT * FROM factory_jobs WHERE store_url=$1 AND NOT (status = ANY($2)) AND ($3::text IS NULL OR id<>$3) LIMIT 1', [storeUrl, terminal, excludeId])).rows[0] ?? null;
    return [...memory.factoryJobs.values()].find((job) => job.store_url === storeUrl && !terminal.includes(job.status) && job.id !== excludeId) ?? null;
  }

  async updateFactoryJob(id: string, patch: Partial<FactoryJobRecord>) {
    const entries = Object.entries(patch).filter(([key]) => FACTORY_JOB_COLUMNS.has(key));
    if (!entries.length) return this.getFactoryJob(id);
    if (this.pool) {
      const sets = entries.map(([key], index) => `${key}=$${index + 2}`).join(', ');
      const values = entries.map(([key, value]) => key === 'score_history' ? JSON.stringify(value) : value);
      return (await this.pool.query<FactoryJobRecord>(`UPDATE factory_jobs SET ${sets}, updated_at=NOW() WHERE id=$1 RETURNING *`, [id, ...values])).rows[0] ?? null;
    }
    const current = memory.factoryJobs.get(id); if (!current) return null;
    const next = { ...current, ...Object.fromEntries(entries), updated_at: now() } as FactoryJobRecord; memory.factoryJobs.set(id, next); persistFactoryMemory(); return next;
  }

  async deleteFactoryJob(id: string) {
    if (this.pool) return Boolean((await this.pool.query('DELETE FROM factory_jobs WHERE id=$1', [id])).rowCount); // clone-project mirror cascades (003)
    if (!memory.factoryJobs.delete(id)) return false;
    for (const [iterId, item] of memory.factoryIterations) if (item.job_id === id) memory.factoryIterations.delete(iterId);
    // Mirror the pg ON DELETE CASCADE: remove the job's clone-project row too.
    for (const [projectId, item] of memory.projects) if (item.factory_job_id === id) memory.projects.delete(projectId);
    persistFactoryMemory();
    return true;
  }

  async createFactoryIteration(input: Omit<FactoryIterationRecord,'id'|'started_at'|'finished_at'>) {
    const record: FactoryIterationRecord = { id: randomUUID(), ...input, started_at: now(), finished_at: null };
    if (this.pool) return (await this.pool.query<FactoryIterationRecord>('INSERT INTO factory_iterations (id,job_id,iteration,kind,status,score,breakdown,report_path,log_path) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [record.id,input.job_id,input.iteration,input.kind,input.status,input.score,input.breakdown ? JSON.stringify(input.breakdown) : null,input.report_path,input.log_path])).rows[0];
    memory.factoryIterations.set(record.id, record); persistFactoryMemory(); return record;
  }

  async finishFactoryIteration(id: string, status: string, extra: Partial<Pick<FactoryIterationRecord,'score'|'breakdown'|'report_path'|'log_path'>> = {}) {
    if (this.pool) return (await this.pool.query<FactoryIterationRecord>('UPDATE factory_iterations SET status=$2, score=COALESCE($3,score), breakdown=COALESCE($4,breakdown), report_path=COALESCE($5,report_path), log_path=COALESCE($6,log_path), finished_at=NOW() WHERE id=$1 RETURNING *',
      [id,status,extra.score ?? null,extra.breakdown ? JSON.stringify(extra.breakdown) : null,extra.report_path ?? null,extra.log_path ?? null])).rows[0] ?? null;
    const current = memory.factoryIterations.get(id); if (!current) return null;
    const next = { ...current, status, ...extra, finished_at: now() }; memory.factoryIterations.set(id, next); persistFactoryMemory(); return next;
  }

  async listFactoryIterations(jobId: string) {
    if (this.pool) return (await this.pool.query<FactoryIterationRecord>('SELECT * FROM factory_iterations WHERE job_id=$1 ORDER BY started_at ASC', [jobId])).rows;
    return [...memory.factoryIterations.values()].filter((item) => item.job_id === jobId).sort((a,b) => a.started_at.localeCompare(b.started_at));
  }

  // --- Saved factory stores (006): encrypted credential reuse for the wizard ---
  async listFactoryStores() {
    if (this.pool) return (await this.pool.query<FactoryStoreRecord>('SELECT * FROM factory_stores ORDER BY created_at ASC')).rows;
    return [...memory.factoryStores.values()].sort((a,b) => a.created_at.localeCompare(b.created_at));
  }

  async getFactoryStore(id: string) {
    if (this.pool) return (await this.pool.query<FactoryStoreRecord>('SELECT * FROM factory_stores WHERE id=$1', [id])).rows[0] ?? null;
    return memory.factoryStores.get(id) ?? null;
  }

  /** Upsert keyed on shop_domain. A null storefront password never erases a stored one. */
  async upsertFactoryStore(input: { label: string; shop_domain: string; client_id: string; client_secret_cipher: string; storefront_password_cipher: string | null }) {
    if (this.pool) return (await this.pool.query<FactoryStoreRecord>(`INSERT INTO factory_stores (id,label,shop_domain,client_id,client_secret_cipher,storefront_password_cipher)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (shop_domain) DO UPDATE SET label=EXCLUDED.label, client_id=EXCLUDED.client_id, client_secret_cipher=EXCLUDED.client_secret_cipher,
        storefront_password_cipher=COALESCE(EXCLUDED.storefront_password_cipher, factory_stores.storefront_password_cipher), updated_at=NOW() RETURNING *`,
      [randomUUID(), input.label, input.shop_domain, input.client_id, input.client_secret_cipher, input.storefront_password_cipher])).rows[0];
    const existing = [...memory.factoryStores.values()].find((store) => store.shop_domain === input.shop_domain);
    const record: FactoryStoreRecord = existing
      ? { ...existing, label: input.label, client_id: input.client_id, client_secret_cipher: input.client_secret_cipher, storefront_password_cipher: input.storefront_password_cipher ?? existing.storefront_password_cipher, updated_at: now() }
      : { id: randomUUID(), ...input, created_at: now(), updated_at: now() };
    memory.factoryStores.set(record.id, record); persistFactoryMemory(); return record;
  }

  async deleteFactoryStore(id: string) {
    if (this.pool) return Boolean((await this.pool.query('DELETE FROM factory_stores WHERE id=$1', [id])).rowCount);
    if (!memory.factoryStores.delete(id)) return false;
    persistFactoryMemory(); return true;
  }

  async getSetting(key: string): Promise<unknown> {
    if (this.pool) return (await this.pool.query<AppSettingRecord>('SELECT * FROM app_settings WHERE key=$1', [key])).rows[0]?.value ?? null;
    return memory.settings.get(key)?.value ?? null;
  }

  async setSetting(key: string, value: unknown) {
    if (this.pool) { await this.pool.query('INSERT INTO app_settings (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()', [key, JSON.stringify(value)]); return; }
    memory.settings.set(key, { key, value, updated_at: now() }); persistFactoryMemory();
  }
}

export const db = new Repository();
