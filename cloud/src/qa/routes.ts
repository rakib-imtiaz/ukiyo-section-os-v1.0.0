// ThemeBot Cloud QA scoring API. The desktop app only CAPTURES evidence (layout dumps, click
// inventories, click effects, page health); every rule that turns evidence into a score lives here.
//
//   POST /v1/qa/sections            { iter, reactBase, shopifyBase, routes:[capture] }       → { report, markdown }
//   POST /v1/qa/interactions/plan   { iter, handles, routes:[inventories] }                  → { plan }   (signed)
//   POST /v1/qa/interactions/score  { plan, effects, reactBase, shopifyBase }                → { report, markdown }
//   POST /v1/qa/summary             { buildRef, iter, jobName, scoreThreshold, sections, interactions, prevIssues?, weights?, handlesMissing? }
//                                                                                             → { score, subscores, breakdown, summaryMarkdown, issueCount, captureFailed, … }
//   POST /v1/qa/calibrate           { reference, candidate?, mode? }                         → { ok, score, subscores, threshold, … }
//
// Every route requires a valid pass. Bodies may be up to 8 MB (a typical build sends well under
// 1 MB), so registerQaRoutes() MUST be mounted before the app-wide 16 kB JSON parser — exactly like
// the webhooks router.
import { createHmac } from 'node:crypto';
import express, { type Express, type Router } from 'express';
import { bodyOf, CloudError, handle, type CloudContext } from '../context';
import { secureEqual } from '../crypto';
import { requirePass, type PassLocals } from '../middleware';
import { calibrateWork, interactionsWork, sectionsWork } from './budget';
import { calibrate } from './calibrate';
import { planInteractions, scoreInteractions } from './interactions';
import * as clean from './sanitize';
import { scoreSections } from './sections';
import { ensureQaSchema, previousRoundKeys, saveRound } from './store';
import { buildSummary, issueKey } from './summary';
import type { ClickPlan, SummaryResponse } from './types';

export const QA_BODY_LIMIT = '8mb';
/** Scoring calls per account per hour (a build iteration makes 4–5). */
const QA_CALLS_PER_HOUR = 900;
/**
 * Scoring work (budget.ts units, ≈ µs) one request may need. A 300-route site with 30 long
 * sections per page estimates under 3 s; the uploads that would take longer are crafted ones.
 */
export const QA_WORK_PER_REQUEST = 3_000_000;
/** …and per account per hour: about a minute of scoring, ~15 rounds of a very large site. */
export const QA_WORK_PER_HOUR = 60_000_000;

/** HMAC over the plan (minus its signature), bound to the account it was issued to. */
export function signPlan(pepper: string, accountId: string, plan: ClickPlan): string {
  const { sig: _sig, ...unsigned } = plan;
  return createHmac('sha256', pepper).update(`qa-plan:v1:${accountId}:${JSON.stringify(unsigned)}`).digest('base64url');
}

export function qaRouter(ctx: CloudContext): Router {
  const router = express.Router();
  router.use(requirePass(ctx)); // before parsing: an unauthenticated caller never gets a large body read
  router.use((_request, response, next) => {
    const { account } = response.locals as PassLocals;
    try { ctx.limiter.enforce(`acc:qa:${account.id}`, QA_CALLS_PER_HOUR, 60 * 60_000); next(); } catch (error) { next(error); }
  });
  router.use(express.json({ limit: QA_BODY_LIMIT }));

  /** Refuses work over the per-request budget (413) or the account's hourly budget (429). */
  const charge = (response: { locals: unknown }, units: number) => {
    if (units > QA_WORK_PER_REQUEST) {
      throw new CloudError(413, 'TOO_LARGE', 'This QA upload has too much to compare in one request (too many sections or clickable elements per page).');
    }
    const { account } = response.locals as PassLocals;
    const spent = ctx.limiter.spend(`acc:qa-work:${account.id}`, Math.ceil(units), QA_WORK_PER_HOUR, 60 * 60_000);
    if (!spent.ok) throw new CloudError(429, 'RATE_LIMITED', 'Too much QA scoring for this account in the last hour. Wait a while and try again.', { retryAfterSec: spent.retryAfterSec });
  };

  router.post('/sections', handle((request, response) => {
    const body = bodyOf(request);
    const iter = clean.iteration(body.iter);
    const routes = clean.sectionsRoutes(body.routes);
    charge(response, sectionsWork(routes));
    const result = scoreSections({ iter, reactBase: clean.base(body.reactBase), shopifyBase: clean.base(body.shopifyBase), routes });
    response.json(result);
  }));

  router.post('/interactions/plan', handle((request, response) => {
    const body = bodyOf(request);
    const { account } = response.locals as PassLocals;
    const iter = clean.iteration(body.iter);
    const handles = clean.handles(body.handles);
    const routes = clean.interactionRoutes(body.routes);
    charge(response, interactionsWork(routes));
    const plan = planInteractions({ iter, handles, routes });
    plan.sig = signPlan(ctx.config.pepper, account.id, plan);
    response.json({ plan });
  }));

  router.post('/interactions/score', handle((request, response) => {
    const body = bodyOf(request);
    const { account } = response.locals as PassLocals;
    const plan = clean.obj(body.plan) as ClickPlan | null;
    if (!plan || typeof plan.sig !== 'string' || !secureEqual(plan.sig, signPlan(ctx.config.pepper, account.id, plan))) {
      throw new CloudError(400, 'PLAN_INVALID', 'This click plan was not issued by ThemeBot Cloud for this account (or was changed). Run the check again.');
    }
    const result = scoreInteractions({ plan, effects: clean.effects(body.effects), reactBase: clean.base(body.reactBase), shopifyBase: clean.base(body.shopifyBase) });
    response.json(result);
  }));

  router.post('/summary', handle((request, response) => {
    const body = bodyOf(request);
    const { account, device } = response.locals as PassLocals;
    const input = clean.summaryRequest(body);
    const ref = clean.buildRef(body.buildRef);
    // Fixed-issue delta: the client's own N-1 reports win (they are what the fixer saw); the
    // Cloud's record of the previous round is the fallback.
    let previousKeys: string[] | null = null;
    let deltaSource: SummaryResponse['deltaSource'] = 'none';
    if (input.prevIssues) { previousKeys = input.prevIssues.map(issueKey); deltaSource = 'client'; }
    else if (ref && input.iter > 1) {
      previousKeys = previousRoundKeys(ctx.db, account.id, ref, input.iter);
      if (previousKeys) deltaSource = 'cloud';
    }
    const summary = buildSummary({ ...input, previousKeys, deltaSource });
    if (ref) {
      const keys = [...(input.sections?.issues ?? []), ...(input.interactions?.issues ?? [])].map(issueKey);
      saveRound(ctx.db, { accountId: account.id, deviceId: device.id, buildRef: ref, iter: input.iter, score: summary.score, subscores: { ...summary.subscores }, issueKeys: keys, captureFailed: summary.captureFailed }, ctx.now());
    }
    response.json(summary);
  }));

  router.post('/calibrate', handle((request, response) => {
    const input = clean.calibrateRequest(bodyOf(request));
    charge(response, calibrateWork(input));
    response.json(calibrate(input));
  }));

  return router;
}

/**
 * Mounts the QA API at /v1/qa (and creates its table). Call it in createCloud() BEFORE
 * `app.use(express.json({ limit: '16kb' }))`, next to the webhooks router.
 */
export function registerQaRoutes(app: Express, ctx: CloudContext) {
  ensureQaSchema(ctx.db);
  app.use('/v1/qa', qaRouter(ctx));
}
