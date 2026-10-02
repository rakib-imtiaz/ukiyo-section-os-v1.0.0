// "Is this the right store?" — shown on Ready to go only when ThemeBot is about to reuse a store an
// earlier attempt made. Checks (read-only) which Shopify login the ThemeBot window uses and whether
// that login can open the store, lets the user look at it, and needs one click to confirm.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Info, Plus, RefreshCw, Store } from 'lucide-react';
import { Button, Spinner, useToast } from './ui';
import { api } from './api';
import type { StoreAccess } from './types';

export function StoreCheckCard({ shop, confirmed, onUse, onNew, onChange }: {
  shop: string; confirmed: boolean; onUse: () => void; onNew: () => void; onChange: () => void;
}) {
  const toast = useToast();
  const [check, setCheck] = useState<StoreAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [opened, setOpened] = useState(false);

  const run = useCallback(async (force = false) => {
    setLoading(true);
    try { setCheck(await api.easyStoreCheck(shop, force)); }
    catch { setCheck({ shop, access: 'unknown', account: null, storeName: null, reason: 'launch-failed', checkedAt: Date.now() }); }
    finally { setLoading(false); }
  }, [shop]);
  useEffect(() => { setCheck(null); void run(); }, [run]);

  const openStore = async () => {
    try { await api.easySigninWindow(undefined, shop); setOpened(true); }
    catch (caught) { toast.push({ title: 'Could not open the store', detail: caught instanceof Error ? caught.message : undefined, variant: 'destructive' }); }
  };

  const bad = check?.access === 'no';
  const tone = loading ? 'muted' : check?.access === 'yes' ? 'ok' : bad ? 'bad' : 'warn';
  const status = loading ? <><Spinner className="size-3.5" /> Checking which Shopify account the ThemeBot window uses…</>
    : check?.access === 'yes' ? <><CheckCircle2 className="size-4" /> Signed in as <b>{check.account ?? 'your account'}</b> — this account can open it.</>
    : bad ? <><AlertTriangle className="size-4" /> Signed in as <b>{check?.account ?? 'another account'}</b>, which can't open this store. It was probably made under a different Shopify login.</>
    : check?.access === 'signed-out' ? <><Info className="size-4" /> The ThemeBot window isn't signed in to Shopify yet — it will ask when you press Start.</>
    : check?.reason === 'window-open' ? <><Info className="size-4" /> The ThemeBot window is open, so it can't be checked. Close it, then check again.</>
    : check?.reason === 'busy' ? <><Info className="size-4" /> The setup bot is busy — check again when it finishes.</>
    : <><Info className="size-4" /> Couldn't check right now. Open the store to look, or check again.</>;

  if (confirmed) {
    return (
      <div className="store-check store-check--done">
        <CheckCircle2 className="size-4.5 text-emerald-600" />
        <span>Using <b>{check?.storeName ?? shop}</b>{check?.storeName ? <> · {shop}</> : null}</span>
        <button type="button" className="store-check__link" onClick={onChange}>Change</button>
      </div>
    );
  }

  return (
    <div className={`store-check store-check--${tone}`}>
      <div className="store-check__head">
        <span className="store-check__icon"><Store className="size-4.5" /></span>
        <div className="min-w-0">
          <p className="store-check__eyebrow">Using an existing store — is this the right one?</p>
          <p className="store-check__name">{check?.storeName ? <><b>{check.storeName}</b> · </> : null}{shop}</p>
        </div>
      </div>
      <p className="store-check__status">{status}</p>
      <div className="store-check__actions">
        <Button variant="outline" size="sm" onClick={() => void openStore()}><ExternalLink /> Open store</Button>
        <Button size="sm" variant={bad ? 'outline' : 'default'} onClick={onUse} disabled={loading}><CheckCircle2 /> Yes, use this one</Button>
        <Button size="sm" variant={bad ? 'default' : 'outline'} onClick={onNew}><Plus /> Make a new one</Button>
        {!loading && check?.access !== 'yes' && <Button size="sm" variant="ghost" onClick={() => void run(true)}><RefreshCw /> Check again</Button>}
      </div>
      {opened && <p className="store-check__hint">Opened in the ThemeBot window. Close that window before pressing Start.</p>}
    </div>
  );
}
