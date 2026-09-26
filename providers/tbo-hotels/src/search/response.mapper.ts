import {
  HotelRoomOccupancySchema,
  type HotelOffer,
  type HotelRoomOccupancy,
} from '@sales-travel/canonical';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { TboResponseMappingError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import { MAX_ISSUE_REFS, zodIssueRefs } from '../internal/zod-issues';
import { TBO_HOTELS_PROVIDER_CODE } from '../provider-code';
import { pickTboLogMeta } from '../redaction';
import {
  mapTboRoompack,
  readTboHotelCurrency,
  rejectTbo,
  type TboHotelRejection,
  type TboPackObserver,
  type TboPackRejection,
  type TboPackScope,
  type TboRejection,
  type TboSearchPackContext,
} from '../roompack/roompack.mapper';
import { tboOfferExpiresAt } from './offer-window';
import {
  TBO_SEARCH_HOTEL_KEYS,
  TBO_SEARCH_ROOM_KEYS,
  TBO_SEARCH_ROOT_KEYS,
  TboSearchHotelSchema,
  type TboSearchEnvelope,
} from './response.schema';

// Tipos que el adapter y el entry público ya leían de aquí. Viven en el mapeo compartido con
// PreBook; se re-exportan para que ningún importador cambie.
export type {
  TboHotelRejection,
  TboPackRejection,
  TboSearchPackContext,
} from '../roompack/roompack.mapper';

/**
 * Respuesta de Search → ofertas neutrales (docs/tbo/02 §9, §10 y §13; 08 RF-07, RF-09, RF-10 y
 * RF-11).
 *
 * - **Un elemento de `Rooms[]` es UN roompack** que cubre todas las habitaciones pedidas, con un
 *   `BookingCode` y un `TotalFare` (02 §9.3). El token va en el pack (`provider.offerRef`), no en
 *   la habitación: `choiceId` queda vacío.
 * - **Cada pack dice de dónde es** (`provider.name = 'tbo-hotels'`), se muestre o no según la
 *   divulgación del tenant: con eso se enruta el PreBook y la web pinta el proveedor de cada tarifa
 *   de la búsqueda combinada (RF-40; D-TBO-06 A, "me tiene que mostrar de dónde es").
 * - **La moneda sale de `HotelResult[].Currency`, sin valor por defecto** (S-08). Sin moneda, el
 *   hotel se descarta y se mide; con una moneda de exponente distinto de 2, también, y el adapter
 *   deja a TBO no disponible para esa cuenta con motivo (D-TBO-15 A).
 * - **Un pack inválido se descarta y se mide; nunca tumba la respuesta** (02 §10). Tampoco escapa
 *   un `Error` plano: los importes pasan por el decimal exacto del paquete, no por
 *   `Money.fromMajor`.
 * - **Los suplementos nunca se suman ni se convierten** (RF-10). `ExtraGuestCharges` es informativo
 *   y sólo para el vendedor (RF-11 CA-4): va a su campo y a ningún total.
 * - **El literal de `TotalFare` no viaja en el pack público** (RF-07 CA-5): se devuelve aparte, para
 *   el contexto de búsqueda del servidor (RF-08), junto a su `BookingCode`.
 *
 * El pack se arma en `roompack/roompack.mapper.ts`, el mismo mapeo que usa PreBook, y se valida
 * contra `HotelRoompackSchema` de `packages/canonical`: lo que no cumple el contrato neutral no
 * sale de aquí.
 */

// ───────────────────────── Contrato del mapper ─────────────────────────

/** Con qué se leyó la respuesta. Todo lo pone el adapter; nada viene del navegador. */
export interface TboSearchMapContext {
  /** Id NUESTRO de la búsqueda: va a `provider.raw` y es la clave del contexto del servidor. */
  readonly searchId: string;
  /** Epoch en ms del ENVÍO del Search: de ahí sale `expiresAt` (RF-09). */
  readonly searchSentAt: number;
  /** Ocupación pedida, en el orden del request: TBO devuelve los nombres en ese orden (p. 13). */
  readonly rooms: readonly HotelRoomOccupancy[];
}

export interface TboSearchMapDeps {
  readonly metrics?: MetricsPort;
  readonly logger?: LoggerPort;
}

export interface TboSearchDiagnostics {
  readonly hotelsReceived: number;
  readonly packsReceived: number;
  readonly packsMapped: number;
  readonly hotelsRejected: Readonly<Partial<Record<TboHotelRejection, number>>>;
  readonly packsRejected: Readonly<Partial<Record<TboPackRejection, number>>>;
  /** Nombres de claves que el esquema no conoce, con su ruta. Nunca valores. */
  readonly unknownKeys: readonly string[];
  readonly unknownMealTypes: number;
  /** Importes que traían más decimales que su moneda y se redondearon half-up. */
  readonly amountsWithPrecisionLoss: number;
  /**
   * Monedas de `HotelResult` con forma ISO pero exponente distinto de 2, ordenadas. Con ellas el
   * adapter deja a TBO no disponible para la cuenta con motivo (D-TBO-15 A; RF-07 CA-4).
   */
  readonly unsupportedCurrencies: readonly string[];
}

export interface TboSearchMapping {
  readonly offers: HotelOffer[];
  readonly packs: readonly TboSearchPackContext[];
  readonly diagnostics: TboSearchDiagnostics;
}

// ───────────────────────── Piezas ─────────────────────────

const SEARCH_PATH = TBO_OPERATIONS.search.path;
const OP = 'search';

const MAX_UNKNOWN_KEYS = 20;
const UNKNOWN_KEY_MAX = 120;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Acumula lo observado y lo reporta sin que la observabilidad pueda cambiar el resultado: un
 * logger o unas métricas que lanzan no le quitan a nadie sus tarifas.
 */
class SearchObserver implements TboPackObserver {
  hotelsReceived = 0;
  packsReceived = 0;
  packsMapped = 0;
  unknownMealTypes = 0;
  amountsWithPrecisionLoss = 0;
  readonly hotelsRejected: Partial<Record<TboHotelRejection, number>> = {};
  readonly packsRejected: Partial<Record<TboPackRejection, number>> = {};
  readonly unknownKeys = new Set<string>();
  readonly unsupportedCurrencies = new Set<string>();
  readonly rejectionIssues: string[] = [];

  constructor(private readonly deps: TboSearchMapDeps) {}

  count(name: string, tags: Record<string, string>): void {
    this.safely(() => this.deps.metrics?.counter(name, 1, tags));
  }

  unknownMealType(): void {
    this.unknownMealTypes += 1;
  }

  rejectHotel(rejection: TboRejection<TboHotelRejection>): void {
    this.hotelsRejected[rejection.reason] = (this.hotelsRejected[rejection.reason] ?? 0) + 1;
    this.count('tbo.search.hotel_rejected', { reason: rejection.reason });
    this.noteIssues(rejection);
  }

  rejectPack(rejection: TboRejection<TboPackRejection>): void {
    this.packsRejected[rejection.reason] = (this.packsRejected[rejection.reason] ?? 0) + 1;
    this.count('tbo.search.pack_rejected', { reason: rejection.reason });
    this.noteIssues(rejection);
  }

  precisionLoss(field: string): void {
    this.amountsWithPrecisionLoss += 1;
    this.count('tbo.amount_precision_loss', { op: OP, field });
  }

  /** Nombres de claves de `value` que no están en `known`, con la ruta del nivel. */
  collectUnknownKeys(value: unknown, known: readonly string[], prefix: string): void {
    if (!isRecord(value)) return;
    for (const key of Object.keys(value)) {
      if (known.includes(key) || this.unknownKeys.size >= MAX_UNKNOWN_KEYS) continue;
      this.unknownKeys.add(`${prefix}${key}`.slice(0, UNKNOWN_KEY_MAX));
    }
  }

  finish(offers: HotelOffer[], packs: TboSearchPackContext[]): TboSearchMapping {
    const unknownKeys = [...this.unknownKeys];
    for (const key of unknownKeys) this.count('tbo.contract.unknown_key', { op: OP, key });
    if (unknownKeys.length > 0) {
      this.log('warn', 'tbo.search.unknown_keys', { unknownKeys });
    }
    if (this.rejectionIssues.length > 0) {
      this.log('warn', 'tbo.search.rejected', { issues: this.rejectionIssues });
    }
    this.log('debug', 'tbo.search.mapped', {
      hotelsReceived: this.hotelsReceived,
      packsReceived: this.packsReceived,
      packsMapped: this.packsMapped,
    });
    return {
      offers,
      packs,
      diagnostics: {
        hotelsReceived: this.hotelsReceived,
        packsReceived: this.packsReceived,
        packsMapped: this.packsMapped,
        hotelsRejected: { ...this.hotelsRejected },
        packsRejected: { ...this.packsRejected },
        unknownKeys,
        unknownMealTypes: this.unknownMealTypes,
        amountsWithPrecisionLoss: this.amountsWithPrecisionLoss,
        unsupportedCurrencies: [...this.unsupportedCurrencies].sort(),
      },
    };
  }

  private noteIssues(rejection: TboRejection<string>): void {
    for (const issue of rejection.issues) {
      if (this.rejectionIssues.length >= MAX_ISSUE_REFS) return;
      this.rejectionIssues.push(`${rejection.reason} ${issue}`);
    }
  }

  private log(level: 'debug' | 'warn', message: string, meta: Record<string, unknown>): void {
    const logger = this.deps.logger;
    if (logger === undefined) return;
    this.safely(() =>
      logger[level](
        message,
        pickTboLogMeta({ provider: TBO_HOTELS_PROVIDER_CODE, op: OP, ...meta }),
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

// ───────────────────────── Contexto ─────────────────────────

interface ReadContext {
  readonly searchId: string;
  readonly searchSentAt: number;
  readonly expiresAt: string;
  readonly rooms: readonly HotelRoomOccupancy[];
}

/**
 * El contexto lo arma el adapter, pero sin él no hay forma honesta de leer la respuesta: sin
 * ocupación no se sabe a quién cubre cada habitación y sin instante de envío no hay vencimiento.
 */
function readContext(context: TboSearchMapContext): ReadContext {
  const issues: string[] = [];
  const searchId: unknown = context.searchId;
  if (typeof searchId !== 'string' || searchId.length === 0 || searchId.length > 128) {
    issues.push('context.searchId:invalid');
  }
  const expiresAt = tboOfferExpiresAt(context.searchSentAt);
  if (expiresAt === undefined || context.searchSentAt < 0) {
    issues.push('context.searchSentAt:invalid');
  }
  const rooms = HotelRoomOccupancySchema.array().min(1).max(8).safeParse(context.rooms);
  if (!rooms.success) issues.push(...zodIssueRefs(rooms.error, 'context.rooms'));
  if (issues.length > 0 || expiresAt === undefined || !rooms.success) {
    throw new TboResponseMappingError(SEARCH_PATH, issues);
  }
  return {
    searchId: context.searchId,
    searchSentAt: context.searchSentAt,
    expiresAt,
    rooms: rooms.data,
  };
}

// ───────────────────────── Entrada ─────────────────────────

/**
 * Lee un Search ya aceptado por el cliente HTTP (`TboSearchEnvelopeSchema` como `responseSchema`).
 *
 * - `Status.Code` 201, o sin `HotelResult`: lista vacía, no error (p. 18; 02 §9.10). Un hotel pedido
 *   que no vuelve se trata como sin disponibilidad (Q-20).
 * - Cualquier otro código no se lee como éxito: si llega aquí es un error de cableado del adapter.
 *
 * Lanza `TboResponseMappingError` sólo por eso o por un contexto inválido; lo demás se descarta,
 * se mide y se devuelve en `diagnostics`.
 */
export function mapTboSearchResponse(
  envelope: TboSearchEnvelope,
  context: TboSearchMapContext,
  deps: TboSearchMapDeps = {},
): TboSearchMapping {
  const read = readContext(context);
  const code = envelope.Status?.Code;
  if (code !== undefined && code !== 200 && code !== 201) {
    throw new TboResponseMappingError(SEARCH_PATH, ['Status.Code:not_a_success_code']);
  }

  const observer = new SearchObserver(deps);
  observer.collectUnknownKeys(envelope, TBO_SEARCH_ROOT_KEYS, '');
  observer.collectUnknownKeys(envelope.Status, ['Code', 'Description'], 'Status.');
  if (code === 201) return observer.finish([], []);

  const offers = new Map<string, HotelOffer>();
  const packs: TboSearchPackContext[] = [];
  const bookingCodes = new Set<string>();

  for (const rawHotel of envelope.HotelResult ?? []) {
    observer.hotelsReceived += 1;
    observer.collectUnknownKeys(rawHotel, TBO_SEARCH_HOTEL_KEYS, 'HotelResult[].');
    const hotel = TboSearchHotelSchema.safeParse(rawHotel);
    if (!hotel.success) {
      observer.rejectHotel(rejectTbo('HOTEL_SCHEMA', zodIssueRefs(hotel.error, 'HotelResult')));
      continue;
    }
    const rooms = hotel.data.Rooms ?? [];
    observer.packsReceived += rooms.length;
    const currency = readTboHotelCurrency(hotel.data.Currency);
    if (!currency.ok) {
      if (currency.unsupported !== undefined) {
        observer.unsupportedCurrencies.add(currency.unsupported);
      }
      observer.rejectHotel(currency);
      continue;
    }

    const scope: TboPackScope = {
      op: OP,
      source: 'search-indicative',
      hotelCode: hotel.data.HotelCode,
      currency: currency.currency,
      searchId: read.searchId,
      expiresAt: read.expiresAt,
      rooms: read.rooms,
      knownRoomKeys: TBO_SEARCH_ROOM_KEYS,
      observer,
    };
    for (const rawRoom of rooms) {
      const outcome = mapTboRoompack(rawRoom, scope);
      if (!outcome.ok) {
        observer.rejectPack(outcome);
        continue;
      }
      // El `BookingCode` identifica la unidad reservable (p. 13): dos packs con el mismo token
      // enrutarían el PreBook a uno cualquiera. Gana el primero.
      if (bookingCodes.has(outcome.pack.id)) {
        observer.rejectPack(rejectTbo('DUPLICATE_BOOKING_CODE', ['Rooms.BookingCode:duplicated']));
        continue;
      }
      bookingCodes.add(outcome.pack.id);
      observer.packsMapped += 1;
      packs.push(outcome.context);
      const offer = offers.get(scope.hotelCode);
      if (offer === undefined) {
        offers.set(scope.hotelCode, { hotelId: scope.hotelCode, roompacks: [outcome.pack] });
      } else {
        offer.roompacks.push(outcome.pack);
      }
    }
  }

  // Un hotel sin ningún pack válido no se ofrece: para el vendedor es "sin disponibilidad", y el
  // motivo de cada descarte ya quedó medido.
  return observer.finish([...offers.values()], packs);
}
