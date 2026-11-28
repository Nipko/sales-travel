import { formatMoney } from '../../../../lib/flight-format';
import { areaOfAirport, cityByCode } from '../../../../lib/airport-cities';
import { getAirportByCode } from '../../../../lib/airports';
import type { PackageItem, PackageSummary } from '../actions';
import {
  asSnapshot,
  nightsBetween,
  payingTravelers,
  perPerson,
  type ItemSnapshot,
} from './package-model';

/**
 * Lo que la cotización del paquete le dice al cliente final, sin I/O: la usan la vista del panel,
 * el PDF y el texto de WhatsApp, así los tres cuentan lo mismo.
 */

export interface QuoteItem {
  id: string;
  vertical: string;
  totalMinor: number;
  snapshot: ItemSnapshot;
}

export interface QuoteModel {
  title: string;
  currency: string;
  totalMinor: number;
  perPersonMinor: number;
  travelers: number;
  adults: number;
  children: number;
  nights: number;
  start?: string;
  end?: string;
  originCode?: string;
  destinationLabel?: string;
  expiresAt: string;
  showBreakdown: boolean;
  items: QuoteItem[];
  flight?: QuoteItem;
  hotel?: QuoteItem;
  car?: QuoteItem;
  extras: QuoteItem[];
  coverImage?: string;
  hasTestContent: boolean;
}

/** «PQ-3F9A1C»: corto para decirlo por teléfono, estable porque sale del id. */
/**
 * El estado que ve el vendedor: una cotización no aceptada con `expiresAt` en el pasado está vencida
 * aunque la base todavía diga borrador o enviada (nadie la pasa a `expired`). Lista y detalle igual.
 */
export function shownStatus(pkg: { status: string; expiresAt: string }, now: number): string {
  return pkg.status !== 'accepted' && Date.parse(pkg.expiresAt) < now ? 'expired' : pkg.status;
}

export function quoteRefOf(id: string): string {
  return `PQ-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

export function quoteModel(pkg: PackageSummary, rawItems: readonly PackageItem[]): QuoteModel {
  const items: QuoteItem[] = [];
  for (const raw of [...rawItems].sort((a, b) => a.position - b.position)) {
    const snapshot = asSnapshot(raw.details);
    if (snapshot)
      items.push({ id: raw.id, vertical: raw.vertical, totalMinor: raw.totalMinor, snapshot });
  }
  const rooms = pkg.searchCriteria?.rooms ?? [];
  const travelers = rooms.length > 0 ? payingTravelers(rooms) : 1;
  const adults = rooms.reduce(
    (n, r) => n + r.adults + r.childrenAges.filter((a) => a >= 12).length,
    0,
  );
  const children = rooms.reduce((n, r) => n + r.childrenAges.filter((a) => a < 12).length, 0);
  const start = pkg.searchCriteria?.departureDate;
  const end = pkg.searchCriteria?.returnDate;
  const hotel = items.find((i) => i.snapshot.kind === 'hotel');
  const coverImage = hotel?.snapshot.kind === 'hotel' ? hotel.snapshot.images[0] : undefined;
  return {
    title: pkg.title,
    currency: pkg.currency,
    totalMinor: pkg.totalAmountMinor,
    perPersonMinor: perPerson(pkg.totalAmountMinor, travelers),
    travelers,
    adults: Math.max(adults, rooms.length > 0 ? 1 : 0),
    children,
    nights: start && end ? nightsBetween(start, end) : 0,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(pkg.searchCriteria?.origin ? { originCode: pkg.searchCriteria.origin } : {}),
    ...(pkg.searchCriteria?.destinationLabel
      ? { destinationLabel: pkg.searchCriteria.destinationLabel }
      : {}),
    expiresAt: pkg.expiresAt,
    showBreakdown: pkg.showBreakdown,
    items,
    ...(items.find((i) => i.snapshot.kind === 'flight')
      ? { flight: items.find((i) => i.snapshot.kind === 'flight')! }
      : {}),
    ...(hotel ? { hotel } : {}),
    ...(items.find((i) => i.snapshot.kind === 'car')
      ? { car: items.find((i) => i.snapshot.kind === 'car')! }
      : {}),
    extras: items.filter((i) => i.snapshot.kind === 'manual' || i.snapshot.kind === 'activity'),
    ...(coverImage ? { coverImage } : {}),
    hasTestContent: items.some(
      (i) =>
        (i.snapshot.kind === 'flight' || i.snapshot.kind === 'hotel') && i.snapshot.test === true,
    ),
  };
}

/** «BOG» → «Bogotá». Sin dato, el código tal cual. */
export function placeName(code: string): string {
  return (cityByCode(code) ?? areaOfAirport(code))?.city ?? getAirportByCode(code)?.city ?? code;
}

export function formatLongDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('es-CO', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

export function formatShortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function travelersText(m: Pick<QuoteModel, 'adults' | 'children'>): string {
  const parts = [`${m.adults} ${m.adults === 1 ? 'adulto' : 'adultos'}`];
  if (m.children > 0) parts.push(`${m.children} ${m.children === 1 ? 'niño' : 'niños'}`);
  return parts.join(' y ');
}

export const BOARD_TEXT: Record<string, string> = {
  RO: 'Solo alojamiento',
  BB: 'Desayuno incluido',
  HB: 'Media pensión',
  FB: 'Pensión completa',
  AI: 'Todo incluido',
};

export function boardText(s: { board: string; boardLabel?: string | undefined }): string {
  return s.boardLabel ?? BOARD_TEXT[s.board] ?? 'Alojamiento';
}

/** Lo que incluye, en el idioma del cliente. */
export function includedList(m: QuoteModel): string[] {
  const out: string[] = [];
  for (const item of m.items) {
    const s = item.snapshot;
    if (s.kind === 'flight') {
      out.push('Vuelos de ida y vuelta con tasas e impuestos');
      if (s.baggage?.checked?.qty) {
        out.push(
          `${s.baggage.checked.qty} ${s.baggage.checked.qty === 1 ? 'maleta' : 'maletas'} en bodega por pasajero`,
        );
      }
      if (s.baggage?.carryOn?.qty) out.push('Equipaje de mano');
    } else if (s.kind === 'hotel') {
      out.push(`${m.nights} ${m.nights === 1 ? 'noche' : 'noches'} en ${s.name}`);
      out.push(boardText(s));
    } else if (s.kind === 'car') {
      out.push(`Alquiler de auto ${s.category.toLowerCase()} (${s.model})`);
      if (/unlimit|ilimit/i.test(s.kmIncluded)) out.push('Kilometraje ilimitado');
    } else if (s.kind === 'manual') {
      out.push(s.title);
    } else if (s.kind === 'activity') {
      out.push(s.modality ? `${s.title} (${s.modality})` : s.title);
    }
  }
  return [...new Set(out)];
}

/** Lo que NO incluye: lo que suele preguntar el cliente y conviene decir antes. */
export function excludedList(m: QuoteModel): string[] {
  const out: string[] = [];
  const flight = m.flight?.snapshot;
  if (flight?.kind === 'flight' && !flight.baggage?.checked?.qty) out.push('Maleta en bodega');
  const hotel = m.hotel?.snapshot;
  if (hotel?.kind === 'hotel' && (hotel.board === 'RO' || hotel.board === 'BB')) {
    out.push('Comidas no mencionadas');
  }
  if (hotel) out.push('Impuestos o tasas que el hotel cobre en destino, si aplican');
  if (!m.car) out.push('Traslados no mencionados');
  if (m.car) out.push('Combustible, peajes y seguros adicionales del auto');
  out.push('Gastos personales y propinas');
  return out;
}

/** El texto que el vendedor manda por WhatsApp: corto, con lo esencial y el total. */
export function whatsappText(m: QuoteModel, agencyName: string): string {
  const lines: string[] = [`*${m.title}*`];
  if (m.start && m.end) {
    lines.push(`${formatShortDate(m.start)} – ${formatShortDate(m.end)} · ${travelersText(m)}`);
  }
  lines.push('');
  for (const item of m.items) {
    const s = item.snapshot;
    if (s.kind === 'flight') {
      const out = s.itineraries[0];
      const first = out?.segments[0];
      const last = out?.segments.at(-1);
      if (first && last) {
        lines.push(
          `✈️ Vuelo ${placeName(first.origin)} – ${placeName(last.destination)}, ida y vuelta`,
        );
      }
    } else if (s.kind === 'hotel') {
      lines.push(
        `🏨 ${s.name}${s.stars ? ` ${'★'.repeat(Math.round(s.stars))}` : ''} · ${boardText(s)}`,
      );
    } else if (s.kind === 'car') {
      lines.push(`🚗 Auto ${s.category.toLowerCase()} (${s.model})`);
    } else {
      lines.push(`✨ ${s.title}`);
    }
  }
  lines.push('');
  lines.push(`*Total: ${formatMoney(m.totalMinor, m.currency)}*`);
  if (m.travelers > 1) lines.push(`${formatMoney(m.perPersonMinor, m.currency)} por persona`);
  lines.push(`Válida hasta el ${formatShortDate(m.expiresAt)}. Sujeta a disponibilidad.`);
  lines.push('');
  lines.push(agencyName);
  return lines.join('\n');
}
