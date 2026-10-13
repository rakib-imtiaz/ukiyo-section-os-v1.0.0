// Wire format between the desktop capture scripts (templates/factory/qa-capture) and the Cloud QA
// scorer. Type-only: the desktop adapter (server/factory/qa-cloud.ts) imports these with
// `import type`, so no scoring code is ever bundled into the desktop app.

// ---- capture: page health ------------------------------------------------------------------

/** What the browser saw when it loaded one page (used to tell "capture failed" from "clone is wrong"). */
export interface SiteHealth {
  /** HTTP status of the main document; null when no response arrived. */
  status: number | null;
  /** Pathname after redirects (e.g. "/password" when a storefront lock redirected us). */
  finalPath: string | null;
  /** Navigation error message (timeout, connection refused, …). */
  navError: string | null;
  /** The storefront password form is still showing after the password was tried. */
  passwordGate: boolean;
  /** Visible text characters in <body>. */
  textLength: number;
  elementCount: number;
  /** img / video / picture / canvas / svg elements. */
  mediaCount: number;
  bodyHeight: number;
  title: string;
}

// ---- capture: raw layout dump (segmentation happens in the Cloud) --------------------------

/**
 * One content block of the page body. `parent` is -1 for the root's (main || body) children,
 * otherwise the id of the single wrapper it sits in. The capture descends single-child wrapper
 * chains (up to 3 levels) and applies no size rule — the Cloud decides what counts as a section.
 */
export interface LayoutBlock {
  id: number;
  parent: number;
  tag: string;
  /** Document coordinates (CSS px, unrounded). */
  x: number;
  y: number;
  w: number;
  h: number;
  childCount: number;
  headings: string[];
  text: string;
  imgCount: number;
  imgAlts: string[];
  linkCount: number;
  shapeHash: string;
}

export interface LayoutDump {
  /** window.innerWidth at capture time (the width rule is relative to it). */
  viewportWidth: number;
  root: 'main' | 'body';
  blocks: LayoutBlock[];
}

/** A section as the scorer sees it (identical to what the old in-page segmentSections returned). */
export interface Section {
  headings: string[];
  text: string;
  imgCount: number;
  imgAlts: string[];
  linkCount: number;
  shapeHash: string;
  childCount: number;
  bbox: { y: number; height: number };
}

// ---- sections ------------------------------------------------------------------------------

export interface CapturedReactPage { ok: boolean; status: number | null; health?: SiteHealth | null; layout?: LayoutDump | null }
export interface CapturedShopifyPage { status: number | null; health?: SiteHealth | null; layout?: LayoutDump | null }

/** One route of the sections capture. */
export interface SectionsCaptureRoute {
  route: string;
  /** The Shopify path the capture visited (null = no mapping, e.g. a blog base without handles). */
  shopifyPath: string | null;
  react?: CapturedReactPage | null;
  shopify?: CapturedShopifyPage | null;
  /** Unexpected capture exception for this route. */
  error?: string | null;
}

export interface SectionsRequest {
  buildRef?: string;
  iter: number;
  reactBase: string;
  shopifyBase: string;
  routes: SectionsCaptureRoute[];
}

export interface QaIssue { id: string; kind: string; page: string; title: string; detail?: string }

export interface CaptureProblem { route: string; site: 'react' | 'shopify'; problem: string }

/** Present on a report only when something went wrong while capturing. */
export interface CaptureStatus {
  /** Nothing could be scored: report "capture failed", never a score. */
  failed: boolean;
  reason?: string;
  problems: CaptureProblem[];
}

export interface SectionsPageResult {
  route: string;
  shopifyPath?: string;
  status: string;
  reactSections?: number;
  matched?: number;
  missing?: number;
  extra?: number;
  textScore?: number | null;
  sections?: Array<{ react: string; order: [number, number]; textScore: number; structureMatch: boolean }>;
  reason?: string;
}

/** Same shape as qa/reports/factory/sections-<iter>.json (+ `capture` only when capture had problems). */
export interface SectionsReport {
  presence: number;
  text: number;
  catalogUnseeded: string[];
  pages: SectionsPageResult[];
  issues: QaIssue[];
  capture?: CaptureStatus;
}

// ---- interactions --------------------------------------------------------------------------

/** One clickable element from the in-page inventory (unchanged from interaction-verify.mjs). */
export interface InventoryItem {
  key: string;
  tag: string;
  name: string;
  ordinal: number;
  kind: 'link' | 'action';
  href: string | null;
  visible: boolean;
  region: 'header' | 'footer' | 'main';
  ariaExpanded: string | null;
  idClass: string;
  isSubmit: boolean;
}

export interface InteractionsCaptureRoute {
  route: string;
  shopifyPath: string | null;
  react?: { ok: boolean; status: number | null; health?: SiteHealth | null; items?: InventoryItem[] } | null;
  shopify?: { status: number | null; health?: SiteHealth | null; items?: InventoryItem[] } | null;
  error?: string | null;
}

export interface PlanRequest {
  buildRef?: string;
  iter: number;
  handles?: Record<string, string>;
  routes: InteractionsCaptureRoute[];
}

export interface ClickTarget { tag: string; name: string; ordinal: number }

/** A click the capture must perform, on both sites, in this order. */
export interface PlannedClick { i: number; route: string; shopifyPath: string; react: ClickTarget; shopify: ClickTarget }

export interface InteractionsPageResult {
  route: string;
  elements: number;
  tested: number;
  same: number;
  different: number;
  missing: number;
  clicked: number;
  verifiedStatic: number;
  untested: number;
  skippedClicks: number;
  status?: string;
  reason?: string;
}

export type PlanEvent = { issue: Omit<QaIssue, 'id'> } | { click: number; name: string };

export interface PlannedRoute { page: InteractionsPageResult; events: PlanEvent[] }

/** Returned by /v1/qa/interactions/plan; sent back unchanged with the effects. Signed by the Cloud. */
export interface ClickPlan {
  v: 1;
  iter: number;
  handles: Record<string, string>;
  routes: PlannedRoute[];
  clicks: PlannedClick[];
  capture?: CaptureStatus;
  sig?: string;
}

/** What one click did (unchanged from interaction-verify.mjs recordClickEffect). */
export interface ClickEffect {
  navigatedTo?: string | null;
  overlayAppeared?: boolean;
  domDelta?: number;
  ariaFlipped?: boolean;
  consoleErrors?: string[];
  networkCalls?: string[];
  noop?: boolean;
  error?: string;
  /** The capture's own commerce safety net refused to click this element. */
  refused?: boolean;
}

export interface ClickEffects { i: number; react: ClickEffect | null; shopify: ClickEffect | null }

export interface ScoreRequest {
  buildRef?: string;
  plan: ClickPlan;
  effects: ClickEffects[];
  reactBase: string;
  shopifyBase: string;
}

/** Same shape as qa/reports/factory/interactions-<iter>.json (+ `capture` only when capture had problems). */
export interface InteractionsReport {
  interaction: number;
  tested: number;
  same: number;
  untested: number;
  issues: QaIssue[];
  informational: QaIssue[];
  pages: InteractionsPageResult[];
  capture?: CaptureStatus;
}

// ---- summary -------------------------------------------------------------------------------

export interface ScoreWeights { presence: number; text: number; interaction: number }
export interface QaSubscores { presence: number | null; text: number | null; interaction: number | null }

export interface SummaryRequest {
  buildRef?: string;
  iter: number;
  jobName: string;
  scoreThreshold: number;
  sections: Pick<SectionsReport, 'presence' | 'text' | 'pages' | 'issues' | 'capture'> | null;
  interactions: Pick<InteractionsReport, 'interaction' | 'issues' | 'capture'> | null;
  /** Scoring issues of iteration N-1 (sections + interactions), for the "fixed since last time" list. */
  prevIssues?: Array<Pick<QaIssue, 'kind' | 'page' | 'title'>> | null;
  weights?: ScoreWeights;
  handlesMissing?: boolean;
}

export interface SummaryResponse {
  score: number;
  subscores: QaSubscores;
  breakdown: { issues: number; fixed: number; unreachable: number; pages: number; subscores: QaSubscores; handlesMissing: boolean; capture?: CaptureStatus };
  summaryMarkdown: string;
  issueCount: number;
  /** True when nothing could be measured: the caller must report a failed check, not this score. */
  captureFailed: boolean;
  captureProblems: CaptureProblem[];
  /** Where the fixed-issue delta came from. */
  deltaSource: 'client' | 'cloud' | 'none';
}

// ---- calibration ---------------------------------------------------------------------------

export interface CalibrateRequest {
  reference: { health?: SiteHealth | null; layout: LayoutDump };
  /** Defaults to the reference (a page compared with itself). */
  candidate?: { health?: SiteHealth | null; layout: LayoutDump } | null;
  mode?: string;
}

export interface CalibrateResponse {
  ok: boolean;
  score: number | null;
  subscores: QaSubscores | null;
  threshold: number;
  mode: string;
  sections?: { reference: number; candidate: number; matched: number };
  error?: string;
}
