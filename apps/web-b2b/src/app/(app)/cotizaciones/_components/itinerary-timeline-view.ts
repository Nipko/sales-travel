import type { Offer } from '../actions';
import { legLabel as sharedLegLabel } from '../../../../lib/flight-legs';
import { fareAttributes, type AttrState, type AttrValue } from '../../../../lib/fare-attributes';
import { flightDate, flightTime } from '../../../../lib/flight-format';
import { airlineName } from './airline-names';
import { fareComponentsForDisplay } from './fare-components-view';
import { LONG_LAYOVER_MINUTES, TIGHT_LAYOVER_MINUTES } from './itinerary-view';

/*
 * El itinerario completo de una oferta, tal como lo lee quien va a reservar o ya reservó: cada
 * trayecto con sus vuelos, las escalas con su espera, quién opera cada tramo y qué incluye la
 * tarifa. Sin React, para fijarlo con tests: el checkout y el detalle de la reserva pintan lo mismo.
 *
 * Las horas son las del AEROPUERTO, leídas del texto ISO con su offset y nunca convertidas a la zona
 * de quien mira (ver `lib/flight-format.ts`). Por la misma razón, el «+1» de la llegada se cuenta
 * entre fechas de calendario de los aeropuertos, no entre medianoches del navegador.
 */

export interface TimelineSegmentInput {
  readonly carrier: string;
  readonly operatingCarrier?: string;
  readonly flightNumber: string;
  readonly origin: string;
  readonly destination: string;
  readonly departureAt: string;
  readonly arrivalAt: string;
  readonly durationMinutes?: number;
  readonly cabin?: string;
  readonly bookingClass?: string;
  readonly aircraft?: string;
}

export interface TimelineLegInput {
  readonly segments: readonly TimelineSegmentInput[];
  readonly totalDurationMinutes?: number;
  readonly stops?: number;
}

export interface TimelinePoint {
  readonly time: string;
  readonly date: string;
  readonly airport: string;
}

export interface TimelineSegmentView {
  readonly key: string;
  readonly departure: TimelinePoint;
  readonly arrival: TimelinePoint & {
    /** Días de calendario desde la SALIDA DEL TRAYECTO; > 0 se pinta «+1». */
    readonly dayOffset: number;
  };
  readonly durationMinutes: number | null;
  readonly carrier: string;
  readonly airline: string;
  /** «LA 4205». */
  readonly flight: string;
  /** El nombre de la aerolínea que OPERA el tramo, sólo si no es la que lo vende. */
  readonly operatedBy?: string;
  readonly cabin?: string;
  readonly bookingClass?: string;
  readonly aircraft?: string;
}

export interface TimelineConnectionView {
  readonly key: string;
  readonly arrivalAirport: string;
  readonly departureAirport: string;
  readonly minutes: number;
  readonly changesAirport: boolean;
  readonly tight: boolean;
  readonly long: boolean;
}

export type TimelineItem =
  | { readonly kind: 'segment'; readonly segment: TimelineSegmentView }
  | { readonly kind: 'connection'; readonly connection: TimelineConnectionView };

export type InclusionKey = 'personal-item' | 'carry-on' | 'checked-bag' | 'change' | 'refund';

export interface InclusionChip {
  readonly key: InclusionKey;
  readonly state: AttrValue;
  readonly text: string;
  /** Un dato corto que acompaña («23 kg», «Cargo US$ 50»). */
  readonly detail?: string;
}

export interface TimelineFareView {
  readonly key: string;
  readonly name: string;
  readonly details: readonly string[];
}

export interface TimelineLegView {
  readonly index: number;
  /** «Ida», «Vuelta», «Vuelo» o «Trayecto 3». */
  readonly label: string;
  readonly origin: string;
  readonly destination: string;
  readonly departure: TimelinePoint;
  readonly arrival: TimelinePoint & { readonly dayOffset: number };
  /** Fecha larga de la salida, para la cabecera del trayecto. */
  readonly longDate: string;
  readonly durationMinutes: number | null;
  readonly stops: number;
  readonly items: readonly TimelineItem[];
  readonly fares: readonly TimelineFareView[];
  readonly inclusions: readonly InclusionChip[];
  /** `leg`: lo que incluye la marca de ESTE trayecto; `offer`: lo del viaje completo. */
  readonly inclusionsSource: 'leg' | 'offer';
}

const CABIN_LABELS: Readonly<Record<string, string>> = {
  economy: 'Económica',
  premium_economy: 'Premium economy',
  business: 'Ejecutiva',
  first: 'Primera',
};

/** «business» → «Ejecutiva». Un valor que no se conoce pasa legible, sin guiones bajos. */
export function cabinLabel(cabin: string | undefined): string | undefined {
  const value = cabin?.trim();
  if (!value) return undefined;
  const known = CABIN_LABELS[value.toLowerCase()];
  if (known) return known;
  const spaced = value.replaceAll('_', ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const DATE_PART = /^(\d{4})-(\d{2})-(\d{2})/;

/** Días de calendario entre las fechas ESCRITAS de dos ISO (las de cada aeropuerto). */
export function calendarDayOffset(fromIso: string, toIso: string): number {
  const a = DATE_PART.exec(fromIso);
  const b = DATE_PART.exec(toIso);
  if (!a || !b) return 0;
  const from = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const to = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((to - from) / 86_400_000);
}

/** Minutos entre dos instantes ISO (con su offset). `null` si alguno no se entiende. */
export function minutesBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 60_000));
}

/** «2h 05m», «45m». */
export function formatDurationShort(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** «Directo», «1 escala», «2 escalas». */
export function stopsLabel(stops: number): string {
  if (stops <= 0) return 'Directo';
  return `${stops} ${stops === 1 ? 'escala' : 'escalas'}`;
}

/** «Escala en LIM · 2h 10m», con el motivo de alerta si lo hay. */
export function connectionLabel(connection: TimelineConnectionView): string {
  const time = formatDurationShort(connection.minutes);
  if (connection.changesAirport) {
    return `Cambio de aeropuerto ${connection.arrivalAirport} → ${connection.departureAirport} · ${time}`;
  }
  return `Escala en ${connection.arrivalAirport} · ${time}`;
}

/** Las alertas de una escala, escritas: el color nunca va solo. */
export function connectionAlerts(connection: TimelineConnectionView): string[] {
  const alerts: string[] = [];
  if (connection.changesAirport) alerts.push('Traslado entre aeropuertos');
  if (connection.tight) alerts.push('Conexión corta');
  if (connection.long) alerts.push('Escala larga');
  return alerts;
}

function point(iso: string, airport: string): TimelinePoint {
  return { time: flightTime(iso), date: flightDate(iso), airport };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function segmentView(
  segment: TimelineSegmentInput,
  legDepartureAt: string,
  key: string,
): TimelineSegmentView {
  const carrier = segment.carrier.trim().toUpperCase();
  const operating = segment.operatingCarrier?.trim().toUpperCase();
  const duration =
    typeof segment.durationMinutes === 'number' && segment.durationMinutes > 0
      ? segment.durationMinutes
      : minutesBetween(segment.departureAt, segment.arrivalAt);
  const cabin = cabinLabel(segment.cabin);
  const bookingClass = clean(segment.bookingClass);
  const aircraft = clean(segment.aircraft);
  return {
    key,
    departure: point(segment.departureAt, segment.origin),
    arrival: {
      ...point(segment.arrivalAt, segment.destination),
      dayOffset: calendarDayOffset(legDepartureAt, segment.arrivalAt),
    },
    durationMinutes: duration,
    carrier,
    airline: airlineName(carrier),
    flight: `${carrier} ${segment.flightNumber}`.trim(),
    ...(operating && operating !== carrier ? { operatedBy: airlineName(operating) } : {}),
    ...(cabin ? { cabin } : {}),
    ...(bookingClass ? { bookingClass } : {}),
    ...(aircraft ? { aircraft } : {}),
  };
}

type Wording = Readonly<Record<AttrValue, string>>;

const WORDING: Readonly<Record<InclusionKey, Wording>> = {
  'personal-item': {
    yes: 'Artículo personal',
    partial: 'Artículo personal con cargo',
    no: 'Sin artículo personal',
    unknown: 'Artículo personal sin informar',
  },
  'carry-on': {
    yes: 'Equipaje de mano',
    partial: 'Equipaje de mano con cargo',
    no: 'Sin equipaje de mano',
    unknown: 'Equipaje de mano sin informar',
  },
  'checked-bag': {
    yes: 'Maleta facturada',
    partial: 'Maleta con cargo',
    no: 'Sin maleta facturada',
    unknown: 'Maleta sin informar',
  },
  change: {
    yes: 'Cambios sin cargo',
    partial: 'Cambios con cargo',
    no: 'Sin cambios',
    unknown: 'Cambios sin informar',
  },
  refund: {
    yes: 'Reembolsable',
    partial: 'Reembolso con cargo',
    no: 'No reembolsable',
    unknown: 'Reembolso sin informar',
  },
};

/** Lo que ya dice el texto del chip no se repite como detalle. */
const REDUNDANT_DETAILS: ReadonlySet<string> = new Set(['no informado', 'sin cargo', 'con cargo']);

/** Un atributo de la tarifa como chip. El detalle sólo si es corto y suma algo. */
export function inclusionChip(key: InclusionKey, state: AttrState): InclusionChip {
  const detail = state.detail?.trim();
  const useful =
    detail !== undefined &&
    detail.length > 0 &&
    detail.length <= 18 &&
    !REDUNDANT_DETAILS.has(detail.toLowerCase());
  return {
    key,
    state: state.value,
    text: WORDING[key][state.value],
    ...(useful ? { detail } : {}),
  };
}

function inclusionsFor(
  offer: Offer,
  leg: number,
  formatMoney: (amountMinor: number, currency: string) => string,
): { chips: InclusionChip[]; source: 'leg' | 'offer' } {
  const attrs = fareAttributes(offer, leg, formatMoney);
  const chips = [
    // El artículo personal sólo cuando se sabe algo: «sin informar» de los cinco era ruido.
    ...(attrs.personalItem.value === 'unknown'
      ? []
      : [inclusionChip('personal-item', attrs.personalItem)]),
    inclusionChip('carry-on', attrs.carryOn),
    inclusionChip('checked-bag', attrs.checked),
    inclusionChip('change', attrs.change),
    inclusionChip('refund', attrs.refund),
  ];
  return { chips, source: attrs.source };
}

/**
 * El itinerario de la oferta, trayecto por trayecto. `formatMoney` entra por parámetro porque los
 * cargos de cambio y reembolso se escriben en la moneda de la oferta.
 */
export function buildTimeline(
  offer: Offer,
  formatMoney: (amountMinor: number, currency: string) => string,
): TimelineLegView[] {
  const legs = offer.itineraries ?? [];
  const fares = fareComponentsForDisplay(offer);
  return legs.flatMap((leg, index): TimelineLegView[] => {
    const first = leg.segments[0];
    const last = leg.segments[leg.segments.length - 1];
    if (!first || !last) return [];

    const items: TimelineItem[] = [];
    leg.segments.forEach((segment, i) => {
      items.push({
        kind: 'segment',
        segment: segmentView(segment, first.departureAt, `${index}-${i}`),
      });
      const next = leg.segments[i + 1];
      if (!next) return;
      const minutes = minutesBetween(segment.arrivalAt, next.departureAt) ?? 0;
      items.push({
        kind: 'connection',
        connection: {
          key: `${index}-${i}-c`,
          arrivalAirport: segment.destination,
          departureAirport: next.origin,
          minutes,
          changesAirport: segment.destination !== next.origin,
          tight: minutes < TIGHT_LAYOVER_MINUTES,
          long: minutes >= LONG_LAYOVER_MINUTES,
        },
      });
    });

    const duration =
      typeof leg.totalDurationMinutes === 'number' && leg.totalDurationMinutes > 0
        ? leg.totalDurationMinutes
        : minutesBetween(first.departureAt, last.arrivalAt);
    const { chips, source } = inclusionsFor(offer, index, formatMoney);

    return [
      {
        index,
        label: sharedLegLabel(legs, index) ?? 'Vuelo',
        origin: first.origin,
        destination: last.destination,
        departure: point(first.departureAt, first.origin),
        arrival: {
          ...point(last.arrivalAt, last.destination),
          dayOffset: calendarDayOffset(first.departureAt, last.arrivalAt),
        },
        longDate: flightDate(first.departureAt, 'long'),
        durationMinutes: duration,
        stops: Math.max(leg.stops ?? 0, leg.segments.length - 1),
        items,
        fares: fares
          .filter((fare) => fare.itineraryIndexes.includes(index))
          .map((fare) => ({ key: fare.key, name: fare.name, details: fare.details })),
        inclusions: chips,
        inclusionsSource: source,
      },
    ];
  });
}

/** «BOG → LIM», «BOG ⇄ LIM» (ida y vuelta) o «BOG → LIM → CUZ» (varios trayectos). */
export function routeTitle(legs: readonly Pick<TimelineLegView, 'origin' | 'destination'>[]) {
  const first = legs[0];
  if (!first) return '';
  if (legs.length === 1) return `${first.origin} → ${first.destination}`;
  const last = legs[legs.length - 1]!;
  if (legs.length === 2 && last.destination === first.origin && last.origin === first.destination) {
    return `${first.origin} ⇄ ${first.destination}`;
  }
  return [first.origin, ...legs.map((leg) => leg.destination)].join(' → ');
}

/** «mar, 14 oct – dom, 19 oct»: las fechas de salida del primer y del último trayecto. */
export function travelDates(legs: readonly Pick<TimelineLegView, 'departure'>[]): string {
  const first = legs[0];
  if (!first) return '';
  const last = legs[legs.length - 1]!;
  return legs.length > 1 && last.departure.date !== first.departure.date
    ? `${first.departure.date} – ${last.departure.date}`
    : first.departure.date;
}
