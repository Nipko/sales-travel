'use client';

import { CalendarDays, Loader2, MapPin, Pencil, Users, X } from 'lucide-react';
import type { HotelSearchCriteriaView } from '../actions';
import { searchSummaryView } from './search-summary';

/*
 * Lo que se buscó, arriba de los resultados, con el formulario plegado: en el teléfono el
 * formulario entero ocupaba la pantalla y los hoteles quedaban abajo. "Editar búsqueda" lo vuelve
 * a abrir con los mismos datos.
 */

export function SearchSummaryBar({
  id,
  criteria,
  editing,
  searching = false,
  onToggleEdit,
  formId,
}: {
  id?: string;
  criteria: HotelSearchCriteriaView;
  editing: boolean;
  /** Una búsqueda en curso (por ejemplo, "Buscar de nuevo" con el formulario plegado). */
  searching?: boolean;
  onToggleEdit: () => void;
  /** El formulario que abre y cierra el botón. */
  formId: string;
}) {
  const view = searchSummaryView(criteria);
  return (
    <div
      id={id}
      className="flex scroll-mt-4 items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-[var(--shadow-xs)]"
    >
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-[var(--color-fg)]">
          <MapPin aria-hidden="true" className="size-4 shrink-0 text-[var(--color-primary)]" />
          <span className="truncate">{view.destination}</span>
          {searching ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-normal text-[var(--color-fg-muted)]">
              <Loader2
                aria-hidden="true"
                className="size-3.5 animate-spin motion-reduce:animate-none"
              />
              Buscando…
            </span>
          ) : null}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-fg-muted)]">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <CalendarDays aria-hidden="true" className="size-3.5 shrink-0" />
            {view.dates} · {view.nights}
          </span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Users aria-hidden="true" className="size-3.5 shrink-0" />
            {view.guests}
          </span>
          {view.currency ? (
            <span className="rounded border border-[var(--color-border)] px-1.5 py-px font-mono text-[11px] font-medium text-[var(--color-fg)]">
              <span className="sr-only">Moneda </span>
              {view.currency}
            </span>
          ) : null}
        </p>
      </div>
      <button
        type="button"
        onClick={onToggleEdit}
        aria-expanded={editing}
        aria-controls={formId}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-fg)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
      >
        {editing ? (
          <X aria-hidden="true" className="size-4" />
        ) : (
          <Pencil aria-hidden="true" className="size-4" />
        )}
        <span className="hidden sm:inline">{editing ? 'Cerrar' : 'Editar búsqueda'}</span>
        <span className="sm:hidden">{editing ? 'Cerrar' : 'Editar'}</span>
      </button>
    </div>
  );
}
