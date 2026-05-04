'use client';

import { Loader2, Plane } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { searchAirports, type Airport } from '../../lib/airports';
import { cn } from '../../lib/cn';

interface AirportComboboxProps {
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
}

const DEBOUNCE_MS = 200;

export function AirportCombobox({
  name,
  label,
  defaultValue,
  required,
  placeholder = 'Ciudad o código (ej. BOG, Bogotá)',
}: AirportComboboxProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [query, setQuery] = useState(defaultValue ?? '');
  const [code, setCode] = useState(defaultValue ?? '');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [results, setResults] = useState<Airport[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const handle = setTimeout(() => {
      setLoading(true);
      searchAirports(query, 8, ctrl.signal)
        .then((items) => {
          if (!ctrl.signal.aborted) {
            setResults(items);
            setActiveIndex(0);
          }
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name !== 'AbortError') {
            setResults([]);
          }
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(handle);
      ctrl.abort();
    };
  }, [query]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function selectAirport(a: Airport) {
    setCode(a.code);
    setQuery(`${a.city} (${a.code})`);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && open && results[activeIndex]) {
      e.preventDefault();
      selectAirport(results[activeIndex]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-[var(--color-fg)]">
        {label}
      </label>

      <input type="hidden" name={name} value={code} required={required} />

      <div className="relative">
        <Plane className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
        <input
          id={id}
          ref={inputRef}
          type="text"
          value={query}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            const v = e.target.value.toUpperCase().trim();
            if (v.length === 3 && /^[A-Z]{3}$/.test(v)) setCode(v);
            else setCode('');
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className={cn(
            'flex h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] pl-9 pr-12 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-xs)]',
            'placeholder:text-[var(--color-fg-subtle)]',
            'focus-visible:outline-none focus-visible:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20',
            'transition-colors',
          )}
        />
        {loading ? (
          <Loader2 className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-[var(--color-fg-subtle)]" />
        ) : code ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[var(--color-fg-muted)]">
            {code}
          </span>
        ) : null}
      </div>

      {open && results.length > 0 ? (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[var(--shadow-md)]"
        >
          {results.map((a, idx) => (
            <li
              key={a.code}
              role="option"
              aria-selected={idx === activeIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                selectAirport(a);
              }}
              onMouseEnter={() => setActiveIndex(idx)}
              className={cn(
                'flex items-center gap-3 px-3 py-2 text-sm cursor-pointer',
                idx === activeIndex
                  ? 'bg-[var(--color-surface-muted)]'
                  : 'hover:bg-[var(--color-surface-muted)]',
              )}
            >
              <span className="font-mono text-[11px] font-semibold text-[var(--color-primary)]">
                {a.code}
              </span>
              <div className="flex-1 min-w-0">
                <p className="truncate text-[var(--color-fg)]">{a.city}</p>
                <p className="truncate text-[11px] text-[var(--color-fg-muted)]">
                  {a.name} · {a.countryName}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {open && !loading && query.length > 0 && results.length === 0 ? (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 text-xs text-[var(--color-fg-muted)] shadow-[var(--shadow-md)]">
          Sin resultados para «{query}». Probá con un código IATA o nombre de ciudad.
        </div>
      ) : null}
    </div>
  );
}
