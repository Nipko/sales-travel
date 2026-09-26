import type { Money } from '@sales-travel/canonical';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import type { HotelBookingView, HotelRateCondition, HotelRateSignal } from '@sales-travel/domain';
import { isTboConfirmationNumber } from '../booking/booking-reference';
import { TboResponseMappingError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { toList } from '../internal/coerce';
import { toMinorUnits } from '../internal/decimal';
import { parseTboResponseDate } from '../internal/tbo-date';
import { MAX_ISSUE_REFS, zodIssueRefs } from '../internal/zod-issues';
import { readTboRateConditions } from '../prebook/rate-conditions';
import { TBO_HOTELS_PROVIDER_CODE } from '../provider-code';
import { pickTboLogMeta } from '../redaction';
import { tboDecimalText } from '../roompack/roompack.mapper';
import { normalizeTboStars } from '../static/normalize';
import { readTboBookingStatus } from './booking-status';
import {
  TBO_BOOKED_HOTEL_KEYS,
  TBO_BOOKED_ROOM_KEYS,
  TBO_BOOKING_DETAIL_KEYS,
  TBO_BOOKING_DETAIL_ROOT_KEYS,
  TboBookedHotelSchema,
  TboBookedRoomSchema,
  TboBookingDetailSchema,
  type TboBookedHotelDetails,
  type TboBookedRoom,
  type TboBookingDetail,
  type TboBookingDetailEnvelope,
} from './response.schema';

/**
 * Respuesta de `BookingDetail` → vista neutral de la reserva y resumen para la post-venta
 * (docs/tbo/04 §3 y §6.3; 08 RF-24, RF-26; D-TBO-24 A).
 *
 * - **El estado lo decide `./booking-status`**: `Vouchered` es `Confirmed`, `CancelledAndRefundAwaited`
 *   es cancelada con reembolso pendiente y lo desconocido es `UNKNOWN` con aviso, sin adivinar.
 * - **La reserva tiene que ser la pedida.** Leída por localizador, un `ConfirmationNumber` distinto
 *   es otra reserva y la respuesta es ilegible; leída por nuestra referencia, el localizador que
 *   vuelve es el que la orden adopta, así que tiene que tener forma de uno.
 * - **Nada de los huéspedes sale de aquí** (RF-24 CA-3): el esquema no declara `CustomerDetails` y
 *   Zod los descarta; este archivo ni siquiera nombra sus campos.
 * - **Montos como literal decimal** (`TotalFare` de p. 49 llega como `107.14000000000000`), y el
 *   total de la reserva sólo si todas las habitaciones están en la misma moneda y se pueden leer:
 *   BookingDetail no trae total a nivel de reserva (04 §3.5).
 * - **`BookingDate` es informativo** (PV-03): uno roto, como el del ejemplo, se cuenta y queda vacío.
 *   La fecha de reserva la da el intent.
 * - **`RateConditions` saneadas** con el mismo algoritmo que PreBook (el voucher las muestra), en la
 *   reserva y en cada habitación, porque la tabla es plana (PV-06).
 * - **El voucher se lee por partes** (RF-24, esquema tolerante): el hotel, cada habitación y cada
 *   norma que no se pueden leer se descartan con `ruta:código` en `diagnostics.unreadable` y el aviso
 *   `DETAIL_PARTIALLY_UNREADABLE`. El estado y el localizador se leen igual: una estrella numérica o
 *   una norma `null` no pueden dejar sin verificar un Book incierto (p. 42). Con una habitación
 *   descartada no hay total: sumar las que quedan daría un importe falso.
 *
 * Lanza `TboResponseMappingError` con `ruta:código`, nunca con valores.
 */

const DETAIL_PATH = TBO_OPERATIONS.bookingDetail.path;
const OP = 'bookingDetail';
const MAX_UNKNOWN_KEYS = 20;
const UNKNOWN_KEY_MAX = 120;
const TEXT_MAX = 500;
const HCN_MAX = 64;

/** Con qué se pidió la reserva: la lectura se valida contra eso. */
export type TboBookingLookup =
  | { readonly confirmationNumber: string; readonly bookingReferenceId?: never }
  | { readonly bookingReferenceId: string; readonly confirmationNumber?: never };

export interface TboBookingDetailMapContext {
  readonly lookup: TboBookingLookup;
  readonly requestId?: string;
}

export interface TboBookingDetailMapDeps {
  readonly metrics?: MetricsPort;
  readonly logger?: LoggerPort;
}

/** Avisos de la vista, como códigos cerrados: nunca texto del proveedor. */
export const TBO_BOOKING_DETAIL_WARNINGS = [
  /** `BookingStatus` fuera del enum: escalar sin cambiar el estado (04 §6.3). */
  'BOOKING_STATUS_UNKNOWN',
  /** Confirmada con `VoucherStatus` `false` o `"Confirm"`: el Book sólo emite voucher (PV-02). */
  'VOUCHER_NOT_ISSUED',
  /** `VoucherStatus` con un valor que no es ninguno de los documentados. */
  'VOUCHER_STATUS_UNKNOWN',
  /** `CheckIn` o `CheckOut` sin forma de fecha: no se pueden comparar con lo reservado. */
  'STAY_DATES_UNREADABLE',
  /** Parte del voucher (hotel, habitación o norma) descartada por ilegible: el estado sí se leyó. */
  'DETAIL_PARTIALLY_UNREADABLE',
] as const;
export type TboBookingDetailWarning = (typeof TBO_BOOKING_DETAIL_WARNINGS)[number];

export type TboVoucherStatus = 'VOUCHERED' | 'NOT_VOUCHERED' | 'UNKNOWN';

export interface TboBookedRoomSummary {
  readonly currency?: string;
  readonly names: readonly string[];
  /** `TotalFare` de la habitación como literal decimal. */
  readonly totalFare?: string;
  readonly totalTax?: string;
  /** Enum abierto de TBO, tal cual (PV-11). */
  readonly mealType?: string;
  readonly inclusion?: string;
  readonly isRefundable?: boolean;
}

export interface TboBookedHotel {
  readonly name?: string;
  /**
   * Estrellas 1-5 (medias incluidas), normalizadas como en el catálogo (RF-32: `"ThreeStar"` y `3`
   * son 3). Sin clasificación o con un valor que no es del enum, ausente.
   */
  readonly stars?: number;
  readonly addressLine1?: string;
  readonly addressLine2?: string;
  /** `latitud|longitud`, tal como llega (p. 49). */
  readonly map?: string;
  readonly city?: string;
}

/** Lo que la post-venta guarda y muestra. Sin huéspedes. */
export interface TboBookingDetailSummary {
  readonly confirmationNumber: string;
  readonly providerStatus: string;
  readonly voucherStatus?: TboVoucherStatus;
  readonly hotelConfirmationNumber?: string;
  /** Número de factura de TBO, para la conciliación financiera (04 §3.3). */
  readonly invoiceNumber?: string;
  /** `YYYY-MM-DD`. */
  readonly checkIn?: string;
  readonly checkOut?: string;
  readonly bookingDate?: string;
  readonly noOfRooms?: number;
  readonly hotel: TboBookedHotel;
  readonly rooms: readonly TboBookedRoomSummary[];
  /** Suma de `Rooms[].TotalFare`, sólo si todas se leen y comparten moneda. */
  readonly total?: Money;
  readonly rateConditions: readonly HotelRateCondition[];
  readonly signals: readonly HotelRateSignal[];
}

export interface TboBookingDetailDiagnostics {
  /** Nombres de claves que el esquema no conoce, con su ruta. Nunca valores. */
  readonly unknownKeys: readonly string[];
  readonly bookingStatusUnknown: boolean;
  readonly bookingStatusCasingVariant: boolean;
  readonly bookingDateMalformed: boolean;
  readonly amountsWithPrecisionLoss: number;
  /** Por qué no hay `total`, si no lo hay. */
  readonly totalUnavailable?:
    | 'NO_ROOMS'
    | 'ROOM_UNREADABLE'
    | 'CURRENCY_MISSING'
    | 'MIXED_CURRENCY'
    | 'AMOUNT_MISSING'
    | 'AMOUNT_INVALID';
  readonly emptyRateConditions: number;
  /** Partes del voucher descartadas por ilegibles, como `ruta:código`. Nunca valores. */
  readonly unreadable: readonly string[];
}

export interface TboBookingDetailMapping {
  readonly view: HotelBookingView;
  readonly detail: TboBookingDetailSummary;
  readonly diagnostics: TboBookingDetailDiagnostics;
}

// ───────────────────────── Piezas ─────────────────────────

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safely(run: () => void): void {
  try {
    run();
  } catch {
    // Se descarta a propósito: la observabilidad nunca cambia la lectura de una reserva.
  }
}

function collectUnknownKeys(
  value: unknown,
  known: readonly string[],
  prefix: string,
  into: Set<string>,
): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (known.includes(key) || into.size >= MAX_UNKNOWN_KEYS) continue;
    into.add(`${prefix}${key}`.slice(0, UNKNOWN_KEY_MAX));
  }
}

function clip(value: string | undefined, max = TEXT_MAX): string | undefined {
  return value === undefined ? undefined : value.slice(0, max);
}

function readVoucher(raw: unknown): TboVoucherStatus | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === true) return 'VOUCHERED';
  if (raw === false) return 'NOT_VOUCHERED';
  if (typeof raw !== 'string') return 'UNKNOWN';
  const value = raw.trim().toLowerCase();
  if (value === 'voucher' || value === 'vouchered' || value === 'true') return 'VOUCHERED';
  if (value === 'confirm' || value === 'confirmed' || value === 'false') return 'NOT_VOUCHERED';
  return 'UNKNOWN';
}

/** Sólo los textos de una lista (o el texto suelto). El resto se cuenta aparte, nunca se muestra. */
function textItems(value: unknown): { readonly items: string[]; readonly dropped: number } {
  const list = toList(value) ?? [value];
  const items = list.filter((item): item is string => typeof item === 'string');
  return { items, dropped: list.length - items.length };
}

function roomNames(name: unknown): string[] {
  return textItems(name)
    .items.map((item) => item.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX))
    .filter((item) => item.length > 0);
}

/**
 * Las partes del voucher, cada una con su esquema: lo que no pasa se descarta con `ruta:código`
 * (sin valores) y no arrastra al estado de la reserva.
 */
interface VoucherParts {
  readonly hotel: TboBookedHotelDetails;
  readonly rooms: readonly TboBookedRoom[];
  readonly roomsUnreadable: number;
  readonly rateConditions: readonly string[];
  readonly unreadable: readonly string[];
}

function readVoucherParts(
  detail: Pick<TboBookingDetail, 'HotelDetails' | 'Rooms' | 'RateConditions'>,
): VoucherParts {
  const unreadable: string[] = [];
  const note = (issues: readonly string[]): void => {
    for (const issue of issues) if (unreadable.length < MAX_ISSUE_REFS) unreadable.push(issue);
  };

  let hotel: TboBookedHotelDetails = {};
  if (detail.HotelDetails !== undefined && detail.HotelDetails !== null) {
    const parsed = TboBookedHotelSchema.safeParse(detail.HotelDetails);
    if (parsed.success) hotel = parsed.data;
    else note(zodIssueRefs(parsed.error, 'BookingDetail.HotelDetails'));
  }

  const rateConditions: string[] = [];
  const readConditions = (value: unknown, at: string): void => {
    if (value === undefined || value === null) return;
    const { items, dropped } = textItems(value);
    rateConditions.push(...items);
    if (dropped > 0) note([`${at}:invalid_type`]);
  };
  readConditions(detail.RateConditions, 'BookingDetail.RateConditions');

  const rooms: TboBookedRoom[] = [];
  let roomsUnreadable = 0;
  const rawRooms = toList(detail.Rooms);
  if (rawRooms === undefined) {
    // Un escalar donde van las habitaciones: no se sabe cuántas hay ni cuánto cuestan.
    roomsUnreadable += 1;
    note(['BookingDetail.Rooms:invalid_type']);
  }
  for (const [index, raw] of (rawRooms ?? []).entries()) {
    const at = `BookingDetail.Rooms.${index}`;
    const parsed = TboBookedRoomSchema.safeParse(raw);
    if (!parsed.success) {
      roomsUnreadable += 1;
      note(zodIssueRefs(parsed.error, at));
      continue;
    }
    rooms.push(parsed.data);
    readConditions(parsed.data.RateConditions, `${at}.RateConditions`);
  }

  return { hotel, rooms, roomsUnreadable, rateConditions, unreadable };
}

function roomSummary(room: TboBookedRoom): TboBookedRoomSummary {
  return {
    ...(room.Currency === undefined ? {} : { currency: room.Currency }),
    names: roomNames(room.Name),
    ...(room.TotalFare === undefined || room.TotalFare === null
      ? {}
      : { totalFare: tboDecimalText(room.TotalFare) }),
    ...(room.TotalTax === undefined || room.TotalTax === null
      ? {}
      : { totalTax: tboDecimalText(room.TotalTax) }),
    ...(room.MealType === undefined ? {} : { mealType: clip(room.MealType, 64) }),
    ...(room.Inclusion === undefined ? {} : { inclusion: clip(room.Inclusion) }),
    ...(room.IsRefundable === undefined ? {} : { isRefundable: room.IsRefundable }),
  };
}

type TotalRead =
  | { readonly ok: true; readonly total: Money; readonly precisionLoss: number }
  | {
      readonly ok: false;
      readonly reason: NonNullable<TboBookingDetailDiagnostics['totalUnavailable']>;
    };

function readTotal(rooms: readonly TboBookedRoomSummary[], roomsUnreadable: number): TotalRead {
  if (roomsUnreadable > 0) return { ok: false, reason: 'ROOM_UNREADABLE' };
  if (rooms.length === 0) return { ok: false, reason: 'NO_ROOMS' };
  const currencies = new Set(rooms.map((room) => room.currency));
  const [currency] = [...currencies];
  if (currencies.size !== 1 || currency === undefined) {
    return { ok: false, reason: currencies.size !== 1 ? 'MIXED_CURRENCY' : 'CURRENCY_MISSING' };
  }
  let amountMinor = 0;
  let precisionLoss = 0;
  for (const room of rooms) {
    if (room.totalFare === undefined) return { ok: false, reason: 'AMOUNT_MISSING' };
    const minor = toMinorUnits(room.totalFare, currency);
    if (!minor.ok) return { ok: false, reason: 'AMOUNT_INVALID' };
    if (minor.precisionLoss) precisionLoss += 1;
    amountMinor += minor.amountMinor;
  }
  if (!Number.isSafeInteger(amountMinor)) return { ok: false, reason: 'AMOUNT_INVALID' };
  return { ok: true, total: { amountMinor, currency }, precisionLoss };
}

// ───────────────────────── Entrada ─────────────────────────

/**
 * Lee un BookingDetail ya aceptado por el cliente HTTP (`TboBookingDetailEnvelopeSchema` como
 * `responseSchema`, que fija que hay un `BookingDetail`).
 */
export function mapTboBookingDetailResponse(
  envelope: TboBookingDetailEnvelope,
  context: TboBookingDetailMapContext,
  deps: TboBookingDetailMapDeps = {},
): TboBookingDetailMapping {
  const { requestId } = context;
  const meta = {
    provider: TBO_HOTELS_PROVIDER_CODE,
    op: OP,
    ...(requestId === undefined ? {} : { requestId }),
  };
  const count = (name: string, tags: Record<string, string> = {}): void =>
    safely(() => deps.metrics?.counter(name, 1, { op: OP, ...tags }));
  const log = (level: 'debug' | 'warn', message: string, extra: Record<string, unknown>): void =>
    safely(() => deps.logger?.[level](message, pickTboLogMeta({ ...meta, ...extra })));

  const unknown = new Set<string>();
  const rawDetail = envelope.BookingDetail;
  collectUnknownKeys(envelope, TBO_BOOKING_DETAIL_ROOT_KEYS, '', unknown);
  collectUnknownKeys(envelope.Status, ['Code', 'Description'], 'Status.', unknown);
  collectUnknownKeys(rawDetail, TBO_BOOKING_DETAIL_KEYS, 'BookingDetail.', unknown);
  collectUnknownKeys(
    rawDetail['HotelDetails'],
    TBO_BOOKED_HOTEL_KEYS,
    'BookingDetail.HotelDetails.',
    unknown,
  );
  for (const room of toList(rawDetail['Rooms']) ?? []) {
    collectUnknownKeys(room, TBO_BOOKED_ROOM_KEYS, 'BookingDetail.Rooms[].', unknown);
  }
  const unknownKeys = [...unknown];
  // Una respuesta ilegible es justo la que más interesa: sus claves nuevas se reportan antes de
  // fallar.
  const flushUnknownKeys = (): void => {
    for (const key of unknownKeys) count('tbo.contract.unknown_key', { key });
    if (unknownKeys.length > 0) log('warn', 'tbo.booking_detail.unknown_keys', { unknownKeys });
  };
  const fail = (issues: readonly string[]): never => {
    flushUnknownKeys();
    throw new TboResponseMappingError(DETAIL_PATH, issues, requestId);
  };

  const code = envelope.Status?.Code;
  if (code !== undefined && code !== 200) return fail(['Status.Code:not_a_success_code']);

  const parsed = TboBookingDetailSchema.safeParse(rawDetail);
  if (!parsed.success) return fail(zodIssueRefs(parsed.error, 'BookingDetail'));
  const detail = parsed.data;

  const confirmationNumber = detail.ConfirmationNumber;
  if (!isTboConfirmationNumber(confirmationNumber)) {
    return fail(['BookingDetail.ConfirmationNumber:invalid_format']);
  }
  const requested = context.lookup.confirmationNumber;
  if (requested !== undefined && requested.toUpperCase() !== confirmationNumber.toUpperCase()) {
    return fail(['BookingDetail.ConfirmationNumber:not_the_requested_booking']);
  }
  flushUnknownKeys();

  const status = readTboBookingStatus(detail.BookingStatus);
  const voucherStatus = readVoucher(detail.VoucherStatus);
  const checkIn = parseTboResponseDate(detail.CheckIn);
  const checkOut = parseTboResponseDate(detail.CheckOut);
  const bookingDate = parseTboResponseDate(detail.BookingDate);
  const bookingDateMalformed = detail.BookingDate !== undefined && bookingDate === undefined;
  const parts = readVoucherParts(detail);
  const rooms = parts.rooms.map(roomSummary);
  const total = readTotal(rooms, parts.roomsUnreadable);
  const conditions = readTboRateConditions([...new Set(parts.rateConditions)]);

  const warnings: TboBookingDetailWarning[] = [];
  if (status.unknown) warnings.push('BOOKING_STATUS_UNKNOWN');
  if (status.status === 'CONFIRMED' && voucherStatus === 'NOT_VOUCHERED') {
    warnings.push('VOUCHER_NOT_ISSUED');
  }
  if (voucherStatus === 'UNKNOWN') warnings.push('VOUCHER_STATUS_UNKNOWN');
  if (checkIn === undefined || checkOut === undefined) warnings.push('STAY_DATES_UNREADABLE');
  if (parts.unreadable.length > 0) warnings.push('DETAIL_PARTIALLY_UNREADABLE');

  if (status.unknown) {
    count('tbo.booking_detail.status_unknown');
    log('warn', 'tbo.booking_detail.status_unknown', { providerStatus: status.providerStatus });
  }
  if (parts.unreadable.length > 0) {
    log('warn', 'tbo.booking_detail.partially_unreadable', { issues: parts.unreadable });
  }
  if (status.casingVariant) count('tbo.booking_detail.status_casing_variant');
  if (bookingDateMalformed) count('tbo.booking_detail.booking_date_malformed');
  for (const warning of warnings) count('tbo.booking_detail.warning', { warning });

  const hcn = clip(detail.HotelConfirmationNumber, HCN_MAX);
  const { hotel } = parts;
  const rating = hotel.Rating === undefined ? undefined : normalizeTboStars(hotel.Rating);
  const stars = rating?.stars ?? null;
  if (rating !== undefined && !rating.known) count('tbo.booking_detail.rating_unknown');
  const bookingReference = context.lookup.bookingReferenceId;
  const view: HotelBookingView = {
    found: true,
    providerBookingId: confirmationNumber,
    ...(bookingReference === undefined ? {} : { bookingReference }),
    status: status.status,
    providerStatus: status.providerStatus,
    ...(status.refundAwaited ? { refundAwaited: true } : {}),
    ...(hcn === undefined ? {} : { hotelConfirmationNumber: hcn }),
    warnings,
  };
  log('debug', 'tbo.booking_detail.mapped', {
    confirmationNumber,
    providerStatus: status.providerStatus,
  });

  return {
    view,
    detail: {
      confirmationNumber,
      providerStatus: status.providerStatus,
      ...(voucherStatus === undefined ? {} : { voucherStatus }),
      ...(hcn === undefined ? {} : { hotelConfirmationNumber: hcn }),
      ...(detail.InvoiceNumber === undefined
        ? {}
        : { invoiceNumber: clip(detail.InvoiceNumber, 64) }),
      ...(checkIn === undefined ? {} : { checkIn }),
      ...(checkOut === undefined ? {} : { checkOut }),
      ...(bookingDate === undefined ? {} : { bookingDate }),
      ...(detail.NoOfRooms === undefined ? {} : { noOfRooms: detail.NoOfRooms }),
      hotel: {
        ...(hotel.HotelName === undefined ? {} : { name: clip(hotel.HotelName) }),
        ...(stars === null ? {} : { stars }),
        ...(hotel.AddressLine1 === undefined ? {} : { addressLine1: clip(hotel.AddressLine1) }),
        ...(hotel.AddressLine2 === undefined ? {} : { addressLine2: clip(hotel.AddressLine2) }),
        ...(hotel.Map === undefined ? {} : { map: clip(hotel.Map, 64) }),
        ...(hotel.City === undefined ? {} : { city: clip(hotel.City) }),
      },
      rooms,
      ...(total.ok ? { total: total.total } : {}),
      rateConditions: conditions.conditions,
      signals: conditions.signals,
    },
    diagnostics: {
      unknownKeys,
      bookingStatusUnknown: status.unknown,
      bookingStatusCasingVariant: status.casingVariant,
      bookingDateMalformed,
      amountsWithPrecisionLoss: total.ok ? total.precisionLoss : 0,
      ...(total.ok ? {} : { totalUnavailable: total.reason }),
      emptyRateConditions: conditions.emptyItems,
      unreadable: parts.unreadable,
    },
  };
}
