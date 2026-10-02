// Glass sort menu: a button that opens a small popover of options (checkmark on the current one).
// Keyboard: arrows move, Enter/Space choose, Escape closes. Closes on outside click.
import { useEffect, useRef, useState } from 'react';
import { ArrowUpDown, Check, ChevronDown } from 'lucide-react';

export interface SortOption { id: string; label: string; detail?: string }

export function SortMenu({ options, value, onChange, hint }: { options: SortOption[]; value: string; onChange: (id: string) => void; hint?: string }) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.id === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    setFocus(Math.max(0, options.findIndex((option) => option.id === value)));
    const onDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, options, value]);

  const choose = (id: string) => { onChange(id); setOpen(false); };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setOpen(true); return; }
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setFocus((index) => (index + 1) % options.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setFocus((index) => (index - 1 + options.length) % options.length); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(options[focus].id); }
  };

  return (
    <div ref={root} className={`sortm${open ? ' is-open' : ''}`} onKeyDown={onKeyDown}>
      <button type="button" className="sortm__btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((value) => !value)} title={hint}>
        <ArrowUpDown size={15} />
        <span className="sortm__label">{current.label}</span>
        <ChevronDown size={15} className="sortm__caret" />
      </button>
      <div className="sortm__pop" role="listbox" aria-label="Sort projects" aria-hidden={!open}>
        <p className="sortm__head">Sort by</p>
        {options.map((option, index) => (
          <button key={option.id} type="button" role="option" aria-selected={option.id === value} tabIndex={open ? 0 : -1}
            className={`sortm__opt${option.id === value ? ' is-on' : ''}${index === focus ? ' is-focus' : ''}`}
            onMouseEnter={() => setFocus(index)} onClick={() => choose(option.id)}>
            <span><b>{option.label}</b>{option.detail && <em>{option.detail}</em>}</span>
            {option.id === value && <Check size={16} />}
          </button>
        ))}
        {hint && <p className="sortm__hint">{hint}</p>}
      </div>
    </div>
  );
}
