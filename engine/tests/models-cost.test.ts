// The model table and the cost meter: prices, how a response's usage is billed (cache writes by TTL,
// compaction, refusal fallbacks), and the per-build budget shared through the ledger.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetExceeded, CostMeter, billableParts, ledgerTotal, priceParts } from '../src/cost';
import { MODELS, capTier, ratesFor, resolveModel, tierOf, worstCaseRates } from '../src/models';
import { estimateUsd } from '../../server/factory/engines';

let tmp: string;
beforeAll(async () => { tmp = await mkdtemp(path.join(tmpdir(), 'tb-engine-cost-')); });
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('the model table', () => {
  it('maps the three tiers to the ids and list prices verified against the claude-api skill', () => {
    expect(MODELS.opus).toMatchObject({ id: 'claude-opus-5-5', rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 } });
    expect(MODELS.sonnet).toMatchObject({ id: 'claude-sonnet-5-5', rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } });
    expect(MODELS.haiku).toMatchObject({ id: 'claude-haiku-4-5-20251001', rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 } });
  });

  it('never sends what a model rejects: no effort or thinking to Haiku 4.5, effort always set on the 5.5 models', () => {
    expect(MODELS.haiku.effort).toBeNull();
    expect(MODELS.haiku.thinking).toBe('off');
    expect(MODELS.haiku.fallbacks).toBeNull();
    expect(MODELS.opus.effort).toBeTruthy(); // Opus 5.5 defaults to medium when effort is omitted
    expect(MODELS.sonnet.effort).toBeTruthy();
  });

  it('agrees with the usage dashboard\'s price list for every tier (one source, no drift)', () => {
    const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };
    for (const spec of Object.values(MODELS)) {
      const ours = priceParts([{ kind: 'message', model: spec.id, input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite5m: tokens.cacheWrite, cacheWrite1h: 0 }]);
      expect(estimateUsd(spec.id, tokens), spec.id).toBeCloseTo(ours, 6);
    }
  });

  it('prices fallback targets and dated ids, and bills unknown models at the highest rates', () => {
    expect(ratesFor('claude-opus-5')).toEqual({ rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 }, known: true });
    expect(ratesFor('claude-opus-4-8').known).toBe(true);
    expect(ratesFor('claude-sonnet-5-5-20261101')).toEqual({ rates: MODELS.sonnet.rates, known: true });
    const unknown = ratesFor('claude-something-new');
    expect(unknown.known).toBe(false);
    expect(unknown.rates.output).toBeGreaterThanOrEqual(25);
  });

  it('budgets an Opus request at the dearer fallback rates', () => {
    expect(worstCaseRates(MODELS.opus).output).toBe(25);
    expect(worstCaseRates(MODELS.haiku)).toEqual(MODELS.haiku.rates);
  });

  it('resolves aliases and ids, caps sub-agent tiers, and honours operator overrides', () => {
    expect(tierOf('sonnet')).toBe('sonnet');
    expect(tierOf('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(tierOf('gpt-5')).toBeNull();
    expect(capTier('opus', 'sonnet')).toBe('sonnet');
    expect(capTier('haiku', 'opus')).toBe('haiku');
    expect(resolveModel('opus', { THEMEBOT_ENGINE_EFFORT_OPUS: 'xhigh' }).effort).toBe('xhigh');
    expect(resolveModel('opus', { THEMEBOT_ENGINE_EFFORT_OPUS: 'turbo' }).effort).toBe(MODELS.opus.effort);
    expect(resolveModel('haiku', { THEMEBOT_ENGINE_EFFORT_HAIKU: 'high' }).effort).toBeNull();
    const plain = resolveModel('sonnet', { THEMEBOT_ENGINE_BETAS: 'off' });
    expect([plain.fallbacks, plain.progressUpdates, plain.compaction]).toEqual([null, false, false]);
    expect(MODELS.sonnet.fallbacks).toBe('default'); // the table itself is untouched
  });
});

describe('what a response costs', () => {
  it('prices plain usage, splitting cache writes by TTL', () => {
    const parts = billableParts({ input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 } }, 'claude-opus-5-5');
    expect(parts).toHaveLength(1);
    // 1000×4 + 2000×20 + 10000×0.2 + 2000×5 + 1000×8 = 64,000 → $0.064
    expect(priceParts(parts)).toBeCloseTo(0.064, 9);
  });

  it('adds the compaction pass the top-level usage leaves out', () => {
    const parts = billableParts({
      input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      iterations: [{ type: 'compaction', input_tokens: 150_000, output_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { type: 'message', model: 'claude-sonnet-5-5', input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
    }, 'claude-sonnet-5-5');
    expect(parts.map((part) => part.kind)).toEqual(['message', 'compaction']);
    expect(priceParts(parts)).toBeCloseTo((500 * 2 + 100 * 10 + 150_000 * 2 + 3000 * 10) / 1e6, 9);
  });

  it('bills a refusal fallback at both models\' rates: the declined attempt and the one that answered', () => {
    const parts = billableParts({
      input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      iterations: [
        { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ],
    }, 'claude-opus-5', 'claude-opus-5-5');
    expect(parts.map((part) => [part.kind, part.model])).toEqual([['message', 'claude-opus-5'], ['declined', 'claude-opus-5-5']]);
    expect(priceParts(parts)).toBeCloseTo((1000 * 5 + 400 * 25 + 1000 * 4 + 50 * 20) / 1e6, 9);
  });
});

describe('the build budget', () => {
  it('shares one ledger between sessions and refuses a request that does not fit', async () => {
    const ledger = path.join(tmp, 'shared', 'job.jsonl');
    const first = new CostMeter({ capUsd: 1, ledgerPath: ledger, sessionId: 's1' });
    const second = new CostMeter({ capUsd: 1, ledgerPath: ledger, sessionId: 's2' });
    const held = await first.reserve(0.3);
    await first.settle(held, [{ kind: 'message', model: 'claude-sonnet-5-5', input: 0, output: 40_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }]); // $0.40
    expect(await second.buildSpentUsd()).toBeCloseTo(0.4, 9);
    expect(await second.roomUsd()).toBeCloseTo(0.6, 9);
    await expect(second.reserve(0.7)).rejects.toBeInstanceOf(BudgetExceeded);
    const ok = await second.reserve(0.5);
    // In flight, the 0.5 is held: a parallel request in the same session cannot take it too.
    await expect(second.reserve(0.2)).rejects.toThrow(/Build budget reached/);
    second.release(ok);
    expect(await ledgerTotal(ledger)).toBeCloseTo(0.4, 9);
    const line = JSON.parse((await readFile(ledger, 'utf8')).trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ v: 1, session: 's1', model: 'claude-sonnet-5-5', kind: 'message', output: 40_000 });
  });

  it('waits for in-flight requests to give back their worst-case reservations before calling the budget spent', async () => {
    const meter = new CostMeter({ capUsd: 1, sessionId: 'parallel' });
    // Like the agent's sizing: as much as fits, up to $0.50, but at least $0.30.
    const size = (room: number) => (room >= 0.3 ? { usd: Math.min(room, 0.5) } : null);
    const first = await meter.reserveFor(size, 0.5);
    const second = await meter.reserveFor(size, 0.5);
    let third: { plan: { usd: number } } | null = null;
    const waiting = meter.reserveFor(size, 0.5).then((value) => { third = value; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(third).toBeNull(); // both slots are held by requests still running
    // The first request turns out to cost $0.10 of its $0.50: the waiting one now fits.
    await meter.settle(first.reservation, [{ kind: 'message', model: 'claude-sonnet-5-5', input: 0, output: 10_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }]);
    await waiting;
    expect(third!.plan.usd).toBeCloseTo(0.4, 9); // $1 − $0.10 spent − $0.50 still held
    meter.release(second.reservation);
    // Real spend that leaves too little room is refused at once.
    const broke = new CostMeter({ capUsd: 0.2, sessionId: 'broke' });
    await expect(broke.reserveFor(size, 0.3)).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it('reads a ledger it cannot fully parse and counts spend whose ledger write failed', async () => {
    const ledger = path.join(tmp, 'torn.jsonl');
    await writeFile(ledger, '{"usd":0.25}\n{"usd":0.1\nnot json\n{"usd":0.05}\n');
    expect(await ledgerTotal(ledger)).toBeCloseTo(0.3, 9);
    expect(await ledgerTotal(path.join(tmp, 'missing.jsonl'))).toBe(0);
    // A ledger "file" that is a folder: the append fails, the spend still counts.
    const meter = new CostMeter({ capUsd: 10, ledgerPath: tmp, sessionId: 's' });
    await meter.settle(null, [{ kind: 'message', model: 'claude-haiku-4-5-20251001', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }]);
    expect(meter.sessionUsd).toBeCloseTo(1, 9);
  });

  it('runs without a cap only when none is given, and reports unpriced models', async () => {
    const meter = new CostMeter({ capUsd: null, sessionId: 's' });
    expect(await meter.roomUsd()).toBe(Number.POSITIVE_INFINITY);
    await meter.settle(await meter.reserve(5), [{ kind: 'message', model: 'mystery-model', input: 10, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }]);
    expect([...meter.unpriced]).toEqual(['mystery-model']);
    expect(meter.modelUsage()['mystery-model']).toMatchObject({ inputTokens: 10, outputTokens: 10 });
  });
});
