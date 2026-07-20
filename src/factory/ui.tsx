// Self-contained shadcn-style primitives (monochrome, dual-theme, no Radix dependency).
// Everything renders inside .factory-root, which carries the token set + scoped reset.
// Every interactive control is keyboard-accessible and readable in BOTH themes —
// text color is always explicitly paired with its background.
import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  type ComponentProps, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
} from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CheckCircle2, ChevronDown, Info, TriangleAlert, X, XCircle } from 'lucide-react';
import { cn } from '../lib/utils';

// ---------- Presence (mount/unmount transitions) ----------

/** Keeps an overlay mounted through its exit transition and drives data-state. */
export function usePresence(open: boolean, duration = 320) {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<'open' | 'closed'>('closed');
  useEffect(() => {
    if (open) {
      setMounted(true);
      // requestAnimationFrame is paused in background/throttled tabs — pair it with a
      // timeout so overlays always reach their "open" state (backdrop/panel visible,
      // cancel paths live) instead of getting stuck in the "closed" CSS state.
      const raf = requestAnimationFrame(() => setState('open'));
      const fallback = setTimeout(() => setState('open'), 50);
      return () => { cancelAnimationFrame(raf); clearTimeout(fallback); };
    }
    setState('closed');
    const timer = setTimeout(() => setMounted(false), duration);
    return () => clearTimeout(timer);
  }, [open, duration]);
  return { mounted, state };
}

// ---------- Button ----------

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold transition-all duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/85',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground',
        outline: 'border border-border bg-card text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground',
        ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        link: 'text-foreground underline underline-offset-4 hover:opacity-70',
      },
      size: {
        default: 'h-10 px-5 text-[15px] [&_svg]:size-4.5',
        sm: 'h-9 rounded-md px-3.5 text-sm [&_svg]:size-4',
        lg: 'h-11 rounded-lg px-6 text-base [&_svg]:size-5',
        icon: 'h-10 w-10 [&_svg]:size-4.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({ className, variant, size, ...props }: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button type="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

// ---------- Card ----------

export const Card = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cn('rounded-xl border border-border bg-card text-card-foreground shadow-sm', className)}>{children}</div>
);
export const CardHeader = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cn('flex flex-col gap-1.5 p-6 pb-4', className)}>{children}</div>
);
export const CardTitle = ({ className, children }: { className?: string; children: ReactNode }) => (
  <h3 className={cn('text-[17px] font-bold leading-tight tracking-tight', className)}>{children}</h3>
);
export const CardDescription = ({ className, children }: { className?: string; children: ReactNode }) => (
  <p className={cn('text-[13.5px] font-medium leading-relaxed text-muted-foreground', className)}>{children}</p>
);
export const CardContent = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cn('p-6 pt-0', className)}>{children}</div>
);
export const CardFooter = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cn('flex items-center gap-2 p-6 pt-0', className)}>{children}</div>
);

// ---------- Inputs ----------

export function Input({ className, id, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const fieldId = useContext(FieldIdContext);
  return (
    <input
      id={id ?? fieldId}
      className={cn(
        'flex h-10 w-full rounded-lg border border-input bg-card px-3.5 py-1 text-[15px] font-medium text-foreground shadow-sm transition-all placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export const Label = ({ className, children, htmlFor }: { className?: string; children: ReactNode; htmlFor?: string }) => (
  <label htmlFor={htmlFor} className={cn('text-[13px] font-bold leading-none tracking-tight text-foreground', className)}>{children}</label>
);

/** Lets controls rendered inside a Field pick up the label's htmlFor id automatically. */
const FieldIdContext = createContext<string | undefined>(undefined);

/** Labeled field with optional help text + validation state. */
export function Field({ label, icon, help, error, ok, children }: { label: string; icon?: ReactNode; help?: string; error?: string | null; ok?: string | null; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className={icon ? 'flex items-center gap-2 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground' : undefined}>{icon}{label}</Label>
      <FieldIdContext.Provider value={id}>{children}</FieldIdContext.Provider>
      {error ? <p className="text-[13px] font-semibold text-destructive">{error}</p>
        : ok ? <p className="text-[13px] font-semibold text-success">{ok}</p>
        : help ? <p className="text-[13px] font-medium leading-relaxed text-muted-foreground">{help}</p> : null}
    </div>
  );
}

export function Select({ className, children, id, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const fieldId = useContext(FieldIdContext);
  return (
    <div className="relative w-full">
      <select
        id={id ?? fieldId}
        className={cn(
          'flex h-10 w-full appearance-none rounded-lg border border-input bg-card pl-3.5 pr-10 py-1 text-[15px] font-medium text-foreground shadow-sm transition-all focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

export function Switch({ checked, onCheckedChange, disabled, id, 'aria-label': ariaLabel }: { checked: boolean; onCheckedChange: (value: boolean) => void; disabled?: boolean; id?: string; 'aria-label'?: string }) {
  return (
    <button
      id={id} type="button" role="switch" aria-checked={checked} aria-label={ariaLabel} disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
      )}
    >
      <span className={cn('pointer-events-none block size-5 rounded-full bg-card shadow-md transition-transform duration-200', checked ? 'translate-x-5' : 'translate-x-0')} />
    </button>
  );
}

export function Slider({ value, onValueChange, min, max, step = 1, disabled, format, id, 'aria-label': ariaLabel }: {
  value: number; onValueChange: (value: number) => void; min: number; max: number; step?: number; disabled?: boolean; format?: (value: number) => string;
  id?: string; 'aria-label'?: string;
}) {
  const fieldId = useContext(FieldIdContext);
  const percent = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex items-center gap-4">
      <input
        id={id ?? fieldId} aria-label={ariaLabel}
        type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(event) => onValueChange(Number(event.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: `linear-gradient(to right, var(--primary) ${percent}%, var(--secondary) ${percent}%)` }}
      />
      <span className="w-16 shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-center text-[13px] font-bold tabular-nums text-foreground">
        {format ? format(value) : value}
      </span>
    </div>
  );
}

// ---------- Badge ----------

const badgeVariants = cva('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold leading-5', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      outline: 'border-border text-foreground',
      success: 'border-success/25 bg-success/10 text-success',
      warning: 'border-warning/25 bg-warning/10 text-warning',
      destructive: 'border-destructive/25 bg-destructive/10 text-destructive',
      /* "info" (in-progress) renders MONOCHROME — no blue on this surface */
      info: 'border-foreground/20 bg-foreground/[0.06] text-foreground',
    },
  },
  defaultVariants: { variant: 'default' },
});
export function Badge({ className, variant, children }: { className?: string; children: ReactNode } & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)}>{children}</span>;
}

/** Small live dot with a radar ping — pair with text-success / text-foreground. */
export const LiveDot = ({ className }: { className?: string }) => (
  <span className={cn('pulse-dot relative inline-flex size-2 shrink-0 rounded-full bg-current', className)} aria-hidden />
);

// ---------- Progress / Skeleton / Separator / Spinner ----------

export function Progress({ value, className, active }: { value: number; className?: string; active?: boolean }) {
  return (
    <div className={cn('h-2.5 w-full overflow-hidden rounded-full bg-secondary', className)} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div
        className={cn('h-full rounded-full bg-primary transition-all duration-700 ease-out', active && 'progress-shine')}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </div>
  );
}
export const Skeleton = ({ className }: { className?: string }) => <div className={cn('skeleton rounded-lg', className)} />;
export const Separator = ({ className }: { className?: string }) => <div className={cn('h-px w-full bg-border', className)} />;
export const Spinner = ({ className }: { className?: string }) => (
  <svg className={cn('size-4 animate-spin text-muted-foreground', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

// ---------- Tabs (controlled, with sliding indicator) ----------

export function Tabs({ tabs, value, onChange, className }: {
  tabs: Array<{ id: string; label: ReactNode }>; value: string; onChange: (id: string) => void; className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('[data-active="true"]');
    if (active) setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
  }, []);

  useLayoutEffect(() => { measure(); }, [measure, value, tabs.length]);
  useEffect(() => {
    if (!listRef.current) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(listRef.current);
    return () => observer.disconnect();
  }, [measure]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === value);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    onChange(next.id);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.focus());
  };

  return (
    <div ref={listRef} role="tablist" onKeyDown={onKeyDown} className={cn('relative inline-flex h-10 items-center gap-1 rounded-lg bg-muted p-1', className)}>
      {indicator && (
        <span aria-hidden className="absolute inset-y-1 rounded-md bg-card shadow-sm transition-all duration-300 ease-out"
          style={{ left: indicator.left, width: indicator.width }} />
      )}
      {tabs.map((tab) => (
        <button
          key={tab.id} type="button" role="tab" aria-selected={value === tab.id} data-active={value === tab.id}
          tabIndex={value === tab.id ? 0 : -1} onClick={() => onChange(tab.id)}
          className={cn(
            'relative z-10 inline-flex items-center gap-2 whitespace-nowrap rounded-md px-3.5 py-1.5 text-sm font-semibold transition-colors duration-200',
            value === tab.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Dialog (confirm) ----------

export function ConfirmDialog({ open, title, description, confirmLabel = 'Confirm', destructive, onConfirm, onCancel, children }: {
  open: boolean; title: string; description?: string; confirmLabel?: string; destructive?: boolean;
  onConfirm: () => void; onCancel: () => void; children?: ReactNode;
}) {
  const { mounted, state } = usePresence(open, 240);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Freeze content while the exit transition plays (callers often clear their
  // state on confirm/cancel, which would otherwise flash empty text).
  const frozen = useRef({ title, description, confirmLabel, destructive, children });
  if (open) frozen.current = { title, description, confirmLabel, destructive, children };
  const content = open ? { title, description, confirmLabel, destructive, children } : frozen.current;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  useEffect(() => { if (open && mounted) requestAnimationFrame(() => cancelRef.current?.focus()); }, [open, mounted]);
  if (!mounted) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="dialog-overlay absolute inset-0 bg-black/50 backdrop-blur-[2px]" data-state={state} onClick={onCancel} aria-hidden="true" />
      <div role="alertdialog" aria-modal="true" aria-label={content.title} data-state={state}
        className="dialog-panel relative z-10 w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
        <h2 className="text-[17px] font-bold tracking-tight">{content.title}</h2>
        {content.description && <p className="mt-2 text-[14px] font-medium leading-relaxed text-muted-foreground">{content.description}</p>}
        {content.children && <div className="mt-4">{content.children}</div>}
        <div className="mt-6 flex justify-end gap-2.5">
          <Button ref={cancelRef} variant="outline" onClick={onCancel}>Cancel</Button>
          <Button variant={content.destructive ? 'destructive' : 'default'} onClick={onConfirm}>{content.confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}

// ---------- Sheet (right-side panel) ----------

export function Sheet({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const { mounted, state } = usePresence(open, 340);
  const panelRef = useRef<HTMLDivElement>(null);
  // Freeze content while the exit transition plays so the panel doesn't flash
  // back to its loading state as the caller clears its selection.
  const frozen = useRef({ title, children });
  if (open) frozen.current = { title, children };
  const content = open ? { title, children } : frozen.current;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  useEffect(() => { if (open && mounted) requestAnimationFrame(() => panelRef.current?.focus()); }, [open, mounted]);
  if (!mounted) return null;
  return (
    <div className="fixed inset-0 z-40">
      <div className="sheet-overlay absolute inset-0 bg-black/45 backdrop-blur-[2px]" data-state={state} onClick={onClose} />
      <div
        ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" data-state={state}
        className={cn('sheet-panel absolute inset-y-0 right-0 flex w-full flex-col border-l border-border bg-background shadow-2xl outline-none', wide ? 'max-w-3xl' : 'max-w-xl')}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
          <div className="min-w-0 flex-1 text-[15px] font-bold">{content.title}</div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close panel"><X /></Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">{content.children}</div>
      </div>
    </div>
  );
}

// ---------- Dropdown menu (kebab actions) ----------

export function DropdownMenu({ trigger, items, label = 'Actions' }: {
  trigger: ReactNode; label?: string;
  items: Array<{ label: string; onSelect: () => void; destructive?: boolean; disabled?: boolean; title?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onClick); window.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open} aria-label={label}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        {trigger}
      </button>
      {open && (
        <div className="pop-in absolute right-0 top-10 z-30 min-w-48 rounded-lg border border-border bg-card p-1.5 shadow-xl" role="menu">
          {items.map((item) => (
            <button
              key={item.label} type="button" role="menuitem" disabled={item.disabled} title={item.title}
              onClick={() => { setOpen(false); item.onSelect(); }}
              className={cn(
                'block w-full rounded-md px-3 py-2 text-left text-[14px] font-semibold text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40',
                item.destructive && 'text-destructive hover:bg-destructive/10',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Toasts ----------

interface Toast { id: number; title: string; detail?: string; variant: 'default' | 'success' | 'destructive' | 'warning'; }
const ToastContext = createContext<{ push: (toast: Omit<Toast, 'id'>) => void }>({ push: () => {} });
export const useToast = () => useContext(ToastContext);

const toastIcon: Record<Toast['variant'], ReactNode> = {
  default: <Info className="size-4.5 text-foreground" />,
  success: <CheckCircle2 className="size-4.5 text-success" />,
  destructive: <XCircle className="size-4.5 text-destructive" />,
  warning: <TriangleAlert className="size-4.5 text-warning" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = (toast: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-4), { ...toast, id }]);
    setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 5000);
  };
  const dismiss = (id: number) => setToasts((current) => current.filter((entry) => entry.id !== id));
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[22rem] flex-col gap-2.5">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast-in pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-xl">
            <span className="mt-0.5 shrink-0">{toastIcon[toast.variant]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-bold leading-snug text-foreground">{toast.title}</p>
              {toast.detail && <p className="mt-1 text-[13px] font-medium leading-relaxed text-muted-foreground">{toast.detail}</p>}
            </div>
            <button type="button" onClick={() => dismiss(toast.id)} aria-label="Dismiss notification"
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------- Empty state ----------

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="dot-grid relative flex flex-col items-center justify-center gap-2.5 overflow-hidden rounded-xl border border-dashed border-border py-20 text-center">
      <div className="absolute inset-0" style={{ background: 'radial-gradient(closest-side, transparent, var(--background))' }} aria-hidden />
      <div className="rise-in relative flex size-16 items-center justify-center rounded-2xl border border-border bg-card text-foreground shadow-sm [&_svg]:size-8 [&_svg]:stroke-[1.5]">{icon}</div>
      <h3 className="relative mt-3 text-[17px] font-bold tracking-tight">{title}</h3>
      <p className="relative max-w-md text-[14px] font-medium leading-relaxed text-muted-foreground">{description}</p>
      {action && <div className="relative mt-4">{action}</div>}
    </div>
  );
}
