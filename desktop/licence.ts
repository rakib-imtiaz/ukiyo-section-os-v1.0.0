// Licence keys for the desktop app, sold and issued through Lemon Squeezy (License API).
//
// - Activation ties a key to this computer (an "instance"); the key's activation limit = seats.
// - The key is re-checked online every 7 days; offline, the app keeps working for 14 days
//   after the last successful check.
// - Keys must belong to our store/product (set at build time), so a key from another
//   Lemon Squeezy product can't unlock ThemeBot.
// - With no store configured (dev builds, the internal edition) no licence is required.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { safeStorage } from 'electron';

const API = 'https://api.lemonsqueezy.com/v1/licenses';
const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

export interface LicenceConfig { storeId: number | null; productIds: number[] }
interface Stored { key: string; instanceId: string; lastValidatedAt: number; customer?: string }
export type LicenceState =
  | { ok: true; customer?: string; offline?: boolean }
  | { ok: false; reason: string; hasKey: boolean };

interface LsMeta { store_id?: number; product_id?: number }
interface LsResponse { activated?: boolean; valid?: boolean; deactivated?: boolean; error?: string | null; license_key?: { status?: string }; instance?: { id?: string } | null; meta?: LsMeta & { customer_name?: string } }

/** Lemon Squeezy's error strings, in plain words. */
function friendly(error: string | null | undefined): string | null {
  if (!error) return null;
  if (/not found/i.test(error)) return "That key wasn't found. Check it was copied completely from your purchase email.";
  if (/activation limit/i.test(error)) return 'This key is already used on all the computers it covers. Deactivate it on another computer (Help → Move licence) or buy another seat.';
  if (/expired/i.test(error)) return 'This licence has expired. Renew it to keep using ThemeBot.';
  if (/disabled/i.test(error)) return 'This licence has been disabled. Contact whoever sold you ThemeBot.';
  return error;
}

export class Licence {
  private readonly file: string;

  constructor(userData: string, private readonly config: LicenceConfig) {
    this.file = path.join(userData, 'licence.json');
  }

  get required() { return this.config.storeId != null; }

  private read(): Stored | null {
    try {
      if (!existsSync(this.file)) return null;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Stored & { encrypted?: boolean };
      const key = raw.encrypted && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(raw.key, 'base64')) : raw.key;
      return { ...raw, key };
    } catch { return null; }
  }

  private write(stored: Stored) {
    const encrypted = safeStorage.isEncryptionAvailable();
    const key = encrypted ? safeStorage.encryptString(stored.key).toString('base64') : stored.key;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ ...stored, key, encrypted }, null, 2));
  }

  private ours(meta: LsMeta | undefined): boolean {
    if (!meta || meta.store_id !== this.config.storeId) return false;
    return !this.config.productIds.length || (meta.product_id != null && this.config.productIds.includes(meta.product_id));
  }

  private async call(action: 'activate' | 'validate' | 'deactivate', params: Record<string, string>): Promise<LsResponse> {
    const response = await fetch(`${API}/${action}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15_000),
    });
    return await response.json() as LsResponse;
  }

  /** Checks the stored licence (online at most every 7 days). */
  async check(): Promise<LicenceState> {
    if (!this.required) return { ok: true };
    const stored = this.read();
    if (!stored) return { ok: false, reason: 'Enter your ThemeBot licence key to start.', hasKey: false };
    if (Date.now() - stored.lastValidatedAt < RECHECK_MS) return { ok: true, customer: stored.customer };
    try {
      const result = await this.call('validate', { license_key: stored.key, instance_id: stored.instanceId });
      if (result.valid && result.license_key?.status !== 'expired' && this.ours(result.meta)) {
        this.write({ ...stored, lastValidatedAt: Date.now() });
        return { ok: true, customer: stored.customer };
      }
      return { ok: false, reason: friendly(result.error) || `This licence is ${result.license_key?.status ?? 'no longer valid'}. Renew it or enter a new key.`, hasKey: true };
    } catch {
      // Offline: keep working inside the grace period.
      if (Date.now() - stored.lastValidatedAt < OFFLINE_GRACE_MS) return { ok: true, customer: stored.customer, offline: true };
      return { ok: false, reason: 'ThemeBot could not check your licence for 14 days. Connect to the internet and try again.', hasKey: true };
    }
  }

  /** Activates a key on this computer (uses one seat). */
  async activate(key: string): Promise<LicenceState> {
    const trimmed = key.trim();
    if (!trimmed) return { ok: false, reason: 'Enter a licence key.', hasKey: false };
    let result: LsResponse;
    try { result = await this.call('activate', { license_key: trimmed, instance_name: `${hostname()} (${process.platform})` }); }
    catch { return { ok: false, reason: 'Could not reach the licence server. Check your internet connection.', hasKey: false }; }
    if (!result.activated || !result.instance?.id) return { ok: false, reason: friendly(result.error) || 'That key could not be activated.', hasKey: false };
    if (!this.ours(result.meta)) {
      await this.call('deactivate', { license_key: trimmed, instance_id: result.instance.id }).catch(() => {});
      return { ok: false, reason: 'That key is not a ThemeBot licence.', hasKey: false };
    }
    this.write({ key: trimmed, instanceId: result.instance.id, lastValidatedAt: Date.now(), customer: result.meta?.customer_name });
    return { ok: true, customer: result.meta?.customer_name };
  }

  /** Frees this computer's seat (to move the licence to another machine). */
  async deactivate(): Promise<void> {
    const stored = this.read();
    if (stored) await this.call('deactivate', { license_key: stored.key, instance_id: stored.instanceId }).catch(() => {});
    rmSync(this.file, { force: true });
  }
}

/** Store/product IDs baked into the app's package.json at build time (see scripts/desktop/build.mjs). */
export function licenceConfigFrom(pkg: { themebot?: { licence?: { storeId?: number; productIds?: number[] } } }): LicenceConfig {
  const licence = pkg.themebot?.licence;
  return { storeId: typeof licence?.storeId === 'number' ? licence.storeId : null, productIds: Array.isArray(licence?.productIds) ? licence.productIds.filter((id) => typeof id === 'number') : [] };
}
