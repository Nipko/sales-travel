import {
  HotelRoomOccupancySchema,
  type HotelRoomOccupancy,
  type HotelRoompack,
} from '@sales-travel/canonical';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import type { HotelPrebookResult, HotelRateSignal } from '@sales-travel/domain';
import { z } from 'zod';
import { TboResponseMappingError, TboUnsupportedCurrencyError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { zodIssueRefs } from '../internal/zod-issues';
import { TBO_HOTELS_PROVIDER_CODE } from '../provider-code';
import { pickTboLogMeta } from '../redaction';
import {
  mapTboRoompack,
  readTboHotelCurrency,
  type TboPackObserver,
  type TboSearchPackContext,
} from '../roompack/roompack.mapper';
import { tboOfferExpiresAt } from '../search/offer-window';
import { readTboRateConditions } from './rate-conditions';
import {
  TBO_PREBOOK_HOTEL_KEYS,
  TBO_PREBOOK_ROOM_KEYS,
  TBO_PREBOOK_ROOT_KEYS,
  TboPrebookHotelSchema,
  type TboPrebookEnvelope,
} from './response.schema';

/**
 * Respuesta de PreBook → resultado neutral del puerto y contexto para el Book (docs/tbo/03 §2;
 * 08 RF-15, RF-16 y RF-17).
 *
 * - **Una sola unidad reservable** (03 §2.2): exactamente un `HotelResult`, con el `HotelCode` del
 *   contexto del servidor, y un elemento en `Rooms` con un nombre por habitación pedida. Otra cosa
 *   es una respuesta ilegible: con dinero no se adivina cuál es la tarifa que eligió el vendedor.
 * - **Políticas y normas finales** (KP-3, p. 71): el pack sale con `policySource: 'prebook-final'`,
 *   del MISMO mapeo que Search, para que la comparación C1 compare lecturas idénticas.
 * - **`BookingCode` de PreBook** (Q-30): si difiere del enviado se usa el de PreBook —es el que
 *   TBO acaba de revalidar— y se alerta.
 * - **`TotalFare` como literal** para el Book (03 §3.4): nunca reconstruido desde unidades menores.
 * - **`RateConditions` saneadas** y con señales críticas (RF-16, RF-17). La señal de "solo con
 *   aéreo" se informa; bloquear el Book suelto es del servidor (D-TBO-22 A).
 * - **`CreditCardBillingOptions` no se lee** (03 §2.8): sólo se cuenta que vino, sin contenido.
 * - El vencimiento es el de la búsqueda (`searchSentAt + 27 min`): PreBook no renueva el reloj
 *   hasta que TBO diga lo contrario (Q-29).
 *
 * Lanza `TboResponseMappingError` (con `ruta:código`, nunca valores) o
 * `TboUnsupportedCurrencyError`; nunca un `Error` plano.
 */

// ───────────────────────── Contrato ─────────────────────────

/** Con qué se lee la respuesta. Todo sale del contexto del servidor, nada del navegador. */
export interface TboPrebookMapContext {
  /** El `HotelCode` del pack elegido, del contexto de búsqueda (RF-08). */
  readonly hotelCode: string;
  /** El `BookingCode` que se mandó en el request. */
  readonly bookingCode: string;
  /** Id NUESTRO de la búsqueda que emitió la tarifa: va a `provider.raw` del pack. */
  readonly searchId: string;
  /** Epoch en ms del envío del Search: el vencimiento no se mueve con el PreBook (Q-29). */
  readonly searchSentAt: number;
  /** Ocupación pedida, en el orden del request: `Name[j]` es la habitación j (p. 20). */
  readonly rooms: readonly HotelRoomOccupancy[];
  /** El de la llamada HTTP, para ubicar el RQ/RS si la lectura falla. */
  readonly requestId?: string;
}

export interface TboPrebookMapDeps {
  readonly metrics?: MetricsPort;
  readonly logger?: LoggerPort;
}

/** Avisos del resultado, como códigos cerrados: nunca texto del proveedor. */
export const TBO_PREBOOK_WARNINGS = [
  'BOOKING_CODE_CHANGED',
  'CARD_BILLING_OPTIONS_IGNORED',
] as const;
export type TboPrebookWarning = (typeof TBO_PREBOOK_WARNINGS)[number];

export interface TboPrebookDiagnostics {
  /** Nombres de claves que el esquema no conoce, con su ruta. Nunca valores. */
  readonly unknownKeys: readonly string[];
  readonly unknownMealTypes: number;
  readonly amountsWithPrecisionLoss: number;
  /** Vino `CreditCardBillingOptions` en un PreBook `Limit`: perfil de cuenta a revisar (03 §2.8). */
  readonly cardBillingOptionsIgnored: boolean;
  readonly bookingCodeChanged: boolean;
  /** Ítems de `RateConditions` que no dejaron texto tras el saneo. */
  readonly emptyRateConditions: number;
  /** Ítems que mencionan "package" sin disparar la señal (03 §2.11 punto 3). */
  readonly packageMentionsWithoutSignal: number;
}

export interface TboPrebookMapping {
  readonly result: HotelPrebookResult;
  /**
   * Lo que el Book reenvía (03 §3.1 y §3.4): el `BookingCode` de PreBook y el literal de su
   * `TotalFare`, con la moneda y el hotel. Nunca va al navegador.
   */
  readonly pack: TboSearchPackContext;
  /** Huella del texto saneado de `RateConditions`, para la comparación C2 (03 §2.9). */
  readonly rateConditionsHash: string;
  /** `Amenities` de la habitación, en texto plano: el contrato neutral todavía no los modela. */
  readonly amenities: readonly string[];
  readonly diagnostics: TboPrebookDiagnostics;
}

// ───────────────────────── Piezas ─────────────────────────

const PREBOOK_PATH = TBO_OPERATIONS.prebook.path;
const OP = 'prebook';

const MAX_UNKNOWN_KEYS = 20;
const UNKNOWN_KEY_MAX = 120;
/** Techos de `Amenities`: son etiquetas cortas ("Free WiFi"); 42 en el ejemplo de p. 24-25. */
const MAX_AMENITIES = 200;
const AMENITY_MAX = 200;

const AmenitiesSchema = z.array(z.string()).nullish();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Acumula lo observado y lo reporta sin que la observabilidad pueda cambiar el resultado: un
 * logger que lanza no le quita a nadie una revalidación que TBO ya respondió.
 */
class PrebookObserver implements TboPackObserver {
  unknownMealTypes = 0;
  amountsWithPrecisionLoss = 0;
  readonly unknownKeys = new Set<string>();

  constructor(
    private readonly deps: TboPrebookMapDeps,
    private readonly meta: Readonly<Record<string, unknown>>,
  ) {}

  count(name: string, tags: Record<string, string>): void {
    this.safely(() => this.deps.metrics?.counter(name, 1, tags));
  }

  unknownMealType(): void {
    this.unknownMealTypes += 1;
  }

  precisionLoss(field: string): void {
    this.amountsWithPrecisionLoss += 1;
    this.count('tbo.amount_precision_loss', { op: OP, field });
  }

  collectUnknownKeys(value: unknown, known: readonly string[], prefix: string): void {
    if (!isRecord(value)) return;
    for (const key of Object.keys(value)) {
      if (known.includes(key) || this.unknownKeys.size >= MAX_UNKNOWN_KEYS) continue;
      this.unknownKeys.add(`${prefix}${key}`.slice(0, UNKNOWN_KEY_MAX));
    }
  }

  /** Nombres de claves desconocidas, antes de que el esquema las descarte. */
  flushUnknownKeys(): readonly string[] {
    const unknownKeys = [...this.unknownKeys];
    for (const key of unknownKeys) this.count('tbo.contract.unknown_key', { op: OP, key });
    if (unknownKeys.length > 0) this.log('warn', 'tbo.prebook.unknown_keys', { unknownKeys });
    return unknownKeys;
  }

  log(level: 'debug' | 'warn', message: string, meta: Record<string, unknown> = {}): void {
    const logger = this.deps.logger;
    if (logger === undefined) return;
    this.safely(() =>
      logger[level](
        message,
        pickTboLogMeta({ provider: TBO_HOTELS_PROVIDER_CODE, op: OP, ...this.meta, ...meta }),
      ),
    );
  }

  private safely(run: () => void): void {
    try {
      run();
    } catch {
      // Se descarta a propósito: no hay a dónde reportar un fallo del propio canal de reporte.
    }
  }
}

interface ReadContext {
  readonly hotelCode: string;
  readonly bookingCode: string;
  readonly searchId: string;
  readonly expiresAt: string;
  readonly rooms: readonly HotelRoomOccupancy[];
  readonly requestId: string | undefined;
}

function unreadable(issues: readonly string[], requestId: string | undefined): never {
  throw new TboResponseMappingError(PREBOOK_PATH, issues, requestId);
}

/** Sin el contexto del servidor no hay forma honesta de leer la respuesta: se falla cerrado. */
function readContext(context: TboPrebookMapContext): ReadContext {
  const issues: string[] = [];
  const text = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max;
  if (!text(context.hotelCode, 64)) issues.push('context.hotelCode:invalid');
  if (!text(context.bookingCode, 255)) issues.push('context.bookingCode:invalid');
  if (!text(context.searchId, 128)) issues.push('context.searchId:invalid');
  const expiresAt = tboOfferExpiresAt(context.searchSentAt);
  if (expiresAt === undefined || context.searchSentAt < 0) {
    issues.push('context.searchSentAt:invalid');
  }
  const rooms = HotelRoomOccupancySchema.array().min(1).max(8).safeParse(context.rooms);
  if (!rooms.success) issues.push(...zodIssueRefs(rooms.error, 'context.rooms'));
  if (issues.length > 0 || expiresAt === undefined || !rooms.success) {
    unreadable(issues, context.requestId);
  }
  return {
    hotelCode: context.hotelCode,
    bookingCode: context.bookingCode,
    searchId: context.searchId,
    expiresAt,
    rooms: rooms.data,
    requestId: context.requestId,
  };
}

/** `Amenities` como lista de textos cortos, sin vacíos. Un valor ilegible no invalida la tarifa. */
function readAmenities(rawRoom: unknown): string[] {
  const raw = isRecord(rawRoom) ? rawRoom['Amenities'] : undefined;
  const parsed = AmenitiesSchema.safeParse(raw);
  if (!parsed.success) return [];
  return (parsed.data ?? [])
    .map((amenity) => amenity.replace(/\s+/g, ' ').trim().slice(0, AMENITY_MAX))
    .filter((amenity) => amenity.length > 0)
    .slice(0, MAX_AMENITIES);
}

// ───────────────────────── Entrada ─────────────────────────

/**
 * Lee un PreBook ya aceptado por el cliente HTTP (`TboPrebookEnvelopeSchema` como
 * `responseSchema`, que fija que hay exactamente un `HotelResult`).
 */
export function mapTboPrebookResponse(
  envelope: TboPrebookEnvelope,
  context: TboPrebookMapContext,
  deps: TboPrebookMapDeps = {},
): TboPrebookMapping {
  const read = readContext(context);
  const observer = new PrebookObserver(deps, {
    searchId: read.searchId,
    ...(read.requestId === undefined ? {} : { requestId: read.requestId }),
  });

  const code = envelope.Status?.Code;
  // Cualquier otro código no se lee como éxito: si llega aquí es un error de cableado del adapter.
  if (code !== undefined && code !== 200) {
    unreadable(['Status.Code:not_a_success_code'], read.requestId);
  }

  const [rawHotel] = envelope.HotelResult;
  observer.collectUnknownKeys(envelope, TBO_PREBOOK_ROOT_KEYS, '');
  observer.collectUnknownKeys(envelope.Status, ['Code', 'Description'], 'Status.');
  observer.collectUnknownKeys(rawHotel, TBO_PREBOOK_HOTEL_KEYS, 'HotelResult[].');
  const cardBillingOptionsIgnored =
    isRecord(rawHotel) && Object.hasOwn(rawHotel, 'CreditCardBillingOptions');
  // Una respuesta que no se puede leer es justo la que más interesa: sus claves nuevas se reportan
  // antes de fallar.
  const fail = (issues: readonly string[]): never => {
    observer.flushUnknownKeys();
    return unreadable(issues, read.requestId);
  };

  const hotel = TboPrebookHotelSchema.safeParse(rawHotel);
  if (!hotel.success) return fail(zodIssueRefs(hotel.error, 'HotelResult.0'));
  if (hotel.data.HotelCode !== read.hotelCode) {
    return fail(['HotelResult.0.HotelCode:not_the_requested_hotel']);
  }

  const currency = readTboHotelCurrency(hotel.data.Currency);
  if (!currency.ok) {
    if (currency.unsupported !== undefined) {
      observer.flushUnknownKeys();
      throw new TboUnsupportedCurrencyError([currency.unsupported]);
    }
    return fail(currency.issues);
  }

  const [rawRoom] = hotel.data.Rooms;
  const outcome = mapTboRoompack(rawRoom, {
    op: OP,
    source: 'prebook-final',
    hotelCode: read.hotelCode,
    currency: currency.currency,
    searchId: read.searchId,
    expiresAt: read.expiresAt,
    rooms: read.rooms,
    knownRoomKeys: TBO_PREBOOK_ROOM_KEYS,
    observer,
  });
  const unknownKeys = observer.flushUnknownKeys();
  if (!outcome.ok) {
    unreadable(
      [
        `HotelResult.0.Rooms.0:${outcome.reason.toLowerCase()}`,
        ...outcome.issues.map((issue) => `HotelResult.0.${issue}`),
      ],
      read.requestId,
    );
  }

  const conditions = readTboRateConditions(hotel.data.RateConditions);
  const bookingCodeChanged = outcome.context.bookingCode !== read.bookingCode;
  const warnings: TboPrebookWarning[] = [];

  if (bookingCodeChanged) {
    // Q-30: el Book usa el de PreBook. Es una alerta para nosotros, no un error del vendedor.
    warnings.push('BOOKING_CODE_CHANGED');
    observer.count('tbo.prebook.booking_code_changed', { op: OP });
    observer.log('warn', 'tbo.prebook.booking_code_changed');
  }
  if (cardBillingOptionsIgnored) {
    warnings.push('CARD_BILLING_OPTIONS_IGNORED');
    observer.count('tbo.prebook.card_billing_options', { op: OP });
    observer.log('warn', 'tbo.prebook.card_billing_options');
  }
  observeConditions(observer, conditions.signals, conditions.packageMentionsWithoutSignal);
  observer.log('debug', 'tbo.prebook.mapped');

  const roompack: HotelRoompack = outcome.pack;
  return {
    result: {
      total: roompack.price.total,
      expiresAt: read.expiresAt,
      roompack,
      rateConditions: conditions.conditions,
      signals: conditions.signals,
      providerStatus: String(code ?? 200),
      warnings,
    },
    pack: outcome.context,
    rateConditionsHash: conditions.textHash,
    amenities: readAmenities(rawRoom),
    diagnostics: {
      unknownKeys,
      unknownMealTypes: observer.unknownMealTypes,
      amountsWithPrecisionLoss: observer.amountsWithPrecisionLoss,
      cardBillingOptionsIgnored,
      bookingCodeChanged,
      emptyRateConditions: conditions.emptyItems,
      packageMentionsWithoutSignal: conditions.packageMentionsWithoutSignal,
    },
  };
}

/** Cada señal y cada posible falso negativo, contados: la regla es heurística (03 §2.11 punto 3). */
function observeConditions(
  observer: PrebookObserver,
  signals: readonly HotelRateSignal[],
  packageMentionsWithoutSignal: number,
): void {
  for (const signal of signals) observer.count('tbo.prebook.rate_signal', { op: OP, signal });
  for (let i = 0; i < packageMentionsWithoutSignal; i += 1) {
    observer.count('tbo.prebook.package_text_without_signal', { op: OP });
  }
}
