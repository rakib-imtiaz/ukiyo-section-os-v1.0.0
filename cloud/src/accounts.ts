// Account rules every module agrees on: when an account may use ThemeBot, and what a client sees.
import { iso } from './context';
import type { AccountRow } from './db';

/** Active status and not past its end date. */
export function accountUsable(account: AccountRow, now: number): boolean {
  return account.status === 'active' && (account.expires_at == null || account.expires_at > now);
}

/** The account as the desktop app sees it. */
export function publicAccount(account: AccountRow) {
  return { email: account.email, plan: account.plan, seats: account.seats, expiresAt: iso(account.expires_at) };
}
