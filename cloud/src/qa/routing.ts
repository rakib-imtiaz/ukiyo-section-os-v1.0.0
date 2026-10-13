// React route → Shopify path mapping, as the scorer needs it (link targets, "expected" hints,
// catalog 404 classification). The capture keeps its own copy to know which URL to open.
// Ported 1:1 from templates/factory/qa/qa-shared.mjs.

/** Map a React route to the Shopify storefront path (heuristics + handles.json overrides). */
export function computeShopifyPath(route: string, handles: Record<string, string> = {}): string | null {
  if (Object.prototype.hasOwnProperty.call(handles, route) && handles[route]) return handles[route];
  if (route === '/') return '/';
  if (route === '/blog' || route === '/journal') return null; // blog base needs the blog handle — supplied via handles.json
  // Catalog + blog routes share the same path space on Shopify — map them 1:1, never to /pages/.
  if (/^\/(products|collections|blogs)(\/|$)/.test(route)) return route;
  return `/pages/${route.replace(/^\//, '').replace(/\//g, '-')}`;
}

/**
 * True when a Shopify path lives in the catalog space (needs a seeded product/collection to
 * resolve). A 404 there means "catalog not seeded", not "clone forgot the page".
 */
export function isCatalogPath(shopifyPath: string | null | undefined): boolean {
  return /^\/(products|collections)\//.test(shopifyPath || '');
}

/** Tolerant parser for qa/state/handles.json — accepts several shapes the clone run may write. */
export function parseHandles(raw: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return map;
  const entries: unknown[] = Array.isArray(raw) ? raw : Object.entries(raw as Record<string, unknown>).map(([key, value]) => ({ key, value }));
  for (const entry of entries) {
    const item = entry as { route?: unknown; shopify_path?: unknown; handle?: unknown; key?: unknown; value?: unknown } | null;
    if (item && typeof item === 'object' && typeof item.route === 'string') {
      const handle = (item.shopify_path as string) || (item.handle ? `/pages/${String(item.handle)}` : null);
      if (handle) map[item.route] = handle.startsWith('/') ? handle : `/pages/${handle}`;
    } else if (item && typeof item.key === 'string' && typeof item.value === 'string') {
      const route = item.key.startsWith('/') ? item.key : null;
      if (route) map[route] = item.value.startsWith('/') ? item.value : `/pages/${item.value}`;
    }
  }
  return map;
}

/** A React href matches a Shopify href when equal, or when Shopify carries the mapped path. */
export function linkTargetMatches(reactHref: string | null | undefined, shopifyHref: string | null | undefined, handles: Record<string, string> = {}): boolean {
  if (!reactHref || !shopifyHref) return false;
  const clean = (href: string) => href.split(/[?#]/)[0].replace(/\/$/, '') || '/';
  const react = clean(reactHref);
  const shopify = clean(shopifyHref);
  if (/^https?:|^mailto:|^tel:/.test(react)) return react === shopify;
  if (react === shopify) return true;
  const expected = computeShopifyPath(react, handles);
  return expected != null && shopify === clean(expected);
}
