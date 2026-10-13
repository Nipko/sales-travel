import {
  ticketingDeadline,
  type ProviderClockSource,
  type TicketingDeadline,
} from '../../../lib/ticketing-deadline';

/*
 * Lo que una reserva de vuelo tiene guardado de su última lectura al proveedor, en Mis Reservas y
 * sin React: los localizadores de la aerolínea (con lo que el pasajero hace el check-in), los
 * tiquetes con su estado y el plazo de emisión.
 *
 * `GET /orders` lo devuelve en `flightTracking` (espejo de `PublicFlightOrderTracking` del API).
 * Se lee sin confiar en su forma: lo que no se entiende no se pinta. Los nombres de los pasajeros
 * salen de la orden, nunca del seguimiento, que sólo trae la posición.
 */

export const FLIGHT_DOCUMENT_STATUSES = [
  'ISSUED',
  'VOIDED',
  'REFUNDED',
  'EXCHANGED',
  'UNKNOWN',
] as const;
export type FlightDocumentStatus = (typeof FLIGHT_DOCUMENT_STATUSES)[number];

export interface FlightTrackingLocator {
  readonly carrierCode: string;
  readonly locator: string;
}

export interface FlightTrackingDocument {
  readonly number: string;
  readonly kind: 'TICKET' | 'EMD';
  readonly status: FlightDocumentStatus;
  /** Posición del pasajero en la reserva, desde 0. */
  readonly travelerIndex: number | null;
}

export interface FlightTrackingDeadline {
  readonly date: string;
  readonly time?: string;
  readonly zone: 'UTC' | 'PROVIDER_LOCAL';
  readonly at?: string;
}

export interface FlightTracking {
  readonly airlineLocators: readonly FlightTrackingLocator[];
  readonly documents: readonly FlightTrackingDocument[];
  readonly ticketingDeadline: FlightTrackingDeadline | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CARRIER = /^[A-Z0-9]{2,4}$/;
const LOCATOR = /^[A-Z0-9]{5,16}$/;
const DOCUMENT_NUMBER = /^[0-9]{10,16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function locatorOf(value: unknown): FlightTrackingLocator[] {
  if (!isRecord(value)) return [];
  const { carrierCode, locator } = value;
  return typeof carrierCode === 'string' &&
    CARRIER.test(carrierCode) &&
    typeof locator === 'string' &&
    LOCATOR.test(locator)
    ? [{ carrierCode, locator }]
    : [];
}

function documentOf(value: unknown): FlightTrackingDocument[] {
  if (!isRecord(value)) return [];
  const { number, kind, status, travelerIndex } = value;
  if (typeof number !== 'string' || !DOCUMENT_NUMBER.test(number)) return [];
  if (kind !== 'TICKET' && kind !== 'EMD') return [];
  if (!FLIGHT_DOCUMENT_STATUSES.includes(status as FlightDocumentStatus)) return [];
  return [
    {
      number,
      kind,
      status: status as FlightDocumentStatus,
      travelerIndex:
        typeof travelerIndex === 'number' && Number.isInteger(travelerIndex) && travelerIndex >= 0
          ? travelerIndex
          : null,
    },
  ];
}

function deadlineOf(value: unknown): FlightTrackingDeadline | null {
  if (!isRecord(value)) return null;
  const { date, time, zone, at } = value;
  if (typeof date !== 'string' || !DATE.test(date)) return null;
  if (zone !== 'UTC' && zone !== 'PROVIDER_LOCAL') return null;
  return {
    date,
    zone,
    ...(typeof time === 'string' && TIME.test(time) ? { time } : {}),
    ...(typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? { at } : {}),
  };
}

/** `flightTracking` de una orden, o `null` si no viene o no se entiende. */
export function parseFlightTracking(raw: unknown): FlightTracking | null {
  if (!isRecord(raw)) return null;
  return {
    airlineLocators: Array.isArray(raw['airlineLocators'])
      ? raw['airlineLocators'].flatMap(locatorOf)
      : [],
    documents: Array.isArray(raw['documents']) ? raw['documents'].flatMap(documentOf) : [],
    ticketingDeadline: deadlineOf(raw['ticketingDeadline']),
  };
}

/** Lo que se lee en la columna de estado de un tiquete. */
export const DOCUMENT_STATUS_LABEL: Readonly<Record<FlightDocumentStatus, string>> = {
  ISSUED: 'Emitido',
  VOIDED: 'Anulado',
  REFUNDED: 'Reembolsado',
  EXCHANGED: 'Cambiado',
  UNKNOWN: 'Sin confirmar',
};

/** Tono del estado, para el color. El texto lo dice igual: el color nunca va solo. */
export function documentStatusTone(status: FlightDocumentStatus): 'ok' | 'muted' | 'warning' {
  if (status === 'ISSUED') return 'ok';
  if (status === 'UNKNOWN') return 'warning';
  return 'muted';
}

/** «LA · ABC123»: la aerolínea primero, porque el pasajero hace el check-in en su web. */
export function locatorChipLabel(locator: FlightTrackingLocator): string {
  return `${locator.carrierCode} · ${locator.locator}`;
}

/** El nombre accesible del botón «Copiar» de cada localizador. */
export function copyLocatorLabel(locator: FlightTrackingLocator): string {
  return `Copiar localizador ${locator.locator}`;
}

/** «Tiquete» o «EMD» (el documento que cobra un servicio aparte: maleta, asiento). */
export function documentKindLabel(kind: FlightTrackingDocument['kind']): string {
  return kind === 'EMD' ? 'EMD' : 'Tiquete';
}

interface PassengerLike {
  readonly givenName?: unknown;
  readonly surname?: unknown;
}

/**
 * A nombre de quién está el documento: el pasajero de la reserva en esa posición, o «Pasajero N»
 * si la posición no tiene nombre. Sin posición, «—».
 */
export function documentPassengerLabel(
  document: FlightTrackingDocument,
  passengers: readonly PassengerLike[] | undefined,
): string {
  if (document.travelerIndex === null) return '—';
  const passenger = passengers?.[document.travelerIndex];
  const name = [passenger?.givenName, passenger?.surname]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .trim();
  return name.length > 0 ? name : `Pasajero ${document.travelerIndex + 1}`;
}

/** El plazo de emisión de una reserva, listo para pintar, y de dónde sale. */
export interface OrderDeadline {
  readonly deadline: TicketingDeadline;
  /** `office`: el de la reserva en el proveedor; `fare`: el de la tarifa cuando se reservó. */
  readonly clock: ProviderClockSource;
  /** `true` si es el de la tarifa: el texto lo dice («Plazo de la tarifa»). */
  readonly fromOrder: boolean;
}

/** El plazo guardado al reloj de la librería: con instante si lo hay, si no la hora tal cual. */
function trackedDeadline(deadline: FlightTrackingDeadline): TicketingDeadline {
  if (deadline.zone === 'UTC') {
    if (deadline.at !== undefined) return { kind: 'instant', at: deadline.at };
    if (deadline.time !== undefined) {
      return { kind: 'instant', at: `${deadline.date}T${deadline.time}:00.000Z` };
    }
  }
  return deadline.time === undefined
    ? { kind: 'provider-clock', date: deadline.date }
    : { kind: 'provider-clock', date: deadline.date, time: deadline.time };
}

interface OrderLike {
  readonly flightTracking?: unknown;
  readonly selectedOffer?: { readonly provider?: { readonly raw?: Record<string, unknown> } };
}

/**
 * El plazo de emisión que se muestra de una reserva: el que la reserva tiene guardado en el
 * proveedor y, si todavía no se leyó, el de la tarifa con la que se reservó.
 */
export function orderTicketingDeadline(order: OrderLike): OrderDeadline | null {
  const tracked = parseFlightTracking(order.flightTracking)?.ticketingDeadline ?? null;
  if (tracked !== null) {
    return {
      deadline: trackedDeadline(tracked),
      clock: 'office',
      fromOrder: false,
    };
  }
  const fare = ticketingDeadline(order.selectedOffer?.provider?.raw);
  return fare === null ? null : { deadline: fare, clock: 'fare', fromOrder: true };
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Lo que dice el aviso de «Consultar estado» de un vuelo. Los datos van a la fila (localizadores,
 * tiquetes y plazo); el aviso sólo cuenta qué quedó guardado.
 */
export function retrieveSummary(tracking: FlightTracking | null): string {
  if (tracking === null) return 'Reserva consultada en el proveedor.';
  const locators = tracking.airlineLocators.length;
  const documents = tracking.documents.length;
  if (locators === 0 && documents === 0) {
    return 'Reserva consultada. La aerolínea todavía no informó localizador ni tiquetes.';
  }
  const parts = [
    ...(locators === 0
      ? []
      : [plural(locators, 'localizador de la aerolínea', 'localizadores de la aerolínea')]),
    ...(documents === 0 ? [] : [plural(documents, 'tiquete', 'tiquetes')]),
  ];
  return `Reserva consultada: ${parts.join(' y ')} al día.`;
}

/**
 * ¿La lectura dice que el proveedor tiene la reserva cancelada? `status` viene en el vocabulario de
 * cada proveedor (`CANCELLED`, `cancelled`). Sólo cuenta el estado exacto: uno a medio camino
 * («cancelación pendiente») no es una reserva caída.
 */
export function providerReportsCancelled(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  const normalized = status.trim().toLowerCase();
  return normalized === 'cancelled' || normalized === 'canceled';
}

/** El aviso de «Consultar estado» y si tiene que llamar la atención. */
export interface RetrieveNotice {
  readonly message: string;
  /** `true`: el proveedor ya no tiene viva una reserva que aquí sigue activa. */
  readonly alert: boolean;
}

/**
 * El aviso completo de «Consultar estado». Si el proveedor tiene la reserva cancelada y aquí sigue
 * viva, eso va primero y como alerta: es lo que pasa cuando la aerolínea la cae por plazo de
 * emisión, y el vendedor no se puede enterar al cobrar o emitir. Sin eso, cuenta lo guardado.
 */
export function retrieveNotice(
  tracking: FlightTracking | null,
  providerStatus: unknown,
  orderStatus: string,
): RetrieveNotice {
  if (!providerReportsCancelled(providerStatus)) {
    return { message: retrieveSummary(tracking), alert: false };
  }
  if (orderStatus === 'cancelled') {
    return {
      message: 'Reserva consultada: también figura cancelada en el proveedor.',
      alert: false,
    };
  }
  return {
    message: 'La reserva figura cancelada en el proveedor. Revísala antes de cobrar o emitir.',
    alert: true,
  };
}
