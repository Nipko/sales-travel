'use client';

import { Building2, Search, User } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { comboboxKeyAction } from '../../../../components/ui/airport-combobox';
import { cn } from '../../../../lib/cn';
import {
  CUSTOMER_SEARCH_DEBOUNCE_MS,
  CUSTOMER_SEARCH_MIN_CHARS,
  crmCustomerDetail,
  crmCustomerName,
  customerSearchTerm,
  customerSearchUrl,
  parseCustomerSearchResponse,
  type CrmCustomer,
} from '../../../../lib/customer-search';

type SearchState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'done'; readonly results: readonly CrmCustomer[] }
  | { readonly kind: 'error' };

/** Lo que anuncia la región viva bajo el campo. Vacío mientras no hay nada que decir. */
export function customerSearchStatus(state: SearchState, query: string): string {
  if (state.kind === 'loading') return 'Buscando…';
  if (state.kind === 'error') return 'No pudimos buscar en Clientes. Inténtalo de nuevo.';
  if (state.kind === 'done') {
    const n = state.results.length;
    if (n === 0) return `Sin clientes registrados para «${query.trim()}».`;
    return n === 1 ? '1 cliente encontrado.' : `${n} clientes encontrados.`;
  }
  return '';
}

interface CustomerSearchComboboxProps {
  /** Prefijo estable de ids (la etiqueta apunta al campo). */
  readonly id: string;
  readonly label: string;
  readonly placeholder?: string;
  /** Qué resultados sirven aquí (p. ej. sólo personas para un pasajero). */
  readonly accept?: (customer: CrmCustomer) => boolean;
  readonly onPick: (customer: CrmCustomer) => void;
}

/**
 * «Buscar cliente registrado»: un combobox ARIA (campo + lista) que consulta Clientes al dejar de
 * teclear. Elegir una fila no cambia el texto del campo por el nombre: el campo se limpia y los
 * datos van a los campos del formulario, que es donde el vendedor los revisa.
 */
export function CustomerSearchCombobox({
  id,
  label,
  placeholder = 'Nombre, email o número de documento',
  accept,
  onPick,
}: CustomerSearchComboboxProps) {
  const uid = useId();
  const inputId = `${id}-search`;
  const listboxId = `${uid}-listbox`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  const acceptRef = useRef(accept);
  acceptRef.current = accept;

  useEffect(() => {
    const term = customerSearchTerm(query);
    if (term === null) {
      setState({ kind: 'idle' });
      setActiveIndex(-1);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState({ kind: 'loading' });
      fetch(customerSearchUrl(term), { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          const all = parseCustomerSearchResponse(await res.json());
          const filter = acceptRef.current;
          setState({ kind: 'done', results: filter ? all.filter(filter) : all });
          setActiveIndex(-1);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setState({ kind: 'error' });
        });
    }, CUSTOMER_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    function outside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, []);

  const results = state.kind === 'done' ? state.results : [];
  const active = activeIndex >= 0 ? results[activeIndex] : undefined;
  const optionId = (c: CrmCustomer) => `${uid}-opt-${c.id}`;
  const expanded = open && results.length > 0;

  function pick(c: CrmCustomer) {
    onPick(c);
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const total = results.length;
    const action = comboboxKeyAction(e.key, { open, activeIndex, optionCount: total });
    if (action === 'next') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % total);
    } else if (action === 'prev') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i <= 0 ? total - 1 : i - 1));
    } else if (action === 'select' && active) {
      e.preventDefault();
      pick(active);
    } else if (action === 'close') {
      if (e.key === 'Escape' && open) e.preventDefault();
      setOpen(false);
    }
  }

  const status = customerSearchStatus(state, query);

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-[var(--color-fg)]">
        {label}
      </label>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]"
        />
        <input
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          value={query}
          placeholder={placeholder}
          aria-expanded={expanded}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={expanded && active ? optionId(active) : undefined}
          aria-describedby={`${inputId}-hint`}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] pl-9 pr-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus-visible:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/20"
        />
      </div>
      <p id={`${inputId}-hint`} className="sr-only">
        Escribe al menos {CUSTOMER_SEARCH_MIN_CHARS} letras. Usa las flechas para recorrer los
        resultados y Enter para elegir uno.
      </p>
      <ul
        id={listboxId}
        role="listbox"
        aria-label={label}
        hidden={!expanded}
        className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
      >
        {results.map((c, i) => {
          const Icon = c.customerType === 'company' ? Building2 : User;
          return (
            <li
              key={c.id}
              id={optionId(c)}
              role="option"
              aria-selected={i === activeIndex}
              // `mousedown` y no `click`: el clic llega después del blur y la lista ya se cerró.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              onMouseEnter={() => setActiveIndex(i)}
              className={cn(
                'flex min-h-11 cursor-pointer items-start gap-2.5 px-3 py-2',
                i === activeIndex && 'bg-[var(--color-surface-muted)]',
              )}
            >
              <Icon
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-subtle)]"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-[var(--color-fg)]">
                  {crmCustomerName(c)}
                </span>
                <span className="block truncate text-xs text-[var(--color-fg-muted)]">
                  {crmCustomerDetail(c)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <p
        role="status"
        aria-live="polite"
        className={cn(
          'mt-1 min-h-4 text-[11px]',
          state.kind === 'error' ? 'text-red-700' : 'text-[var(--color-fg-muted)]',
          // Con resultados a la vista el conteo sólo hace falta para el lector de pantalla.
          expanded && 'sr-only',
        )}
      >
        {open || state.kind === 'error' ? status : ''}
      </p>
    </div>
  );
}
