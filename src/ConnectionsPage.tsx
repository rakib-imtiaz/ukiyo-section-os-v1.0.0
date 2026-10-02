// Connections: everything ThemeBot is signed in to, what each one is used for, and the one
// action you'd want on each. Plain language — no API versions or database internals.
import { useEffect, useState, type ReactNode } from 'react';
import { Cpu, SlidersHorizontal, Chrome, ExternalLink, Trash2, Factory, FolderOpen, KeyRound, LogOut, Sparkles, Store, TerminalSquare, UserRound } from 'lucide-react';
import { api } from './factory/api';
import type { FactoryStore } from './factory/types';

interface Props {
  claudeConnected: boolean;
  workspaceName: string | null;
  developerMode: boolean;
  onDeveloperMode: (on: boolean) => void;
  onSwitchWorkspace: () => void;
  onLogoutClaude: () => void;
  onOpenAccounts: () => void;
  onNewBuild: () => void;
  confirm: (options: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
}

function Pill({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return <span className={`conn-pill ${ok == null ? 'is-wait' : ok ? 'is-ok' : 'is-off'}`}><i />{children}</span>;
}

function ConnCard({ icon, title, pill, usedFor, children, wide }: { icon: ReactNode; title: string; pill: ReactNode; usedFor: string; children: ReactNode; wide?: boolean }) {
  return (
    <article className={`settings-card conn-card${wide ? ' conn-card--wide' : ''}`}>
      <header className="conn-card__head">
        <span className="conn-card__icon">{icon}</span>
        <h3>{title}</h3>
        {pill}
      </header>
      <p className="conn-card__use"><b>Used for</b> {usedFor}</p>
      {children}
    </article>
  );
}

const handleOf = (domain: string) => domain.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '');

export default function ConnectionsPage(props: Props) {
  const [stores, setStores] = useState<FactoryStore[] | null>(null);
  const [profile, setProfile] = useState<{ exists: boolean; inUse: boolean } | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [browserError, setBrowserError] = useState('');
  const [busyShops, setBusyShops] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<string | null>(null);
  const [storeError, setStoreError] = useState('');

  useEffect(() => {
    api.listStores().then((data) => setStores(data.stores)).catch(() => setStores([]));
    api.easyProfile().then(setProfile).catch(() => setProfileFailed(true));
    // Stores with a build in progress can't be removed (the build still needs their keys).
    api.listJobs().then(({ jobs }) => setBusyShops(new Set(jobs
      .filter((job) => job.running || ['queued', 'scaffolding', 'cloning', 'qa_running', 'fixing'].includes(job.status))
      .map((job) => handleOf(job.store_url))))).catch(() => {});
  }, []);

  const removeStore = async (store: FactoryStore) => {
    const name = store.label || handleOf(store.shop_domain);
    const ok = await props.confirm({
      title: `Remove ${name} from ThemeBot?`,
      body: `ThemeBot forgets this store's keys, so it can no longer update its theme. The store itself stays on Shopify, untouched. To delete the store, do that in Shopify.`,
      confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    setRemoving(store.id); setStoreError('');
    try { await api.purgeKeys(store.shop_domain); setStores((list) => list?.filter((entry) => entry.shop_domain !== store.shop_domain) ?? list); }
    catch (error) { setStoreError(error instanceof Error ? error.message : 'Could not remove the store.'); }
    finally { setRemoving(null); }
  };

  const openShopify = async () => {
    setOpening(true); setBrowserError('');
    try { await api.easySigninWindow('shopify'); }
    catch (error) { setBrowserError(error instanceof Error ? error.message : 'Could not open the window.'); }
    finally { setOpening(false); }
  };

  return (
    <section className="page-pad settings-page">
      <div className="glass-heading"><div><h2>Connections</h2><p>What ThemeBot is signed in to, and what each one is used for.</p></div></div>
      <div className="settings-grid conn-grid">
        <ConnCard icon={<Cpu size={18} />} title="AI engine" usedFor="the AI that builds your themes and checks them against your website. See which one is connected, sign in, or add API keys under Manage."
          pill={<Pill ok={props.claudeConnected}>{props.claudeConnected ? 'Connected' : 'Not connected'}</Pill>}>
          <div className="conn-facts"><span>Builds are saved in</span><b>{props.workspaceName ?? 'No folder chosen'}</b></div>
          <div className="conn-actions">
            <button type="button" className="gbtn gbtn--outline" onClick={props.onSwitchWorkspace}><FolderOpen size={14} /> Change folder</button>
            <button type="button" className="gbtn gbtn--outline" onClick={() => window.dispatchEvent(new Event('themebot:open-engines'))}><SlidersHorizontal size={14} /> Manage AI engines</button>
          </div>
        </ConnCard>

        <ConnCard icon={<Chrome size={18} />} title="ThemeBot browser" usedFor="signing in to Shopify (and Google) to create your stores and connect them. It's a separate window: your everyday Chrome is never touched."
          pill={<Pill ok={profile == null ? null : profile.exists}>{profile == null ? (profileFailed ? 'Status unknown' : 'Checking…') : profile.inUse ? 'In use now' : profile.exists ? 'Signed in' : 'Not signed in yet'}</Pill>}>
          {browserError && <p className="conn-error">{browserError}</p>}
          <div className="conn-actions">
            <button type="button" className="gbtn gbtn--outline" onClick={props.onOpenAccounts}><UserRound size={14} /> Manage accounts</button>
            <button type="button" className="gbtn gbtn--outline" disabled={opening || profile?.inUse} onClick={() => void openShopify()}><ExternalLink size={14} /> Open Shopify</button>
          </div>
        </ConnCard>

        <ConnCard wide icon={<Store size={18} />} title="Your stores" usedFor="putting the finished theme on each store. Every store has its own keys, saved encrypted on this computer."
          pill={<Pill ok={stores == null ? null : stores.length > 0}>{stores == null ? 'Checking…' : `${stores.length} connected`}</Pill>}>
          {stores && stores.length > 0 ? (
            <ul className="conn-stores">
              {stores.map((store) => (
                <li key={store.id}>
                  <span className="conn-stores__mark"><Store size={15} /></span>
                  <div><b>{store.label || handleOf(store.shop_domain)}</b><code>{store.shop_domain}</code></div>
                  <span className="conn-stores__keys"><KeyRound size={12} /> Keys saved</span>
                  <a className="glink" href={`https://admin.shopify.com/store/${handleOf(store.shop_domain)}`} target="_blank" rel="noreferrer">Store admin <ExternalLink size={12} /></a>
                  <button type="button" className="conn-stores__remove" disabled={removing != null || busyShops.has(handleOf(store.shop_domain))}
                    title={busyShops.has(handleOf(store.shop_domain)) ? 'A build is using this store right now' : 'Remove from ThemeBot'}
                    aria-label={`Remove ${store.label || store.shop_domain}`} onClick={() => void removeStore(store)}>
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : stores && <p className="conn-empty">No stores yet. When you build one, ThemeBot connects it here automatically.</p>}
          {storeError && <p className="conn-error">{storeError}</p>}
          <div className="conn-actions">
            <button type="button" className="gbtn gbtn--outline" onClick={props.onNewBuild}><Factory size={14} /> Build a new store</button>
          </div>
        </ConnCard>

        <ConnCard wide icon={<TerminalSquare size={18} />} title="Developer tools" usedFor="fixing ThemeBot itself. Adds Terminal and Browser to the sidebar. You don't need them to build stores."
          pill={<Pill ok={props.developerMode}>{props.developerMode ? 'Shown' : 'Hidden'}</Pill>}>
          <label className="settings-toggle"><input type="checkbox" checked={props.developerMode} onChange={(event) => props.onDeveloperMode(event.target.checked)} /> Show developer tools</label>
        </ConnCard>
      </div>
    </section>
  );
}
