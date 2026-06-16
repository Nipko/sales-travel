'use client';

import { Loader2, MapPin, Plane } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../../../lib/cn';
import { suggestCarLocationsAction, type CarLocation } from '../actions';

const DEBOUNCE_MS = 160;

/** Caché de sugerencias por query (nivel módulo: persiste mientras viva la sesión del SPA). */
const suggestCache = new Map<string, CarLocation[]>();

const inputClass = cn(
  'flex h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] pl-9 pr-14 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)]',
  'placeholder:text-[var(--color-fg-subtle)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30 focus-visible:border-[var(--color-primary)]',
  'transition-all duration-150',
);

interface Props {
  label: string;
  value: CarLocation | null;
  onSelect: (loc: CarLocation | null) => void;
  placeholder?: string;
}

export function CarLocationCombobox({
  label,
  value,
  onSelect,
  placeholder = 'Ciudad, aeropuerto o IATA',
}: Props) {
  const id = useId();
  const listboxId = `${id}-listbox`;
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef('');

  const [query, setQuery] = useState(value?.value ?? '');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<CarLocation[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function runSearch(q: string) {
    if (timerRef.current) clearTimeout(timerRef.current);
    const norm = q.trim().toLowerCase();
    latestRef.current = norm;
    if (norm.length < 2) {
      setItems([]);
      setLoading(false);
      return;
    }
    // Caché: resultados instantáneos para una query ya consultada (sin spinner ni round-trip).
    const cached = suggestCache.get(norm);
    if (cached) {
      setItems(cached);
      setActiveIndex(-1);
      setLoading(false);
      return;
    }
    setLoading(true);
    timerRef.current = setTimeout(() => {
      void suggestCarLocationsAction(q).then((results) => {
        suggestCache.set(norm, results);
        // Aplica sólo si la query sigue vigente (una respuesta vieja no pisa una más nueva).
        if (latestRef.current !== norm) return;
        setItems(results);
        setActiveIndex(-1);
        setLoading(false);
      });
    }, DEBOUNCE_MS);
  }

  function handleChange(text: string) {
    setQuery(text);
    setOpen(true);
    onSelect(null); // invalida la selección previa hasta elegir de la lista
    runSearch(text);
  }

  function pick(loc: CarLocation) {
    onSelect(loc);
    setQuery(loc.value);
    setOpen(false);
    setItems([]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === 'Enter' && open && activeIndex >= 0) {
      const sel = items[activeIndex];
      if (sel) {
        e.preventDefault();
        pick(sel);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-[var(--color-fg)]">
        {label}
      </label>

      <div className="relative">
        <MapPin className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
        <input
          id={id}
          role="combobox"
          type="text"
          value={query}
          autoComplete="off"
          placeholder={placeholder}
          aria-expanded={open && items.length > 0}
          aria-controls={listboxId}
          aria-autocomplete="list"
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className={inputClass}
        />
        {loading ? (
          <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-[var(--color-fg-subtle)]" />
        ) : value?.iata ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-[var(--color-primary)]/10 px-2 py-0.5 font-mono text-[11px] font-semibold tracking-wider text-[var(--color-primary)]">
            {value.iata}
          </span>
        ) : value ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg-muted)]">
            Ciudad
          </span>
        ) : null}
      </div>

      {open && items.length > 0 ? (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-80 w-full overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
        >
          {items.map((loc, idx) => {
            const isActive = idx === activeIndex;
            const key = `${loc.iata ?? loc.value}-${loc.latitude}-${loc.longitude}`;
            return (
              <li
                key={key}
                role="option"
                aria-selected={isActive}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(loc);
                }}
                onMouseEnter={() => setActiveIndex(idx)}
                className={cn(
                  'flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors duration-75',
                  isActive
                    ? 'bg-[var(--color-primary)]/8 text-[var(--color-fg)]'
                    : 'text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]',
                )}
              >
                {loc.iata ? (
                  <Plane className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
                ) : (
                  <MapPin className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{loc.value}</p>
                  <p className="truncate text-[11px] text-[var(--color-fg-muted)]">
                    {loc.countryCode}
                    {loc.hasOffice > 0 ? ` · ${loc.hasOffice} oficina(s)` : ''}
                  </p>
                </div>
                {loc.iata ? (
                  <span className="shrink-0 rounded-md bg-[var(--color-surface-muted)] px-2 py-0.5 font-mono text-[11px] font-bold tracking-wider text-[var(--color-fg-muted)]">
                    {loc.iata}
                  </span>
                ) : (
                  <span className="shrink-0 rounded-md bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg-muted)]">
                    Ciudad
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {open && !loading && query.trim().length >= 2 && items.length === 0 ? (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-5 text-center shadow-lg">
          <p className="text-xs font-medium text-[var(--color-fg)]">
            Sin resultados para «{query.trim()}»
          </p>
          <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
            Probá con un código IATA (BOG, MIA) o el nombre de la ciudad. Las ciudades sin
            aeropuerto también sirven.
          </p>
        </div>
      ) : null}
    </div>
  );
}
