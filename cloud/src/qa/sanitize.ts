// Request validation for the QA routes. Everything arrives from a customer's PC, so it is coerced
// into the exact shapes the scorer expects: strings are clipped to the lengths the capture already
// uses, numbers must be finite, and lists over their cap are refused (silently dropping routes or
// clicks would change the score).
import { CloudError } from '../context';
import type {
  CalibrateRequest, ClickEffect, ClickEffects, InteractionsCaptureRoute, InventoryItem, LayoutBlock, LayoutDump, QaIssue,
  ScoreWeights, SectionsCaptureRoute, SiteHealth, SummaryRequest,
} from './types';

export const QA_LIMITS = {
  routes: 300,
  blocksPerPage: 800,
  itemsPerPage: 3000,
  clicks: 6000,
  issues: 6000,
  handles: 2000,
} as const;

type Json = Record<string, unknown>;

const bad = (message: string) => new CloudError(400, 'BAD_REQUEST', message);
const tooMany = (what: string, max: number) => new CloudError(413, 'TOO_LARGE', `Too many ${what} (at most ${max}).`);

export const obj = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null);
const str = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
const optStr = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : null);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const int = (value: unknown) => Math.trunc(num(value));
const status = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1000 ? value : null);
const strList = (value: unknown, maxItems: number, maxLength: number) => (Array.isArray(value) ? value.slice(0, maxItems).filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.slice(0, maxLength)) : []);

function list(value: unknown, max: number, what: string): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw bad(`${what} must be a list.`);
  if (value.length > max) throw tooMany(what, max);
  return value;
}

export function iteration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100_000) throw bad('iter must be a positive whole number.');
  return value;
}

/** Optional build reference (the desktop job id): letters, digits and - _ . : only. */
export function buildRef(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value)) throw bad('buildRef must be a short id.');
  return value;
}

export function route(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 500) throw bad('Each route must be a path starting with "/".');
  return value;
}

/** A site base URL as given (only shown in the reports). */
export const base = (value: unknown) => str(value, 500);

export function handles(value: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  const source = obj(value);
  if (!source) return out;
  const entries = Object.entries(source);
  if (entries.length > QA_LIMITS.handles) throw tooMany('handles', QA_LIMITS.handles);
  for (const [key, mapped] of entries) {
    if (key.startsWith('/') && key.length <= 500 && typeof mapped === 'string' && mapped.length <= 500) out[key] = mapped;
  }
  return out;
}

export function weights(value: unknown): ScoreWeights | undefined {
  const source = obj(value);
  if (!source) return undefined;
  const weight = (entry: unknown) => (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 && entry <= 1000 ? entry : null);
  const presence = weight(source.presence); const text = weight(source.text); const interaction = weight(source.interaction);
  if (presence == null || text == null || interaction == null) throw bad('weights must have presence, text and interaction (non-negative numbers).');
  return { presence, text, interaction };
}

export function health(value: unknown): SiteHealth | null {
  const source = obj(value);
  if (!source) return null;
  return {
    status: status(source.status),
    finalPath: optStr(source.finalPath, 500),
    navError: optStr(source.navError, 300) || null,
    passwordGate: source.passwordGate === true,
    textLength: Math.max(0, int(source.textLength)),
    elementCount: Math.max(0, int(source.elementCount)),
    mediaCount: Math.max(0, int(source.mediaCount)),
    bodyHeight: Math.max(0, num(source.bodyHeight)),
    title: str(source.title, 200),
  };
}

function block(value: unknown): LayoutBlock | null {
  const source = obj(value);
  if (!source) return null;
  return {
    id: int(source.id), parent: int(source.parent), tag: str(source.tag, 20).toUpperCase(),
    x: num(source.x), y: num(source.y), w: num(source.w), h: num(source.h),
    childCount: Math.max(0, int(source.childCount)),
    headings: strList(source.headings, 10, 500),
    text: str(source.text, 4000),
    imgCount: Math.max(0, int(source.imgCount)),
    imgAlts: strList(source.imgAlts, 10, 300),
    linkCount: Math.max(0, int(source.linkCount)),
    shapeHash: str(source.shapeHash, 32),
  };
}

export function layout(value: unknown): LayoutDump | null {
  const source = obj(value);
  if (!source) return null;
  const blocks = list(source.blocks, QA_LIMITS.blocksPerPage, 'layout blocks').map(block).filter((entry): entry is LayoutBlock => Boolean(entry));
  return { viewportWidth: Math.max(0, num(source.viewportWidth)), root: source.root === 'main' ? 'main' : 'body', blocks };
}

export function sectionsRoutes(value: unknown): SectionsCaptureRoute[] {
  if (!Array.isArray(value)) throw bad('routes must be a list.');
  return list(value, QA_LIMITS.routes, 'routes').map((entry) => {
    const source = obj(entry);
    if (!source) throw bad('Each route must be an object.');
    const react = obj(source.react);
    const shopify = obj(source.shopify);
    return {
      route: route(source.route),
      shopifyPath: typeof source.shopifyPath === 'string' && source.shopifyPath ? source.shopifyPath.slice(0, 500) : null,
      react: react ? { ok: react.ok === true, status: status(react.status), health: health(react.health), layout: layout(react.layout) } : null,
      shopify: shopify ? { status: status(shopify.status), health: health(shopify.health), layout: layout(shopify.layout) } : null,
      error: optStr(source.error, 300) || null,
    };
  });
}

function item(value: unknown): InventoryItem | null {
  const source = obj(value);
  if (!source) return null;
  const tag = str(source.tag, 20);
  const name = str(source.name, 200);
  const ordinal = Math.max(1, int(source.ordinal));
  return {
    // The capture omits the key to save bytes; it is tag|lower-cased name|ordinal, as in the inventory.
    key: typeof source.key === 'string' ? source.key.slice(0, 600) : `${tag}|${name.toLowerCase()}|${ordinal}`,
    tag,
    name,
    ordinal,
    kind: source.kind === 'link' ? 'link' : 'action',
    href: optStr(source.href, 2000),
    visible: source.visible === true,
    region: source.region === 'header' || source.region === 'footer' ? source.region : 'main',
    ariaExpanded: optStr(source.ariaExpanded, 20),
    idClass: str(source.idClass, 200),
    isSubmit: source.isSubmit === true,
  };
}

const items = (value: unknown) => list(value, QA_LIMITS.itemsPerPage, 'inventory items').map(item).filter((entry): entry is InventoryItem => Boolean(entry));

export function interactionRoutes(value: unknown): InteractionsCaptureRoute[] {
  if (!Array.isArray(value)) throw bad('routes must be a list.');
  return list(value, QA_LIMITS.routes, 'routes').map((entry) => {
    const source = obj(entry);
    if (!source) throw bad('Each route must be an object.');
    const react = obj(source.react);
    const shopify = obj(source.shopify);
    return {
      route: route(source.route),
      shopifyPath: typeof source.shopifyPath === 'string' && source.shopifyPath ? source.shopifyPath.slice(0, 500) : null,
      react: react ? { ok: react.ok === true, status: status(react.status), health: health(react.health), items: items(react.items) } : null,
      shopify: shopify ? { status: status(shopify.status), health: health(shopify.health), items: items(shopify.items) } : null,
      error: optStr(source.error, 300) || null,
    };
  });
}

function effect(value: unknown): ClickEffect | null {
  const source = obj(value);
  if (!source) return null;
  const out: ClickEffect = {
    navigatedTo: optStr(source.navigatedTo, 2000) || null,
    overlayAppeared: source.overlayAppeared === true,
    domDelta: int(source.domDelta),
    ariaFlipped: source.ariaFlipped === true,
    consoleErrors: strList(source.consoleErrors, 3, 200),
    networkCalls: strList(source.networkCalls, 10, 300),
    noop: source.noop === true,
  };
  const error = optStr(source.error, 200);
  if (error) out.error = error;
  if (source.refused === true) out.refused = true;
  return out;
}

export function effects(value: unknown): ClickEffects[] {
  return list(value, QA_LIMITS.clicks, 'click effects').map((entry) => {
    const source = obj(entry) ?? {};
    return { i: int(source.i), react: effect(source.react), shopify: effect(source.shopify) };
  });
}

function issue(value: unknown): QaIssue | null {
  const source = obj(value);
  if (!source) return null;
  const out: QaIssue = { id: str(source.id, 40), kind: str(source.kind, 40), page: str(source.page, 500), title: str(source.title, 1000) };
  if (typeof source.detail === 'string') out.detail = source.detail.slice(0, 4000);
  return out;
}

const issues = (value: unknown) => list(value, QA_LIMITS.issues, 'issues').map(issue).filter((entry): entry is QaIssue => Boolean(entry));

function captureStatus(value: unknown) {
  const source = obj(value);
  if (!source) return undefined;
  const problems = list(source.problems, QA_LIMITS.routes * 4, 'capture problems').map((entry) => {
    const problem = obj(entry) ?? {};
    return { route: str(problem.route, 500), site: problem.site === 'shopify' ? 'shopify' as const : 'react' as const, problem: str(problem.problem, 300) };
  });
  const reason = optStr(source.reason, 300);
  return { failed: source.failed === true, ...(reason ? { reason } : {}), problems };
}

const unit = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function summaryRequest(body: Json): SummaryRequest {
  const sections = obj(body.sections);
  const interactions = obj(body.interactions);
  if (!sections && !interactions) throw bad('Send the sections report, the interactions report, or both.');
  const threshold = typeof body.scoreThreshold === 'number' && Number.isFinite(body.scoreThreshold) ? body.scoreThreshold : 0;
  return {
    iter: iteration(body.iter),
    jobName: str(body.jobName, 200),
    scoreThreshold: threshold,
    sections: sections ? {
      presence: unit(sections.presence), text: unit(sections.text),
      pages: list(sections.pages, QA_LIMITS.routes, 'pages').map((entry) => { const page = obj(entry) ?? {}; return { route: str(page.route, 500), status: str(page.status, 40) }; }),
      issues: issues(sections.issues),
      capture: captureStatus(sections.capture),
    } : null,
    interactions: interactions ? { interaction: unit(interactions.interaction), issues: issues(interactions.issues), capture: captureStatus(interactions.capture) } : null,
    prevIssues: Array.isArray(body.prevIssues) ? issues(body.prevIssues) : null,
    weights: weights(body.weights),
    handlesMissing: body.handlesMissing === true,
  };
}

export function calibrateRequest(body: Json): CalibrateRequest {
  const page = (value: unknown, label: string) => {
    const source = obj(value);
    const dump = source ? layout(source.layout) : null;
    if (!source || !dump) throw bad(`${label} must carry a layout dump.`);
    return { health: health(source.health), layout: dump };
  };
  const reference = page(body.reference ?? body.dump, 'reference');
  return {
    reference,
    candidate: body.candidate == null ? null : page(body.candidate, 'candidate'),
    mode: str(body.mode, 20) || 'fixture',
  };
}
