import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, LogIn, RefreshCw, XCircle } from 'lucide-react';
import { api } from './api';
import type { LoginStatus } from './types';

/** Shopify sign-in gate for easy mode. The whole "do it for me" pipeline runs inside ThemeBot's
 *  built-in browser, so that browser must be signed in to the user's Shopify account first.
 *  Checks on mount, lets the user open the sign-in page (in the Browser tab) and re-check. */
export function SignInGate({ onOpenBrowser, onStatus, autoCheck = true }: {
  /** Switch the app to the Browser view so the user can log in on the page we just opened. */
  onOpenBrowser?: () => void;
  onStatus?: (status: LoginStatus | null) => void;
  autoCheck?: boolean;
}) {
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const check = useCallback(async (fresh: boolean) => {
    setChecking(true); setError(null);
    try {
      const next = await api.shopifyLogin(fresh);
      setStatus(next);
      onStatusRef.current?.(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not check the sign-in.');
      onStatusRef.current?.(null);
    } finally { setChecking(false); }
  }, []);

  useEffect(() => { if (autoCheck) void check(false); }, [autoCheck, check]);

  const openSignIn = async () => {
    setOpening(true); setError(null);
    try { await api.openShopifySignIn(); onOpenBrowser?.(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not open the sign-in page.'); }
    finally { setOpening(false); }
  };

  const tone = status?.signedIn ? 'success' : status ? 'warning' : 'muted';
  const border = tone === 'success' ? 'border-success/30 bg-success/5' : tone === 'warning' ? 'border-warning/40 bg-warning/5' : 'border-border bg-muted/40';

  return (
    <div className={`rounded-xl border p-4 ${border}`} role="status" aria-live="polite">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">
          {checking && !status ? <Loader2 className="size-5 animate-spin text-muted-foreground" />
            : status?.signedIn ? <CheckCircle2 className="size-5 text-success" />
            : status ? <XCircle className="size-5 text-warning" />
            : <LogIn className="size-5 text-muted-foreground" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-bold text-foreground">
            {checking && !status ? 'Checking whether you are signed in to Shopify…'
              : status?.signedIn ? 'You are signed in to Shopify'
              : status ? 'Please sign in to Shopify first'
              : 'Shopify sign-in'}
          </p>
          <p className="mt-1 text-[13px] font-medium leading-relaxed text-muted-foreground">
            {status?.signedIn
              ? 'ThemeBot will use this sign-in to create your store and connect it. You will not be asked for it again.'
              : status && !status.browserAvailable
                ? status.detail
                : 'ThemeBot works inside its own built-in browser. Sign in there once, and it can create the store, connect it, and build the theme for you. Nothing starts until you are signed in.'}
          </p>
          {error && <p className="mt-2 text-[13px] font-semibold text-destructive">{error}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!status?.signedIn && (
              <button
                type="button" onClick={() => void openSignIn()} disabled={opening || (status ? !status.browserAvailable : false)}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-[13px] font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {opening ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />} Open Shopify sign-in
              </button>
            )}
            <button
              type="button" onClick={() => void check(true)} disabled={checking}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-[13px] font-bold text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {status?.signedIn ? 'Check again' : "I've signed in — check again"}
            </button>
          </div>
          {!status?.signedIn && status?.browserAvailable && (
            <p className="mt-2.5 text-[12.5px] font-medium leading-relaxed text-muted-foreground">
              The sign-in page opens in the <b className="text-foreground">Browser</b> tab on the left. Log in there like you normally would (Shopify may ask you to prove you are human), then come back here and press <b className="text-foreground">check again</b>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
