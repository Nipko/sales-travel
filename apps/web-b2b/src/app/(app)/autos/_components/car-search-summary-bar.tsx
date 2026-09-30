'use client';

import { ArrowRight, CalendarDays, CreditCard, Loader2, MapPin, Pencil, X } from 'lucide-react';
import { searchSummaryView, type CarSearchCriteria } from './car-search-model';

/*
 * Lo que se buscó, arriba de los resultados, con el formulario plegado (como en hoteles): en el
 * teléfono el formulario entero ocupaba la pantalla y los autos quedaban abajo. "Editar búsqueda"
 * lo vuelve a abrir con los mismos datos.
 */
export function CarSearchSummaryBar({
  id,
  criteria,
  editing,
  searching = false,
  onToggleEdit,
  formId,
}: {
  id?: string;
  criteria: CarSearchCriteria;
  editing: boolean;
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
          <span className="truncate">{view.place}</span>
          {view.dropoffPlace ? (
            <>
              <ArrowRight
                aria-hidden="true"
                className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]"
              />
              <span className="sr-only">, devolución en </span>
              <span className="truncate">{view.dropoffPlace}</span>
            </>
          ) : null}
          {searching ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-normal text-[var(--color-fg-muted)]">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Buscando…
            </span>
          ) : null}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-fg-muted)]">
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <CalendarDays aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="whitespace-nowrap">{view.pickUp}</span>
            <span aria-hidden="true">–</span>
            <span className="sr-only">hasta</span>
            <span className="whitespace-nowrap">{view.dropOff}</span>
            <span className="whitespace-nowrap">· {view.days}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <CreditCard aria-hidden="true" className="size-3.5 shrink-0" />
            {view.payment}
          </span>
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
