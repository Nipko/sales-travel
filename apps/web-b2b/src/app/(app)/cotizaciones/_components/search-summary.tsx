'use client';

import { Pencil, Route } from 'lucide-react';
import { formatDayShort } from '../../../../components/ui/date-range-picker';
import { cabinLabel, paxComposition, type PaxCounts } from './search-form-model';

/** Lo que se buscó, congelado al enviar: lo mismo que viaja a la cotización. */
export interface SearchedTrip {
  readonly origin: string;
  readonly destination: string;
  readonly departureDate: string;
  readonly returnDate?: string;
  readonly legs?: readonly {
    readonly origin: string;
    readonly destination: string;
    readonly departureDate: string;
  }[];
  readonly paxCount: PaxCounts;
  readonly cabin: string;
}

/** «CTG → MIA → ORL → CTG» y «9 dic – 19 dic · 3 tramos»: la ruta y las fechas en una línea. */
export function summarizeTrip(trip: SearchedTrip): { route: string; when: string } {
  if (trip.legs && trip.legs.length > 0) {
    const stops = [trip.legs[0]!.origin, ...trip.legs.map((leg) => leg.destination)];
    const first = trip.legs[0]!.departureDate;
    const last = trip.legs[trip.legs.length - 1]!.departureDate;
    return {
      route: stops.join(' → '),
      when: `${formatDayShort(first)} – ${formatDayShort(last)} · ${String(trip.legs.length)} tramos`,
    };
  }
  if (trip.returnDate) {
    return {
      route: `${trip.origin} ⇄ ${trip.destination}`,
      when: `${formatDayShort(trip.departureDate)} – ${formatDayShort(trip.returnDate)}`,
    };
  }
  return {
    route: `${trip.origin} → ${trip.destination}`,
    when: `${formatDayShort(trip.departureDate)} · Solo ida`,
  };
}

/**
 * La búsqueda plegada: una línea con ruta, fechas y pasajeros, y «Modificar». Con resultados en
 * pantalla el formulario entero no aporta nada y empujaba el primer vuelo media pantalla abajo
 * (con tres tramos, casi una pantalla entera en el teléfono).
 */
export function SearchSummary({ trip, onEdit }: { trip: SearchedTrip; onEdit: () => void }) {
  const { route, when } = summarizeTrip(trip);
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="hidden size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary)]/10 text-[var(--color-primary)] sm:flex"
      >
        <Route className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold tracking-tight text-[var(--color-fg)]">
          {route}
        </p>
        <p className="truncate text-sm text-[var(--color-fg-muted)]">
          {when} · {paxComposition(trip.paxCount)} · {cabinLabel(trip.cabin)}
        </p>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-semibold text-[var(--color-fg)] transition-colors hover:border-[var(--color-border-strong)]"
      >
        <Pencil className="size-3.5" aria-hidden="true" />
        Modificar
      </button>
    </div>
  );
}
