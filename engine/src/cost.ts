// The cost meter: what every API response cost in USD, and the build's budget cap.
//
// Pricing reads `usage` the way the API bills it:
//   - top-level usage is the attempt that produced the returned message;
//   - `usage.iterations` adds what the top level leaves out: `compaction` entries (the server-side
//     summarizing request), `advisor_message` entries, and — when a safety classifier declined and a
//     fallback model answered — the declined attempts (`message` entries + earlier `fallback_message`s).
// Each part is priced at the rates of the model that ran it (models.ts). Cache writes are split by TTL.
//
// The budget is per BUILD, shared by every session of that build (and the sub-agents inside each):
// each settled cost is appended to the build's ledger file, and before a request is sent the engine
// reserves its worst case (input at the cache-write rate + max_tokens of output, at the highest rate
// the request could be billed at). A request that does not fit is never sent.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ratesFor, type Rates } from './models';

export interface UsagePart {
  kind: 'message' | 'declined' | 'compaction' | 'advisor';
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

type IterationLike = { type?: string; model?: string | null; input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null };
/** A response's `usage` (BetaUsage fits; so does a hand-written one in tests). */
export type UsageLike = IterationLike & { iterations?: IterationLike[] | null };

const n = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

function part(kind: UsagePart['kind'], model: string, usage: IterationLike): UsagePart {
  const write = n(usage.cache_creation_input_tokens);
  const split = usage.cache_creation;
  const write1h = split ? n(split.ephemeral_1h_input_tokens) : 0;
  // No breakdown → all writes at the 5-minute rate (the only TTL the engine asks for).
  const write5m = split ? Math.max(n(split.ephemeral_5m_input_tokens), write - write1h) : write;
  return { kind, model, input: n(usage.input_tokens), output: n(usage.output_tokens), cacheRead: n(usage.cache_read_input_tokens), cacheWrite5m: write5m, cacheWrite1h: write1h };
}

/** Every billed part of one response. `responseModel` = the response's top-level `model`. */
export function billableParts(usage: UsageLike | null | undefined, responseModel: string, requestedModel = responseModel): UsagePart[] {
  if (!usage) return [];
  const parts: UsagePart[] = [part('message', responseModel, usage)];
  const iterations = usage.iterations ?? [];
  const fallbacks = iterations.filter((entry) => entry.type === 'fallback_message');
  for (const entry of iterations) {
    if (entry.type === 'compaction') parts.push(part('compaction', responseModel, entry));
    else if (entry.type === 'advisor_message') parts.push(part('advisor', entry.model || responseModel, entry));
    else if (fallbacks.length && entry.type === 'message') parts.push(part('declined', entry.model || requestedModel, entry));
    else if (fallbacks.length && entry.type === 'fallback_message' && entry !== fallbacks[fallbacks.length - 1]) parts.push(part('declined', entry.model || responseModel, entry));
  }
  return parts.filter((entry) => entry.input || entry.output || entry.cacheRead || entry.cacheWrite5m || entry.cacheWrite1h);
}

export function priceWith(rates: Rates, tokens: Omit<UsagePart, 'kind' | 'model'>): number {
  return (tokens.input * rates.input + tokens.output * rates.output + tokens.cacheRead * rates.cacheRead
    + tokens.cacheWrite5m * rates.cacheWrite5m + tokens.cacheWrite1h * rates.cacheWrite1h) / 1e6;
}

export function pricePart(entry: UsagePart): { usd: number; known: boolean } {
  const { rates, known } = ratesFor(entry.model);
  return { usd: priceWith(rates, entry), known };
}

export function priceParts(parts: UsagePart[]): number {
  return parts.reduce((total, entry) => total + pricePart(entry).usd, 0);
}

// ---- the build ledger -----------------------------------------------------------------------------
// One JSON line per priced response: {"v":1,"at":…,"session":"…","model":"…","usd":…,…}. Shared by the
// sessions of one build, including ones running at the same time (each append is one small write).

export interface LedgerLine { v: 1; at: number; session: string; model: string; kind: UsagePart['kind']; usd: number; input: number; output: number; cacheRead: number; cacheWrite: number }

/** Total USD recorded in a ledger file (0 when it does not exist yet). */
export async function ledgerTotal(file: string | null | undefined): Promise<number> {
  if (!file) return 0;
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return 0; }
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const entry = JSON.parse(line) as Partial<LedgerLine>; if (typeof entry.usd === 'number' && Number.isFinite(entry.usd)) total += entry.usd; } catch { /* torn line */ }
  }
  return total;
}

export class BudgetExceeded extends Error {
  constructor(readonly spentUsd: number, readonly capUsd: number, readonly neededUsd: number) {
    super(`Build budget reached: $${spentUsd.toFixed(2)} spent of the $${capUsd.toFixed(2)} cap (the next request could cost up to $${neededUsd.toFixed(2)}).`);
    this.name = 'BudgetExceeded';
  }
}

export interface ModelTotals { input: number; output: number; cacheRead: number; cacheWrite: number; usd: number }
export interface Reservation { id: number; usd: number }

export interface MeterOptions {
  /** Whole-build cap in USD; null = no cap (only for standalone/dev runs). */
  capUsd: number | null;
  /** The build's shared ledger; null = this session only. */
  ledgerPath?: string | null;
  sessionId: string;
}

export class CostMeter {
  readonly capUsd: number | null;
  readonly ledgerPath: string | null;
  readonly sessionId: string;
  /** What THIS session (all its agents) has spent. */
  sessionUsd = 0;
  readonly byModel = new Map<string, ModelTotals>();
  /** Model ids this table had no price for (billed at the highest rates; reported in the result). */
  readonly unpriced = new Set<string>();
  private readonly reserved = new Map<number, number>();
  private nextId = 1;
  private ledgerChain: Promise<void> = Promise.resolve();
  /** Spend whose ledger append failed (still counted). */
  private unrecordedUsd = 0;
  /** reserveFor calls waiting for an in-flight request to settle. */
  private readonly waiters: Array<() => void> = [];

  constructor(options: MeterOptions) {
    this.capUsd = options.capUsd != null && Number.isFinite(options.capUsd) ? Math.max(0, options.capUsd) : null;
    this.ledgerPath = options.ledgerPath ?? null;
    this.sessionId = options.sessionId;
  }

  /** Spent by the whole build so far (all sessions in the ledger; this session alone without one). */
  async buildSpentUsd(): Promise<number> {
    if (!this.ledgerPath) return this.sessionUsd;
    await this.ledgerChain;   // our own pending appends first
    return (await ledgerTotal(this.ledgerPath)) + this.unrecordedUsd;
  }

  private reservedUsd() { let total = 0; for (const usd of this.reserved.values()) total += usd; return total; }

  /** USD still available to new requests (Infinity without a cap). */
  async roomUsd(): Promise<number> {
    if (this.capUsd == null) return Number.POSITIVE_INFINITY;
    return this.capUsd - (await this.buildSpentUsd()) - this.reservedUsd();
  }

  /** Holds `usd` for an in-flight request, or throws BudgetExceeded when it does not fit. */
  async reserve(usd: number): Promise<Reservation> {
    const amount = Math.max(0, usd);
    if (this.capUsd != null) {
      const spent = await this.buildSpentUsd();
      // No await between this check and the set below: concurrent reservations in this process see each other.
      if (spent + this.reservedUsd() + amount > this.capUsd) throw new BudgetExceeded(spent, this.capUsd, amount);
    }
    const reservation = { id: this.nextId++, usd: amount };
    this.reserved.set(reservation.id, amount);
    return reservation;
  }

  /**
   * Reserves for a request sized to the room left: `size(roomUsd)` returns the request's worst-case
   * `usd` (and whatever else the caller needs), or null when even a minimal request does not fit.
   * Requests still in flight hold worst-case reservations they mostly give back, so a shortfall
   * caused by them is waited out; only a shortfall in real spend throws BudgetExceeded.
   */
  async reserveFor<T extends { usd: number }>(size: (roomUsd: number) => T | null, minimalUsd: number): Promise<{ reservation: Reservation; plan: T }> {
    while (true) {
      const spent = this.capUsd == null ? 0 : await this.buildSpentUsd();
      // From here to the set below there is no await: concurrent reservations in this process see each other.
      const room = this.capUsd == null ? Number.POSITIVE_INFINITY : this.capUsd - spent - this.reservedUsd();
      const plan = size(room);
      if (plan && plan.usd <= room) {
        const reservation = { id: this.nextId++, usd: Math.max(0, plan.usd) };
        this.reserved.set(reservation.id, reservation.usd);
        return { reservation, plan };
      }
      if (this.reserved.size) { await new Promise<void>((resolve) => this.waiters.push(resolve)); continue; }
      throw new BudgetExceeded(spent, this.capUsd ?? 0, plan?.usd ?? minimalUsd);
    }
  }

  release(reservation: Reservation | null | undefined) {
    if (!reservation || !this.reserved.delete(reservation.id)) return;
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** Records a response's cost (and frees its reservation). Returns the USD it cost. */
  async settle(reservation: Reservation | null, parts: UsagePart[]): Promise<number> {
    let usd = 0;
    const lines: LedgerLine[] = [];
    for (const entry of parts) {
      const priced = pricePart(entry);
      if (!priced.known) this.unpriced.add(entry.model);
      usd += priced.usd;
      const totals = this.byModel.get(entry.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
      totals.input += entry.input; totals.output += entry.output; totals.cacheRead += entry.cacheRead;
      totals.cacheWrite += entry.cacheWrite5m + entry.cacheWrite1h; totals.usd += priced.usd;
      this.byModel.set(entry.model, totals);
      lines.push({ v: 1, at: Date.now(), session: this.sessionId, model: entry.model, kind: entry.kind, usd: priced.usd, input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite5m + entry.cacheWrite1h });
    }
    this.sessionUsd += usd;
    if (this.ledgerPath && lines.length) {
      const file = this.ledgerPath;
      const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
      this.ledgerChain = this.ledgerChain.then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, text);
      }).catch(() => {
        // A ledger write must never crash the build — but the spend still counts against the cap.
        this.unrecordedUsd += usd;
      });
      await this.ledgerChain;
    }
    this.release(reservation);
    return usd;
  }

  /** Token totals in the shape Claude Code's result message uses (modelUsage). */
  modelUsage(): Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }> {
    const out: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }> = {};
    for (const [model, totals] of this.byModel) out[model] = { inputTokens: totals.input, outputTokens: totals.output, cacheReadInputTokens: totals.cacheRead, cacheCreationInputTokens: totals.cacheWrite, costUSD: totals.usd };
    return out;
  }
}
