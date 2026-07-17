import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, Braces, Check, ChevronDown, CircleAlert, Code2, Copy, Download, ExternalLink,
  Factory, FileCode2, FileDiff, FolderKanban, Globe, History, House, KeyRound, Layers3, Link2, LoaderCircle, LogOut,
  Monitor, Moon, PackageCheck, PanelLeftClose, Play, Plus, RefreshCw, Rocket, RotateCcw,
  Save, Search, ShieldCheck, SlidersHorizontal, Smartphone, Sparkles, Store, Sun, TerminalSquare, Trash2,
  Upload, WandSparkles,
} from 'lucide-react';
import { createCinematicHeroManifest, defaultHeroState } from './compiler/cinematicHero';
import { locateIssue } from './compiler/inspect';
import { getTemplate, templateForManifest, templates } from './compiler/templates';
import type { ControlDef, TemplateDef } from './compiler/templates';
import FactoryApp, { applyFactoryTheme } from './factory/FactoryApp';
import HomeScreen from './HomeScreen';
import Sidebar from './Sidebar';
import TerminalPane from './TerminalPane';
import BrowserPane from './BrowserPane';
import OnboardingGate from './onboarding/OnboardingGate';
import type { CompileResult, GeneratedFile, HeroBuilderState, SectionManifest } from './shared/types';

// Light styling is now the CSS default; stamp the persisted theme before first
// paint so returning dark-theme users don't flash light for a frame.
document.documentElement.setAttribute('data-app-theme', localStorage.getItem('factory-theme') === 'dark' ? 'dark' : 'light');

type View = 'home' | 'projects' | 'build' | 'contract' | 'code' | 'deploy' | 'settings' | 'factory' | 'terminal' | 'browser';
type Device = 'desktop' | 'mobile';

interface AppSession { authenticated:boolean; shop:string|null; persistent:boolean; shopify:{configured:boolean;apiVersion:string}; billing:null|{enabled:boolean;active:boolean;mode:string;subscriptions:unknown[]}; claude?:{connected:boolean;method:string|null}; workspace?:{path:string|null;name:string|null;ready:boolean;projectCount:number}; }
/**
 * Project records now come in two kinds (backend Wave 2 data-model unification):
 * hand-built sections (`kind: 'section'`, the historic shape) and factory clone jobs
 * surfaced as projects (`kind: 'clone'`). Both `kind` and `manifest` are treated as
 * optional so the UI degrades gracefully if the listing predates the unification.
 */
interface CloneMeta { react_url?:string; store_url?:string; status?:string; status_detail?:string|null; last_score?:number|null; }
interface SavedProject { id:string; name:string; handle:string; description:string; kind?:'section'|'clone'|string; status?:string; clone_meta?:CloneMeta|null; factory_job_id?:string|null; manifest:SectionManifest|null; created_at:string; updated_at:string; }
interface SavedApiKey { id:string; label:string; key_prefix:string; last_used_at:string|null; created_at:string; revoked_at:string|null; }
interface SavedDeployment { id:string; theme_name:string; theme_id:string; status:string; installed_files:string[]; rolled_back_at:string|null; created_at:string; }
/** One file in a deploy dry-run diff (POST /api/shopify/diff). */
interface DiffFileEntry { path: string; status: 'new' | 'changed' | 'same'; bytes: number }
interface ProjectVersion { id:string; project_id:string; version_number:number; manifest:SectionManifest; compiled_files?:GeneratedFile[]; checksum:string; created_at:string; }

/** Minimal LCS line diff between two JSON blobs — used by the version history panel. */
function diffLines(oldText: string, newText: string): Array<{ type: 'same' | 'add' | 'del'; text: string }> {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<{ type: 'same' | 'add' | 'del'; text: string }> = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < m) { out.push({ type: 'del', text: a[i] }); i++; }
  while (j < n) { out.push({ type: 'add', text: b[j] }); j++; }
  return out;
}

const navItems: Array<{ id: View; label: string; icon: typeof WandSparkles; number: string }> = [
  { id: 'home', label: 'Home', icon: House, number: '00' },
  { id: 'projects', label: 'Projects', icon: FolderKanban, number: '01' },
  { id: 'build', label: 'Visual builder', icon: WandSparkles, number: '02' },
  { id: 'contract', label: 'Design contract', icon: Braces, number: '03' },
  { id: 'code', label: 'Generated files', icon: Code2, number: '04' },
  { id: 'deploy', label: 'Deployments', icon: Rocket, number: '05' },
  { id: 'settings', label: 'Connections', icon: KeyRound, number: '06' },
  { id: 'factory', label: 'Factory', icon: Factory, number: '07' },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare, number: '08' },
  { id: 'browser', label: 'Browser', icon: Globe, number: '09' },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="field"><span className="field__label">{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function Group({ title, number, children, open = false }: { title: string; number: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="control-group" open={open}>
      <summary><span><em>{number}</em>{title}</span><ChevronDown size={15} /></summary>
      <div className="control-group__body">{children}</div>
    </details>
  );
}

function Slider({ label, value, min, max, step = 1, unit = '', onChange }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (value: number) => void;
}) {
  return (
    <div className="slider-field">
      <div><span>{label}</span><output>{value}{unit}</output></div>
      <input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="toggle-row"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>;
}

/* ===== Registry-driven builder plumbing (Wave 2) =====================================
 * The builder no longer hardcodes the Cinematic Hero: it renders whatever controls the
 * selected TemplateDef declares and keeps a generic per-template state object. */

type TemplateState = Record<string, unknown>;
interface BlockInstance { type: string; settings: Record<string, unknown> }

const cloneDeep = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? {})) as T;
const asTemplateState = (value: unknown): TemplateState => (value && typeof value === 'object' ? { ...(value as TemplateState) } : {});

/** Call the registry's buildManifest without depending on how it types its state param. */
const buildTemplateManifest = (template: TemplateDef, state: TemplateState): SectionManifest =>
  (template.buildManifest as unknown as (state: TemplateState) => SectionManifest)(state);

/** Recover a template state from a saved manifest; null when the template can't represent it. */
const templateStateFromManifest = (template: TemplateDef, manifest: SectionManifest): TemplateState | null => {
  const recovered = (template.stateFromManifest as unknown as (manifest: SectionManifest) => unknown)(manifest);
  return recovered && typeof recovered === 'object' ? { ...(recovered as TemplateState) } : null;
};

const blocksOf = (state: TemplateState): BlockInstance[] => (Array.isArray(state.blocks) ? (state.blocks as BlockInstance[]) : []);

function normalizeOptions(options: ControlDef['options']): Array<{ value: string; label: string }> {
  if (!Array.isArray(options)) return [];
  return (options as unknown[]).map((option) => {
    if (typeof option === 'string') return { value: option, label: option };
    const item = option as { value?: unknown; label?: unknown };
    return { value: String(item.value ?? ''), label: String(item.label ?? item.value ?? '') };
  });
}

function emptyControlValue(control: ControlDef): unknown {
  switch (control.type) {
    case 'range': return control.min ?? 0;
    case 'toggle': return false;
    case 'color': return '#111111';
    case 'select': return normalizeOptions(control.options)[0]?.value ?? '';
    default: return '';
  }
}

/** Preserve first-appearance order of `control.group` so templates control their own panel layout. */
function groupControls(controls: ControlDef[]): Array<{ group: string; controls: ControlDef[] }> {
  const grouped: Array<{ group: string; controls: ControlDef[] }> = [];
  for (const control of controls) {
    const bucket = grouped.find((entry) => entry.group === control.group);
    if (bucket) bucket.controls.push(control);
    else grouped.push({ group: control.group || 'Settings', controls: [control] });
  }
  return grouped;
}

/** Maps a ControlDef to the input primitives the builder already uses. */
function ControlInput({ control, value, onChange }: { control: ControlDef; value: unknown; onChange: (value: unknown) => void }) {
  switch (control.type) {
    case 'textarea':
      return <Field label={control.label} hint={control.help}><textarea rows={3} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} /></Field>;
    case 'select':
      return <Field label={control.label} hint={control.help}><select value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>{normalizeOptions(control.options).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>;
    case 'color':
      return <Field label={control.label} hint={control.help}><input type="color" value={typeof value === 'string' && value.startsWith('#') ? value : '#111111'} onChange={(event) => onChange(event.target.value)} /></Field>;
    case 'range':
      return <Slider label={control.label} value={typeof value === 'number' ? value : Number(value ?? control.min ?? 0) || (control.min ?? 0)} min={control.min ?? 0} max={control.max ?? 100} step={control.step ?? 1} unit={control.unit ?? ''} onChange={(next) => onChange(next)} />;
    case 'toggle':
      return <Toggle label={control.label} checked={Boolean(value)} onChange={(next) => onChange(next)} />;
    case 'url':
      return <Field label={control.label} hint={control.help}><input placeholder="https://… or /path" value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} /></Field>;
    default: // text
      return <Field label={control.label} hint={control.help}><input value={String(value ?? '')} onChange={(event) => onChange(control.id === 'handle' ? event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') : event.target.value)} /></Field>;
  }
}

/** Block authoring: add / remove / reorder / duplicate block instances against template.blockTypes. */
function BlockEditor({ template, blocks, maxBlocks, onChange }: { template: TemplateDef; blocks: BlockInstance[]; maxBlocks?: number; onChange: (blocks: BlockInstance[]) => void }) {
  const blockTypes = template.blockTypes ?? [];
  const typeDef = (type: string) => blockTypes.find((entry) => entry.type === type);
  const atLimit = typeof maxBlocks === 'number' && blocks.length >= maxBlocks;
  const addBlock = (type: string) => {
    const definition = typeDef(type);
    if (!definition || atLimit) return;
    const settings: Record<string, unknown> = {};
    definition.fields.forEach((field) => { settings[field.id] = emptyControlValue(field); });
    onChange([...blocks, { type, settings }]);
  };
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const duplicate = (index: number) => { if (!atLimit) onChange([...blocks.slice(0, index + 1), cloneDeep(blocks[index]), ...blocks.slice(index + 1)]); };
  const remove = (index: number) => onChange(blocks.filter((_, at) => at !== index));
  const setSetting = (index: number, id: string, value: unknown) =>
    onChange(blocks.map((block, at) => (at === index ? { ...block, settings: { ...block.settings, [id]: value } } : block)));
  return (
    <div className="block-list">
      {blocks.length === 0 && <p className="block-list__empty">No blocks yet — add one below. Blocks become repeatable elements the merchant manages in the theme editor.</p>}
      {blocks.map((block, index) => {
        const definition = typeDef(block.type);
        return (
          <details className="block-card" key={`${block.type}-${index}`} open={blocks.length <= 3}>
            <summary>
              <span><em>{String(index + 1).padStart(2, '0')}</em>{definition?.name ?? block.type}</span>
              <span className="block-card__tools" onClick={(event) => event.preventDefault()}>
                <button type="button" title="Move up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={12} /></button>
                <button type="button" title="Move down" disabled={index === blocks.length - 1} onClick={() => move(index, 1)}><ArrowDown size={12} /></button>
                <button type="button" title="Duplicate block" disabled={atLimit} onClick={() => duplicate(index)}><Copy size={12} /></button>
                <button type="button" title="Remove block" onClick={() => remove(index)}><Trash2 size={12} /></button>
              </span>
            </summary>
            <div className="block-card__body">
              {(definition?.fields ?? []).map((field) => (
                <ControlInput key={field.id} control={field} value={block.settings[field.id]} onChange={(value) => setSetting(index, field.id, value)} />
              ))}
              {!definition && <p className="block-list__empty">Unknown block type “{block.type}” — it will pass through to the manifest unchanged.</p>}
            </div>
          </details>
        );
      })}
      <div className="block-add">
        {blockTypes.map((entry) => (
          <button type="button" key={entry.type} className="button button--quiet" disabled={atLimit} onClick={() => addBlock(entry.type)}><Plus size={13} />{entry.name}</button>
        ))}
        {atLimit && <small>Block limit reached ({maxBlocks}).</small>}
      </div>
    </div>
  );
}

/** True when a generic template state carries the fields the hero's React preview needs. */
function isHeroLikeState(state: TemplateState): boolean {
  return typeof state.heading === 'string' && typeof state.overlayOpacity === 'number' && typeof state.animation === 'string'
    && typeof state.contentPosition === 'string' && typeof state.backgroundType === 'string' && typeof state.sectionHeight === 'number';
}

/** Fallback preview for templates without a bespoke React preview — points at the compiled output path. */
function GenericPreview({ manifest, device, onCompile }: { manifest: SectionManifest; device: Device; onCompile: () => void }) {
  const settingCount = (manifest.settings ?? []).filter((entry) => 'id' in entry).length;
  return (
    <div className={`preview-shell preview-shell--${device}`}>
      <div className="preview-browserbar"><span /><span /><span /><div>preview.theme / {manifest.handle}</div></div>
      <div className="generic-preview">
        <span>SECTION PREVIEW</span>
        <h2>{manifest.name}</h2>
        <p>{manifest.description}</p>
        <div className="generic-preview__facts">
          <div><b>{settingCount}</b><span>Settings</span></div>
          <div><b>{(manifest.blocks ?? []).length}</b><span>Block types</span></div>
          <div><b>{(manifest.presets ?? []).length}</b><span>Presets</span></div>
        </div>
        <p className="generic-preview__hint">This template renders through its compiled Shopify output. Compile the section to inspect the generated Liquid, CSS, and JavaScript.</p>
        <button className="button button--accent" onClick={onCompile}><Play size={14} />Compile section</button>
      </div>
    </div>
  );
}

function LivePreview({ state, device, replayKey }: { state: HeroBuilderState; device: Device; replayKey: number }) {
  const alpha = Math.round(state.overlayOpacity * 2.55).toString(16).padStart(2, '0');
  const background = state.previewImageUrl
    ? `linear-gradient(${state.overlayColor}${alpha}, ${state.overlayColor}${alpha}), url(${state.previewImageUrl})`
    : state.backgroundType === 'gradient' ? state.gradient : state.backgroundColor;
  const justify = state.contentPosition.includes('center') && !state.contentPosition.includes('left') ? 'center' : 'flex-start';
  const align = state.contentPosition.startsWith('top') ? 'flex-start' : state.contentPosition.startsWith('bottom') ? 'flex-end' : 'center';
  return (
    <div className={`preview-shell preview-shell--${device}`}>
      <div className="preview-browserbar"><span /><span /><span /><div>preview.theme / {state.handle}</div></div>
      <section
        key={replayKey}
        className={`hero-preview hero-preview--${state.animation}`}
        style={{
          backgroundImage: background.includes('gradient') || background.includes('url(') ? background : undefined,
          backgroundColor: background.includes('gradient') || background.includes('url(') ? undefined : background,
          color: state.textColor,
          minHeight: device === 'mobile' ? 600 : Math.max(520, state.sectionHeight * 7),
          padding: device === 'mobile' ? '34px 24px' : `${state.paddingY}px ${state.paddingX}px`,
          alignItems: align,
          justifyContent: justify,
          textAlign: state.textAlignment,
          ['--preview-accent' as string]: state.accentColor,
          ['--preview-duration' as string]: `${state.animationDuration}ms`,
        }}
      >
        <div className="hero-preview__noise" />
        <div className="hero-preview__content" style={{ maxWidth: device === 'mobile' ? '100%' : state.contentWidth }}>
          <div className="hero-preview__eyebrow">{state.eyebrow}</div>
          <h1 style={{ fontSize: device === 'mobile' ? state.mobileHeadingSize : `clamp(42px, 5.4vw, ${state.headingSize}px)` }}>{state.heading}</h1>
          <p>{state.body}</p>
          <div className="hero-preview__actions">
            {state.primaryLabel && <a className="preview-button preview-button--solid">{state.primaryLabel}<ExternalLink size={13} /></a>}
            {state.secondaryLabel && <a className="preview-button preview-button--line">{state.secondaryLabel}</a>}
          </div>
          <div className="hero-preview__stats"><div><b>01</b><span>Modular by default</span></div><div><b>02</b><span>Motion ready</span></div></div>
        </div>
        <div className="hero-preview__scroll"><span />SCROLL</div>
      </section>
    </div>
  );
}

function renderCodeLines(content: string, query: string) {
  const lines = content.split('\n');
  const needle = query.trim().toLowerCase();
  if (!needle) return content;
  return lines.map((line, index) => {
    const at = line.toLowerCase().indexOf(needle);
    const suffix = index < lines.length - 1 ? '\n' : '';
    if (at < 0) return <span key={index}>{line}{suffix}</span>;
    return <span key={index}>{line.slice(0, at)}<mark>{line.slice(at, at + needle.length)}</mark>{line.slice(at + needle.length)}{suffix}</span>;
  });
}

function FileViewer({ files, activePath, onSelect }: { files: GeneratedFile[]; activePath: string; onSelect: (path: string) => void }) {
  const active = files.find((file) => file.path === activePath) ?? files[0];
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');
  const copy = async () => {
    if (!active) return;
    try { await navigator.clipboard.writeText(active.content); }
    catch { const area = document.createElement('textarea'); area.value = active.content; document.body.appendChild(area); area.select(); try { document.execCommand('copy'); } catch { /* ignore */ } area.remove(); }
    setCopied(true); window.setTimeout(() => setCopied(false), 1500);
  };
  const download = () => {
    if (!active) return;
    const blob = new Blob([active.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = active.path.split('/').pop() || 'file.txt'; link.click();
    URL.revokeObjectURL(url);
  };
  const groups = files.reduce<Record<string, GeneratedFile[]>>((accumulator, file) => {
    const top = file.path.includes('/') ? file.path.split('/')[0] : 'files';
    (accumulator[top] = accumulator[top] ?? []).push(file);
    return accumulator;
  }, {});
  const lineCount = (active?.content ?? '').split('\n').length;
  const matches = query.trim() ? (active?.content ?? '').split('\n').filter((line) => line.toLowerCase().includes(query.trim().toLowerCase())).length : 0;
  return (
    <div className="file-workspace">
      <aside className="file-list">
        <p>OUTPUT PACKAGE</p>
        {Object.entries(groups).map(([folder, groupFiles]) => (
          <div className="file-group" key={folder}>
            <span className="file-group__label">{folder}/</span>
            {groupFiles.map((file) => <button className={file.path === active?.path ? 'is-active' : ''} onClick={() => onSelect(file.path)} key={file.path}><FileCode2 size={14} /><span>{file.path.split('/').pop()}</span></button>)}
          </div>
        ))}
      </aside>
      <div className="code-panel">
        <header>
          <span>{active?.path}{active?.language && <em className="file-lang">{active.language}</em>}</span>
          <div className="code-panel__actions">
            <div className="code-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find in file…" />{query.trim() && <b>{matches}</b>}</div>
            <button onClick={download}><Download size={13} />Download</button>
            <button onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy'}</button>
          </div>
        </header>
        <div className="code-body">
          <div className="code-gutter">{Array.from({ length: lineCount }, (_, index) => <span key={index}>{index + 1}</span>)}</div>
          <pre><code>{renderCodeLines(active?.content ?? '', query)}</code></pre>
        </div>
      </div>
    </div>
  );
}

interface ConfirmOptions { title: string; body?: string; confirmLabel?: string; danger?: boolean }
interface ConfirmState extends ConfirmOptions { resolve: (ok: boolean) => void }

function ConfirmModal({ state, onResolve }: { state: ConfirmState; onResolve: (ok: boolean) => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onResolve(false); if (event.key === 'Enter') onResolve(true); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onResolve]);
  return (
    <div className="modal-overlay" onClick={() => onResolve(false)}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <h3>{state.title}</h3>
        {state.body && <p>{state.body}</p>}
        <div className="modal-actions">
          <button className="button button--quiet" onClick={() => onResolve(false)}>Cancel</button>
          <button className={`button ${state.danger ? 'button--danger' : 'button--accent'}`} onClick={() => onResolve(true)} autoFocus>{state.confirmLabel ?? 'Confirm'}</button>
        </div>
      </div>
    </div>
  );
}

function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch { const area = document.createElement('textarea'); area.value = text; document.body.appendChild(area); area.select(); try { document.execCommand('copy'); } catch { /* ignore */ } area.remove(); }
    setDone(true); window.setTimeout(() => setDone(false), 1400);
  };
  return <button type="button" className={className} onClick={onCopy} title="Copy">{done ? <Check size={13} /> : <Copy size={13} />}{label && (done ? 'Copied' : label)}</button>;
}

function VersionHistoryModal({ project, versions, loading, error, onRestore, onClose }: {
  project: SavedProject; versions: ProjectVersion[]; loading: boolean; error: string;
  onRestore: (versionId: string) => void; onClose: () => void;
}) {
  // Default the diff to the two most recent versions (compare = newest, base = previous).
  const [baseId, setBaseId] = useState('');
  const [compareId, setCompareId] = useState('');
  useEffect(() => {
    if (versions.length) { setCompareId(versions[0].id); setBaseId((versions[1] ?? versions[0]).id); }
  }, [versions]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const base = versions.find((version) => version.id === baseId) ?? null;
  const compare = versions.find((version) => version.id === compareId) ?? null;
  const diff = useMemo(() => {
    if (!base || !compare) return [];
    return diffLines(JSON.stringify(base.manifest, null, 2), JSON.stringify(compare.manifest, null, 2));
  }, [base, compare]);
  const changes = diff.filter((line) => line.type !== 'same').length;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card--wide version-history" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="version-history__head">
          <div><span>VERSION HISTORY</span><h3>{project.name}</h3></div>
          <button className="button button--quiet button--icon" onClick={onClose} aria-label="Close">×</button>
        </div>
        {loading ? <div className="version-history__empty"><LoaderCircle className="spin" size={20} /><p>Loading versions…</p></div>
          : error ? <div className="error-line"><CircleAlert size={15} />{error}</div>
          : versions.length === 0 ? <div className="version-history__empty"><History size={22} /><p>No saved versions yet. Every save creates a version.</p></div>
          : <div className="version-history__body">
              <ul className="version-list">
                {versions.map((version) => (
                  <li key={version.id} className={version.id === compareId ? 'is-current' : ''}>
                    <div className="version-list__meta">
                      <b>v{version.version_number}</b>
                      <small>{new Date(version.created_at).toLocaleString()}</small>
                      <code title={version.checksum}>{version.checksum.slice(0, 12)}</code>
                    </div>
                    <button className="button button--quiet" onClick={() => onRestore(version.id)} disabled={version.id === versions[0].id} title={version.id === versions[0].id ? 'This is the current version' : 'Restore this version'}><RotateCcw size={13} />Restore</button>
                  </li>
                ))}
              </ul>
              <div className="version-diff">
                <div className="version-diff__controls">
                  <label>Base<select value={baseId} onChange={(event) => setBaseId(event.target.value)}>{versions.map((version) => <option key={version.id} value={version.id}>v{version.version_number}</option>)}</select></label>
                  <label>Compare<select value={compareId} onChange={(event) => setCompareId(event.target.value)}>{versions.map((version) => <option key={version.id} value={version.id}>v{version.version_number}</option>)}</select></label>
                  <span className="version-diff__count">{changes === 0 ? 'Identical manifests' : `${changes} changed line${changes === 1 ? '' : 's'}`}</span>
                </div>
                <pre className="version-diff__pane">{diff.map((line, index) => (
                  <span key={index} className={`diff-line diff-line--${line.type}`}>{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '} {line.text}{'\n'}</span>
                ))}</pre>
              </div>
            </div>}
      </div>
    </div>
  );
}

/** Human message for a failed API response — distinguishes auth from other errors. */
function apiErrorMessage(status: number, payload: { error?: string } | null, fallback: string): string {
  if (status === 401) return 'Connect a Shopify store first (Projects → Connect Shopify).';
  return payload?.error || fallback;
}

const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

export default function App() {
  const [view, setView] = useState<View>('home');
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const confirm = (options: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirmState({ ...options, resolve }));
  const resolveConfirm = (ok: boolean) => { setConfirmState((current) => { current?.resolve(ok); return null; }); };
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === '1');
  useEffect(() => { localStorage.setItem('sidebar-collapsed', sidebarCollapsed ? '1' : '0'); }, [sidebarCollapsed]);
  const [dark, setDark] = useState(() => localStorage.getItem('factory-theme') === 'dark');
  useEffect(() => { applyFactoryTheme(dark); }, [dark]);
  // Registry-driven builder: which template is being authored + its generic control state.
  const [templateId, setTemplateId] = useState<string>(() => templates[0]?.id ?? '');
  const template: TemplateDef | null = useMemo(() => getTemplate(templateId) ?? templates[0] ?? null, [templateId]);
  const [builderState, setBuilderState] = useState<TemplateState>(() => asTemplateState(templates[0]?.defaultState));
  const [device, setDevice] = useState<Device>('desktop');
  const [replayKey, setReplayKey] = useState(0);
  const [customManifest, setCustomManifest] = useState<SectionManifest | null>(null);
  const generatedManifest = useMemo<SectionManifest>(() => {
    if (template) { try { return buildTemplateManifest(template, builderState); } catch { /* fall through to the hero fallback */ } }
    return createCinematicHeroManifest(defaultHeroState);
  }, [template, builderState]);
  const manifest = customManifest ?? generatedManifest;
  // A contract-authored manifest that no template can round-trip stays authoritative: the
  // builder shows no controls for it, so nothing can silently regenerate (and discard) it.
  const contractOnly = useMemo(() => {
    if (!customManifest) return false;
    const match = templateForManifest(customManifest);
    if (!match) return true;
    return templateStateFromManifest(match, customManifest) === null;
  }, [customManifest]);
  const groupedControls = useMemo(() => (template ? groupControls(template.controls) : []), [template]);
  // The hero keeps its bespoke React preview; any state carrying the hero fields can use it.
  const heroPreviewState = useMemo<HeroBuilderState | null>(
    () => (!contractOnly && isHeroLikeState(builderState) ? (builderState as unknown as HeroBuilderState) : null),
    [builderState, contractOnly],
  );
  const builderControlCount = contractOnly || !template
    ? (manifest.settings ?? []).filter((entry) => 'id' in entry).length
    : template.controls.length;
  const [contractText, setContractText] = useState(JSON.stringify(manifest, null, 2));
  const [contractError, setContractError] = useState('');
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [activeFile, setActiveFile] = useState('');
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [session, setSession] = useState<AppSession | null>(null);
  const [shopInput, setShopInput] = useState('');
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<SavedApiKey[]>([]);
  const [newApiToken, setNewApiToken] = useState('');
  const [deployments, setDeployments] = useState<SavedDeployment[]>([]);
  const [themes, setThemes] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [themeId, setThemeId] = useState('');
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  const [projectKindFilter, setProjectKindFilter] = useState<'all' | 'section' | 'clone'>('all');
  const [contractIssues, setContractIssues] = useState<CompileResult['issues']>([]);
  const [contractChecking, setContractChecking] = useState(false);
  const [keyLabel, setKeyLabel] = useState('');
  const [dirty, setDirty] = useState(false);
  const [deployProjectId, setDeployProjectId] = useState('');
  const [historyProject, setHistoryProject] = useState<SavedProject | null>(null);
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState('');
  // Deploy dry-run diff (Preview changes) state.
  const [diffFiles, setDiffFiles] = useState<DiffFileEntry[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState('');
  // Contract editor line lookup (compiler inspect module).
  const contractAreaRef = useRef<HTMLTextAreaElement | null>(null);

  /** Line/column for each contract issue index, resolved against the CURRENT textarea text. */
  const contractIssueLocations = useMemo(() => {
    const map = new Map<number, { line: number; column: number }>();
    contractIssues.forEach((issue, index) => {
      try { const location = locateIssue(contractText, issue.path); if (location) map.set(index, location); } catch { /* tolerate locator errors */ }
    });
    return map;
  }, [contractIssues, contractText]);

  /** Scroll + focus the contract textarea to a 1-indexed line and select it. */
  const jumpToContractLine = (line: number) => {
    const area = contractAreaRef.current;
    if (!area) return;
    const lines = contractText.split('\n');
    const bounded = Math.max(1, Math.min(line, lines.length));
    let offset = 0;
    for (let index = 0; index < bounded - 1; index++) offset += lines[index].length + 1;
    area.focus();
    area.setSelectionRange(offset, offset + (lines[bounded - 1]?.length ?? 0));
    const lineHeight = parseFloat(window.getComputedStyle(area).lineHeight) || 18;
    area.scrollTop = Math.max(0, (bounded - 1) * lineHeight - area.clientHeight / 2);
  };

  // Editing a control regenerates the manifest from the CURRENT template's state (never the
  // hero's), so a non-hero section survives control edits — the old customManifest-nuking bug.
  const updateControl = (id: string, value: unknown) => {
    setCustomManifest(null);
    setDirty(true);
    setBuilderState((current) => ({ ...current, [id]: value }));
  };
  const updateBlocks = (blocks: BlockInstance[]) => {
    setCustomManifest(null);
    setDirty(true);
    setBuilderState((current) => ({ ...current, blocks }));
  };

  const selectTemplate = async (id: string) => {
    const next = getTemplate(id);
    if (!next || id === templateId) return;
    if (dirty || customManifest) {
      const ok = await confirm({ title: `Switch to ${next.name}?`, body: 'The builder resets to the selected template’s defaults. Unsaved edits to the current section are discarded.', confirmLabel: 'Switch template', danger: true });
      if (!ok) return;
    }
    setTemplateId(id);
    setBuilderState(asTemplateState(next.defaultState));
    setCustomManifest(null);
    setCompileResult(null);
    setDirty(false);
    setNotice(`${next.name} template loaded.`);
  };

  useEffect(() => {
    if (!customManifest) setContractText(JSON.stringify(generatedManifest, null, 2));
  }, [generatedManifest, customManifest]);

  const loadSession = () => fetch('/api/session').then((response) => response.json()).then((data:AppSession) => {
    setSession(data);
    if(data.authenticated)void loadProjects();
  }).catch(() => undefined);

  const loadProjects = async () => {
    setProjectsLoading(true); setProjectsError('');
    try {
      const response = await fetch('/api/projects');
      if (!response.ok) { if (response.status !== 401) setProjectsError('Projects could not be loaded.'); return; }
      const payload = await response.json(); setProjects(payload.projects ?? []);
    } catch { setProjectsError('Could not reach the server.'); }
    finally { setProjectsLoading(false); }
  };

  useEffect(() => { void loadSession(); }, []);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  useEffect(()=>{
    if(!session?.authenticated)return;
    if(view==='deploy')void fetch('/api/deployments').then((response)=>response.json()).then((payload)=>setDeployments(payload.deployments??[]));
    if(view==='settings')void fetch('/api/api-keys').then((response)=>response.json()).then((payload)=>setApiKeys(payload.keys??[]));
  },[view,session?.authenticated]);

  const compile = async (goToCode = true) => {
    setWorking(true);
    setNotice('');
    try {
      const response = await fetch('/api/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest }) });
      // 200 = valid, 422 = validation failures (still a CompileResult). Anything else is an error.
      if (response.status !== 200 && response.status !== 422) {
        const payload = await response.json().catch(() => null);
        setNotice(apiErrorMessage(response.status, payload, 'The compiler is not reachable.'));
        return;
      }
      const result = await response.json() as CompileResult;
      setCompileResult(result);
      setActiveFile(result.files?.[0]?.path ?? '');
      if (result.valid && goToCode) setView('code');
      if (!result.valid) setNotice('The contract has validation errors. Open Generated files to review them.');
    } catch {
      setNotice('The compiler API is not reachable. Start the app with npm run dev.');
    } finally { setWorking(false); }
  };

  const exportZip = async () => {
    setWorking(true);
    try {
      const response = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest }) });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setNotice(apiErrorMessage(response.status, payload, response.status === 422 ? 'The section has validation errors — compile it first to review them.' : 'The section could not be exported.'));
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${manifest.handle}.zip`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice('Shopify section package exported.');
    } catch { setNotice('The section could not be exported. Validate the contract first.'); }
    finally { setWorking(false); }
  };

  const applyContract = async () => {
    let parsed: SectionManifest;
    try { parsed = JSON.parse(contractText) as SectionManifest; }
    catch (error) { setContractError(error instanceof Error ? error.message : 'Invalid JSON'); setContractIssues([]); return; }
    setContractError(''); setContractChecking(true); setContractIssues([]);
    try {
      const response = await fetch('/api/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: parsed }) });
      if (response.status !== 200 && response.status !== 422) {
        const payload = await response.json().catch(() => null);
        setContractError(apiErrorMessage(response.status, payload, 'Validation service is unreachable.'));
        return;
      }
      const result = await response.json() as CompileResult;
      setContractIssues(result.issues ?? []);
      if (result.valid) {
        setCustomManifest(parsed);
        // Re-hydrate the builder when a registered template can round-trip this contract.
        const match = templateForManifest(parsed);
        const recovered = match ? templateStateFromManifest(match, parsed) : null;
        if (match && recovered) { setTemplateId(match.id); setBuilderState(recovered); }
        setDirty(false);
        setNotice(match && recovered ? `Contract validated and applied — editable as ${match.name}.` : 'Contract validated and applied.');
      }
      else setNotice(`Contract has ${result.issues.length} validation issue(s) — see below.`);
    } catch { setContractError('Validation service is unreachable.'); }
    finally { setContractChecking(false); }
  };

  const formatContract = () => { try { setContractText(JSON.stringify(JSON.parse(contractText), null, 2)); setContractError(''); } catch (error) { setContractError(error instanceof Error ? error.message : 'Invalid JSON'); } };
  const copyContract = async () => { try { await navigator.clipboard.writeText(contractText); setNotice('Contract JSON copied to clipboard.'); } catch { setNotice('Clipboard is unavailable in this context.'); } };
  const downloadContract = () => { const blob = new Blob([contractText], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${manifest.handle || 'section'}.contract.json`; link.click(); URL.revokeObjectURL(url); };
  const importContract = (file: File | undefined) => { if (!file) return; const reader = new FileReader(); reader.onload = () => { setContractText(String(reader.result ?? '')); setContractError(''); setContractIssues([]); setNotice(`Loaded ${file.name}.`); }; reader.readAsText(file); };

  // Navigation guard: warn before leaving the builder with unsaved edits.
  const requestView = async (target: View) => {
    if (dirty && view === 'build' && target !== 'build') {
      const ok = await confirm({ title: 'Discard unsaved changes?', body: 'Your builder edits have not been saved as a project version.', confirmLabel: 'Discard', danger: true });
      if (!ok) return;
      setDirty(false);
    }
    setView(target);
  };

  const logoutClaude = async () => {
    if (!(await confirm({ title: 'Log out of Claude?', body: 'This app will forget its Claude connection and return to the start screen. Your Claude CLI sign-in on this machine is not affected.', confirmLabel: 'Log out', danger: true }))) return;
    await fetch('/api/claude/disconnect', { method: 'POST' }).catch(() => undefined);
    await loadSession();
  };
  const switchWorkspace = async () => {
    if (!(await confirm({ title: 'Switch workspace?', body: 'You will return to the workspace picker. Indexed project summaries stay cached in each folder.', confirmLabel: 'Switch' }))) return;
    await fetch('/api/workspace/close', { method: 'POST' }).catch(() => undefined);
    await loadSession();
  };

  const resetTemplate = () => {
    if (!template) return;
    setBuilderState(asTemplateState(template.defaultState));
    setCustomManifest(null);
    setDirty(false);
    setNotice(`Reset to the ${template.name} defaults.`);
  };

  const newProject=(withTemplateId?:string)=>{
    const chosen=(withTemplateId?getTemplate(withTemplateId):null)??template??templates[0]??null;
    if(chosen){setTemplateId(chosen.id);setBuilderState(asTemplateState(chosen.defaultState));}
    setCustomManifest(null);setProjectId(null);setCompileResult(null);setDirty(false);setView('build');setNotice(chosen?`New ${chosen.name} workspace ready.`:'New section workspace ready.');
  };

  const openProject=(project:SavedProject)=>{
    // Factory clone jobs surfaced as projects have no section manifest — they live in the Factory.
    if(project.kind==='clone'||!project.manifest){setView('factory');setNotice(`${project.name} is a factory clone job — opening the Factory.`);return;}
    // Pick the template that authored this manifest and hydrate BOTH the per-template builder
    // state and the custom manifest, so a control edit regenerates via the RIGHT template
    // instead of discarding the section (the old hero-only nuking bug).
    const match=templateForManifest(project.manifest);
    const recovered=match?templateStateFromManifest(match,project.manifest):null;
    if(match&&recovered){setTemplateId(match.id);setBuilderState(recovered);}
    setProjectId(project.id);setCustomManifest(project.manifest);setContractText(JSON.stringify(project.manifest,null,2));setContractIssues([]);setCompileResult(null);setDirty(false);setView('contract');
    setNotice(match&&recovered?`${project.name} opened — editable in the builder as ${match.name}.`:`${project.name} opened — no matching template, edit it as a design contract.`);
  };

  const saveProject=async()=>{
    if(!session?.authenticated){setNotice('Connect a Shopify store before saving projects.');return;}
    setWorking(true);
    try{
      const response=await fetch(projectId?`/api/projects/${projectId}`:'/api/projects',{method:projectId?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({manifest})});
      const payload=await response.json();if(!response.ok)throw new Error(payload.error||payload.issues?.[0]?.message||'Project could not be saved.');
      setProjectId(payload.project.id);setDirty(false);await loadProjects();setNotice(`${manifest.name} saved as version ${payload.version.version_number}.`);
    }catch(error){setNotice(error instanceof Error?error.message:'Project could not be saved.');}
    finally{setWorking(false);}
  };

  const deleteProject=async(id:string)=>{
    const target=projects.find((project)=>project.id===id);
    if(!(await confirm({title:'Delete project?',body:`"${target?.name??'This project'}" and all its versions will be permanently removed.`,confirmLabel:'Delete',danger:true})))return;
    const previous=projects;
    setProjects((items)=>items.filter((project)=>project.id!==id)); // optimistic
    if(projectId===id)setProjectId(null);
    const response=await fetch(`/api/projects/${id}`,{method:'DELETE'});
    if(response.ok)setNotice('Project deleted.');
    else{setProjects(previous);setNotice('The project could not be deleted.');}
  };

  const cloneProject=async(project:SavedProject)=>{
    if(!project.manifest){setNotice('Factory clone jobs are duplicated from the Factory, not the section library.');return;}
    setWorking(true);
    try{
      const copy={...project.manifest,name:`${project.manifest.name} copy`,handle:`${project.manifest.handle}-copy`.slice(0,64)};
      const response=await fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({manifest:copy})});
      const payload=await response.json();if(!response.ok)throw new Error(payload.error||payload.issues?.[0]?.message||'Project could not be duplicated.');
      await loadProjects();setNotice(`Duplicated as "${copy.name}".`);
    }catch(error){setNotice(error instanceof Error?error.message:'Project could not be duplicated.');}
    finally{setWorking(false);}
  };

  const createApiKey=async()=>{
    setWorking(true);try{const label=keyLabel.trim()||'AI platform connection';const response=await fetch('/api/api-keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label})});const payload=await response.json();if(!response.ok)throw new Error(payload.error);setNewApiToken(payload.token);setKeyLabel('');const keys=await fetch('/api/api-keys').then((item)=>item.json());setApiKeys(keys.keys??[]);}catch(error){setNotice(error instanceof Error?error.message:'API key could not be created.');}finally{setWorking(false);}
  };

  const revokeApiKey=async(id:string)=>{
    const target=apiKeys.find((key)=>key.id===id);
    if(!(await confirm({title:'Revoke API key?',body:`Any integration using "${target?.label??'this key'}" will immediately lose access. This cannot be undone.`,confirmLabel:'Revoke',danger:true})))return;
    const previous=apiKeys;
    setApiKeys((items)=>items.map((item)=>item.id===id?{...item,revoked_at:new Date().toISOString()}:item));
    const response=await fetch(`/api/api-keys/${id}`,{method:'DELETE'});
    if(!response.ok){setApiKeys(previous);setNotice('The key could not be revoked.');}
  };

  const rotateApiKey=async(id:string)=>{
    const target=apiKeys.find((key)=>key.id===id);
    if(!(await confirm({title:'Rotate API key?',body:`A new secret will be minted for "${target?.label??'this key'}". The current token stops working immediately — update your integration with the new one.`,confirmLabel:'Rotate'})))return;
    setWorking(true);
    try{
      const response=await fetch(`/api/api-keys/${id}/rotate`,{method:'POST'});
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'The key could not be rotated.');
      setNewApiToken(payload.token);
      const keys=await fetch('/api/api-keys').then((item)=>item.json());setApiKeys(keys.keys??[]);
      setNotice(`"${target?.label??'Key'}" rotated — copy the new token now, it is shown only once.`);
    }catch(error){setNotice(error instanceof Error?error.message:'The key could not be rotated.');}
    finally{setWorking(false);}
  };

  const loadVersions=async(projectId:string)=>{
    setVersionsLoading(true);setVersionsError('');
    try{
      const response=await fetch(`/api/projects/${projectId}/versions`);
      if(!response.ok){setVersionsError(response.status===401?'Connect a Shopify store to view versions.':'Versions could not be loaded.');setVersions([]);return;}
      const payload=await response.json();setVersions(payload.versions??[]);
    }catch{setVersionsError('Could not reach the server.');setVersions([]);}
    finally{setVersionsLoading(false);}
  };

  const openHistory=(project:SavedProject)=>{setHistoryProject(project);setVersions([]);setVersionsError('');void loadVersions(project.id);};

  const restoreVersion=async(versionId:string)=>{
    if(!historyProject)return;
    const version=versions.find((item)=>item.id===versionId);
    if(!(await confirm({title:'Restore this version?',body:`"${historyProject.name}" will be rolled back to version ${version?.version_number??'?'}. This is saved as a new version, so nothing is lost.`,confirmLabel:'Restore'})))return;
    setWorking(true);
    try{
      const response=await fetch(`/api/projects/${historyProject.id}/versions/${versionId}/restore`,{method:'POST'});
      const payload=await response.json().catch(()=>null);
      if(!response.ok)throw new Error(payload?.error||'The version could not be restored.');
      await loadProjects();await loadVersions(historyProject.id);
      setNotice(payload?.version?.version_number?`Restored — saved as version ${payload.version.version_number}.`:'Version restored.');
    }catch(error){setNotice(error instanceof Error?error.message:'The version could not be restored.');}
    finally{setWorking(false);}
  };

  const rollback=async(id:string)=>{
    if(!(await confirm({title:'Roll back deployment?',body:'This restores the theme files to their pre-installation snapshot.',confirmLabel:'Roll back',danger:true})))return;
    setWorking(true);try{const response=await fetch(`/api/deployments/${id}/rollback`,{method:'POST'});const payload=await response.json();if(!response.ok)throw new Error(payload.error);setDeployments((items)=>items.map((item)=>item.id===id?{...item,status:'rolled_back',rolled_back_at:new Date().toISOString()}:item));setNotice('Deployment rolled back successfully.');}catch(error){setNotice(error instanceof Error?error.message:'Rollback failed.');}finally{setWorking(false);}
  };

  const loadThemes = async () => {
    setWorking(true);
    setNotice('');
    try {
      const response = await fetch('/api/shopify/themes');
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      const safeThemes = payload.themes.filter((theme: { role: string }) => theme.role !== 'MAIN');
      setThemes(safeThemes);
      setThemeId(safeThemes[0]?.id ?? '');
      if (safeThemes.length === 0) setNotice('This store has no unpublished theme. Duplicate your live theme in Shopify first, then reload.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to load Shopify themes.'); }
    finally { setWorking(false); }
  };

  // Clone jobs are projects too now, but only real section projects carry an installable manifest.
  const projectKindOf = (project: SavedProject): 'section' | 'clone' => (project.kind === 'clone' ? 'clone' : 'section');
  const sectionProjects = projects.filter((project) => projectKindOf(project) === 'section' && project.manifest);
  const cloneCount = projects.length - sectionProjects.length;
  // Install either the live builder section or a chosen saved project's manifest.
  const installManifest = (() => { const chosen = sectionProjects.find((project) => project.id === deployProjectId); return chosen?.manifest ?? manifest; })();
  // The compile result reflects the builder `manifest`, so it only mirrors what installs when the
  // builder section is the install target (no saved project chosen). Otherwise the server recompiles
  // the chosen project's stored version on install, so we can't preview its exact files here.
  const installFiles: GeneratedFile[] | null = (!deployProjectId && compileResult && compileResult.files.length > 0) ? compileResult.files : null;
  const filteredProjects = projects.filter((project) =>
    (projectKindFilter === 'all' || projectKindOf(project) === projectKindFilter)
    && `${project.name} ${project.handle} ${project.description ?? ''}`.toLowerCase().includes(projectQuery.trim().toLowerCase()));

  // A stale diff describes a different target — drop it when the section or theme changes.
  useEffect(() => { setDiffFiles(null); setDiffError(''); }, [themeId, deployProjectId]);

  /** Dry-run: ask the server what installing would change on the selected theme. */
  const previewChanges = async () => {
    if (!themeId) return;
    setDiffLoading(true); setDiffError(''); setDiffFiles(null);
    try {
      const response = await fetch('/api/shopify/diff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: installManifest, themeId }) });
      if (response.status === 404) { setDiffError('Dry-run preview is not available on this server yet.'); return; }
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setDiffError(apiErrorMessage(response.status, payload, response.status === 422 ? 'The section has validation errors — compile it first to review them.' : 'The changes could not be previewed.')); return; }
      setDiffFiles(Array.isArray(payload?.files) ? (payload.files as DiffFileEntry[]) : []);
    } catch { setDiffError('The diff service is not reachable.'); }
    finally { setDiffLoading(false); }
  };

  const install = async () => {
    if (!themeId) return;
    setWorking(true);
    try {
      const response = await fetch('/api/shopify/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: installManifest, themeId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Install failed');
      setNotice(`${installManifest.name} installed to ${payload.theme.name}.`);
      const history=await fetch('/api/deployments').then((item)=>item.json());setDeployments(history.deployments??[]);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to install section.'); }
    finally { setWorking(false); }
  };

  // Startup gate: the app must not run until Claude is connected AND a workspace is chosen.
  // (In production the server reports claude/workspace ready, so the gate is skipped.)
  if (session === null) return <div className="app-boot"><LoaderCircle className="spin" size={26} /></div>;
  const claudeReady = session.claude ? session.claude.connected : true;
  const workspaceReady = session.workspace ? session.workspace.ready : true;
  if (!claudeReady || !workspaceReady) return <OnboardingGate onComplete={() => void loadSession()} />;

  return (
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar items={navItems} view={view} onNavigate={(target) => void requestView(target)} collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((value) => !value)} settingsView="settings" account={session?.claude ? { workspaceName: session.workspace?.name ?? null, claudeMethod: session.claude.method, onSwitchWorkspace: () => void switchWorkspace(), onLogoutClaude: () => void logoutClaude() } : undefined} />

      <main>
        <header className="topbar">
          <div><p>{['home','projects','settings','factory','terminal','browser'].includes(view)?'THEMEBOT / PRODUCTION':`WORKSPACE / ${manifest.handle}`}</p><h1 key={view}>{view === 'build' ? 'Visual section builder' : navItems.find((item) => item.id === view)?.label}</h1></div>
          <div className="topbar__actions">
            {session?.authenticated&&<div className="shop-pill is-connected"><i />{session.shop}</div>}
            {!['home','projects','settings','factory','terminal','browser'].includes(view)&&<button className="button button--quiet" onClick={saveProject} disabled={working}><Save size={15} />{projectId?'Save version':'Save project'}</button>}
            {!['home','projects','settings','deploy','factory','terminal','browser'].includes(view)&&<button className="button button--quiet" onClick={() => compile(true)} disabled={working}>{working ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}Compile</button>}
            {!['home','projects','settings','factory','terminal','browser'].includes(view)&&<button className="button button--accent" onClick={exportZip} disabled={working}><Download size={15} />Export package</button>}
            {/* Theme toggle is always the last item → same top-right corner on every page. */}
            <button className="button button--quiet button--icon topbar__theme" title={dark?'Switch to light theme':'Switch to dark theme'} aria-label={dark?'Switch to light theme':'Switch to dark theme'} onClick={()=>setDark((value)=>!value)}>{dark?<span key="sun" className="theme-icon"><Sun size={15} /></span>:<span key="moon" className="theme-icon"><Moon size={15} /></span>}</button>
          </div>
        </header>

        {notice && <div className="notice"><Sparkles size={15} /><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}

        {view === 'home' && <HomeScreen onNavigate={(target) => setView(target)} workspaceName={session?.workspace?.name ?? null} onSwitchWorkspace={() => void switchWorkspace()} />}

        {view === 'projects' && <section className="page-pad projects-page">
          <div className="page-heading"><div><span>YOUR MODULAR SECTION LIBRARY</span><h2>Section projects</h2><p>Create once, version every change, and deploy the same design system across connected Shopify stores and unpublished themes.</p></div><button className="button button--accent" onClick={()=>newProject()}><Plus size={15}/>New section</button></div>
          {!session?.authenticated&&<div className="connect-hero">
            <div className="connect-hero__mark"><Link2 size={27}/></div><div><span>CONNECT YOUR FIRST STORE</span><h3>{session?.shopify.configured?'Turn ThemeBot into your Shopify workspace.':'Production credentials are not configured yet.'}</h3><p>{session?.shopify.configured?'Authorize the app to save projects, create versions, install sections, and roll back deployments.':'The full builder remains available in demo mode. Add the Shopify credentials from .env.example when you are ready to connect a store.'}</p></div>
            {session?.shopify.configured&&<form onSubmit={(event)=>{event.preventDefault();window.location.href=`/auth/shopify?shop=${encodeURIComponent(shopInput)}`;}}><input value={shopInput} onChange={(event)=>setShopInput(event.target.value)} placeholder="your-store.myshopify.com" required/><button className="button button--accent" type="submit"><Store size={15}/>Connect Shopify</button></form>}
          </div>}
          {session?.authenticated&&<>
            {projectsError&&<div className="error-line"><CircleAlert size={15}/>{projectsError}<button className="button button--quiet" onClick={()=>void loadProjects()}><RefreshCw size={13}/>Retry</button></div>}
            {projects.length>0&&<div className="projects-toolbar">
              <div className="projects-search"><Search size={14}/><input value={projectQuery} onChange={(event)=>setProjectQuery(event.target.value)} placeholder="Search projects by name or handle…"/></div>
              {cloneCount>0&&<div className="kind-filter" role="tablist" aria-label="Filter projects by kind">
                {([['all',`All · ${projects.length}`],['section',`Sections · ${sectionProjects.length}`],['clone',`Clones · ${cloneCount}`]] as const).map(([value,label])=>
                  <button key={value} className={projectKindFilter===value?'is-active':''} onClick={()=>setProjectKindFilter(value)}>{label}</button>)}
              </div>}
              <span>{filteredProjects.length} of {projects.length}</span>
            </div>}
            <div className="project-grid">
              <div className="new-project-card new-project-card--menu" role="group" aria-label="Create new section">
                <span><Plus size={21}/></span><b>Create new section</b><small>{templates.length>1?'Pick a section template':'Start with the cinematic modular system'}</small>
                {templates.length>0
                  ?<div className="new-project-card__templates">{templates.map((entry)=><button key={entry.id} title={entry.description} onClick={()=>newProject(entry.id)}>{entry.name}</button>)}</div>
                  :<div className="new-project-card__templates"><button onClick={()=>newProject()}>Open the builder</button></div>}
              </div>
              {filteredProjects.map((project)=>{const isClone=projectKindOf(project)==='clone';return <article className={`project-card${isClone?' project-card--clone':''}`} key={project.id}>
                <div className="project-card__top"><span className={isClone?'kind-badge kind-badge--clone':undefined}>{isClone?<><Factory size={11}/>CLONE PROJECT</>:'SECTION PROJECT'}</span>
                  <div className="project-card__tools">
                    {!isClone&&<button title="Version history" onClick={()=>openHistory(project)}><History size={14}/></button>}
                    {!isClone&&<button title="Duplicate project" onClick={()=>cloneProject(project)}><Copy size={13}/></button>}
                    {!isClone&&<button title="Delete project" onClick={()=>deleteProject(project.id)}><Trash2 size={14}/></button>}
                  </div>
                </div>
                <div className="project-card__visual">{isClone?<Factory size={29}/>:<Layers3 size={29}/>}<i/></div>
                <h3>{project.name}</h3><code>{project.handle}</code><p>{project.description}</p>
                <footer>
                  <span>{(()=>{const cloneStatus=project.clone_meta?.status??project.status;return isClone&&cloneStatus?`${cloneStatus.replace(/_/g,' ')} · `:'';})()}Updated {new Date(project.updated_at).toLocaleDateString()}</span>
                  <button onClick={()=>openProject(project)}>{isClone?'Open in Factory':'Open'} <ExternalLink size={13}/></button>
                </footer>
              </article>;})}
            </div>
            {projectsLoading&&projects.length===0&&<div className="project-empty"><LoaderCircle className="spin" size={22}/><p>Loading your projects…</p></div>}
            {!projectsLoading&&projects.length===0&&!projectsError&&<div className="project-empty"><FolderKanban size={25}/><h3>Your section library is ready.</h3><p>Create your first modular Shopify section to begin.</p></div>}
            {projects.length>0&&filteredProjects.length===0&&<div className="project-empty"><Search size={22}/><p>No projects match “{projectQuery}”.</p></div>}
          </>}
        </section>}

        {view === 'build' && <div className="builder-layout">
          <aside className="controls-panel">
            <div className="panel-intro"><div><span>MODULAR CONTROLS</span><p>Everything configured here becomes a native Shopify theme setting.</p></div><button className="button button--quiet button--icon" title="Reset to template defaults" onClick={resetTemplate}><RotateCcw size={14} /></button></div>
            <div className="template-picker">
              <Field label="Section template" hint={template?.description}>
                <select value={template?.id ?? ''} onChange={(event) => void selectTemplate(event.target.value)} disabled={templates.length === 0}>
                  {templates.length === 0 && <option value="">No templates registered</option>}
                  {templates.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select>
              </Field>
            </div>
            {contractOnly ? (
              <div className="contract-only-note">
                <Braces size={16} />
                <p><b>Contract-authored section.</b><br />No registered template matches this manifest, so visual controls are unavailable — and the builder will never overwrite it. Edit it in the Design contract view.</p>
                <button className="button button--quiet" onClick={() => void requestView('contract')}>Open design contract</button>
              </div>
            ) : template ? (<>
              {groupedControls.map((entry, index) => (
                <Group key={entry.group} title={entry.group} number={String(index + 1).padStart(2, '0')} open={index === 0}>
                  {entry.controls.map((control) => (
                    <ControlInput key={control.id} control={control} value={builderState[control.id]} onChange={(value) => updateControl(control.id, value)} />
                  ))}
                </Group>
              ))}
              {(template.blockTypes?.length ?? 0) > 0 && (
                <Group title="Blocks" number={String(groupedControls.length + 1).padStart(2, '0')}>
                  <BlockEditor template={template} blocks={blocksOf(builderState)} maxBlocks={manifest.maxBlocks} onChange={updateBlocks} />
                </Group>
              )}
            </>) : (
              <div className="contract-only-note"><CircleAlert size={16} /><p><b>No templates registered.</b><br />The template registry is empty — the builder falls back to the cinematic hero manifest.</p></div>
            )}
          </aside>

          <section className="preview-area">
            <div className="preview-toolbar"><div><span className="status-dot" />LIVE PREVIEW</div><div className="device-switch"><button className={device === 'desktop' ? 'is-active' : ''} onClick={() => setDevice('desktop')}><Monitor size={15} /></button><button className={device === 'mobile' ? 'is-active' : ''} onClick={() => setDevice('mobile')}><Smartphone size={15} /></button></div><button onClick={() => setReplayKey((key) => key + 1)}><RefreshCw size={14} />Replay motion</button></div>
            <div className="preview-stage">
              {heroPreviewState
                ? <LivePreview state={heroPreviewState} device={device} replayKey={replayKey} />
                : <GenericPreview manifest={manifest} device={device} onCompile={() => void compile(true)} />}
            </div>
            <div className="preview-summary"><div><SlidersHorizontal size={15} /><span><b>{builderControlCount}</b> section controls</span></div><div><Layers3 size={15} /><span><b>{(manifest.blocks ?? []).length}</b> repeatable block type{(manifest.blocks ?? []).length === 1 ? '' : 's'}</span></div><div><Sparkles size={15} /><span>Reduced-motion safe</span></div></div>
          </section>
        </div>}

        {view === 'contract' && <section className="page-pad contract-page">
          <div className="page-heading"><div><span>PLATFORM-NEUTRAL SOURCE OF TRUTH</span><h2>Section design contract</h2><p>Claude, Kimi, Bolt, Emergent, or another coding agent can generate this JSON contract. ThemeBot turns it into Shopify Liquid and schema.</p></div><div><button className="button button--quiet" onClick={() => { setCustomManifest(null); setContractText(JSON.stringify(generatedManifest, null, 2)); setContractIssues([]); setContractError(''); }}>Reset to builder</button><button className="button button--accent" onClick={applyContract} disabled={contractChecking}>{contractChecking ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}Validate &amp; apply</button></div></div>
          <div className="contract-toolbar">
            <button className="button button--quiet" onClick={formatContract}><Braces size={14} />Format</button>
            <button className="button button--quiet" onClick={copyContract}><Copy size={14} />Copy</button>
            <button className="button button--quiet" onClick={downloadContract}><Download size={14} />Download</button>
            <label className="button button--quiet"><Upload size={14} />Import<input type="file" accept="application/json,.json" hidden onChange={(event) => { importContract(event.target.files?.[0]); event.target.value = ''; }} /></label>
            <span className="contract-toolbar__hint">Agents: POST to <code>{window.location.origin}/mcp</code> (<code>validate_shopify_section</code>, <code>compile_shopify_section</code>) or <code>/v1/compile</code>.</span>
          </div>
          {contractError && <div className="error-line"><CircleAlert size={15} />{contractError}</div>}
          {contractIssues.length > 0 && <div className="issues">{contractIssues.map((issue, index) => {
            const location = contractIssueLocations.get(index);
            return <div key={index} className={`issue issue--${issue.severity}${location ? ' issue--clickable' : ''}`} onClick={location ? () => jumpToContractLine(location.line) : undefined}><CircleAlert size={14} /><span><b>{issue.path}</b>{issue.message}</span>{location && <button type="button" className="issue__line" title={`Jump to line ${location.line}, column ${location.column}`} onClick={() => jumpToContractLine(location.line)}>Ln {location.line}</button>}</div>;
          })}</div>}
          <div className="contract-editor"><div className="editor-gutter">{contractText.split('\n').map((_, index) => <span key={index}>{index + 1}</span>)}</div><textarea ref={contractAreaRef} spellCheck={false} value={contractText} onChange={(event) => setContractText(event.target.value)} /></div>
        </section>}

        {view === 'code' && <section className="page-pad code-page">
          <div className="page-heading"><div><span>NATIVE SHOPIFY OUTPUT</span><h2>Generated section package</h2><p>Liquid, schema, scoped CSS, motion JavaScript, source contract, and manual installation instructions.</p></div><button className="button button--accent" onClick={exportZip}><Download size={15} />Export ZIP</button></div>
          {!compileResult ? <div className="empty-state"><div><Code2 size={25} /></div><h3>No build yet</h3><p>Compile the current design to generate its Shopify-ready files.</p><button className="button button--accent" onClick={() => compile(false)}>Compile section</button></div> : <>
            <div className="build-stats"><div><b>{compileResult.valid ? 'VALID' : 'FAILED'}</b><span>Build status</span></div><div><b>{compileResult.stats.settings}</b><span>Section settings</span></div><div><b>{compileResult.stats.blockTypes}</b><span>Block types</span></div><div><b>{Math.round((compileResult.stats.liquidBytes + compileResult.stats.cssBytes + compileResult.stats.javascriptBytes) / 1024)} KB</b><span>Compiled size</span></div></div>
            {compileResult.issues.length > 0 && <div className="issues">{compileResult.issues.map((issue, index) => <div key={index} className={`issue issue--${issue.severity}`}><CircleAlert size={14} /><span><b>{issue.path}</b>{issue.message}</span></div>)}</div>}
            {compileResult.files.length > 0 && <FileViewer files={compileResult.files} activePath={activeFile} onSelect={setActiveFile} />}
          </>}
        </section>}

        {view === 'deploy' && <section className="page-pad deploy-page">
          <div className="page-heading"><div><span>SAFE THEME INSTALLATION</span><h2>Install to an unpublished theme</h2><p>ThemeBot refuses to modify the published theme. Connect a Shopify store, select a duplicated theme, and install the generated files.</p></div></div>
          <div className="deploy-grid">
            <div className="connection-card"><div className="connection-card__icon"><Store size={23} /></div><span>SHOPIFY CONNECTION</span><h3>{session?.authenticated ? session.shop : 'Store not connected'}</h3><p>{session?.authenticated ? `Secure OAuth session · Admin API ${session.shopify.apiVersion}.` : 'Connect a Shopify store from Projects before installing section files.'}</p><div className={`connection-state ${session?.authenticated ? 'is-connected' : ''}`}><i />{session?.authenticated ? 'Connected securely' : 'Connection required'}</div><button className="button button--quiet button--full" onClick={loadThemes} disabled={!session?.authenticated || working}>{working ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}Load unpublished themes</button></div>
            <div className="install-card"><span>INSTALL TARGET</span><h3>{installManifest.name}</h3><Field label="Section to install" hint={deployProjectId ? 'Installing a saved project version.' : 'Installing the section currently open in the builder.'}><select value={deployProjectId} onChange={(event) => setDeployProjectId(event.target.value)}><option value="">Current builder section</option>{sectionProjects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field><div className="install-files">{installFiles ? installFiles.map((file) => <div key={file.path}><FileCode2 size={15} /><span>{file.path}</span><Check size={14} /></div>) : <div className="install-files__hint"><FileCode2 size={15} /><span>{deployProjectId ? 'This saved version is compiled on the server at install time.' : 'Compile the section to preview the exact files that will install.'}</span></div>}</div><Field label="Unpublished theme"><select value={themeId} onChange={(event) => setThemeId(event.target.value)} disabled={!themes.length}><option value="">{themes.length ? 'Select a theme' : 'Load connected themes first'}</option>{themes.map((theme) => <option value={theme.id} key={theme.id}>{theme.name} · {theme.role.toLowerCase()}</option>)}</select></Field><div className="safety-note"><PanelLeftClose size={16} /><p><b>Published-theme lock is active.</b><br />Installation is only allowed on an unpublished theme.</p></div>
              {diffError && <div className="error-line"><CircleAlert size={15} />{diffError}</div>}
              {diffFiles && <div className="deploy-diff">
                <div className="deploy-diff__summary">
                  {(['new', 'changed', 'same'] as const).map((status) => {
                    const count = diffFiles.filter((file) => file.status === status).length;
                    return <span key={status} className={`diff-badge diff-badge--${status}`}>{count} {status === 'same' ? 'unchanged' : status}</span>;
                  })}
                </div>
                {diffFiles.length === 0
                  ? <div className="deploy-diff__empty">The server reported no files for this install.</div>
                  : diffFiles.map((file) => <div key={file.path} className="deploy-diff__row"><FileCode2 size={14} /><span title={file.path}>{file.path}</span><em className={`diff-badge diff-badge--${file.status}`}>{file.status === 'same' ? 'unchanged' : file.status}</em><small>{formatBytes(file.bytes)}</small></div>)}
              </div>}
              <button className="button button--quiet button--full" onClick={previewChanges} disabled={!themeId || working || diffLoading} title="Dry run — see which theme files would be added or changed, without installing">{diffLoading ? <LoaderCircle className="spin" size={15} /> : <FileDiff size={15} />}Preview changes</button>
              <button className="button button--accent button--full" onClick={install} disabled={!themeId || working}>{working ? <LoaderCircle className="spin" size={15} /> : <PackageCheck size={15} />}Install section package</button></div>
          </div>
          {session?.authenticated&&<div className="deployment-history"><div className="history-heading"><div><History size={17}/><div><span>DEPLOYMENT LEDGER</span><h3>Installation history</h3></div></div><button onClick={()=>fetch('/api/deployments').then((item)=>item.json()).then((data)=>setDeployments(data.deployments??[]))}><RefreshCw size={14}/>Refresh</button></div>{deployments.length===0?<div className="history-empty">No deployments have been made from this store yet.</div>:<div className="history-table">{deployments.map((deployment)=><div key={deployment.id}><span className={`deployment-status deployment-status--${deployment.status}`}>{deployment.status.replace('_',' ')}</span><div><b>{deployment.theme_name}</b><small>{deployment.installed_files.length} files · {new Date(deployment.created_at).toLocaleString()}</small></div><code>{deployment.theme_id.split('/').pop()}</code><button onClick={()=>rollback(deployment.id)} disabled={deployment.status!=='succeeded'||working}><RotateCcw size={13}/>Rollback</button></div>)}</div>}</div>}
        </section>}

        {view === 'settings' && <section className="page-pad settings-page">
          <div className="page-heading"><div><span>CONNECTIONS & PRODUCT ACCESS</span><h2>Platform connections</h2><p>Securely connect Shopify and give external coding agents access through scoped ThemeBot API keys.</p></div></div>
          <div className="settings-grid">
            <div className="settings-card"><div className="settings-card__heading"><Store size={19}/><div><span>SHOPIFY STORE</span><h3>{session?.shop??'Not connected'}</h3></div></div><p>{session?.authenticated?'The store is connected with an encrypted, rotating offline token.':'Connect from the Projects page to enable persistence and deployment.'}</p><div className="settings-facts"><div><span>API version</span><b>{session?.shopify.apiVersion??'2026-07'}</b></div><div><span>Database</span><b>{session?.persistent?'PostgreSQL':'Development memory'}</b></div><div><span>Billing</span><b>{session?.billing?.enabled?(session.billing.active?'Active':'Approval required'):'Disabled'}</b></div></div>{session?.authenticated&&<button className="button button--quiet button--full" onClick={()=>fetch('/auth/logout',{method:'POST'}).then(()=>window.location.reload())}><LogOut size={14}/>Disconnect this browser</button>}</div>
            <div className="settings-card settings-card--wide"><div className="settings-card__heading"><KeyRound size={19}/><div><span>AI PLATFORM ACCESS</span><h3>API and MCP keys</h3></div></div><p>Use one key for Claude, Kimi, Bolt, Emergent, or each outside development team. The full secret is shown only once.</p><div className="key-create"><input value={keyLabel} onChange={(event)=>setKeyLabel(event.target.value)} placeholder="Key label (e.g. Claude — production)" disabled={!session?.authenticated} onKeyDown={(event)=>{if(event.key==='Enter'&&session?.authenticated&&!working)void createApiKey();}} /><button className="button button--accent" onClick={createApiKey} disabled={!session?.authenticated||working}><Plus size={14}/>Create key</button></div>{newApiToken&&<div className="token-reveal"><div><ShieldCheck size={17}/><span><b>Copy this key now</b><small>It cannot be displayed again.</small></span></div><code>{newApiToken}</code><CopyButton text={newApiToken}/><button className="token-reveal__done" onClick={()=>setNewApiToken('')}><Check size={14}/>Done</button></div>}<div className="endpoint-row"><div><span>MCP endpoint</span><code>{window.location.origin}/mcp</code><CopyButton text={`${window.location.origin}/mcp`} label="" /></div><div><span>REST endpoint</span><code>{window.location.origin}/v1</code><CopyButton text={`${window.location.origin}/v1`} label="" /></div></div><details className="mcp-tools"><summary>MCP tools available to a connected agent</summary><ul><li><code>validate_shopify_section</code> — validate a contract without saving</li><li><code>compile_shopify_section</code> — compile to Liquid, CSS, JS, schema</li><li><code>list_section_projects</code> — list saved projects</li><li><code>save_section_project</code> — save a new project</li><li><code>deploy_section_to_unpublished_theme</code> — deploy (explicit confirmation required)</li></ul></details><div className="key-list">{apiKeys.length===0?<p>No external platform keys created yet.</p>:apiKeys.map((key)=><div key={key.id} className={key.revoked_at?'is-revoked':''}><KeyRound size={14}/><span><b>{key.label}</b><small>vso_live_{key.key_prefix}•••• · created {new Date(key.created_at).toLocaleDateString()} · {key.last_used_at?`used ${new Date(key.last_used_at).toLocaleDateString()}`:'never used'}</small></span><em>{key.revoked_at?'Revoked':'Active'}</em>{!key.revoked_at&&<button title="Rotate key" onClick={()=>void rotateApiKey(key.id)} disabled={working}><RefreshCw size={13}/></button>}{!key.revoked_at&&<button title="Revoke key" onClick={()=>revokeApiKey(key.id)}><Trash2 size={13}/></button>}</div>)}</div></div>
          </div>
        </section>}

        {view === 'factory' && <FactoryApp onNavigate={(target) => void requestView(target)} />}

        {view === 'terminal' && <TerminalPane onActivity={() => window.dispatchEvent(new Event('app:refresh'))} />}

        {view === 'browser' && <BrowserPane onActivity={() => window.dispatchEvent(new Event('app:refresh'))} />}
      </main>
      {confirmState && <ConfirmModal state={confirmState} onResolve={resolveConfirm} />}
      {historyProject && <VersionHistoryModal project={historyProject} versions={versions} loading={versionsLoading} error={versionsError} onRestore={(versionId) => void restoreVersion(versionId)} onClose={() => setHistoryProject(null)} />}
    </div>
  );
}
