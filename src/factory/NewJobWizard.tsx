import { Fragment, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Eye, EyeOff, Globe, KeyRound, Rocket, Settings2, ShieldCheck, XCircle } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Field, Input, Select, Separator, Slider, Spinner, Switch, useToast } from './ui';
import { api } from './api';
import { ChromeKeysCard, SetupChecklist, SetupVideoCard } from './SetupChecklist';
import type { CredCheckResult, FactorySettings, FactoryStore } from './types';

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const derivePrefix = (name: string) => {
  const words = name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  return (words.length >= 2 ? words.slice(0, 3).map((word) => word[0]).join('') : (words[0] ?? '').slice(0, 3)).slice(0, 3);
};
/** Accepts every way users actually paste a store: the *.myshopify.com domain, a full admin URL
 *  (https://admin.shopify.com/store/<handle>/...), a storefront URL, or just the bare handle. */
const normalizeShopInput = (value: string) => {
  const stripped = value.trim().replace(/^https?:\/\//i, '');
  const adminMatch = stripped.match(/^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/i);
  if (adminMatch) return `${adminMatch[1].toLowerCase()}.myshopify.com`;
  const host = stripped.replace(/\/.*$/, '');
  if (/^[a-z0-9][a-z0-9-]*$/i.test(host)) return `${host.toLowerCase()}.myshopify.com`; // bare handle
  return host;
};

/** Wizard draft persisted to localStorage so tab switches / reloads don't lose entries.
 *  Secrets (clientSecret, storefrontPassword) are intentionally NEVER persisted —
 *  savedStoreId is safe to persist: it's only a reference, the secret stays server-side. */
const DRAFT_KEY = 'factory-wizard-draft';
type WizardDraft = {
  step: number; name: string; reactUrl: string; storeUrl: string; reactFilesPath: string; clientId: string;
  savedStoreId: string | null;
  prefix: string; prefixTouched: boolean; devThemeName: string; autoswap: boolean;
  autoQa: boolean; qaMode: string; qaEngine: string; maxIterations: number; threshold: number;
};
const loadDraft = (): Partial<WizardDraft> | null => {
  try { const raw = localStorage.getItem(DRAFT_KEY); return raw ? JSON.parse(raw) as Partial<WizardDraft> : null; } catch { return null; }
};

/** Dashboard resume-card support: summary of any meaningful in-progress draft (null when empty). */
export function getWizardDraft(): { name: string; step: number } | null {
  const draft = loadDraft();
  if (!draft) return null;
  const meaningful = [draft.name, draft.reactUrl, draft.storeUrl, draft.clientId].some((value) => (value ?? '').trim());
  if (!meaningful) return null;
  return { name: (draft.name ?? '').trim() || 'Untitled clone', step: Math.min((draft.step ?? 0) + 1, 3) };
}
export function clearWizardDraft() { localStorage.removeItem(DRAFT_KEY); }

const STEPS = [
  { label: 'Sources', icon: <Globe className="size-4" /> },
  { label: 'Credentials', icon: <KeyRound className="size-4" /> },
  { label: 'Options & launch', icon: <Settings2 className="size-4" /> },
];

function Stepper({ step, onJump }: { step: number; onJump: (index: number) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-y-3">
      {STEPS.map((entry, index) => (
        <Fragment key={entry.label}>
          {index > 0 && (
            <div className="mx-3 h-0.5 w-8 overflow-hidden rounded-full bg-border sm:w-12" aria-hidden>
              <div className={`h-full origin-left bg-primary transition-transform duration-500 ease-out ${index <= step ? 'scale-x-100' : 'scale-x-0'}`} />
            </div>
          )}
          <button
            type="button" onClick={() => { if (index < step) onJump(index); }} aria-disabled={index > step || undefined}
            aria-current={index === step ? 'step' : undefined}
            className={`flex items-center gap-2.5 rounded-lg px-1 py-0.5 transition-opacity ${index < step ? 'cursor-pointer hover:opacity-75' : index > step ? 'cursor-not-allowed' : 'cursor-default'}`}
            title={index < step ? `Back to ${entry.label}` : index > step ? 'Locked — complete the current step to unlock' : undefined}
          >
            <span className={`flex size-9 items-center justify-center rounded-full text-[14px] font-bold transition-all duration-300 ${
              index < step ? 'bg-primary text-primary-foreground'
              : index === step ? 'bg-primary text-primary-foreground shadow-md ring-4 ring-primary/15'
              : 'bg-muted text-muted-foreground'}`}>
              {index < step ? <Check className="size-4.5" /> : index + 1}
            </span>
            <span className={`text-[14px] font-bold ${index === step ? 'text-foreground' : 'text-muted-foreground'}`}>{entry.label}</span>
          </button>
        </Fragment>
      ))}
      <span className="ml-auto hidden text-[13px] font-semibold text-muted-foreground sm:block">Step {step + 1} of {STEPS.length}</span>
    </div>
  );
}

export function NewJobWizard({ defaults, onCreated, onCancel }: { defaults: FactorySettings | null; onCreated: () => void; onCancel?: () => void }) {
  const toast = useToast();
  const [stored] = useState(loadDraft);
  const [step, setStep] = useState(stored?.step ?? 0);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(false);

  // Step 1 — sources
  const [name, setName] = useState(stored?.name ?? '');
  const [reactUrl, setReactUrl] = useState(stored?.reactUrl ?? '');
  const [storeUrl, setStoreUrl] = useState(stored?.storeUrl ?? '');
  const [storefrontPassword, setStorefrontPassword] = useState('');
  const [reactFilesPath, setReactFilesPath] = useState(stored?.reactFilesPath ?? '');
  const [reactFilesCheck, setReactFilesCheck] = useState<{ ok: boolean; detail?: string } | null>(null);

  // Step 2 — credentials
  const [clientId, setClientId] = useState(stored?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState<'conn' | 'push' | null>(null);
  const [credCheck, setCredCheck] = useState<CredCheckResult | null>(null);
  // Saved stores (lazy onboarding): enter credentials once, pick from the list forever after.
  const [stores, setStores] = useState<FactoryStore[]>([]);
  const [savedStoreId, setSavedStoreId] = useState<string | null>(stored?.savedStoreId ?? null);
  const [rememberStore, setRememberStore] = useState(true);
  // Bot-delivery success screen + field highlight, and the keys-everywhere purge flow.
  const [keysSuccess, setKeysSuccess] = useState(false);
  const [fieldFlash, setFieldFlash] = useState(false);
  const [purgeConfirm, setPurgeConfirm] = useState(false);
  const [purging, setPurging] = useState(false);

  // Step 3 — options
  const [prefix, setPrefix] = useState(stored?.prefix ?? '');
  const [prefixTouched, setPrefixTouched] = useState(stored?.prefixTouched ?? false);
  const [devThemeName, setDevThemeName] = useState(stored?.devThemeName ?? '');
  const [autoswap, setAutoswap] = useState(stored?.autoswap ?? false);
  const [autoswapConfirm, setAutoswapConfirm] = useState(false);
  const [autoQa, setAutoQa] = useState(stored?.autoQa ?? true);
  const [qaMode, setQaMode] = useState(stored?.qaMode ?? 'both');
  const [qaEngine, setQaEngine] = useState(stored?.qaEngine ?? 'playwright');
  const [browser, setBrowser] = useState<{ ready: boolean; hasChromium: boolean; installing: boolean } | null>(null);
  const [maxIterations, setMaxIterations] = useState(stored?.maxIterations ?? defaults?.defaultMaxIterations ?? 5);
  const [threshold, setThreshold] = useState(stored?.threshold ?? defaults?.defaultScoreThreshold ?? 0.92);

  // Persist the draft on every change (cleared on successful queue or explicit discard).
  useEffect(() => {
    const draft: WizardDraft = { step, name, reactUrl, storeUrl, reactFilesPath, clientId, savedStoreId, prefix, prefixTouched, devThemeName, autoswap, autoQa, qaMode, qaEngine, maxIterations, threshold };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [step, name, reactUrl, storeUrl, reactFilesPath, clientId, savedStoreId, prefix, prefixTouched, devThemeName, autoswap, autoQa, qaMode, qaEngine, maxIterations, threshold]);

  useEffect(() => { if (!prefixTouched) setPrefix(derivePrefix(name)); }, [name, prefixTouched]);
  useEffect(() => { if (!devThemeName && name) setDevThemeName(`${name} Clone (dev)`); }, [name, devThemeName]);
  useEffect(() => { if (autoQa) void api.browserStatus().then((status) => setBrowser(status)).catch(() => setBrowser(null)); }, [autoQa, step]);
  useEffect(() => { void api.listStores().then((result) => setStores(result.stores)).catch(() => setStores([])); }, []);

  // Debounced react_files existence check
  useEffect(() => {
    if (!reactFilesPath) { setReactFilesCheck(null); return; }
    const timer = setTimeout(() => { void api.validate('reactFiles', reactFilesPath).then(setReactFilesCheck).catch(() => setReactFilesCheck(null)); }, 500);
    return () => clearTimeout(timer);
  }, [reactFilesPath]);

  const normalizedShop = useMemo(() => normalizeShopInput(storeUrl), [storeUrl]);
  const savedStore = useMemo(() => (savedStoreId ? stores.find((store) => store.id === savedStoreId) ?? null : null), [savedStoreId, stores]);
  const urlValid = useMemo(() => { try { const url = new URL(reactUrl); return /^https?:$/.test(url.protocol); } catch { return false; } }, [reactUrl]);
  const shopValid = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(normalizedShop);
  const idValid = /^[0-9a-f]{32}$/i.test(clientId.trim());
  const secretValid = /^shpss_/.test(clientSecret.trim());
  const prefixValid = /^[a-z][a-z0-9]{1,2}$/.test(prefix);

  const step1Ready = name.trim().length > 0 && urlValid && shopValid && (!reactFilesPath || reactFilesCheck?.ok === true);
  // A picked saved store already holds a validated secret server-side — nothing more to type.
  const step2Ready = savedStoreId ? true : idValid && secretValid;
  const step3Ready = prefixValid && devThemeName.trim().length > 0;

  const pickSavedStore = (id: string) => {
    setSavedStoreId(id || null);
    setCredCheck(null);
    if (!id) return;
    const store = stores.find((entry) => entry.id === id);
    if (store) { setStoreUrl(store.shop_domain); setClientId(store.client_id); setClientSecret(''); }
  };

  // Editing the store URL away from the picked saved store detaches it (the saved secret
  // would no longer match the target — the server rejects that mismatch anyway).
  const changeStoreUrl = (value: string) => {
    setStoreUrl(value);
    if (savedStore && normalizeShopInput(value).toLowerCase() !== savedStore.shop_domain) setSavedStoreId(null);
  };

  // canary=true additionally proves write access end-to-end (writes + deletes a harmless
  // snippet on the main theme). With a saved store the secret is used server-side.
  const testConnection = async (canary: boolean) => {
    setTesting(canary ? 'push' : 'conn');
    try {
      const result = savedStoreId
        ? await api.testStore(savedStoreId, canary)
        : await api.validateCreds(normalizedShop, clientId.trim(), clientSecret.trim(), canary);
      setCredCheck(result);
    } catch (error) { setCredCheck({ ok: false, detail: error instanceof Error ? error.message : 'Request failed' }); }
    finally { setTesting(null); }
  };

  // Next/Queue never fail silently: an invalid attempt flags empty required fields inline.
  const goNext = () => {
    if (step === 0 ? !step1Ready : !step2Ready) { setAttempted(true); return; }
    setAttempted(false);
    setStep((value) => value + 1);
  };
  const trySubmit = () => {
    if (!step1Ready || !step2Ready || !step3Ready) { setAttempted(true); return; }
    void submit();
  };

  const dirty = !!(name || reactUrl || storeUrl || storefrontPassword || reactFilesPath || clientId || clientSecret || devThemeName || prefixTouched || autoswap || autoQa !== true || step > 0);
  const resetWizard = () => {
    localStorage.removeItem(DRAFT_KEY);
    setStep(0); setAttempted(false);
    setName(''); setReactUrl(''); setStoreUrl(''); setStorefrontPassword(''); setReactFilesPath(''); setReactFilesCheck(null);
    setClientId(''); setClientSecret(''); setCredCheck(null); setSavedStoreId(null);
    setPrefix(''); setPrefixTouched(false); setDevThemeName(''); setAutoswap(false);
    setAutoQa(true); setQaMode('both'); setQaEngine('playwright');
    setMaxIterations(defaults?.defaultMaxIterations ?? 5); setThreshold(defaults?.defaultScoreThreshold ?? 0.92);
  };

  const submit = async () => {
    setBusy(true);
    try {
      // Lazy onboarding: stash the store's credentials (encrypted) so the next job is a
      // dropdown pick. Best-effort — a failed save must never block the clone itself.
      if (rememberStore && !savedStoreId) {
        try { await api.saveStore({ storeUrl: normalizedShop, clientId: clientId.trim(), clientSecret: clientSecret.trim(), storefrontPassword: storefrontPassword || undefined }); }
        catch { /* non-fatal by design */ }
      }
      await api.createJob({
        name: name.trim(), reactUrl: reactUrl.trim(), storeUrl: normalizedShop,
        clientId: clientId.trim(), clientSecret: savedStoreId ? '' : clientSecret.trim(),
        savedStoreId: savedStoreId ?? undefined,
        storefrontPassword: storefrontPassword || undefined,
        reactFilesPath: reactFilesPath || undefined,
        prefix, devThemeName: devThemeName.trim(), autoswap, autoQa, qaMode, qaEngine,
        maxIterations, scoreThreshold: threshold,
      });
      localStorage.removeItem(DRAFT_KEY);
      setClientId(''); setClientSecret(''); setStorefrontPassword(''); // never keep secrets in form state
      toast.push({ title: 'Clone job queued', detail: `"${name.trim()}" starts as soon as a slot is free.`, variant: 'success' });
      onCreated();
    } catch (error) {
      toast.push({ title: 'Could not create the job', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    } finally { setBusy(false); }
  };

  /** Close the success screen and take the user straight to the (now filled) key fields. */
  const revealFilledKeys = () => {
    setKeysSuccess(false);
    document.getElementById('wizard-client-id')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFieldFlash(true);
    window.setTimeout(() => setFieldFlash(false), 2600);
  };

  /** "Change key": unlock manual entry — clears the stored selection + fields for a fresh paste. */
  const changeKey = () => {
    setSavedStoreId(null); setClientId(''); setClientSecret(''); setCredCheck(null);
    document.getElementById('wizard-client-id')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast.push({ title: 'Enter the new keys', detail: 'Paste the new Client ID and Secret, then run Test connection.', variant: 'default' });
  };

  /** Remove this store's credentials from every place ThemeBot keeps anything. */
  const purgeKeys = async () => {
    setPurging(true);
    try {
      const result = await api.purgeKeys(normalizedShop);
      setSavedStoreId(null); setClientId(''); setClientSecret(''); setCredCheck(null);
      const refreshed = await api.listStores().catch(() => ({ stores: [] as FactoryStore[] }));
      setStores(refreshed.stores);
      toast.push({ title: 'Keys removed everywhere', detail: `${result.stores} saved store(s), ${result.jobs} job(s), and ${result.files} API.txt file(s) wiped.`, variant: 'success' });
    } catch (error) {
      toast.push({ title: 'Purge failed', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    } finally { setPurging(false); setPurgeConfirm(false); }
  };

  const keysOnFile = Boolean(savedStoreId) || (idValid && secretValid);

  return (
    <div className="relative mx-auto flex w-full max-w-2xl flex-col gap-6">
      {/* Pinned setup video (mobile-first): hidden by default — on small screens the video stays
          reachable via the checklist's "Prefer watching?" row + modal. From ~1330px CSS width up,
          it appears viewport-FIXED in the empty space left of the form (scrolling never moves it),
          with a clamped width — left-52 clears the sidebar, calc keeps it off the form column. */}
      <aside className="fixed hidden w-[calc(50vw-32rem)] max-w-80 min-[1380px]:block" style={{ left: '17.5rem', top: '8.5rem' }}>
        <SetupVideoCard />
      </aside>
      <div className="rise-in">
        <h2 className="text-2xl font-bold tracking-tight">Create a clone job</h2>
        <p className="mt-1 text-[14.5px] font-medium leading-relaxed text-muted-foreground">Point the factory at a React site and a Shopify store — it clones, QAs, and fixes until they match.</p>
      </div>

      <Stepper step={step} onJump={setStep} />

      {step === 0 && (
        <Card key="step-0" className="rise-in">
          <CardHeader>
            <CardTitle>Where is the design, and where does it go?</CardTitle>
            <CardDescription>The React site is the source of truth. The factory clones it into the Shopify store's dev theme.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field label="Project name" error={attempted && !name.trim() ? 'Required' : null} help={name ? `Workspace folder: ${slugify(name) || '—'}` : 'Used for the workspace folder and dev theme name.'}>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Wild & Sacred" autoFocus aria-invalid={attempted && !name.trim() || undefined} />
            </Field>
            <Field label="React site URL (source of truth)" error={reactUrl && !urlValid ? 'Enter a full http(s):// URL.' : attempted && !reactUrl.trim() ? 'Required' : null}>
              <Input value={reactUrl} onChange={(event) => setReactUrl(event.target.value)} placeholder="https://wild-sacred.vercel.app" inputMode="url" aria-invalid={(attempted && !reactUrl.trim()) || (!!reactUrl && !urlValid) || undefined} />
            </Field>
            <Field label="Shopify store" error={storeUrl && !shopValid ? 'Must be a *.myshopify.com domain.' : attempted && !storeUrl.trim() ? 'Required' : null} ok={shopValid ? `Targets ${normalizedShop}` : null}>
              <Input value={storeUrl} onChange={(event) => changeStoreUrl(event.target.value)} placeholder="wild-sacred.myshopify.com" aria-invalid={(attempted && !storeUrl.trim()) || (!!storeUrl && !shopValid) || undefined} />
            </Field>
            <Field label="Storefront password (optional)" help={savedStore?.has_storefront_password ? 'A storefront password is saved with this store — leave blank to reuse it.' : "Only needed when the store's online storefront is password-protected — QA uses it to get past the wall. Dev stores are always password-protected."}>
              <Input type="password" value={storefrontPassword} onChange={(event) => setStorefrontPassword(event.target.value)} placeholder="•••••" autoComplete="off" />
            </Field>
            <Field
              label="React source folder (optional)"
              error={reactFilesPath && reactFilesCheck && !reactFilesCheck.ok ? reactFilesCheck.detail ?? 'Invalid folder' : null}
              ok={reactFilesPath && reactFilesCheck?.ok ? reactFilesCheck.detail ?? 'Looks good' : null}
              help="Local path to the React project source (with package.json). Leave blank if the workspace folder already contains react_files/."
            >
              <Input value={reactFilesPath} onChange={(event) => setReactFilesPath(event.target.value)} placeholder="C:\intake\wild-sacred" spellCheck={false} />
            </Field>
          </CardContent>
        </Card>
      )}

      {step === 1 && (
        <Card key="step-1" className="rise-in">
          <CardHeader>
            <CardTitle>Shopify custom-app credentials</CardTitle>
            <CardDescription>From the Dev Dashboard (dev.shopify.com): your app → Settings tab → Client ID &amp; Client Secret. The factory mints short-lived tokens from these; they are stored encrypted and never leave this machine.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <ChromeKeysCard
              storeUrl={normalizedShop}
              projectName={name.trim()}
              keysOnFile={keysOnFile}
              onChangeKey={changeKey}
              onRemoveKeys={() => setPurgeConfirm(true)}
              onKeys={({ clientId: gotId, clientSecret: gotSecret }) => {
                if (gotId) setClientId(gotId);
                if (gotSecret) setClientSecret(gotSecret);
                if (gotId && gotSecret) { setSavedStoreId(null); setCredCheck(null); setKeysSuccess(true); }
                else if (gotId || gotSecret) { setSavedStoreId(null); setCredCheck(null); toast.push({ title: 'Partial delivery', detail: 'Check the fields below — one key still needs a manual paste.', variant: 'default' }); }
              }}
            />
            <SetupChecklist />
            {stores.length > 0 && (
              <Field label="Saved stores" help="Pick one to skip re-entering credentials — the secret is pulled from encrypted storage server-side.">
                <Select value={savedStoreId ?? ''} onChange={(event) => pickSavedStore(event.target.value)} aria-label="Saved stores">
                  <option value="">Enter new credentials…</option>
                  {stores.map((store) => <option key={store.id} value={store.id}>{store.label} ({store.shop_domain})</option>)}
                </Select>
              </Field>
            )}
            <Field label="Client ID" error={clientId && !idValid ? 'Expected a 32-character hex string.' : attempted && !clientId.trim() && !savedStoreId ? 'Required' : null}>
              <Input id="wizard-client-id" value={clientId} onChange={(event) => { setClientId(event.target.value); setCredCheck(null); }} placeholder="186c0a1b…" spellCheck={false} autoComplete="off" disabled={!!savedStoreId} className={fieldFlash ? 'ring-2 ring-success ring-offset-2' : undefined} aria-invalid={(attempted && !clientId.trim() && !savedStoreId) || (!!clientId && !idValid) || undefined} />
            </Field>
            {savedStoreId ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-success/30 bg-success/5 p-3.5">
                <p className="text-[13px] font-medium leading-relaxed text-muted-foreground">
                  <span className="font-bold text-foreground">Client Secret stored encrypted.</span>
                  {' '}Used automatically — nothing to paste.{savedStore?.has_storefront_password ? ' A storefront password is saved with this store too.' : ''}
                </p>
                <Button variant="ghost" size="sm" onClick={() => pickSavedStore('')}>Use different credentials</Button>
              </div>
            ) : (
              <Field label="Client Secret" error={clientSecret && !secretValid ? 'Expected a value starting with shpss_.' : attempted && !clientSecret.trim() ? 'Required' : null}>
                <div className="relative">
                  <Input type={showSecret ? 'text' : 'password'} value={clientSecret} onChange={(event) => { setClientSecret(event.target.value); setCredCheck(null); }} placeholder="shpss_…" spellCheck={false} autoComplete="off" className={`pr-11 ${fieldFlash ? 'ring-2 ring-success ring-offset-2' : ''}`} aria-invalid={(attempted && !clientSecret.trim()) || (!!clientSecret && !secretValid) || undefined} />
                  <button
                    type="button" onClick={() => setShowSecret((value) => !value)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={showSecret ? 'Hide secret' : 'Show secret'}
                  >
                    {showSecret ? <EyeOff className="size-4.5" /> : <Eye className="size-4.5" />}
                  </button>
                </div>
              </Field>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void testConnection(false)} disabled={!step2Ready || testing !== null}>
                {testing === 'conn' ? <Spinner /> : <ShieldCheck />} Test connection
              </Button>
              <Button variant="outline" onClick={() => void testConnection(true)} disabled={!step2Ready || testing !== null} title="Writes and immediately deletes a harmless snippet on the store's main theme, proving the factory can push.">
                {testing === 'push' ? <Spinner /> : <Rocket />} Test push access
              </Button>
            </div>
            {credCheck && (
              <div className={`rise-in rounded-xl border p-4 ${credCheck.ok ? 'border-success/30 bg-success/5' : 'border-destructive/30 bg-destructive/5'}`}>
                <p className="flex items-center gap-2 text-[14px] font-bold">
                  {credCheck.ok ? <CheckCircle2 className="size-4.5 shrink-0 text-success" /> : <XCircle className="size-4.5 shrink-0 text-destructive" />}
                  {credCheck.ok ? `Connected${credCheck.shopName ? ` to "${credCheck.shopName}"` : ''} — required scopes granted` : credCheck.detail ?? 'Connection failed'}
                </p>
                {credCheck.scopes && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {credCheck.scopes.required.map((entry) => <Badge key={entry.scope} variant={entry.granted ? 'success' : 'destructive'}>{entry.granted ? '✓' : '✗'} {entry.scope}</Badge>)}
                    {credCheck.scopes.recommended.map((entry) => <Badge key={entry.scope} variant={entry.granted ? 'success' : 'warning'}>{entry.granted ? '✓' : '~'} {entry.scope}</Badge>)}
                  </div>
                )}
                {credCheck.push && (
                  <p className={`mt-3 flex items-center gap-2 text-[13px] font-bold ${credCheck.push.ok ? 'text-success' : 'text-destructive'}`}>
                    {credCheck.push.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
                    Push access: {credCheck.push.detail}
                  </p>
                )}
                {credCheck.scopes?.recommended.some((entry) => !entry.granted) && (
                  <p className="mt-3 text-[13px] font-medium leading-relaxed text-muted-foreground">Amber scopes are recommended: without them, menus/pages/blog setup may write BLOCKED.md mid-run. Add them in the Dev Dashboard, release, and re-install.</p>
                )}
              </div>
            )}
            {!savedStoreId && credCheck?.ok && (
              <div className="rise-in flex items-center justify-between gap-4 rounded-xl bg-muted/60 p-3.5">
                <p className="text-[13px] font-medium leading-relaxed text-muted-foreground">
                  <span className="font-bold text-foreground">Remember this store.</span> Credentials are encrypted and reused on future jobs — next time this whole step is one dropdown pick.
                </p>
                <Switch checked={rememberStore} onCheckedChange={setRememberStore} aria-label="Remember this store for future jobs" />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card key="step-2" className="rise-in">
          <CardHeader>
            <CardTitle>Options</CardTitle>
            <CardDescription>Sensible defaults from Settings — override per job as needed.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Section prefix (2-3 chars)" error={prefix && !prefixValid ? 'Lowercase, 2-3 chars, starts with a letter.' : attempted && !prefix.trim() ? 'Required' : null}>
                <Input value={prefix} onChange={(event) => { setPrefix(event.target.value.toLowerCase()); setPrefixTouched(true); }} maxLength={3} spellCheck={false} aria-invalid={(attempted && !prefix.trim()) || (!!prefix && !prefixValid) || undefined} />
              </Field>
              <Field label="Dev theme name" error={attempted && !devThemeName.trim() ? 'Required' : null}>
                <Input value={devThemeName} onChange={(event) => setDevThemeName(event.target.value)} aria-invalid={attempted && !devThemeName.trim() || undefined} />
              </Field>
            </div>
            <Separator />
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[15px] font-bold">Auto-QA convergence loop</p>
                <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-muted-foreground">After the clone, compare both sites and auto-fix until they match.</p>
              </div>
              <Switch checked={autoQa} onCheckedChange={setAutoQa} aria-label="Auto-QA convergence loop" />
            </div>
            {autoQa && (
              <div className="rise-in flex flex-col gap-5">
                <Field label="QA workflows">
                  <Select value={qaMode} onChange={(event) => setQaMode(event.target.value)}>
                    <option value="both">Sections + interactions (recommended)</option>
                    <option value="sections">Section comparison only</option>
                    <option value="interactions">Interaction click-verify only</option>
                  </Select>
                </Field>
                <Field label="QA browser engine" help="Playwright runs headless and fully autonomous. Visible mode opens a real Chrome window so you can watch it click through every element.">
                  <Select value={qaEngine} onChange={(event) => setQaEngine(event.target.value)}>
                    <option value="playwright">Playwright — headless, autonomous (recommended)</option>
                    <option value="headed">Visible browser — watch it run</option>
                  </Select>
                </Field>
                {browser && !browser.ready && (
                  <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
                    <p className="text-[14px] font-bold text-warning">QA browser not installed</p>
                    <p className="mt-1 text-[13px] font-medium leading-relaxed text-muted-foreground">The Playwright Chromium build QA drives isn't present yet. Install it once (~150 MB) so QA can run.</p>
                    <Button size="sm" variant="outline" className="mt-3" disabled={browser.installing} onClick={async () => { await api.installBrowser(); setBrowser({ ...browser, installing: true }); toast.push({ title: 'Installing QA browser…', detail: 'Downloading Chromium — this runs in the background.', variant: 'default' }); }}>
                      {browser.installing ? <Spinner /> : <ShieldCheck />} {browser.installing ? 'Installing…' : 'Install QA browser'}
                    </Button>
                  </div>
                )}
                {browser?.ready && <p className="flex items-center gap-2 text-[13px] font-bold text-success"><CheckCircle2 className="size-4" /> QA browser ready</p>}
                <Field label="Max fix iterations">
                  <Slider value={maxIterations} onValueChange={setMaxIterations} min={1} max={10} />
                </Field>
                <Field label="Convergence threshold" help="The loop stops once the composite match score reaches this.">
                  <Slider value={threshold} onValueChange={setThreshold} min={0.5} max={1} step={0.01} format={(value) => `${Math.round(value * 100)}%`} />
                </Field>
              </div>
            )}
            <Separator />
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[15px] font-bold">Auto-swap to live theme</p>
                <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-muted-foreground">After passing checks, push to the PUBLISHED theme. Off = everything stays on the dev theme.</p>
              </div>
              <Switch checked={autoswap} onCheckedChange={(value) => value ? setAutoswapConfirm(true) : setAutoswap(false)} aria-label="Auto-swap to live theme" />
            </div>

            <Separator />
            <div className="rounded-xl bg-muted/60 p-4 text-[13px] font-medium leading-6 text-muted-foreground">
              <p className="text-[13px] font-bold uppercase tracking-[0.1em] text-foreground">Review</p>
              <p className="mt-1.5">{name || '—'} · {reactUrl || '—'} → {normalizedShop || '—'}</p>
              <p>prefix <code className="rounded bg-secondary px-1 py-0.5 text-foreground">{prefix || '—'}-</code> · dev theme "{devThemeName || '—'}" · {autoQa ? `QA ${qaMode} (${qaEngine === 'headed' ? 'visible browser' : 'headless'}), ≤${maxIterations} iterations, target ${Math.round(threshold * 100)}%` : 'QA off'} · {autoswap ? 'auto-swap ON' : 'stays on dev theme'}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => { if (dirty) setDiscardConfirm(true); else { resetWizard(); onCancel?.(); } }} disabled={busy}>Cancel</Button>
          <Button variant="ghost" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0 || busy}><ArrowLeft /> Back</Button>
        </div>
        {step < 2
          ? <Button onClick={goNext}>Next <ArrowRight /></Button>
          : <Button size="lg" onClick={trySubmit} disabled={busy}>{busy ? <Spinner className="text-primary-foreground" /> : <Rocket />} Queue clone job</Button>}
      </div>

      <ConfirmDialog
        open={discardConfirm}
        title="Discard this clone draft?"
        description="Everything you've entered is cleared and the saved draft is removed — this can't be undone."
        confirmLabel="Discard draft" destructive
        onCancel={() => setDiscardConfirm(false)}
        onConfirm={() => { setDiscardConfirm(false); resetWizard(); onCancel?.(); }}
      />

      <ConfirmDialog
        open={autoswapConfirm}
        title="Enable auto-swap to the live theme?"
        description="When the clone passes verification, its files are pushed to the store's PUBLISHED theme — customers see the result immediately, without a manual review step. Keep this off if a human should approve first."
        confirmLabel="Enable auto-swap" destructive
        onCancel={() => { setAutoswapConfirm(false); setAutoswap(false); }}
        onConfirm={() => { setAutoswapConfirm(false); setAutoswap(true); }}
      />

      <ConfirmDialog
        open={purgeConfirm}
        title={`Remove all keys for ${normalizedShop || 'this store'}?`}
        description="Deletes the saved store record (with its encrypted secret), wipes the credentials from every job targeting this store, rewrites those jobs' API.txt files, and clears the bot's memory. Running jobs for this store will no longer be able to mint tokens. This can't be undone — you'd have to fetch or paste the keys again."
        confirmLabel={purging ? 'Removing…' : 'Remove everywhere'} destructive
        onCancel={() => setPurgeConfirm(false)}
        onConfirm={() => { if (!purging) void purgeKeys(); }}
      />

      {/* Big bot-delivery success screen — then jump the user to the filled fields. */}
      {keysSuccess && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Keys collected" onClick={revealFilledKeys}>
          <div className="rise-in w-full max-w-md rounded-2xl border border-success/40 bg-card p-8 text-center shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <span className="mx-auto flex size-20 items-center justify-center rounded-full bg-success/10">
              <CheckCircle2 className="size-12 text-success" />
            </span>
            <h3 className="mt-4 text-2xl font-bold tracking-tight text-foreground">Keys collected! 🎉</h3>
            <p className="mt-2 text-[14px] font-medium leading-relaxed text-muted-foreground">
              The bot fetched the <b className="text-foreground">Client ID</b> and <b className="text-foreground">Client Secret</b> and filled them into this wizard.
              They're stored encrypted inside ThemeBot — never written to disk. Your project folder (with API.txt) is created when you launch the job in the next step.
            </p>
            <div className="mt-5 flex justify-center">
              <Button onClick={revealFilledKeys}><ShieldCheck /> Show me the keys</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
