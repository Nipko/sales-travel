'use client';

import { Loader2, MapPin } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../../../lib/cn';
import { suggestDestinationsAction, type GeoSuggestion } from '../actions';

/**
 * Autocomplete de destino contra /hotels/suggestions (Despegar). Hoy es contextual:
 * `availability` exige IDs de hotel, así que la selección guarda el `gid` para cuando
 * exista el catálogo ciudad→IDs. Escribe inputs ocultos destinationGid/destinationLabel.
 */
export function DestinationCombobox() {
  const id = useId();
  const listId = `${id}-list`;
  const containerRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const [query, setQuery] = useState('');
  const [label, setLabel] = useState('');
  const [gid, setGid] = useState('');
  const [items, setItems] = useState<GeoSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || q === label) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const my = ++seq.current;
    const t = setTimeout(() => {
      suggestDestinationsAction(q)
        .then((res) => {
          if (my !== seq.current) return;
          setItems(res);
          setActive(-1);
          setLoading(false);
        })
        .catch(() => {
          if (my === seq.current) setLoading(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [query, label]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function select(s: GeoSuggestion) {
    setLabel(s.display);
    setQuery(s.display);
    setGid(s.gid);
    setItems([]);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === 'Enter' && open && active >= 0) {
      const sel = items[active];
      if (sel) {
        e.preventDefault();
        select(sel);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-[var(--color-fg)]">
        Destino
      </label>
      <input type="hidden" name="destinationGid" value={gid} />
      <input type="hidden" name="destinationLabel" value={label} />

      <div className="relative">
        <MapPin className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
        <input
          id={id}
          role="combobox"
          type="text"
          value={query}
          autoComplete="off"
          placeholder="Ciudad o destino"
          aria-expanded={open && items.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={(e) => {
            setQuery(e.target.value);
            setGid('');
            setLabel('');
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={cn(
            'flex h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] pl-9 pr-9 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)]',
            'placeholder:text-[var(--color-fg-subtle)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30 focus-visible:border-[var(--color-primary)]',
            'transition-all duration-150',
          )}
        />
        {loading ? (
          <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-[var(--color-fg-subtle)]" />
        ) : null}
      </div>

      {open && items.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
        >
          {items.map((s, i) => (
            <li
              key={s.gid}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                select(s);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'flex items-center gap-3 px-3 py-2 text-sm cursor-pointer transition-colors duration-75',
                i === active
                  ? 'bg-[var(--color-primary)]/8 text-[var(--color-fg)]'
                  : 'text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]',
              )}
            >
              <MapPin className="size-4 shrink-0 text-[var(--color-fg-subtle)]" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{s.display}</p>
                {s.city || s.country ? (
                  <p className="truncate text-[11px] text-[var(--color-fg-muted)]">
                    {[s.city, s.country].filter(Boolean).join(', ')}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {open &&
      !loading &&
      query.trim().length >= 2 &&
      query.trim() !== label &&
      items.length === 0 ? (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 text-center shadow-lg">
          <p className="text-xs text-[var(--color-fg-muted)]">
            Sin resultados para «{query.trim()}»
          </p>
        </div>
      ) : null}
    </div>
  );
}
