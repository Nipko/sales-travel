import type { HotelRoompack, Money } from '../hoteles/actions';
import { formatStayDate, stayNights } from '../hoteles/[hotelKey]/_components/hotel-detail-view';
import {
  parseNonRefundable,
  type PrebookNonRefundable,
} from '../hoteles/checkout/_components/non-refundable-view';
import type {
  HotelPrebookCondition,
  HotelRateConditionCategory,
} from '../hoteles/checkout/_components/prebook-view';
import { cancellationInProgress, PROVIDER_CANCELLING_STATUSES } from './order-capabilities';

/*
 * Una orden de hotel en Mis Reservas sin React (docs/tbo/09 PR-6.5; U-15 a U-17; 08 RF-26): la
 * estadía, las habitaciones con sus huéspedes, el estado de la orden con el subestado del
 * proveedor ("Verificando", "Cancelación en curso"), el HCN y lo que respondió "Actualizar estado".
 *
 * `GET /orders` devuelve la orden como la guardó la reserva (`orders.selected_offer`,
 * `orders.passengers`), que es JSON escrito por otra versión del código: todo se lee sin confiar en
 * su forma, y lo que no se entiende no se pinta. El seguimiento (`providerTracking`) trae sólo
 * códigos y localizadores; los nombres de los huéspedes salen de la orden, nunca de ahí.
 */

/** Lo que la pantalla usa de una orden de `GET /orders`. */
export interface HotelOrderInput {
  readonly id: string;
  readonly orderNumber: number;
  readonly status: string;
  readonly pnr: string | null;
  readonly provider?: string;
  readonly searchCriteria?: unknown;
  readonly selectedOffer?: unknown;
  readonly passengers?: unknown;
  readonly contactInfo?: unknown;
  readonly totalAmount: number;
  readonly currency: string;
  readonly errorMessage?: string | null;
  readonly providerTracking?: unknown;
  readonly createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length === 0 || t.length > max ? undefined : t;
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

// ───────────────────────── Seguimiento (RF-26) ─────────────────────────

/** Espejo de `PublicHotelOrderTracking` del API: códigos y localizadores, nunca PII. */
export interface HotelOrderTracking {
  readonly subStatus: string | null;
  readonly providerStatus: string | null;
  readonly providerStatusAt: string | null;
  readonly providerStatusSource: string | null;
  readonly refundAwaited: boolean;
  readonly hotelConfirmationNumber: string | null;
  readonly hcnState: string | null;
}

const CODE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function codeOrNull(value: unknown): string | null {
  return typeof value === 'string' && CODE_RE.test(value) ? value : null;
}

export function parseHotelTracking(value: unknown): HotelOrderTracking | null {
  if (!isRecord(value)) return null;
  const at = value['providerStatusAt'];
  return {
    subStatus: codeOrNull(value['subStatus']),
    providerStatus: codeOrNull(value['providerStatus']),
    providerStatusAt: typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null,
    providerStatusSource: codeOrNull(value['providerStatusSource']),
    refundAwaited: value['refundAwaited'] === true,
    hotelConfirmationNumber: text(value['hotelConfirmationNumber'], 64) ?? null,
    hcnState: codeOrNull(value['hcnState']),
  };
}

// ───────────────────────── Estado de la orden ─────────────────────────

export type HotelOrderTone =
  | 'pending'
  | 'progress'
  | 'confirmed'
  | 'cancelled'
  | 'failed'
  | 'review';

export interface HotelOrderNotice {
  readonly title: string;
  readonly detail: string;
}

export interface HotelOrderStateView {
  /** El rótulo del estado, en la lista y en el detalle. */
  readonly label: string;
  readonly tone: HotelOrderTone;
  /** Un segundo rótulo al lado: la orden está confirmada pero algo sigue abierto. */
  readonly flag?: string;
  /** Qué está pasando, para el detalle, cuando el rótulo solo no alcanza. */
  readonly notice?: HotelOrderNotice;
  /** Hay una cancelación pedida que no terminó: no se ofrece otra ni el voucher. */
  readonly cancelInProgress: boolean;
}

const NO_REPEAT = 'No la repitas.';

const VERIFYING: HotelOrderNotice = {
  title: 'Verificando con el proveedor',
  detail: `No recibimos la confirmación a tiempo, así que le preguntamos al proveedor si la reserva quedó hecha. El estado final aparece acá solo. ${NO_REPEAT}`,
};

const CANCELLING: HotelOrderNotice = {
  title: 'Cancelación en curso',
  detail:
    'El proveedor aceptó la cancelación y la está procesando con el hotel. La reserva pasa a Cancelada cuando el proveedor lo confirme: no la vuelvas a cancelar.',
};

const CANCEL_REQUESTED: HotelOrderNotice = {
  title: 'Cancelación en curso',
  detail:
    'El pedido de cancelación está en proceso con el proveedor. El estado final aparece acá solo: no la vuelvas a cancelar.',
};

const CANCEL_UNVERIFIED: HotelOrderNotice = {
  title: 'Cancelación sin confirmar',
  detail:
    'El proveedor no confirmó si aplicó la cancelación. La estamos verificando con él (a los 2 minutos, 15 minutos, 1 hora, 6 horas y 24 horas) y el equipo la revisa si no se aclara: no la vuelvas a cancelar.',
};

const IN_REVIEW: HotelOrderNotice = {
  title: 'En revisión',
  detail:
    'El proveedor informó un estado que no reconocemos. El equipo la revisa; mientras tanto no hagas cambios en la reserva.',
};

/**
 * El estado de una orden de hotel como lo ve el vendedor (D-TBO-25 A). `orders.status` conserva su
 * vocabulario y el subestado dice en qué está una orden `pending`: confirmando, verificando o
 * cancelándose. Nunca "Fallida" para un desenlace incierto (U-14).
 */
export function hotelOrderStateOf(
  order: Pick<HotelOrderInput, 'status' | 'errorMessage' | 'providerTracking'>,
): HotelOrderStateView {
  const tracking = parseHotelTracking(order.providerTracking);
  const sub = tracking?.subStatus ?? null;
  const cancelInProgress = cancellationInProgress(tracking);
  const base = { cancelInProgress };

  switch (order.status) {
    case 'failed': {
      const detail = text(order.errorMessage, 1_000);
      return {
        ...base,
        label: 'Fallida',
        tone: 'failed',
        notice: {
          title: 'La reserva no se hizo',
          detail: detail ?? 'El proveedor no confirmó la reserva.',
        },
      };
    }
    case 'cancelled':
      return tracking?.refundAwaited
        ? {
            ...base,
            label: 'Cancelada',
            tone: 'cancelled',
            notice: {
              title: 'Cancelada, con el reembolso del proveedor pendiente',
              detail:
                'El proveedor la canceló y todavía tiene pendiente el reembolso a la cuenta. No hace falta hacer nada: la conciliación diaria lo sigue.',
            },
          }
        : { ...base, label: 'Cancelada', tone: 'cancelled' };
    case 'confirmed':
    case 'ticketed':
      if (cancelInProgress) {
        return { ...base, label: 'Cancelación en curso', tone: 'progress', notice: CANCELLING };
      }
      if (sub === 'unverified-read') {
        return {
          ...base,
          label: 'Confirmada',
          tone: 'confirmed',
          flag: 'Verificando',
          notice: {
            title: 'Verificando con el proveedor',
            detail:
              'El proveedor confirmó la reserva, pero todavía no pudimos leerla de vuelta. La estamos verificando; no hace falta hacer nada.',
          },
        };
      }
      if (sub === 'unknown') {
        return {
          ...base,
          label: 'Confirmada',
          tone: 'confirmed',
          flag: 'En revisión',
          notice: IN_REVIEW,
        };
      }
      return { ...base, label: 'Confirmada', tone: 'confirmed' };
    default:
      break;
  }

  // `pending`: el subestado dice en qué está.
  if (sub === 'cancel-requested') {
    return { ...base, label: 'Cancelación en curso', tone: 'progress', notice: CANCEL_REQUESTED };
  }
  if (sub === 'cancel-unverified') {
    return { ...base, label: 'Cancelación en curso', tone: 'progress', notice: CANCEL_UNVERIFIED };
  }
  if (cancelInProgress) {
    return { ...base, label: 'Cancelación en curso', tone: 'progress', notice: CANCELLING };
  }
  if (sub === 'create-uncertain') {
    return { ...base, label: 'Verificando', tone: 'progress', notice: VERIFYING };
  }
  if (sub === 'create-not-found-yet') {
    return {
      ...base,
      label: 'Verificando',
      tone: 'review',
      notice: {
        title: 'El proveedor todavía no muestra la reserva',
        detail: `La seguimos verificando y el equipo la revisa. ${NO_REPEAT} El estado final aparece acá.`,
      },
    };
  }
  if (sub === 'create-pending') {
    return {
      ...base,
      label: 'Confirmando',
      tone: 'progress',
      notice: {
        title: 'Confirmando con el proveedor',
        detail: `El pedido de reserva está en curso con el proveedor. ${NO_REPEAT}`,
      },
    };
  }
  if (sub === 'unknown') {
    return { ...base, label: 'En revisión', tone: 'review', notice: IN_REVIEW };
  }
  return { ...base, label: 'Pendiente', tone: 'pending' };
}

// ───────────────────────── Estado en el proveedor ─────────────────────────

/** Los valores del enum de TBO (docs/tbo/04 §6.1) y `unknown`, que es como sale uno que no está. */
const PROVIDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  Confirmed: 'Confirmada',
  Vouchered: 'Confirmada, con voucher emitido',
  CancellationInProgress: 'Cancelación en proceso',
  CancelPending: 'Cancelación pendiente',
  CxlRequestSentToHotel: 'Cancelación enviada al hotel',
  CancelledAndRefundAwaited: 'Cancelada, con reembolso pendiente',
  Cancelled: 'Cancelada',
  unknown: 'Estado que no reconocemos',
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  book: 'al reservar',
  verify: 'en la verificación automática',
  retrieve: 'en una consulta',
  cancel: 'al cancelar',
  hcn: 'en el seguimiento del número del hotel',
  reconciliation: 'en la conciliación diaria',
};

export interface ProviderStatusView {
  /** En el idioma del vendedor. */
  readonly label: string;
  /**
   * El código del proveedor tal cual: es lo que ve en su extranet quien certifica la integración
   * (U-17, U-20) y lo que se le cita a soporte.
   */
  readonly code: string;
  /** Cuándo y dónde se leyó: "26 sep 2026, 14:05 · en la conciliación diaria". */
  readonly seen?: string;
}

/** Fecha y hora de una lectura en la zona del navegador ("26 sep 2026, 14:05"). */
export function formatReadAt(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('es', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone === undefined ? {} : { timeZone }),
  })
    .format(date)
    .replace(/\./g, '');
}

export function providerStatusViewOf(
  tracking: HotelOrderTracking | null,
  timeZone?: string,
): ProviderStatusView | undefined {
  const code = tracking?.providerStatus;
  if (!code) return undefined;
  const when = tracking.providerStatusAt ? formatReadAt(tracking.providerStatusAt, timeZone) : '';
  const where = tracking.providerStatusSource
    ? (SOURCE_LABELS[tracking.providerStatusSource] ?? '')
    : '';
  const seen = [when, where].filter(Boolean).join(' · ');
  return {
    label: PROVIDER_STATUS_LABELS[code] ?? code,
    code,
    ...(seen ? { seen } : {}),
  };
}

/** Estados de cancelación del proveedor, para quien necesite distinguirlos del resto. */
export function isProviderCancelling(code: string | null | undefined): boolean {
  return typeof code === 'string' && PROVIDER_CANCELLING_STATUSES.has(code);
}

// ───────────────────────── HCN (RF-27) ─────────────────────────

export interface HcnView {
  /** El número, si llegó. */
  readonly value?: string;
  /** El número, "Pendiente" o "No disponible". */
  readonly label: string;
  readonly detail?: string;
}

const HCN_PENDING_DETAIL: Readonly<Record<string, string>> = {
  'out-of-window':
    'El hotel lo asigna más cerca de la fecha de entrada. Lo consultamos solos y aparece acá.',
  scheduled: 'Lo consultamos solos al proveedor y aparece acá cuando el hotel lo asigna.',
  missing:
    'El hotel todavía no lo asignó y ya pasó el plazo: el equipo de operaciones lo está pidiendo.',
};

/**
 * El número de confirmación del hotel (HCN). No es el localizador del proveedor: lo asigna el
 * hotel, llega más tarde y es el que pide la recepción (U-15: "pendiente" hasta que llega). Sólo
 * existe para una reserva hecha: `undefined` para una fallida o que todavía se está confirmando.
 */
export function hcnViewOf(
  order: Pick<HotelOrderInput, 'status' | 'pnr' | 'providerTracking'>,
): HcnView | undefined {
  const tracking = parseHotelTracking(order.providerTracking);
  const hcn = tracking?.hotelConfirmationNumber;
  if (hcn) return { value: hcn, label: hcn };
  if (!text(order.pnr, 64)) return undefined;
  if (order.status === 'failed') return undefined;
  if (order.status === 'pending' && !cancellationInProgress(tracking)) return undefined;
  if (order.status === 'cancelled' || tracking?.hcnState === 'stopped') {
    return {
      label: 'No disponible',
      detail:
        order.status === 'cancelled'
          ? 'La reserva se canceló antes de que el hotel lo asignara.'
          : 'El seguimiento terminó: ya pasó la fecha de entrada.',
    };
  }
  const detail =
    (tracking?.hcnState ? HCN_PENDING_DETAIL[tracking.hcnState] : undefined) ??
    HCN_PENDING_DETAIL['scheduled'];
  return { label: 'Pendiente', ...(detail ? { detail } : {}) };
}

// ───────────────────────── Estadía, habitaciones y huéspedes ─────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface RoomOccupancy {
  readonly adults: number;
  readonly childrenAges: readonly number[];
}

function occupanciesOf(searchCriteria: unknown): RoomOccupancy[] {
  const rooms = recordOf(searchCriteria)['rooms'];
  if (!Array.isArray(rooms)) return [];
  return rooms.map((room) => {
    const r = recordOf(room);
    const adults = typeof r['adults'] === 'number' && r['adults'] >= 0 ? r['adults'] : 0;
    const ages = Array.isArray(r['childrenAges'])
      ? r['childrenAges'].filter((a): a is number => typeof a === 'number' && a >= 0)
      : [];
    return { adults, childrenAges: ages };
  });
}

function dateOf(order: Pick<HotelOrderInput, 'searchCriteria' | 'selectedOffer'>, key: string) {
  const fromCriteria = recordOf(order.searchCriteria)[key];
  const value =
    typeof fromCriteria === 'string' ? fromCriteria : recordOf(order.selectedOffer)[key];
  return typeof value === 'string' && DATE_RE.test(value) ? value : undefined;
}

export interface HotelStayView {
  readonly checkinDate: string;
  readonly checkoutDate: string;
  /** "12 oct 2026". */
  readonly checkinLabel: string;
  readonly checkoutLabel: string;
  /** "12 oct 2026 → 15 oct 2026". */
  readonly dates: string;
  readonly nights: number;
  readonly rooms: number;
  /** "3 noches · 2 habitaciones · 3 adultos · 1 niño". */
  readonly summary: string;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function hotelStayOf(
  order: Pick<HotelOrderInput, 'searchCriteria' | 'selectedOffer'>,
): HotelStayView | undefined {
  const checkinDate = dateOf(order, 'checkinDate');
  const checkoutDate = dateOf(order, 'checkoutDate');
  if (checkinDate === undefined || checkoutDate === undefined) return undefined;
  const nights = stayNights({ checkinDate, checkoutDate });
  const occupancies = occupanciesOf(order.searchCriteria);
  const adults = occupancies.reduce((n, r) => n + r.adults, 0);
  const children = occupancies.reduce((n, r) => n + r.childrenAges.length, 0);
  const parts = [plural(nights, 'noche', 'noches')];
  if (occupancies.length > 0) {
    parts.push(plural(occupancies.length, 'habitación', 'habitaciones'));
    parts.push(plural(adults, 'adulto', 'adultos'));
    if (children > 0) parts.push(plural(children, 'niño', 'niños'));
  }
  const checkinLabel = formatStayDate(checkinDate);
  const checkoutLabel = formatStayDate(checkoutDate);
  return {
    checkinDate,
    checkoutDate,
    checkinLabel,
    checkoutLabel,
    dates: `${checkinLabel} → ${checkoutLabel}`,
    nights,
    rooms: occupancies.length,
    summary: parts.join(' · '),
  };
}

export interface HotelGuestView {
  /** "Sr. Juan Pérez", como lo escribió el vendedor. */
  readonly name: string;
  readonly type: string;
  /**
   * Como figura en el hotel cuando no es como se escribió: el proveedor recibe los nombres en ASCII
   * (D-TBO-23 A), y es con ése que el huésped se presenta en la recepción.
   */
  readonly registeredAs?: string;
}

export interface HotelRoomView {
  /** Base 1, en el orden de la búsqueda. */
  readonly number: number;
  readonly name: string;
  /** "2 adultos · 1 niño (7 años)". */
  readonly occupancy?: string;
  readonly guests: readonly HotelGuestView[];
}

const TITLE_LABELS: Readonly<Record<string, string>> = { Mr: 'Sr.', Mrs: 'Sra.', Ms: 'Srta.' };
const PAX_LABELS: Readonly<Record<string, string>> = { ADT: 'Adulto', CHD: 'Niño' };

function occupancyText(o: RoomOccupancy): string {
  const parts = [plural(o.adults, 'adulto', 'adultos')];
  if (o.childrenAges.length > 0) {
    const ages = o.childrenAges.map((a) => plural(a, 'año', 'años')).join(', ');
    parts.push(`${plural(o.childrenAges.length, 'niño', 'niños')} (${ages})`);
  }
  return parts.join(' · ');
}

function fullName(first: unknown, last: unknown): string | undefined {
  const name = [text(first, 100), text(last, 100)].filter(Boolean).join(' ');
  return name.length > 0 ? name : undefined;
}

/** Mayúsculas no hacen otro nombre; un acento sí, porque así figura en la reserva del hotel. */
function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, 'es', { sensitivity: 'accent' }) === 0;
}

function guestOf(value: unknown): HotelGuestView | undefined {
  const g = recordOf(value);
  const typed = fullName(g['firstName'], g['lastName']);
  if (typed === undefined) return undefined;
  const title = typeof g['title'] === 'string' ? TITLE_LABELS[g['title']] : undefined;
  const sent = recordOf(g['sent']);
  const registered = fullName(sent['firstName'], sent['lastName']);
  const paxType = typeof g['paxType'] === 'string' ? g['paxType'] : '';
  return {
    name: title ? `${title} ${typed}` : typed,
    type: PAX_LABELS[paxType] ?? 'Huésped',
    ...(registered !== undefined && !sameName(registered, typed)
      ? { registeredAs: registered }
      : {}),
  };
}

function guestsByRoom(passengers: unknown): Map<number, HotelGuestView[]> {
  const out = new Map<number, HotelGuestView[]>();
  if (!Array.isArray(passengers)) return out;
  passengers.forEach((entry, index) => {
    const room = recordOf(entry);
    const at = typeof room['room'] === 'number' && room['room'] >= 0 ? room['room'] : index;
    const guests = Array.isArray(room['guests'])
      ? room['guests'].flatMap((g) => {
          const guest = guestOf(g);
          return guest === undefined ? [] : [guest];
        })
      : [];
    out.set(at, [...(out.get(at) ?? []), ...guests]);
  });
  return out;
}

/** La tarifa guardada, sólo si se puede leer entera: sin ella no hay política ni cargos. */
export function hotelPackOf(
  order: Pick<HotelOrderInput, 'selectedOffer'>,
): HotelRoompack | undefined {
  const pack = recordOf(order.selectedOffer)['roompack'];
  if (!isRecord(pack)) return undefined;
  const rooms = pack['rooms'];
  const cancellation = pack['cancellation'];
  const price = pack['price'];
  const total = isRecord(price) ? price['total'] : undefined;
  const ok =
    typeof pack['board'] === 'string' &&
    Array.isArray(rooms) &&
    rooms.length > 0 &&
    rooms.every((r) => isRecord(r) && typeof r['name'] === 'string') &&
    isRecord(cancellation) &&
    typeof cancellation['refundable'] === 'boolean' &&
    typeof cancellation['status'] === 'string' &&
    Array.isArray(cancellation['rules']) &&
    isRecord(total) &&
    typeof total['amountMinor'] === 'number' &&
    typeof total['currency'] === 'string';
  return ok ? (pack as unknown as HotelRoompack) : undefined;
}

/** Una habitación por cada una de la búsqueda, con su nombre en la tarifa y sus huéspedes. */
export function hotelRoomsOf(
  order: Pick<HotelOrderInput, 'searchCriteria' | 'selectedOffer' | 'passengers'>,
): HotelRoomView[] {
  const occupancies = occupanciesOf(order.searchCriteria);
  const packRooms = hotelPackOf(order)?.rooms ?? [];
  const guests = guestsByRoom(order.passengers);
  const count = Math.max(occupancies.length, packRooms.length, guests.size);
  return Array.from({ length: count }, (_, i) => {
    const occupancy = occupancies[i];
    return {
      number: i + 1,
      name: text(packRooms[i]?.name, 500) ?? 'Habitación',
      ...(occupancy === undefined ? {} : { occupancy: occupancyText(occupancy) }),
      guests: guests.get(i) ?? [],
    };
  });
}

/** El huésped titular: el primero de la primera habitación. */
export function leadGuestOf(order: Pick<HotelOrderInput, 'passengers'>): string | undefined {
  const first = [...guestsByRoom(order.passengers).entries()].sort(([a], [b]) => a - b)[0];
  const guest = first?.[1][0];
  return guest?.name.replace(/^(Sr\.|Sra\.|Srta\.)\s/, '');
}

const CATEGORIES: ReadonlySet<string> = new Set<HotelRateConditionCategory>([
  'checkIn',
  'checkOut',
  'minCheckInAge',
  'mandatoryFees',
  'optionalFees',
  'cardsAccepted',
  'specialInstructions',
  'other',
]);

/**
 * Las condiciones del hotel que la orden guardó del PreBook, en su versión saneada (texto plano).
 * La original (`raw`) queda para disputas y nunca se pinta (RF-16).
 */
export function hotelConditionsOf(
  order: Pick<HotelOrderInput, 'selectedOffer'>,
): HotelPrebookCondition[] {
  const list = recordOf(order.selectedOffer)['rateConditions'];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const c = recordOf(item);
    const body = typeof c['text'] === 'string' ? c['text'] : undefined;
    if (body === undefined || body.trim().length === 0) return [];
    const category = c['category'];
    return [
      {
        category:
          typeof category === 'string' && CATEGORIES.has(category)
            ? (category as HotelRateConditionCategory)
            : 'other',
        text: body,
      },
    ];
  });
}

// ───────────────────────── No reembolsable (pedido del 2026-09-29, punto d) ─────────────────────────

export interface HotelOrderNonRefundable extends PrebookNonRefundable {
  /** Cuándo lo confirmó el vendedor al reservar ("26 sep 2026, 14:05"), si la orden lo guarda. */
  readonly acknowledgedAt?: string;
}

/**
 * Si la reserva es de una tarifa no reembolsable, con el 100 %: lo que la orden guardó al reservar
 * (`selected_offer.nonRefundable`: por qué, el monto, la política y quién y cuándo lo aceptó) o, en
 * una orden de antes, la política declarada no reembolsable con el total de la venta. `undefined`
 * si no lo es.
 */
export function hotelNonRefundableOf(
  order: Pick<HotelOrderInput, 'selectedOffer' | 'totalAmount' | 'currency'>,
  timeZone?: string,
): HotelOrderNonRefundable | undefined {
  const record = recordOf(order.selectedOffer)['nonRefundable'];
  const stored = parseNonRefundable(record);
  if (stored !== undefined) {
    const at = recordOf(record)['acknowledgedAt'];
    return typeof at === 'string' && Number.isFinite(Date.parse(at))
      ? { ...stored, acknowledgedAt: formatReadAt(at, timeZone) }
      : stored;
  }
  const c = hotelPackOf(order)?.cancellation;
  if (c === undefined || (c.refundable && c.status !== 'non_refundable')) return undefined;
  const penalty: Money = { amountMinor: order.totalAmount, currency: order.currency };
  return { reason: 'declared', penalty };
}

export interface GuestContactView {
  readonly email?: string;
  readonly phone?: string;
}

/** El contacto del huésped, que queda en la orden y no viaja al proveedor (D-TBO-23 A). */
export function guestContactOf(order: Pick<HotelOrderInput, 'contactInfo'>): GuestContactView {
  const c = recordOf(order.contactInfo);
  const email = text(c['email'], 254);
  const p = recordOf(c['phone']);
  const cc = text(p['countryCode'], 4);
  const number = text(p['number'], 20);
  const area = text(p['areaCode'], 6);
  const phone =
    number === undefined
      ? undefined
      : [cc ? (cc.startsWith('+') ? cc : `+${cc}`) : undefined, area, number]
          .filter(Boolean)
          .join(' ');
  return { ...(email ? { email } : {}), ...(phone ? { phone } : {}) };
}

const PROVIDER_CODE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HOTEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Con qué proveedor y qué id se pide la ficha del hotel de la orden. `undefined` si la orden no los
 * trae en una forma que la ruta de la ficha acepte: entonces no se pide nada.
 */
export function hotelRefOf(
  order: Pick<HotelOrderInput, 'provider' | 'searchCriteria' | 'selectedOffer'>,
): { readonly provider: string; readonly hotelId: string } | undefined {
  const provider = order.provider;
  const fromCriteria = recordOf(order.searchCriteria)['hotelId'];
  const hotelId =
    typeof fromCriteria === 'string' ? fromCriteria : recordOf(order.selectedOffer)['hotelId'];
  if (typeof provider !== 'string' || !PROVIDER_CODE_RE.test(provider)) return undefined;
  if (typeof hotelId !== 'string' || !HOTEL_ID_RE.test(hotelId)) return undefined;
  return { provider, hotelId };
}

// ───────────────────────── La fila de la lista ─────────────────────────

export interface HotelOrderRowView {
  /** "Hotel · 12 oct 2026 → 15 oct 2026". */
  readonly title: string;
  /** "3 noches · 2 habitaciones · Juan Pérez". */
  readonly detail: string;
  /** En minúsculas: número, localizador, HCN, huéspedes y fechas. */
  readonly searchText: string;
}

export function hotelOrderRowOf(order: HotelOrderInput): HotelOrderRowView {
  const stay = hotelStayOf(order);
  const lead = leadGuestOf(order);
  const guests = hotelRoomsOf(order).flatMap((r) =>
    r.guests.flatMap((g) => [g.name, g.registeredAs ?? '']),
  );
  const hcn = parseHotelTracking(order.providerTracking)?.hotelConfirmationNumber ?? '';
  const detail = [
    stay ? plural(stay.nights, 'noche', 'noches') : undefined,
    stay && stay.rooms > 0 ? plural(stay.rooms, 'habitación', 'habitaciones') : undefined,
    lead,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    title: stay ? `Hotel · ${stay.dates}` : 'Hotel',
    detail,
    searchText: [
      String(order.orderNumber),
      order.pnr ?? '',
      hcn,
      stay?.dates ?? '',
      stay?.checkinDate ?? '',
      ...guests,
    ]
      .join(' ')
      .toLowerCase(),
  };
}

/**
 * El voucher existe para una reserva confirmada con localizador. Una que se está verificando o
 * cancelando no tiene un documento que darle al huésped todavía.
 */
export function hotelVoucherAvailable(
  order: Pick<HotelOrderInput, 'status' | 'pnr' | 'providerTracking'>,
): boolean {
  return (
    (order.status === 'confirmed' || order.status === 'ticketed') &&
    text(order.pnr, 64) !== undefined &&
    !cancellationInProgress(parseHotelTracking(order.providerTracking))
  );
}

// ───────────────────────── "Actualizar estado" (U-16) ─────────────────────────

export type HotelReadResult =
  | { readonly ok: true; readonly message: string; readonly tracking: HotelOrderTracking | null }
  | { readonly ok: false; readonly message: string };

const READ_FAILED =
  'No pudimos consultar al proveedor en este momento. Probá de nuevo en unos minutos.';

/**
 * Lo que respondió `POST /orders/:id/retrieve` para una orden de hotel. Una consulta manual lee la
 * reserva en el proveedor y actualiza el seguimiento, pero nunca cambia el estado de la orden: eso
 * es de la cancelación y la conciliación.
 */
export function hotelReadResultOf(status: number, body: unknown): HotelReadResult {
  const b = recordOf(body);
  if (status < 200 || status >= 300) {
    const message = text(b['error'], 1_000) ?? text(b['message'], 1_000);
    return { ok: false, message: status >= 500 || message === undefined ? READ_FAILED : message };
  }
  if (b['vertical'] !== 'hotels' || typeof b['found'] !== 'boolean') {
    return { ok: false, message: 'La respuesta del proveedor llegó incompleta.' };
  }
  const tracking = parseHotelTracking(b['tracking']);
  if (!b['found']) {
    return {
      ok: true,
      tracking,
      message:
        'El proveedor no encuentra la reserva por su localizador. Ya quedó registrado para revisarla: no la vuelvas a reservar.',
    };
  }
  const code = codeOrNull(b['providerStatus']);
  const hcn = text(b['hotelConfirmationNumber'], 64);
  const label = code ? (PROVIDER_STATUS_LABELS[code] ?? code) : undefined;
  const parts = [
    label ? `El proveedor la informa como «${label}».` : 'El proveedor encontró la reserva.',
    hcn ? `Número de confirmación del hotel: ${hcn}.` : undefined,
  ];
  return { ok: true, tracking, message: parts.filter(Boolean).join(' ') };
}
