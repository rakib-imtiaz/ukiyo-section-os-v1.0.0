// In-memory fixed-window rate limiting (one Cloud process; swap for a shared store if it ever
// runs as several). Keys are free-form: "ip:auth-start:1.2.3.4", "email:auth-start:a@b.co".
import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { CloudError, type CloudContext } from './context';

interface Window { count: number; resetAt: number }

/** Memory valve: past this many live windows, expired ones are swept and then the oldest dropped. */
const MAX_WINDOWS = 500_000;

export class RateLimiter {
  private windows = new Map<string, Window>();

  constructor(private readonly now: () => number) {}

  /** Counts one hit; ok=false once the key went over `limit` within the window. */
  hit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      if (!window && this.windows.size >= MAX_WINDOWS) this.shed();
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return { ok: window.count <= limit, retryAfterSec: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) };
  }

  /**
   * Weighted budget: charges `cost` to the key's window only if it still fits under `limit`
   * (a refused request costs nothing). Returns false when it doesn't fit.
   */
  spend(key: string, cost: number, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      if (!window && this.windows.size >= MAX_WINDOWS) this.shed();
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    const retryAfterSec = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
    if (window.count + cost > limit) return { ok: false, retryAfterSec };
    window.count += cost;
    return { ok: true, retryAfterSec };
  }

  /** Throws RATE_LIMITED when over the limit. */
  enforce(key: string, limit: number, windowMs: number) {
    const result = this.hit(key, limit, windowMs);
    if (!result.ok) throw new CloudError(429, 'RATE_LIMITED', 'Too many attempts. Wait a few minutes and try again.', { retryAfterSec: result.retryAfterSec });
  }

  /** Drops expired windows (called periodically). */
  sweep() {
    const now = this.now();
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }

  /**
   * Keeps the map bounded under a flood of distinct keys: expired windows first, then the oldest
   * (insertion order) until a tenth is free again — so this O(n) pass runs at most once per
   * MAX_WINDOWS / 10 new keys.
   */
  private shed() {
    this.sweep();
    const target = Math.floor(MAX_WINDOWS * 0.9);
    for (const key of this.windows.keys()) {
      if (this.windows.size <= target) break;
      this.windows.delete(key);
    }
  }

  get size() { return this.windows.size; }
}

/**
 * The rate-limit identity of a client address: IPv4 as is (an IPv4-mapped IPv6 address counts as
 * its IPv4), IPv6 by its /64 — one customer line gets a whole /64, so keying by the full address
 * would let anyone rotate through billions of "different" clients.
 */
export function clientKey(ip: string | null | undefined): string {
  if (!ip) return 'unknown';
  let address = ip.trim().split('%')[0];
  if (/^::ffff:/i.test(address) && isIP(address.slice(7)) === 4) address = address.slice(7);
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return 'unknown';
  const [head, tail] = address.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups = tail === undefined ? headGroups : [...headGroups, ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'), ...tailGroups];
  return `${groups.slice(0, 4).map((group) => parseInt(group || '0', 16).toString(16)).join(':')}::/64`;
}

/** Per-client limit for a group of routes (per IPv4 address / IPv6 /64). */
export function limitByIp(ctx: CloudContext, name: string, limit: number, windowMs: number) {
  return (request: Request, _response: Response, next: NextFunction) => {
    try { ctx.limiter.enforce(`ip:${name}:${clientKey(request.ip)}`, limit, windowMs); next(); } catch (error) { next(error); }
  };
}
