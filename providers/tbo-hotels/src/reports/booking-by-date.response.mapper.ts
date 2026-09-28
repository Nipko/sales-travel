import type { Money } from '@sales-travel/canonical';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import type { HotelBookingStatus } from '@sales-travel/domain';
import { isTboConfirmationNumber } from '../booking/booking-reference';
import { readTboBookingStatus } from '../detail/booking-status';
import { TboResponseMappingError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { optionalString, toList } from '../internal/coerce';
import { toMinorUnits } from '../internal/decimal';
import { parseTboDayMonthNameDate } from '../internal/tbo-date';
import { MAX_ISSUE_REFS, zodIssueRefs } from '../internal/zod-issues';
import { TBO_HOTELS_PROVIDER_CODE } from '../provider-code';
import { pickTboLogMeta } from '../redaction';
import type { TboBookingDateWindow } from './booking-by-date.request.builder';
import {
  TBO_BOOKINGS_BY_DATE_ROOT_KEYS,
  TBO_BOOKING_BY_DATE_ROW_KEYS,
  TboBookingByDateRowSchema,
  type TboBookingByDateRow,
  type TboBookingsByDateEnvelope,
} from './booking-by-date.response.schema';

/**
 * Respuesta de `BookingDetailsbasedondate` → las reservas de la cuenta creadas en la ventana, en
 * vocabulario nuestro (docs/tbo/04 §5.4, §9.3 y §9.5; 08 RF-28).
 *
 * **La ventana vale entera o no vale.** De esta lectura sale "la reserva no está en TBO", que libera
 * un intent incierto (D-TBO-24 A), y esa conclusión sólo se puede sacar de una respuesta válida: un
 * `200`, filas que se leen y TODO `BookingDate` dentro de `[fromDate, toDate]`. Una sola fila fuera
 * de la ventana —el síntoma de un servidor que ignoró nuestras claves y aplicó otro rango (PV-25)—,
 * sin localizador o con una fecha ilegible, y se lanza `TboResponseMappingError`: la conciliación
 * descarta el tramo, nunca lo usa a medias.
 *
 * - **`ConfirmationNo` → `confirmationNumber`** (PV-29): el mismo nombre que en BookingDetail, para
 *   que el cruce no dependa de recordar la diferencia.
 * - **El estado lo decide `readTboBookingStatus`**, igual que en BookingDetail: `Vouchered` es
 *   `CONFIRMED` y lo desconocido es `UNKNOWN` con su valor como código (R7). Si no viene, queda
 *   ausente: la tabla no lo declara (PV-28) y toda divergencia se confirma con BookingDetail antes
 *   de actuar (PV-33).
 * - **Montos exactos** (PV-30): `BookingPrice` y `AgentMarkup` como `Money` con la puerta de
 *   decimales del paquete; lo ilegible queda ausente y se cuenta. Su relación con el neto del Book
 *   no está confirmada (PV-32, Q-89): aquí sólo se leen.
 * - **`ClientReferenceNumber`** es la clave con la que la conciliación encuentra un intent sin
 *   localizador (R1). Una fila sin ella legible NO se puede descartar como "no es nuestra": se cuenta
 *   en `clientReferenceMissing` para que la conciliación no concluya ausencias con esa ventana a
 *   ciegas.
 * - **`TripName` no se lee** (el esquema no lo declara) y `AgencyName` es dato comercial: nunca se
 *   loguea.
 */

const BY_DATE_PATH = TBO_OPERATIONS.bookingDetailsByDate.path;
const OP = 'bookingDetailsByDate';
const MAX_UNKNOWN_KEYS = 20;
const UNKNOWN_KEY_MAX = 120;
const AGENCY_NAME_MAX = 200;

/** Identificador opaco de TBO o de un cliente: ASCII visible y con techo. */
const OPAQUE_ID = /^[\x21-\x7E]{1,64}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;

/** Una reserva de la cuenta, creada dentro de la ventana pedida. Sin datos del huésped. */
export interface TboBookingByDate {
  /** `ConfirmationNo`: el localizador de TBO, clave primaria del cruce (04 §9.3). */
  readonly confirmationNumber: string;
  /** `BookingDate`, `YYYY-MM-DD`: siempre dentro de la ventana. */
  readonly bookingDate: string;
  /**
   * `ClientReferenceNumber`: el `ClientReferenceId` del Book, que para nosotros es la misma
   * `BookingReferenceId` (INFERIDO, PV-31; se verifica en certificación, Q-58).
   */
  readonly clientReferenceNumber?: string;
  /** `BookingId` de TBO, sólo para soporte: su semántica no está documentada (PV-31). */
  readonly bookingId?: string;
  /** Ausente si la fila no trae `BookingStatus` (PV-28). */
  readonly status?: HotelBookingStatus;
  /** Grafía del enum o el valor desconocido como código. */
  readonly providerStatus?: string;
  /** `CancelledAndRefundAwaited`: cancelada con el reembolso de TBO pendiente. */
  readonly refundAwaited?: boolean;
  /** `Currency` tal como llega, si tiene forma ISO 4217. */
  readonly currency?: string;
  /** "Booking Price including agency Commision" (p. 63). */
  readonly bookingPrice?: Money;
  /** "Amount which the agent has earned on the booking" (p. 63). */
  readonly agentMarkup?: Money;
  /** Agencia que hizo la reserva (p. 63). Dato comercial: con RLS del dueño de la cuenta. */
  readonly agencyName?: string;
  /** `TBOHotelCode`. */
  readonly hotelCode?: string;
  /** `CheckInDate` y `CheckOutDate`, `YYYY-MM-DD`. */
  readonly checkIn?: string;
  readonly checkOut?: string;
}

export interface TboBookingsByDateDiagnostics {
  /** Nombres de claves que el esquema no conoce, con su ruta. Nunca valores. */
  readonly unknownKeys: readonly string[];
  readonly rowsReceived: number;
  /** Filas sin `BookingStatus`. */
  readonly statusMissing: number;
  /** Filas con un `BookingStatus` fuera del enum (R7). */
  readonly statusUnknown: number;
  /** Filas sin `ClientReferenceNumber` legible: no se pueden descartar como ajenas. */
  readonly clientReferenceMissing: number;
  /** Montos que vinieron y no se pudieron leer (moneda ausente, no ISO o sin dos decimales). */
  readonly amountsUnreadable: number;
  readonly amountsWithPrecisionLoss: number;
  /** Filas con `CheckInDate` o `CheckOutDate` ausente o ilegible. */
  readonly stayDatesUnreadable: number;
  /** Localizadores que aparecen más de una vez en la misma respuesta. */
  readonly duplicateConfirmationNumbers: number;
}

export interface TboBookingsByDateMapping {
  readonly window: TboBookingDateWindow;
  readonly bookings: readonly TboBookingByDate[];
  readonly diagnostics: TboBookingsByDateDiagnostics;
}

export interface TboBookingsByDateMapContext {
  /** La ventana PEDIDA, ya validada por el builder. */
  readonly window: TboBookingDateWindow;
  readonly requestId?: string;
}

export interface TboBookingsByDateMapDeps {
  readonly metrics?: MetricsPort;
  readonly logger?: LoggerPort;
}

interface Counters {
  statusMissing: number;
  statusUnknown: number;
  clientReferenceMissing: number;
  amountsUnreadable: number;
  amountsWithPrecisionLoss: number;
  stayDatesUnreadable: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safely(run: () => void): void {
  try {
    run();
  } catch {
    // Se descarta a propósito: la observabilidad nunca cambia la lectura de una ventana.
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

/** Texto recortado; vacío es "no vino". */
function text(value: unknown): string | undefined {
  const raw = optionalString(value)?.trim();
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

function opaqueId(value: unknown): string | undefined {
  const raw = text(value);
  return raw !== undefined && OPAQUE_ID.test(raw) ? raw : undefined;
}

function isPresent(value: unknown): boolean {
  return (
    value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')
  );
}

function readAmount(
  value: unknown,
  currency: string | undefined,
  counters: Counters,
): Money | undefined {
  if (!isPresent(value)) return undefined;
  const minor = currency === undefined ? undefined : toMinorUnits(value, currency);
  if (currency === undefined || minor === undefined || !minor.ok) {
    counters.amountsUnreadable += 1;
    return undefined;
  }
  if (minor.precisionLoss) counters.amountsWithPrecisionLoss += 1;
  return { amountMinor: minor.amountMinor, currency };
}

function readRow(
  row: TboBookingByDateRow,
  bookingDate: string,
  counters: Counters,
): TboBookingByDate {
  const rawStatus = text(row.BookingStatus);
  const status = rawStatus === undefined ? undefined : readTboBookingStatus(rawStatus);
  if (status === undefined) counters.statusMissing += 1;
  else if (status.unknown) counters.statusUnknown += 1;

  const clientReferenceNumber = opaqueId(row.ClientReferenceNumber);
  if (clientReferenceNumber === undefined) counters.clientReferenceMissing += 1;

  const rawCurrency = text(row.Currency);
  const currency =
    rawCurrency !== undefined && ISO_CURRENCY.test(rawCurrency) ? rawCurrency : undefined;
  const bookingPrice = readAmount(row.BookingPrice, currency, counters);
  const agentMarkup = readAmount(row.AgentMarkup, currency, counters);

  const checkIn = parseTboDayMonthNameDate(text(row.CheckInDate));
  const checkOut = parseTboDayMonthNameDate(text(row.CheckOutDate));
  if (checkIn === undefined || checkOut === undefined) counters.stayDatesUnreadable += 1;

  const agencyName = text(row.AgencyName)?.replace(/\s+/g, ' ').slice(0, AGENCY_NAME_MAX);
  const bookingId = opaqueId(row.BookingId);
  const hotelCode = opaqueId(row.TBOHotelCode);

  return {
    confirmationNumber: row.ConfirmationNo,
    bookingDate,
    ...(clientReferenceNumber === undefined ? {} : { clientReferenceNumber }),
    ...(bookingId === undefined ? {} : { bookingId }),
    ...(status === undefined
      ? {}
      : {
          status: status.status,
          providerStatus: status.providerStatus,
          ...(status.refundAwaited ? { refundAwaited: true } : {}),
        }),
    ...(currency === undefined ? {} : { currency }),
    ...(bookingPrice === undefined ? {} : { bookingPrice }),
    ...(agentMarkup === undefined ? {} : { agentMarkup }),
    ...(agencyName === undefined ? {} : { agencyName }),
    ...(hotelCode === undefined ? {} : { hotelCode }),
    ...(checkIn === undefined ? {} : { checkIn }),
    ...(checkOut === undefined ? {} : { checkOut }),
  };
}

/**
 * Lee una ventana ya aceptada por el cliente HTTP (`TboBookingsByDateEnvelopeSchema` como
 * `responseSchema`). Lanza `TboResponseMappingError` con `ruta:código`, nunca con valores, si la
 * ventana no vale entera.
 */
export function mapTboBookingsByDateResponse(
  envelope: TboBookingsByDateEnvelope,
  context: TboBookingsByDateMapContext,
  deps: TboBookingsByDateMapDeps = {},
): TboBookingsByDateMapping {
  const { requestId, window } = context;
  const meta = {
    provider: TBO_HOTELS_PROVIDER_CODE,
    op: OP,
    fromDate: window.fromDate,
    toDate: window.toDate,
    ...(requestId === undefined ? {} : { requestId }),
  };
  const count = (name: string, value = 1, tags: Record<string, string> = {}): void =>
    safely(() => deps.metrics?.counter(name, value, { op: OP, ...tags }));
  const log = (level: 'debug' | 'warn', message: string, extra: Record<string, unknown>): void =>
    safely(() => deps.logger?.[level](message, pickTboLogMeta({ ...meta, ...extra })));

  const rows = toList(envelope.BookingDetail);
  const unknown = new Set<string>();
  collectUnknownKeys(envelope, TBO_BOOKINGS_BY_DATE_ROOT_KEYS, '', unknown);
  collectUnknownKeys(envelope.Status, ['Code', 'Description'], 'Status.', unknown);
  for (const row of rows ?? []) {
    collectUnknownKeys(row, TBO_BOOKING_BY_DATE_ROW_KEYS, 'BookingDetail[].', unknown);
  }
  const unknownKeys = [...unknown];
  for (const key of unknownKeys) count('tbo.contract.unknown_key', 1, { key });
  if (unknownKeys.length > 0) log('warn', 'tbo.bookings_by_date.unknown_keys', { unknownKeys });

  const fail = (issues: readonly string[]): never => {
    count('tbo.bookings_by_date.invalid_window');
    log('warn', 'tbo.bookings_by_date.invalid_window', { issues });
    throw new TboResponseMappingError(BY_DATE_PATH, issues.slice(0, MAX_ISSUE_REFS), requestId);
  };

  const code = envelope.Status?.Code;
  // Un código que no es 200 nunca es "no hay reservas" (PV-26); el cliente ya lo lanza.
  if (code !== undefined && code !== 200) return fail(['Status.Code:not_a_success_code']);
  if (rows === undefined) return fail(['BookingDetail:invalid_type']);

  const counters: Counters = {
    statusMissing: 0,
    statusUnknown: 0,
    clientReferenceMissing: 0,
    amountsUnreadable: 0,
    amountsWithPrecisionLoss: 0,
    stayDatesUnreadable: 0,
  };
  const issues: string[] = [];
  const bookings: TboBookingByDate[] = [];
  for (const [index, raw] of rows.entries()) {
    const at = `BookingDetail.${index}`;
    const parsed = TboBookingByDateRowSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push(...zodIssueRefs(parsed.error, at));
      continue;
    }
    const row = parsed.data;
    if (!isTboConfirmationNumber(row.ConfirmationNo)) {
      issues.push(`${at}.ConfirmationNo:invalid_format`);
      continue;
    }
    const bookingDate = parseTboDayMonthNameDate(row.BookingDate);
    if (bookingDate === undefined) {
      issues.push(`${at}.BookingDate:invalid_date`);
      continue;
    }
    // `YYYY-MM-DD` ordena como texto.
    if (bookingDate < window.fromDate || bookingDate > window.toDate) {
      issues.push(`${at}.BookingDate:outside_window`);
      continue;
    }
    bookings.push(readRow(row, bookingDate, counters));
  }
  if (issues.length > 0) return fail(issues);

  const seen = new Set<string>();
  let duplicateConfirmationNumbers = 0;
  for (const booking of bookings) {
    const key = booking.confirmationNumber.toUpperCase();
    if (seen.has(key)) duplicateConfirmationNumbers += 1;
    seen.add(key);
  }

  const diagnostics: TboBookingsByDateDiagnostics = {
    unknownKeys,
    rowsReceived: rows.length,
    ...counters,
    duplicateConfirmationNumbers,
  };
  if (counters.statusUnknown > 0)
    count('tbo.bookings_by_date.status_unknown', counters.statusUnknown);
  if (counters.clientReferenceMissing > 0) {
    count('tbo.bookings_by_date.client_reference_missing', counters.clientReferenceMissing);
  }
  if (counters.amountsUnreadable > 0) {
    count('tbo.bookings_by_date.amount_unreadable', counters.amountsUnreadable);
  }
  if (duplicateConfirmationNumbers > 0) {
    count('tbo.bookings_by_date.duplicate_confirmation', duplicateConfirmationNumbers);
  }
  log('debug', 'tbo.bookings_by_date.mapped', { bookingCount: bookings.length });
  return { window: { fromDate: window.fromDate, toDate: window.toDate }, bookings, diagnostics };
}
