'use client';

import { Clock, Plane, Star } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  getAirportByCode,
  getPopularAirports,
  getRecentAirports,
  isDatasetLoaded,
  loadFullDataset,
  saveRecentAirport,
  searchAirports,
  type Airport,
} from '../../lib/airports';
import { cn } from '../../lib/cn';

interface AirportComboboxProps {
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
  error?: string;
  onChange?: (code: string) => void;
  /** id estable para el input visible (permite mover el foco a este campo desde afuera). */
  inputId?: string;
}

const DEBOUNCE_MS = 80;

interface Section {
  label: string;
  icon: typeof Plane;
  items: Airport[];
}

export function AirportCombobox({
  name,
  label,
  defaultValue,
  required,
  placeholder = 'Ciudad o código IATA',
  error,
  onChange,
  inputId,
}: AirportComboboxProps) {
  const id = useId();
  const fieldId = inputId ?? id;
  const listboxId = `${id}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState(() => {
    if (!defaultValue) return '';
    const a = getAirportByCode(defaultValue);
    return a ? `${a.city} (${a.code})` : defaultValue;
  });
  const [code, setCode] = useState(defaultValue ?? '');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [sections, setSections] = useState<Section[]>([]);
  const [datasetVersion, setDatasetVersion] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flatItems = sections.flatMap((s) => s.items);
  const activeItem = activeIndex >= 0 ? flatItems[activeIndex] : undefined;

  const buildSections = useCallback((q: string): Section[] => {
    const trimmed = q.trim();
    if (!trimmed) {
      const result: Section[] = [];
      const recent = getRecentAirports();
      if (recent.length > 0) {
        result.push({ label: 'Recientes', icon: Clock, items: recent });
      }
      result.push({ label: 'Populares', icon: Star, items: getPopularAirports(8) });
      return result;
    }
    const results = searchAirports(trimmed, 8);
    if (results.length === 0) return [];
    return [{ label: 'Resultados', icon: Plane, items: results }];
  }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setSections(buildSections(query));
      setActiveIndex(-1);
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, buildSections, datasetVersion]);

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
    saveRecentAirport(a.code);
    onChange?.(a.code);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const total = flatItems.length;
    if (!total) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % total);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? total - 1 : i - 1));
    } else if (e.key === 'Enter' && open && activeItem) {
      e.preventDefault();
      selectAirport(activeItem);
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  function handleInputChange(value: string) {
    setQuery(value);
    setOpen(true);
    const upper = value.toUpperCase().trim();
    if (upper.length === 3 && /^[A-Z]{3}$/.test(upper)) {
      const found = getAirportByCode(upper);
      const newCode = found ? found.code : upper;
      setCode(newCode);
      onChange?.(newCode);
    } else {
      setCode('');
      onChange?.('');
    }
  }

  let globalIdx = -1;

  return (
    <div ref={containerRef} className="relative space-y-1.5">
      <label htmlFor={fieldId} className="block text-xs font-medium text-[var(--color-fg)]">
        {label}
      </label>

      <input type="hidden" name={name} value={code} required={required} />

      <div className="relative">
        <Plane className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
        <input
          id={fieldId}
          ref={inputRef}
          role="combobox"
          type="text"
          value={query}
          autoComplete="off"
          placeholder={placeholder}
          aria-expanded={open && flatItems.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={activeItem ? `${id}-opt-${activeItem.code}` : undefined}
          aria-autocomplete="list"
          aria-invalid={error ? true : undefined}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => {
            setOpen(true);
            if (!query.trim()) setSections(buildSections(''));
            if (!isDatasetLoaded()) {
              void loadFullDataset().then(() => {
                setDatasetVersion((v) => v + 1);
              });
            }
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            'flex h-10 w-full rounded-lg border bg-[var(--color-surface)] pl-9 pr-14 py-2 text-sm text-[var(--color-fg)]',
            'placeholder:text-[var(--color-fg-subtle)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30 focus-visible:border-[var(--color-primary)]',
            'transition-all duration-150',
            error
              ? 'border-[var(--color-danger)] ring-2 ring-[var(--color-danger)]/20'
              : 'border-[var(--color-border)] shadow-[var(--shadow-xs)]',
          )}
        />

        {code ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-[var(--color-primary)]/10 px-2 py-0.5 font-mono text-[11px] font-semibold tracking-wider text-[var(--color-primary)]">
            {code}
          </span>
        ) : null}
      </div>

      {error ? <p className="text-[11px] text-[var(--color-danger)]">{error}</p> : null}

      {open && flatItems.length > 0 ? (
        <ul
          id={listboxId}
          role="listbox"
          className={cn(
            'absolute z-50 mt-1 max-h-80 w-full overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg',
            'animate-in fade-in-0 zoom-in-95 duration-100',
          )}
        >
          {sections.map((section) => (
            <li key={section.label} role="presentation">
              <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                <section.icon className="size-3 text-[var(--color-fg-subtle)]" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  {section.label}
                </span>
              </div>
              <ul role="group" aria-label={section.label}>
                {section.items.map((a) => {
                  globalIdx++;
                  const idx = globalIdx;
                  const isActive = idx === activeIndex;
                  return (
                    <li
                      key={a.code}
                      id={`${id}-opt-${a.code}`}
                      role="option"
                      aria-selected={isActive}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectAirport(a);
                      }}
                      onMouseEnter={() => setActiveIndex(idx)}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 text-sm cursor-pointer transition-colors duration-75',
                        isActive
                          ? 'bg-[var(--color-primary)]/8 text-[var(--color-fg)]'
                          : 'text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]',
                      )}
                    >
                      <span className="text-base leading-none" aria-hidden="true">
                        {a.flag}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">
                          {a.city}
                          <span className="ml-1.5 text-[var(--color-fg-muted)]">·</span>
                          <span className="ml-1.5 text-xs text-[var(--color-fg-muted)]">
                            {a.country}
                          </span>
                        </p>
                        <p className="truncate text-[11px] text-[var(--color-fg-muted)]">
                          {a.name}
                        </p>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 rounded-md px-2 py-0.5 font-mono text-[11px] font-bold tracking-wider',
                          isActive
                            ? 'bg-[var(--color-primary)] text-white'
                            : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
                        )}
                      >
                        {a.code}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}

      {open && !query.trim() && flatItems.length === 0 ? (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-6 text-center shadow-lg">
          <Plane className="mx-auto mb-2 size-5 text-[var(--color-fg-subtle)]" />
          <p className="text-xs text-[var(--color-fg-muted)]">
            Escribí una ciudad o código IATA para buscar.
          </p>
        </div>
      ) : null}

      {open && query.trim().length > 0 && flatItems.length === 0 ? (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-5 text-center shadow-lg">
          <p className="text-xs font-medium text-[var(--color-fg)]">
            Sin resultados para «{query.trim()}»
          </p>
          <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
            Probá con un código IATA (BOG, MIA) o nombre de ciudad.
          </p>
        </div>
      ) : null}
    </div>
  );
}
