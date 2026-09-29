'use client';

import { Loader2, MapPin, RefreshCw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../../../lib/cn';
import { suggestDestinationsAction, type GeoSuggestion } from '../actions';
import {
  SUGGESTIONS_MIN_QUERY,
  SUGGESTIONS_UNAVAILABLE,
  destinationNotice,
} from './destination-suggestions';

/**
 * Autocomplete de destino contra /hotels/suggestions. Escribe los inputs ocultos
 * destinationId/destinationGid/destinationLabel.
 *
 * Si la consulta falla lo dice, con un motivo sin datos técnicos y la opción de reintentar: una
 * lista vacía se leería como "no hay ciudades que coincidan" (ver `destination-suggestions.ts`).
 */
export function DestinationCombobox() {
  const id = useId();
  const listId = `${id}-list`;
  const noticeId = `${id}-notice`;
  const containerRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const [query, setQuery] = useState('');
  const [label, setLabel] = useState('');
  const [gid, setGid] = useState('');
  const [geoId, setGeoId] = useState('');
  const [items, setItems] = useState<GeoSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const q = query.trim();
    if (q.length < SUGGESTIONS_MIN_QUERY || q === label) {
      setItems([]);
      setError(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    const my = ++seq.current;
    const t = setTimeout(() => {
      suggestDestinationsAction(q)
        .then((res) => {
          if (my !== seq.current) return;
          setItems(res.items);
          setError(res.error);
          setActive(-1);
          setLoading(false);
        })
        .catch(() => {
          // La acción misma no respondió (red, despliegue en curso): tampoco es "no hay ciudades".
          if (my !== seq.current) return;
          setItems([]);
          setError(SUGGESTIONS_UNAVAILABLE);
          setLoading(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [query, label, attempt]);

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
    setGeoId(String(s.id));
    setItems([]);
    setOpen(false);
  }

  const notice = open
    ? destinationNotice({ query, label, loading, itemsCount: items.length, error })
    : undefined;

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
      <input type="hidden" name="destinationId" value={geoId} />
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
          aria-describedby={notice ? noticeId : undefined}
          aria-autocomplete="list"
          onChange={(e) => {
            setQuery(e.target.value);
            setGid('');
            setGeoId('');
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

      {/* Región viva siempre montada: un lector de pantalla anuncia el motivo cuando cambia. */}
      <div role="status" aria-live="polite">
        {notice ? (
          <div
            id={noticeId}
            className={cn(
              'absolute z-50 mt-1 w-full rounded-lg border bg-[var(--color-surface)] px-4 py-3 shadow-lg',
              notice.kind === 'error'
                ? 'border-[var(--color-danger)]/35'
                : 'border-[var(--color-border)] text-center',
            )}
          >
            <p
              className={cn(
                'text-xs',
                notice.kind === 'error'
                  ? 'text-[var(--color-danger)]'
                  : 'text-[var(--color-fg-muted)]',
              )}
            >
              {notice.text}
            </p>
            {notice.kind === 'error' ? (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setAttempt((n) => n + 1)}
                className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30"
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                Reintentar
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
