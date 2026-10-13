// What every Cloud module receives: config, database, clock, mailer, rate limiter, logger.
// Modules are plain functions of this context, so tests can swap the clock and the mailer.
import type { NextFunction, Request, Response } from 'express';
import type { CloudConfig } from './config';
import type { CloudDb } from './db';
import type { Mailer } from './mailer';
import type { RateLimiter } from './rate-limit';

export interface CloudLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface CloudContext {
  config: CloudConfig;
  db: CloudDb;
  /** Unix ms. Injected so tests can move time (seat expiry, code expiry, pass expiry). */
  now: () => number;
  mailer: Mailer;
  limiter: RateLimiter;
  log: CloudLog;
}

/**
 * A refusal the client is meant to understand. `code` is stable (the desktop app maps it to a
 * friendly message); `message` is a plain-English fallback; `details` adds structured context
 * (e.g. the other signed-in devices for SEATS_FULL).
 */
export class CloudError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

type AsyncHandler = (request: Request, response: Response, next: NextFunction) => unknown;
/** Express 5 forwards rejected promises itself; this also catches synchronous throws uniformly. */
export const handle = (handler: AsyncHandler) => async (request: Request, response: Response, next: NextFunction) => {
  try { await handler(request, response, next); } catch (error) { next(error); }
};

export function consoleLog(production: boolean): CloudLog {
  const write = (level: string, message: string, fields?: Record<string, unknown>) => {
    const line = production
      ? JSON.stringify({ at: new Date().toISOString(), level, message, ...fields })
      : `[cloud] ${level === 'info' ? '' : `${level.toUpperCase()} `}${message}${fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ''}`;
    (level === 'error' ? console.error : console.log)(line);
  };
  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

/** Request body as an object (never undefined/array), for field-by-field validation. */
export function bodyOf(request: Request): Record<string, unknown> {
  const body = request.body as unknown;
  return body && typeof body === 'object' && !Array.isArray(body) && !Buffer.isBuffer(body) ? body as Record<string, unknown> : {};
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());
