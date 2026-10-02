import { Fragment, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, Eye, EyeOff, Globe, KeyRound, Rocket, Settings2, ShieldCheck, XCircle } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Field, Input, Select, Separator, Slider, Spinner, Switch, useToast } from './ui';
import { api } from './api';
import { ChromeKeysCard, SetupChecklist } from './SetupChecklist';
import { EasyFlow, clearEasyDraft, getEasyDraft, type ManualHandoff } from './EasyFlow';
import { QaChoice } from './QaChoice';
import { WatchVideoButton } from '../SetupVideo';
import type { CredCheckResult, FactorySettings, FactoryStore, QaEngine } from './types';

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

// ---------------------------------------------------------------------------------------------
// One flow for everyone (EasyFlow): website first, then the user chooses how the store is set up.
// Choosing "I'll do it manually" renders ExpertFlow below in embedded mode, with the website
// details carried over. MODE_KEY is legacy (the old up-front mode picker) and only cleared.
// ---------------------------------------------------------------------------------------------
const MODE_KEY = 'factory-wizard-mode';

/** Expert draft persisted to localStorage so tab switches / reloads don't lose entries.
 *  Secrets (clientSecret, storefrontPassword) are intentionally NEVER persisted —
 *  savedStoreId is safe to persist: it's only a reference, the secret stays server-side. */
const DRAFT_KEY = 'factory-wizard-draft';
type WizardDraft = {
  step: number; name: string; reactUrl: string; storeUrl: string; reactFilesPath: string; clientId: string;
  savedStoreId: string | null;
  prefix: string; prefixTouched: boolean; devThemeName: string; devThemeTouched: boolean; autoswap: boolean;
  autoQa: boolean; qaMode: string; qaEngine: string; maxIterations: number; threshold: number;
};
const loadDraft = (): Partial<WizardDraft> | null => {
  try { const raw = localStorage.getItem(DRAFT_KEY); return raw ? JSON.parse(raw) as Partial<WizardDraft> : null; } catch { return null; }
};

/** Dashboard resume-card support: summary of any meaningful in-progress draft (null when empty).
 *  Whichever mode was last used wins; the easy draft is checked first. */
export function getWizardDraft(): { name: string; step: number } | null {
  const easy = getEasyDraft();
  if (easy) return easy;
  const draft = loadDraft();
  if (draft) {
    const meaningful = [draft.name, draft.reactUrl, draft.storeUrl, draft.clientId].some((value) => (value ?? '').trim());
    if (meaningful) return { name: (draft.name ?? '').trim() || 'Untitled clone', step: Math.min((draft.step ?? 0) + 1, 3) };
  }
  return null;
}
export function clearWizardDraft() { localStorage.removeItem(DRAFT_KEY); clearEasyDraft(); localStorage.removeItem(MODE_KEY); }

export function NewJobWizard({ defaults, onCreated, onCancel, onOpenBrowser }: { defaults: FactorySettings | null; onCreated: () => void; onCancel?: () => void; onOpenBrowser?: () => void }) {
  useEffect(() => { localStorage.removeItem(MODE_KEY); }, []);
  return (
    <EasyFlow
      onCreated={onCreated}
      onCancel={() => onCancel?.()}
      onOpenBrowser={onOpenBrowser}
      renderManual={(handoff) => <ExpertFlow defaults={defaults} onCreated={onCreated} onCancel={onCancel} embedded={handoff} />}
    />
  );
}

// ---------------------------------------------------------------------------------------------

const STEPS = [
  { label: 'Your store', icon: <Globe className="size-4" /> },
  { label: 'Store connection', icon: <KeyRound className="size-4" /> },
  { label: 'Review & start', icon: <Settings2 className="size-4" /> },
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
            title={index < step ? `Back to ${entry.label}` : index > step ? 'Finish the current step first' : undefined}
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

/** The manual store + keys + review steps. `embedded` = shown as step 4 of the one flow: the
 *  website details come from step 1 (and are not asked again), Back on its first screen returns
 *  to the store-setup choice. */
function ExpertFlow({ defaults, onCreated, onCancel, embedded }: { defaults: FactorySettings | null; onCreated: () => void; onCancel?: () => void; embedded?: ManualHandoff }) {
  const toast = useToast();
  const [stored] = useState(loadDraft);
  const [step, setStep] = useState(stored?.step ?? 0);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Step 1 — sources
  const [name, setName] = useState(embedded?.name || stored?.name || '');
  const [reactUrl, setReactUrl] = useState(embedded?.reactUrl || stored?.reactUrl || '');
  const [storeUrl, setStoreUrl] = useState(stored?.storeUrl ?? '');
  const [storefrontPassword, setStorefrontPassword] = useState('');
  const [reactFilesPath, setReactFilesPath] = useState(embedded ? embedded.reactFilesPath : stored?.reactFilesPath ?? '');
  // Fields already answered in step 1 of the one flow are not asked again.
  const givenName = Boolean(embedded?.name);
  const givenUrl = Boolean(embedded?.reactUrl);
  const givenFiles = Boolean(embedded?.reactFilesPath);
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
  // Auto-derived from the project name until the user edits it by hand (otherwise the first
  // keystroke of the name would lock in "E Clone (dev)").
  const [devThemeTouched, setDevThemeTouched] = useState(stored?.devThemeTouched ?? false);
  const [autoswap, setAutoswap] = useState(stored?.autoswap ?? false);
  const [autoswapConfirm, setAutoswapConfirm] = useState(false);
  const [autoQa, setAutoQa] = useState(stored?.autoQa ?? true);
  const [qaMode, setQaMode] = useState(stored?.qaMode ?? 'both');
  const [qaEngine, setQaEngine] = useState<QaEngine>((['playwright', 'headed', 'chrome'].includes(stored?.qaEngine ?? '') ? stored?.qaEngine : 'playwright') as QaEngine);
  const [settings, setSettings] = useState<FactorySettings | null>(defaults);
  useEffect(() => { if (defaults && !settings) setSettings(defaults); }, [defaults, settings]);
  const chromeSetupMissing = autoQa && qaEngine === 'chrome' && !settings?.browserQaSetup?.done;
  const [browser, setBrowser] = useState<{ ready: boolean; hasChromium: boolean; installing: boolean } | null>(null);
  const [maxIterations, setMaxIterations] = useState(stored?.maxIterations ?? defaults?.defaultMaxIterations ?? 5);
  const [threshold, setThreshold] = useState(stored?.threshold ?? defaults?.defaultScoreThreshold ?? 0.92);

  // Persist the draft on every change (cleared on successful queue or explicit discard).
  useEffect(() => {
    const draft: WizardDraft = { step, name, reactUrl, storeUrl, reactFilesPath, clientId, savedStoreId, prefix, prefixTouched, devThemeName, devThemeTouched, autoswap, autoQa, qaMode, qaEngine, maxIterations, threshold };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [step, name, reactUrl, storeUrl, reactFilesPath, clientId, savedStoreId, prefix, prefixTouched, devThemeName, devThemeTouched, autoswap, autoQa, qaMode, qaEngine, maxIterations, threshold]);

  useEffect(() => { if (!prefixTouched) setPrefix(derivePrefix(name)); }, [name, prefixTouched]);
  useEffect(() => { if (!devThemeTouched) setDevThemeName(name.trim() ? `${name.trim()} Clone (dev)` : ''); }, [name, devThemeTouched]);
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
    if (!step1Ready || !step2Ready || !step3Ready) { setAttempted(true); setAdvancedOpen(true); return; }
    if (chromeSetupMissing) { toast.push({ title: 'Finish the one-time Chrome setup', detail: 'Or pick the quiet automatic check instead.', variant: 'warning' }); return; }
    void submit();
  };

  const dirty = !!(name || reactUrl || storeUrl || storefrontPassword || reactFilesPath || clientId || clientSecret || devThemeName || prefixTouched || autoswap || autoQa !== true || step > 0);
  const resetWizard = () => {
    localStorage.removeItem(DRAFT_KEY);
    setStep(0); setAttempted(false);
    setName(''); setReactUrl(''); setStoreUrl(''); setStorefrontPassword(''); setReactFilesPath(''); setReactFilesCheck(null);
    setClientId(''); setClientSecret(''); setCredCheck(null); setSavedStoreId(null);
    setPrefix(''); setPrefixTouched(false); setDevThemeName(''); setDevThemeTouched(false); setAutoswap(false);
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
      toast.push({ title: 'Build started', detail: `"${name.trim()}" begins as soon as a slot is free.`, variant: 'success' });
      onCreated();
    } catch (error) {
      toast.push({ title: 'Could not start the build', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' });
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
    toast.push({ title: 'Enter the new keys', detail: 'Paste the new Client ID and Secret, then press Test connection.', variant: 'default' });
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
      toast.push({ title: 'Could not remove the keys', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    } finally { setPurging(false); setPurgeConfirm(false); }
  };

  const keysOnFile = Boolean(savedStoreId) || (idValid && secretValid);

  return (
    <div className={embedded ? 'relative flex w-full flex-col gap-6' : 'relative mx-auto flex w-full max-w-2xl flex-col gap-6'}>
      {!embedded && (
        <div className="rise-in">
          <h2 className="text-2xl font-bold tracking-tight">Use my own store</h2>
          <p className="mt-1 text-[14.5px] font-medium leading-relaxed text-muted-foreground">Tell ThemeBot which website to copy and which Shopify store to build it in. It builds the theme, compares it with your website, and fixes the differences.</p>
          <div className="mt-4"><WatchVideoButton label="Watch the 2-minute setup video" /></div>
        </div>
      )}

      <Stepper step={step} onJump={setStep} />

      {step === 0 && (
        <Card key="step-0" className="rise-in">
          <CardHeader>
            <CardTitle>{embedded ? 'Which store should the theme go in?' : 'Which website, and which store?'}</CardTitle>
            <CardDescription>{embedded ? 'The new theme is added to this store as a draft theme — your live store is not touched.' : 'The website is what ThemeBot copies. The store is where the new theme goes — it is added as a draft theme, your live store is not touched.'}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {!givenName && <Field label="Name this project" error={attempted && !name.trim() ? 'Please give the project a name.' : null} help={name ? `Project folder: ${slugify(name) || '—'}` : 'Any name you like — it is used for the project folder and the draft theme.'}>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Wild & Sacred" autoFocus aria-invalid={attempted && !name.trim() || undefined} />
            </Field>}
            {embedded && !givenUrl && <p className="text-[13px] font-medium leading-relaxed text-muted-foreground">You gave ThemeBot your website's files. For the manual way it also needs the address where the website runs online.</p>}
            {!givenUrl && <Field label="Link to the website to copy" error={reactUrl && !urlValid ? 'That does not look like a web address — it should start with https://' : attempted && !reactUrl.trim() ? 'Please paste the website address.' : null}>
              <Input value={reactUrl} onChange={(event) => setReactUrl(event.target.value)} placeholder="https://wild-sacred.vercel.app" inputMode="url" aria-invalid={(attempted && !reactUrl.trim()) || (!!reactUrl && !urlValid) || undefined} />
            </Field>}
            <Field label="Your Shopify store" error={storeUrl && !shopValid ? 'Paste the store address — it looks like something.myshopify.com' : attempted && !storeUrl.trim() ? 'Please paste your store address.' : null} ok={shopValid ? `Building in ${normalizedShop}` : null} help="Paste the address from your Shopify admin, or just the store's myshopify.com address.">
              <Input value={storeUrl} onChange={(event) => changeStoreUrl(event.target.value)} placeholder="wild-sacred.myshopify.com" aria-invalid={(attempted && !storeUrl.trim()) || (!!storeUrl && !shopValid) || undefined} />
            </Field>
            <Field label="Storefront password (optional)" help={savedStore?.has_storefront_password ? 'A storefront password is already saved with this store — leave blank to reuse it.' : 'Only needed if visitors need a password to see your store (new stores usually do). ThemeBot uses it to check its work.'}>
              <Input type="password" value={storefrontPassword} onChange={(event) => setStorefrontPassword(event.target.value)} placeholder="•••••" autoComplete="off" />
            </Field>
            {!givenFiles && !embedded && <Field
              label="Website source folder (optional)"
              error={reactFilesPath && reactFilesCheck && !reactFilesCheck.ok ? reactFilesCheck.detail ?? 'Folder not found' : null}
              ok={reactFilesPath && reactFilesCheck?.ok ? reactFilesCheck.detail ?? 'Looks good' : null}
              help="If you have the website's source code on this computer (a folder or a .zip), point ThemeBot at it for a more exact copy."
            >
              <Input value={reactFilesPath} onChange={(event) => setReactFilesPath(event.target.value)} placeholder="C:\intake\wild-sacred" spellCheck={false} />
            </Field>}
          </CardContent>
        </Card>
      )}

      {step === 1 && (
        <Card key="step-1" className="rise-in">
          <CardHeader>
            <CardTitle>Connect ThemeBot to your store</CardTitle>
            <CardDescription>ThemeBot needs the two keys from the app you created for this store in Shopify's Dev Dashboard (your app → Settings). They are stored encrypted on this computer and never leave it.</CardDescription>
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
                else if (gotId || gotSecret) { setSavedStoreId(null); setCredCheck(null); toast.push({ title: 'Almost there', detail: 'Check the fields below — one key still needs to be pasted by hand.', variant: 'default' }); }
              }}
            />
            <SetupChecklist />
            {stores.length > 0 && (
              <Field label="Stores you connected before" help="Pick one and you do not need to paste anything.">
                <Select value={savedStoreId ?? ''} onChange={(event) => pickSavedStore(event.target.value)} aria-label="Saved stores">
                  <option value="">Enter new keys…</option>
                  {stores.map((store) => <option key={store.id} value={store.id}>{store.label} ({store.shop_domain})</option>)}
                </Select>
              </Field>
            )}
            <Field label="Client ID" error={clientId && !idValid ? 'A Client ID is 32 letters and numbers — check what you pasted.' : attempted && !clientId.trim() && !savedStoreId ? 'Please paste the Client ID.' : null}>
              <Input id="wizard-client-id" value={clientId} onChange={(event) => { setClientId(event.target.value); setCredCheck(null); }} placeholder="186c0a1b…" spellCheck={false} autoComplete="off" disabled={!!savedStoreId} className={fieldFlash ? 'ring-2 ring-success ring-offset-2' : undefined} aria-invalid={(attempted && !clientId.trim() && !savedStoreId) || (!!clientId && !idValid) || undefined} />
            </Field>
            {savedStoreId ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-success/30 bg-success/5 p-3.5">
                <p className="text-[13px] font-medium leading-relaxed text-muted-foreground">
                  <span className="font-bold text-foreground">Client Secret already saved.</span>
                  {' '}Nothing to paste.{savedStore?.has_storefront_password ? ' A storefront password is saved with this store too.' : ''}
                </p>
                <Button variant="ghost" size="sm" onClick={() => pickSavedStore('')}>Use different keys</Button>
              </div>
            ) : (
              <Field label="Client Secret" error={clientSecret && !secretValid ? 'The Client Secret starts with shpss_ — check what you pasted.' : attempted && !clientSecret.trim() ? 'Please paste the Client Secret.' : null}>
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
              <Button variant="outline" onClick={() => void testConnection(true)} disabled={!step2Ready || testing !== null} title="Makes a tiny harmless edit on your store and removes it again, to prove ThemeBot is allowed to edit themes.">
                {testing === 'push' ? <Spinner /> : <Rocket />} Test with a tiny edit
              </Button>
            </div>
            {credCheck && (
              <div className={`rise-in rounded-xl border p-4 ${credCheck.ok ? 'border-success/30 bg-success/5' : 'border-destructive/30 bg-destructive/5'}`}>
                <p className="flex items-center gap-2 text-[14px] font-bold">
                  {credCheck.ok ? <CheckCircle2 className="size-4.5 shrink-0 text-success" /> : <XCircle className="size-4.5 shrink-0 text-destructive" />}
                  {credCheck.ok ? `Connected${credCheck.shopName ? ` to "${credCheck.shopName}"` : ''} — ThemeBot is allowed to edit themes` : credCheck.detail ?? 'Connection failed'}
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
                    Edit test: {credCheck.push.detail}
                  </p>
                )}
                {credCheck.scopes?.recommended.some((entry) => !entry.granted) && (
                  <p className="mt-3 text-[13px] font-medium leading-relaxed text-muted-foreground">The amber permissions are optional but recommended: without them ThemeBot may not be able to set up menus, pages, or blog posts. You can add them in the Dev Dashboard and reinstall the app.</p>
                )}
              </div>
            )}
            {!savedStoreId && credCheck?.ok && (
              <div className="rise-in flex items-center justify-between gap-4 rounded-xl bg-muted/60 p-3.5">
                <p className="text-[13px] font-medium leading-relaxed text-muted-foreground">
                  <span className="font-bold text-foreground">Remember this store.</span> Next time you will not have to paste the keys again.
                </p>
                <Switch checked={rememberStore} onCheckedChange={setRememberStore} aria-label="Remember this store for future builds" />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card key="step-2" className="rise-in">
          <CardHeader>
            <CardTitle>Review & start</CardTitle>
            <CardDescription>Everything below is a sensible default. Change it only if you know why.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="rounded-xl bg-muted/60 p-4 text-[13.5px] font-medium leading-6 text-muted-foreground">
              <p className="text-[12.5px] font-bold uppercase tracking-[0.1em] text-foreground">What will happen</p>
              <ul className="mt-1.5 flex flex-col gap-1">
                <li>ThemeBot copies <b className="text-foreground">{reactUrl || '—'}</b> into a new draft theme on <b className="text-foreground">{normalizedShop || '—'}</b>.</li>
                <li>{autoQa ? <>It then compares the two sites{qaEngine === 'chrome' ? ' (in your own Chrome, with Claude)' : qaEngine === 'headed' ? ' (in a window you can watch)' : ' (quietly, in the background)'} and fixes differences, up to <b className="text-foreground">{maxIterations}</b> rounds, until they match at least <b className="text-foreground">{Math.round(threshold * 100)}%</b>.</> : <>Automatic checking is turned off — you review the result yourself.</>}</li>
                <li>{autoswap ? <b className="text-warning">When it passes, the new theme is published live automatically.</b> : <>Your live store is not changed — the result stays a draft theme until you publish it.</>}</li>
              </ul>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[15px] font-bold">Check and fix automatically</p>
                <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-muted-foreground">After the copy, compare both sites and fix differences until they match. Recommended.</p>
              </div>
              <Switch checked={autoQa} onCheckedChange={setAutoQa} aria-label="Check and fix automatically" />
            </div>
            {autoQa && browser && !browser.ready && (
              <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
                <p className="text-[14px] font-bold text-warning">One-time download needed</p>
                <p className="mt-1 text-[13px] font-medium leading-relaxed text-muted-foreground">The checking step needs a small browser (about 150 MB) that is not installed yet. Install it once and you are set.</p>
                <Button size="sm" variant="outline" className="mt-3" disabled={browser.installing} onClick={async () => { await api.installBrowser(); setBrowser({ ...browser, installing: true }); toast.push({ title: 'Installing…', detail: 'Downloading in the background — you can keep going.', variant: 'default' }); }}>
                  {browser.installing ? <Spinner /> : <ShieldCheck />} {browser.installing ? 'Installing…' : 'Install now'}
                </Button>
              </div>
            )}
            {autoQa && browser?.ready && <p className="flex items-center gap-2 text-[13px] font-bold text-success"><CheckCircle2 className="size-4" /> Checking is ready to run</p>}
            {autoQa && <QaChoice value={qaEngine} onChange={setQaEngine} settings={settings} onSettingsChange={setSettings} />}

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[15px] font-bold">Publish live when it passes</p>
                <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-muted-foreground">Off means the result stays a draft theme for you to review first. Keep it off unless you are sure.</p>
              </div>
              <Switch checked={autoswap} onCheckedChange={(value) => value ? setAutoswapConfirm(true) : setAutoswap(false)} aria-label="Publish live when it passes" />
            </div>

            <Separator />
            <button type="button" onClick={() => setAdvancedOpen((value) => !value)} aria-expanded={advancedOpen} className="flex w-full items-center gap-2 text-left text-[14px] font-bold text-foreground">
              <ChevronDown className={`size-4.5 text-muted-foreground transition-transform duration-300 ${advancedOpen ? 'rotate-180' : ''}`} />
              Advanced settings
              <span className="text-[12.5px] font-medium text-muted-foreground">— for developers</span>
              {attempted && !step3Ready && <Badge variant="destructive">needs attention</Badge>}
            </button>
            <div className={`collapse-panel${advancedOpen ? ' is-open' : ''}`} aria-hidden={!advancedOpen}>
              <div className="collapse-panel__inner">
                <div className="flex flex-col gap-5 pt-1">
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field label="Section prefix (2-3 chars)" error={prefix && !prefixValid ? 'Lowercase, 2-3 chars, starts with a letter.' : attempted && !prefix.trim() ? 'Required' : null}>
                      <Input value={prefix} onChange={(event) => { setPrefix(event.target.value.toLowerCase()); setPrefixTouched(true); }} maxLength={3} spellCheck={false} aria-invalid={(attempted && !prefix.trim()) || (!!prefix && !prefixValid) || undefined} />
                    </Field>
                    <Field label="Draft theme name" error={attempted && !devThemeName.trim() ? 'Required' : null}>
                      <Input value={devThemeName} onChange={(event) => { setDevThemeName(event.target.value); setDevThemeTouched(true); }} aria-invalid={attempted && !devThemeName.trim() || undefined} />
                    </Field>
                  </div>
                  {autoQa && (
                    <>
                      <Field label="What to check">
                        <Select value={qaMode} onChange={(event) => setQaMode(event.target.value)}>
                          <option value="both">Layout + clickable things (recommended)</option>
                          <option value="sections">Layout only</option>
                          <option value="interactions">Clickable things only</option>
                        </Select>
                      </Field>
                      <Field label="Maximum fix rounds">
                        <Slider value={maxIterations} onValueChange={setMaxIterations} min={1} max={10} />
                      </Field>
                      <Field label="Good enough when the match reaches" help="Checking stops once the sites match at least this closely.">
                        <Slider value={threshold} onValueChange={setThreshold} min={0.5} max={1} step={0.01} format={(value) => `${Math.round(value * 100)}%`} />
                      </Field>
                    </>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => { if (dirty) setDiscardConfirm(true); else { resetWizard(); onCancel?.(); } }} disabled={busy}>Cancel</Button>
          <Button variant="ghost" onClick={() => { if (step === 0 && embedded) embedded.onBack(); else setStep((value) => Math.max(0, value - 1)); }} disabled={(step === 0 && !embedded) || busy}><ArrowLeft /> Back</Button>
        </div>
        {step < 2
          ? <Button onClick={goNext}>Next <ArrowRight /></Button>
          : <Button size="lg" onClick={trySubmit} disabled={busy}>{busy ? <Spinner className="text-primary-foreground" /> : <Rocket />} Start building</Button>}
      </div>

      <ConfirmDialog
        open={discardConfirm}
        title="Throw away what you entered?"
        description="Everything on these steps is cleared and the saved draft is removed."
        confirmLabel="Throw it away" destructive
        onCancel={() => setDiscardConfirm(false)}
        onConfirm={() => { setDiscardConfirm(false); resetWizard(); onCancel?.(); }}
      />

      <ConfirmDialog
        open={autoswapConfirm}
        title="Publish the new theme live automatically?"
        description="When the build passes its checks, the new theme replaces your store's live theme right away — customers see it immediately, without you reviewing it first. Keep this off if you want to look before it goes live."
        confirmLabel="Yes, publish automatically" destructive
        onCancel={() => { setAutoswapConfirm(false); setAutoswap(false); }}
        onConfirm={() => { setAutoswapConfirm(false); setAutoswap(true); }}
      />

      <ConfirmDialog
        open={purgeConfirm}
        title={`Remove all keys for ${normalizedShop || 'this store'}?`}
        description="Deletes the saved store (and its secret), wipes the keys from every build that uses this store, and clears the bot's memory. Builds that are running for this store will stop being able to connect. You would have to fetch or paste the keys again."
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
              The bot fetched the <b className="text-foreground">Client ID</b> and <b className="text-foreground">Client Secret</b> and filled them in for you.
              They are stored encrypted inside ThemeBot. Your project folder is created when you start the build in the next step.
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
