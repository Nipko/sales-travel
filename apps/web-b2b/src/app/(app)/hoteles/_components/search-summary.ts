import type { HotelSearchCriteriaView } from '../actions';

/*
 * La barra de la búsqueda encima de los resultados: qué se buscó, dicho en una línea que el
 * vendedor le puede leer al cliente. Sale de lo que se BUSCÓ (`criteria`), no del formulario, que
 * se pudo haber tocado después.
 */

export interface SearchSummaryView {
  readonly destination: string;
  /** "12 – 15 oct 2026". */
  readonly dates: string;
  readonly nights: string;
  /** "2 huéspedes · 1 habitación". */
  readonly guests: string;
  readonly currency?: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcDate(iso: string): Date | undefined {
  const m = DATE_RE.exec(iso);
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function part(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('es', { ...options, timeZone: 'UTC' })
    .format(date)
    .replace(/\./g, '');
}

/**
 * El rango de fechas corto, sin repetir lo que comparten: "12 – 15 oct 2026",
 * "30 oct – 2 nov 2026", "28 dic 2026 – 2 ene 2027".
 */
export function stayDatesLabel(checkin: string, checkout: string): string {
  const from = utcDate(checkin);
  const to = utcDate(checkout);
  if (from === undefined || to === undefined) return `${checkin} – ${checkout}`;
  const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
  const sameMonth = sameYear && from.getUTCMonth() === to.getUTCMonth();
  const end = part(to, { day: 'numeric', month: 'short', year: 'numeric' });
  if (sameMonth) return `${from.getUTCDate()} – ${end}`;
  if (sameYear) return `${part(from, { day: 'numeric', month: 'short' })} – ${end}`;
  return `${part(from, { day: 'numeric', month: 'short', year: 'numeric' })} – ${end}`;
}

export function searchSummaryView(criteria: HotelSearchCriteriaView): SearchSummaryView {
  const ids = criteria.hotelIdsCount ?? 0;
  const destination =
    criteria.destinationLabel ??
    (ids > 0 ? `${ids} hotel${ids === 1 ? '' : 'es'} por ID` : 'Destino elegido');
  return {
    destination,
    dates: stayDatesLabel(criteria.checkinDate, criteria.checkoutDate),
    nights: `${criteria.nights} noche${criteria.nights === 1 ? '' : 's'}`,
    guests: `${criteria.guests} huésped${criteria.guests === 1 ? '' : 'es'} · ${criteria.rooms} habitaci${criteria.rooms === 1 ? 'ón' : 'ones'}`,
    ...(criteria.currency === undefined ? {} : { currency: criteria.currency }),
  };
}
