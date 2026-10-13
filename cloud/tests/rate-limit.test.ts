// The in-memory rate limiter: client identity behind the proxy, weighted budgets.
import { describe, expect, it } from 'vitest';
import { RateLimiter, clientKey } from '../src/rate-limit';

describe('clientKey', () => {
  it('keys IPv4 by address and IPv6 by its /64, so one customer line cannot rotate around a limit', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:0db8:0001:0002:0000:0000:0000:0042%eth0')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8:1:3::1')).not.toBe(clientKey('2001:db8:1:2::1'));
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    for (const junk of [undefined, null, '', 'not-an-ip']) expect(clientKey(junk)).toBe('unknown');
  });
});

describe('RateLimiter', () => {
  it('spends a weighted budget, and a refused request costs nothing', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    expect(limiter.spend('work', 60, 100, 1000).ok).toBe(true);
    expect(limiter.spend('work', 50, 100, 1000)).toMatchObject({ ok: false, retryAfterSec: 1 });
    expect(limiter.spend('work', 40, 100, 1000).ok).toBe(true); // the refused 50 was not charged
    expect(limiter.spend('work', 1, 100, 1000).ok).toBe(false);
    now = 1000;
    expect(limiter.spend('work', 100, 100, 1000).ok).toBe(true); // a new window
  });

  it('keeps counting hits per key and window', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    for (let index = 0; index < 3; index += 1) expect(limiter.hit('k', 3, 1000).ok).toBe(true);
    expect(limiter.hit('k', 3, 1000).ok).toBe(false);
    now = 1000;
    limiter.sweep();
    expect(limiter.size).toBe(0);
    expect(limiter.hit('k', 3, 1000).ok).toBe(true);
  });
});
