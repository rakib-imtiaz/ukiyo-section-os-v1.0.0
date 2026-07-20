// Headless credential collector — reads an existing app's Client ID + Secret over Shopify's
// Partner GraphQL API (the same `apiSecretKeys` field the Shopify CLI uses). No browser at all.
//
// IMPORTANT — unverified coverage: this targets the classic Partner API
// (partners.shopify.com/<org>/api). Whether apps created in the newer dev.shopify.com Dev
// Dashboard are visible here is not confirmed — the probe below reports what it actually finds,
// and the method fails cleanly with a clear note if the app isn't returned. This is the path the
// user wanted built specifically to test.

const PARTNER_API_VERSION = '2025-01';

export interface PartnerApiInput {
  partnerToken: string;
  orgId: string;
  shop: string;
  appName: string;
  /** Optional exact Client ID (API key) to disambiguate when several apps match. */
  clientIdHint?: string;
  log: (text: string) => void;
}

export interface CollectorResult {
  clientId: string | null;
  clientSecret: string | null;
  status: 'delivered' | 'partial' | 'failed';
  note: string | null;
}

interface PartnerApp {
  id?: string;
  title?: string;
  apiKey?: string;
  apiSecretKeys?: Array<{ secret?: string }>;
}

/** GraphQL endpoint. With an org id we hit the org-scoped Partner API; without one we fall back
 *  to the CLI GraphQL endpoint (which resolves the org from the token). */
function endpoint(orgId: string): string {
  return orgId
    ? `https://partners.shopify.com/${encodeURIComponent(orgId)}/api/${PARTNER_API_VERSION}/graphql.json`
    : 'https://partners.shopify.com/api/cli/graphql';
}

async function partnerQuery(orgId: string, token: string, query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint(orgId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token, Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Partner API rejected the token (401/403). Check the token and that it has app read access.');
  if (!response.ok) throw new Error(`Partner API returned HTTP ${response.status}.`);
  const json = await response.json().catch(() => null) as { data?: Record<string, unknown>; errors?: Array<{ message?: string }> } | null;
  if (!json) throw new Error('Partner API returned a non-JSON response.');
  if (json.errors?.length) throw new Error(`Partner API error: ${json.errors.map((e) => e.message).filter(Boolean).join('; ') || 'unknown'}`);
  return json.data ?? {};
}

/** Extract a plausible Client ID (32-hex) and Secret (shpss_…) from a Partner App node. */
function extract(app: PartnerApp): { clientId: string | null; clientSecret: string | null } {
  const clientId = typeof app.apiKey === 'string' && /^[0-9a-f]{32}$/i.test(app.apiKey) ? app.apiKey : null;
  const secret = app.apiSecretKeys?.map((k) => k?.secret).find((s) => typeof s === 'string' && s.startsWith('shpss_')) ?? null;
  return { clientId, clientSecret: secret ?? null };
}

export async function fetchAppSecretViaPartnerApi(input: PartnerApiInput): Promise<CollectorResult> {
  const { partnerToken, orgId, appName, clientIdHint, log } = input;

  // 1. Connectivity probe — confirm the token authenticates and learn how many apps are visible.
  log('Checking Partner API access…');
  const probe = await partnerQuery(orgId, partnerToken, `query { app: apps(first: 100) { edges { node { id title apiKey apiSecretKeys { secret } } } } }`)
    .catch((error) => { throw error instanceof Error ? error : new Error('Partner API probe failed.'); });

  const edges = (((probe.app as { edges?: Array<{ node?: PartnerApp }> })?.edges) ?? []).map((e) => e?.node).filter(Boolean) as PartnerApp[];
  if (!edges.length) {
    return { clientId: null, clientSecret: null, status: 'failed', note: 'The Partner API returned no apps for this token. Dev Dashboard apps may not be visible to the classic Partner API — use the bookmarklet or scripted bot instead.' };
  }
  log(`Partner API reachable — ${edges.length} app(s) visible.`);

  // 2. Match the target app: prefer the exact Client ID hint, else the project's `<name>_bot` title.
  const byHint = clientIdHint ? edges.find((a) => a.apiKey?.toLowerCase() === clientIdHint.toLowerCase()) : undefined;
  const byName = edges.find((a) => (a.title ?? '').trim().toLowerCase() === appName.toLowerCase());
  const app = byHint ?? byName;
  if (!app) {
    return { clientId: null, clientSecret: null, status: 'failed', note: `No app named "${appName}"${clientIdHint ? ' or matching the given Client ID' : ''} was found in this Partner org. Create it first (checklist), or paste its Client ID.` };
  }

  const { clientId, clientSecret } = extract(app);
  if (clientId && clientSecret) {
    log('Read Client ID + Secret from the Partner API.');
    return { clientId, clientSecret, status: 'delivered', note: null };
  }
  if (clientId && !clientSecret) {
    return { clientId, clientSecret: null, status: 'partial', note: 'Found the app and its Client ID, but the Partner API did not return a Client Secret for it.' };
  }
  return { clientId: null, clientSecret: null, status: 'failed', note: 'Found the app but could not read a valid Client ID / Secret from the Partner API response.' };
}
