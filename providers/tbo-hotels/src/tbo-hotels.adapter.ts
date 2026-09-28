import {
  HotelRoomOccupancySchema,
  type HotelOffer,
  type HotelRatesQuery,
  type HotelRoomOccupancy,
  type HotelSearchCriteria,
} from '@sales-travel/canonical';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import type {
  HotelBookPort,
  HotelBookRequest,
  HotelBookResult,
  HotelBookingByClientReferencePort,
  HotelBookingContact,
  HotelBookingReadOptions,
  HotelBookingReadPort,
  HotelBookingReadPurpose,
  HotelBookingRoomGuests,
  HotelBookingView,
  HotelCancelRequestOptions,
  HotelCancelPort,
  HotelCancelRequest,
  HotelCancelResult,
  HotelPrebookPort,
  HotelPrebookRequest,
  HotelPrebookResult,
  HotelRatesDetailPort,
  HotelSearchPort,
  SearchContext,
} from '@sales-travel/domain';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildTboBookRequest, TboBookRequestSchema } from './booking/book.request.builder';
import {
  mapTboBookResponse,
  type TboBookReply,
  type TboBookReplyDiagnostics,
} from './booking/book.response.mapper';
import { TboBookEnvelopeSchema } from './booking/book.response.schema';
import { tboBookingReferenceEnvironment } from './booking/booking-reference';
import {
  classifyTboBookOutcome,
  type TboBookClassification,
} from './booking/classify-book-outcome';
import {
  decideTboCancelPreflight,
  decideTboCancelResult,
  type TboCancelSkipReason,
} from './cancel/cancel-decision';
import { buildTboCancelRequest, TboCancelRequestSchema } from './cancel/cancel.request.builder';
import {
  mapTboCancelResponse,
  type TboCancelObservation,
  type TboCancelReply,
} from './cancel/response.mapper';
import { TboCancelEnvelopeSchema } from './cancel/response.schema';
import { requireUsableTboConfig, type TboHotelsConfig } from './config';
import {
  buildTboBookingDetailRequest,
  TboBookingDetailRequestSchema,
} from './detail/booking-detail.request.builder';
import {
  mapTboBookingDetailResponse,
  type TboBookingDetailMapping,
  type TboBookingLookup,
} from './detail/response.mapper';
import { TboBookingDetailEnvelopeSchema } from './detail/response.schema';
import {
  TboApiError,
  TboCancelMappingError,
  TboConfigError,
  TboDispatchRejectedError,
  TboError,
  TboOfferExpiredError,
  TboRequestBuildError,
  TboResponseMappingError,
  TboUnsupportedCurrencyError,
  type TboFailureKind,
} from './errors';
import { TBO_LIMITER_DEFAULTS } from './http/limiter';
import {
  TBO_OPERATIONS,
  TBO_SEARCH_RESPONSE_TIME_S,
  TBO_SEARCH_TIMEOUT_MARGIN_MS,
  tboSearchTimeoutMs,
  type TboLane,
} from './http/operations';
import { TboHttpClient, type TboAccountContext, type TboHttpDeps } from './http/tbo-http.client';
import { zodIssueRefs } from './internal/zod-issues';
import { buildTboPrebookRequest, TboPrebookRequestSchema } from './prebook/prebook.request.builder';
import { mapTboPrebookResponse, type TboPrebookMapping } from './prebook/response.mapper';
import { TboPrebookEnvelopeSchema } from './prebook/response.schema';
import { TBO_HOTELS_PROVIDER_CODE } from './provider-code';
import { pickTboLogMeta } from './redaction';
import {
  buildTboBookingsByDateRequest,
  TboBookingsByDateRequestSchema,
  type TboBookingDateWindow,
} from './reports/booking-by-date.request.builder';
import {
  mapTboBookingsByDateResponse,
  type TboBookingsByDateMapping,
} from './reports/booking-by-date.response.mapper';
import { TboBookingsByDateEnvelopeSchema } from './reports/booking-by-date.response.schema';
import { TBO_OFFER_TTL_MS } from './search/offer-window';
import {
  mapTboSearchResponse,
  type TboHotelRejection,
  type TboPackRejection,
  type TboSearchDiagnostics,
  type TboSearchMapping,
  type TboSearchPackContext,
} from './search/response.mapper';
import { TboSearchEnvelopeSchema } from './search/response.schema';
import {
  TBO_EMPTY_CHILDREN_AGES,
  TBO_SEARCH_LIMITS,
  buildTboSearchRequest,
  type TboEmptyChildrenAges,
  type TboSearchCriteria,
  type TboSearchRequest,
} from './search/search.request.builder';

// Tipos NUESTROS que producen los mappers, no crudos de TBO: los reportes de búsqueda y de PreBook
// los exponen para el servidor (RF-08). Los mappers, que reciben el sobre crudo, no se publican.
export type {
  TboHotelRejection,
  TboPackRejection,
  TboSearchDiagnostics,
  TboSearchPackContext,
} from './search/response.mapper';
export type {
  TboPrebookDiagnostics,
  TboPrebookMapping,
  TboPrebookWarning,
} from './prebook/response.mapper';
export type { TboBookReply, TboBookReplyDiagnostics } from './booking/book.response.mapper';
export type {
  TboBookedHotel,
  TboBookedRoomSummary,
  TboBookingDetailDiagnostics,
  TboBookingDetailMapping,
  TboBookingDetailSummary,
  TboBookingDetailWarning,
  TboBookingLookup,
  TboVoucherStatus,
} from './detail/response.mapper';
export type {
  TboBookingByDate,
  TboBookingsByDateDiagnostics,
  TboBookingsByDateMapping,
} from './reports/booking-by-date.response.mapper';

/**
 * Búsqueda y detalle de un hotel en TBO por los puertos neutrales (docs/tbo/09 PR-1.5; 08 RF-14
 * lado ACL, D-TBO-17 y D-TBO-19).
 *
 * - **Una sola llamada de hasta 100 códigos** por defecto (D-TBO-17 A). Los lotes con
 *   concurrencia acotada existen detrás de `searchBatching` para la opción B, sin cambiar a nadie
 *   más (02 §4.3).
 * - **Un único deadline para toda la búsqueda**: `ResponseTime + 3 s` desde que entra la llamada.
 *   Un lote que sale tarde pide a TBO un `ResponseTime` que quepa en lo que queda, y el que ya no
 *   cabe no sale: queda `not-dispatched` con motivo en vez de estirar la espera del vendedor.
 * - **Nunca en silencio** (RNF-13): un lote que falla o no sale deja el resultado `partial`, con el
 *   error tipado de cada lote para que `apps/api` lo humanice. Si no respondió ninguno, se lanza el
 *   error del primero. Los códigos que exceden el tope se informan, no se descartan callados.
 * - **Sin reintentos propios**: los decide el cliente HTTP, que en Search nunca repite tras un
 *   timeout (01 §10.4).
 * - **Detalle de un hotel** (D-TBO-19 A): el mismo Search con UN código e `IsDetailedResponse:
 *   true`, para ver políticas y precio por noche "sujetos a confirmación". Genera otros
 *   `BookingCode` (02 §6.2): el pack que se reserva es el del detalle.
 * - Cada pack sale con `provider.name = 'tbo-hotels'` y `raw: { searchId }` del mapper: con eso se
 *   enruta el PreBook y la web dice de dónde es cada tarifa (RF-40, "me tiene que mostrar de dónde
 *   es").
 *
 * El puerto devuelve sólo ofertas. Lo que el servidor necesita además —`searchId`, `searchSentAt`,
 * `BookingCode` y literal de `TotalFare` por pack, estado de cada lote— sale por los métodos
 * `…Report`, que son la entrada que usa el factory de `apps/api`.
 *
 * **PreBook** (docs/tbo/09 PR-4.1; 08 RF-09, RF-15 a RF-17): `HotelPrebookPort` más
 * `prebookReport`, que devuelve además lo que el Book reenvía (el `BookingCode` de PreBook y el
 * literal de su `TotalFare`) y la huella de las condiciones para la comparación C2. Pasado
 * `searchSentAt + 27 min` no sale ninguna llamada: `TboOfferExpiredError` (RF-09). Los reintentos
 * los decide el cliente: uno solo tras un fallo rápido y dentro de los 23 s, nunca tras un timeout
 * (08 §9 C-24). Comparar contra lo que vio el vendedor es del servidor (`compareTboRates`).
 *
 * **Book** (docs/tbo/09 PR-4.2; 03 §3-§4; 08 RF-18 a RF-21): `HotelBookPort` más `bookReport`. UN
 * intento, 120 s y nunca un reintento (lo garantiza el cliente, `money-paths.guard.test.ts`);
 * `PaymentMode: "Limit"` y sin `PaymentInfo`. Lo que TBO responde con `200` se devuelve clasificado
 * (`CONFIRMED` o `UNCERTAIN`, `classifyTboBookOutcome`); lo que no, se LANZA tal cual, para que el
 * breaker cuente la caída o suspenda la cuenta, y la saga lo clasifica con la misma función pura
 * (`FAILED` o `UNCERTAIN`). Pasado `searchSentAt + 27 min` no sale ningún Book (RF-09).
 *
 * **BookingDetail** (04 §3; 08 RF-24): `HotelBookingReadPort` por `ConfirmationNumber` y
 * `HotelBookingByClientReferencePort` por nuestra `BookingReferenceId`, más `bookingDetailReport`
 * con el resumen para la post-venta. Es una lectura: se reintenta ante red, 5xx o 429.
 *
 * **Cancel** (docs/tbo/09 PR-5.1; 04 §4.4; 08 RF-25 y §9 C-05): `HotelCancelPort` más
 * `cancelReport`. Lectura previa, `POST /Cancel` con UN intento y lectura posterior; qué se manda y
 * qué se devuelve lo deciden las funciones puras de `./cancel/cancel-decision`. Un `479` vuelve
 * como `success: false` sin lanzar; lo que no dice si TBO aplicó el write se lanza con path
 * `/Cancel` para que la política de cancelaciones lo deje `UNVERIFIED`.
 *
 * **BookingDetailsbasedondate** (PR-5.1; 04 §5 y §9.5; 08 RF-28): `listBookingsByDateReport`, una
 * ventana de hasta 60 días que vale entera o se lanza. Es una lectura de fondo, para la conciliación.
 * No se llama `listBookingsByDate` a propósito: ése es el método de `HotelBookingsByDatePort`, que
 * recibe `{ from, to }` de cualquier largo y devuelve `HotelBookingSummary[]`, y `apps/api` detecta
 * los puertos opcionales por el NOMBRE del método (`supportsHotelBookingsByDate`). Con el mismo
 * nombre y otro contrato, el ACL pasaría por un puerto que no cumple, y un resumen sin
 * `clientReferenceMissing` dejaría concluir "no está en TBO" a ciegas (D-TBO-24 A). El puerto
 * neutral, y con él la capacidad `reconcileByDate`, llegan con la conciliación (PR-5.5).
 */

// ───────────────────────── Opciones ─────────────────────────

/**
 * D-TBO-17. `single` es la opción A; `batches`, la B: "lotes paralelos de 100 hasta 300 códigos".
 *
 * En `batches`, por defecto: `batchSize` 100, `maxHotelCodes` 300 y `concurrency` 1, porque el QPS
 * de TBO no está publicado (08 §9 C-02; Q-10). Con concurrencia 1 los lotes salen en fila y el
 * deadline único deja fuera, con motivo, al que ya no llega: la opción B se configura junto con
 * `responseTimeSeconds` (20 s en D-TBO-17 B).
 */
export type TboSearchBatching =
  | { readonly mode: 'single' }
  | {
      readonly mode: 'batches';
      readonly batchSize?: number;
      readonly maxHotelCodes?: number;
      readonly concurrency?: number;
    };

export interface TboHotelsAdapterOptions {
  readonly searchBatching?: TboSearchBatching;
  /** `ResponseTime` en segundos, entero de 5 a 20; 10 por defecto (D-TBO-17 A; 02 §6.1). */
  readonly responseTimeSeconds?: number;
  /** Qué se manda en `ChildrenAges` sin niños hasta que la sonda PR-01 lo fije (Q-13). */
  readonly emptyChildrenAges?: TboEmptyChildrenAges;
}

export const TBO_SEARCH_BATCHING_LIMITS = Object.freeze({
  /** D-TBO-17 B: hasta 300 códigos por búsqueda. */
  maxHotelCodes: 300,
  /**
   * Lotes en vuelo a la vez: lo que el cupo de ventas de la cuenta puede tener abierto con el
   * limitador por defecto. Más sólo haría esperar a los lotes dentro del limitador.
   */
  maxConcurrency: TBO_LIMITER_DEFAULTS.maxConcurrent - TBO_LIMITER_DEFAULTS.moneyReserve.concurrent,
});

const OptionsSchema = z
  .object({
    searchBatching: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('single') }).strict(),
        z
          .object({
            mode: z.literal('batches'),
            batchSize: z
              .number()
              .int()
              .min(1)
              .max(TBO_SEARCH_LIMITS.maxHotelCodesPerRequest)
              .optional(),
            maxHotelCodes: z
              .number()
              .int()
              .min(1)
              .max(TBO_SEARCH_BATCHING_LIMITS.maxHotelCodes)
              .optional(),
            concurrency: z
              .number()
              .int()
              .min(1)
              .max(TBO_SEARCH_BATCHING_LIMITS.maxConcurrency)
              .optional(),
          })
          .strict(),
      ])
      .optional(),
    responseTimeSeconds: z
      .number()
      .int()
      .min(TBO_SEARCH_RESPONSE_TIME_S.min)
      .max(TBO_SEARCH_RESPONSE_TIME_S.max)
      .optional(),
    emptyChildrenAges: z.enum(TBO_EMPTY_CHILDREN_AGES).optional(),
  })
  .strict();

interface SearchPolicy {
  readonly batchSize: number;
  readonly maxHotelCodes: number;
  readonly concurrency: number;
  readonly responseTimeSeconds: number;
  readonly emptyChildrenAges: TboEmptyChildrenAges;
}

/** Opciones inválidas son un error de configuración del despliegue: sólo `ruta:código`. */
function resolvePolicy(options: TboHotelsAdapterOptions): SearchPolicy {
  const parsed = OptionsSchema.safeParse(options);
  if (!parsed.success) throw new TboConfigError(zodIssueRefs(parsed.error, 'options'));
  const { searchBatching, responseTimeSeconds, emptyChildrenAges } = parsed.data;
  const perRequest = TBO_SEARCH_LIMITS.maxHotelCodesPerRequest;
  const batching =
    searchBatching?.mode === 'batches'
      ? {
          batchSize: searchBatching.batchSize ?? perRequest,
          maxHotelCodes: searchBatching.maxHotelCodes ?? TBO_SEARCH_BATCHING_LIMITS.maxHotelCodes,
          concurrency: searchBatching.concurrency ?? 1,
        }
      : { batchSize: perRequest, maxHotelCodes: perRequest, concurrency: 1 };
  return Object.freeze({
    ...batching,
    responseTimeSeconds: responseTimeSeconds ?? TBO_SEARCH_RESPONSE_TIME_S.default,
    emptyChildrenAges: emptyChildrenAges ?? 'empty-array',
  });
}

// ───────────────────────── Reporte ─────────────────────────

/**
 * - `ok`: TBO respondió y se leyó (puede no haber dejado ningún pack válido: lo dice `diagnostics`).
 * - `empty`: `201`, sin disponibilidad. No es un fallo.
 * - `failed`: la llamada salió y falló, o su respuesta no se pudo leer.
 * - `not-dispatched`: no salió nada hacia TBO (limitador sin cupo o deadline agotado).
 */
export type TboSearchBatchStatus = 'ok' | 'empty' | 'failed' | 'not-dispatched';

export interface TboSearchBatchReport {
  /** Base 0, en el orden de relevancia en que llegaron los códigos. */
  readonly index: number;
  readonly hotelCodeCount: number;
  readonly status: TboSearchBatchStatus;
  /** El de la llamada HTTP, para ubicar el RQ/RS en la bóveda de payloads. */
  readonly requestId?: string;
  readonly durationMs: number;
  /** Sólo en `failed` y `not-dispatched`: el error tipado, para humanizarlo en `apps/api`. */
  readonly error?: TboError;
}

export interface TboSearchReport {
  readonly offers: HotelOffer[];
  /** Nuestro: va en `provider.raw` de cada pack y es la clave del contexto del servidor (RF-08). */
  readonly searchId: string;
  /**
   * Epoch en ms en que entró la búsqueda, antes de que saliera ningún lote: el instante más
   * temprano posible, del que sale `expiresAt` (RF-09).
   */
  readonly searchSentAt: number;
  /** Huella de la cuenta que buscó (`tboAccountRef`), nunca el usuario. */
  readonly accountRef: string;
  /** Por pack válido: lo que PreBook y Book reenvían y nunca va al navegador (RF-08). */
  readonly packs: readonly TboSearchPackContext[];
  readonly batches: readonly TboSearchBatchReport[];
  /** Algún lote no aportó: sus hoteles fallaron o no se consultaron (RF-14 CA-3; RNF-13). */
  readonly partial: boolean;
  /** Códigos distintos que no entraron en la búsqueda por el tope de `searchBatching`. */
  readonly omittedHotelCodes: number;
  /** Suma de la lectura de cada lote que respondió. */
  readonly diagnostics: TboSearchDiagnostics;
}

/** El detalle de un hotel: la oferta de ESE hotel, vacía si no hay disponibilidad. */
export interface TboHotelRatesReport extends Omit<TboSearchReport, 'offers'> {
  readonly offer: HotelOffer;
}

// ───────────────────────── PreBook ─────────────────────────

/**
 * Qué revalidar. Todo sale del contexto de búsqueda que guardó el servidor (RF-08), nunca del
 * navegador: el `HotelCode` y la ocupación que PreBook no recibe pero su respuesta tiene que
 * cumplir, y el instante del Search del que sale el vencimiento.
 */
export interface TboPrebookQuery {
  readonly hotelCode: string;
  /** El `BookingCode` del pack elegido, tal como lo dio Search. */
  readonly bookingCode: string;
  readonly searchId: string;
  /** Epoch en ms del ENVÍO del Search que emitió la tarifa (RF-09). */
  readonly searchSentAt: number;
  /** Ocupación pedida, en el orden del Search: `Name[j]` es la habitación j (p. 20). */
  readonly rooms: readonly HotelRoomOccupancy[];
  /** Señal del request del vendedor: PreBook es una lectura interactiva (01 §5.4). */
  readonly signal?: AbortSignal;
}

export interface TboPrebookReport extends TboPrebookMapping {
  /** El de la llamada HTTP, para ubicar el RQ/RS en la bóveda de payloads. */
  readonly requestId: string;
  /** Huella de la cuenta que revalidó (`tboAccountRef`), nunca el usuario. */
  readonly accountRef: string;
  /** Intentos que hizo el cliente: 2 sólo tras un fallo rápido dentro de los 23 s (C-24). */
  readonly attempts: number;
  readonly durationMs: number;
}

/**
 * Las claves de `HotelPrebookRequest.providerOptions` que lee el ACL de TBO, para quien llama por el
 * puerto neutral: lo que PreBook exige y un `ProviderRef` no lleva. Ninguna es PII.
 */
export interface TboPrebookProviderOptions {
  readonly hotelCode: string;
  readonly rooms: readonly HotelRoomOccupancy[];
}

/** Reloj del servidor frente al instante guardado: más adelantado que esto no es deriva. */
const SEARCH_SENT_AT_MAX_SKEW_MS = 5_000;

const PrebookQuerySchema = z.object({
  hotelCode: z.string().min(1).max(64),
  bookingCode: z.string().min(1).max(255),
  searchId: z.string().min(1).max(128),
  searchSentAt: z.number().int().nonnegative(),
  rooms: HotelRoomOccupancySchema.array().min(1).max(8),
});

const PrebookProviderOptionsSchema = z.object({
  hotelCode: z.string().min(1).max(64),
  rooms: HotelRoomOccupancySchema.array().min(1).max(8),
});

const PREBOOK_PATH = TBO_OPERATIONS.prebook.path;

// ───────────────────────── Book ─────────────────────────

/**
 * Qué reservar. Todo sale de lo que la saga ya persistió en el intent y del snapshot del PreBook de
 * revalidación (C2), nunca del navegador (RF-20): el `BookingCode` y el literal de `TotalFare` son
 * los de ese PreBook, la ocupación es la del Search y la referencia se generó antes de insertar.
 */
export interface TboBookQuery {
  /** `pack.bookingCode` del PreBook de revalidación (Q-30). */
  readonly bookingCode: string;
  /** `pack.totalFare` del PreBook de revalidación: el literal, no una reconstrucción. */
  readonly totalFare: string;
  /** `generateTboBookingReference`, ya persistida en el intent (RF-19). */
  readonly bookingReferenceId: string;
  /** Epoch en ms del ENVÍO del Search que emitió la tarifa (RF-09). */
  readonly searchSentAt: number;
  /** `PaxRooms` del Search, en su orden. */
  readonly occupancy: readonly HotelRoomOccupancy[];
  /** Huéspedes por habitación, en el orden de `occupancy`. */
  readonly rooms: readonly HotelBookingRoomGuests[];
  /** El contacto que viaja a TBO: el operativo de la agencia (D-TBO-23 A). */
  readonly contact: HotelBookingContact;
}

/** Lo que volvió de un Book con `200`, para que la saga lo registre sin volver al cuerpo. */
export interface TboBookReplySummary {
  readonly confirmationNumber?: string;
  readonly clientReferenceId?: string;
}

export interface TboBookReport {
  /** `CONFIRMED` o `UNCERTAIN`: un Book que no respondió `200` se lanza, no se devuelve. */
  readonly result: HotelBookResult;
  readonly classification: TboBookClassification;
  readonly reply: TboBookReplySummary;
  readonly bookingReferenceId: string;
  /** El de la llamada HTTP, para ubicar el RQ/RS en la bóveda de payloads. */
  readonly requestId: string;
  /** Huella de la cuenta que reservó (`tboAccountRef`): la post-venta tiene que usar la misma. */
  readonly accountRef: string;
  /** Siempre 1 (money-paths.guard.test.ts). */
  readonly attempts: number;
  readonly durationMs: number;
  readonly diagnostics: TboBookReplyDiagnostics;
}

/**
 * Las claves de `HotelBookRequest.providerOptions` que lee el ACL de TBO, para quien llama por el
 * puerto neutral: lo que el Book exige y el puerto no lleva. Ninguna es PII.
 */
export interface TboBookProviderOptions {
  /** Literal decimal del `TotalFare` del PreBook de revalidación. */
  readonly totalFare: string;
  /** ISO 8601 del envío del Search que emitió la tarifa. */
  readonly searchSentAt: string;
  /** `PaxRooms` del Search, en su orden. */
  readonly rooms: readonly HotelRoomOccupancy[];
}

const BookQueryShapeSchema = z.object({
  bookingCode: z.string().min(1).max(255),
  totalFare: z.string().min(1).max(64),
  bookingReferenceId: z.string().min(1).max(64),
  searchSentAt: z.number().int().nonnegative(),
  occupancy: HotelRoomOccupancySchema.array().min(1).max(8),
});

const BookProviderOptionsSchema = z.object({
  totalFare: z.string().min(1).max(64),
  searchSentAt: z.string().min(1).max(64),
  rooms: HotelRoomOccupancySchema.array().min(1).max(8),
});

const BOOK_PATH = TBO_OPERATIONS.book.path;
const DETAIL_PATH = TBO_OPERATIONS.bookingDetail.path;

/**
 * `HotelBookRequest` → consulta de Book. El pago tiene que ser el crédito de la cuenta (`Limit`):
 * un token de checkout alojado no tiene a dónde ir en TBO y pedirlo con `Limit` cargaría la reserva
 * a la cuenta sin que nadie lo decidiera.
 */
function bookQueryFromPort(request: HotelBookRequest): TboBookQuery {
  const issues: string[] = [];
  if (request.offer.name !== TBO_HOTELS_PROVIDER_CODE) issues.push('offer.name:not_tbo_hotels');
  const options = BookProviderOptionsSchema.safeParse(request.providerOptions ?? {});
  if (!options.success) issues.push(...zodIssueRefs(options.error, 'providerOptions'));
  const sentAt = options.success ? Date.parse(options.data.searchSentAt) : Number.NaN;
  if (options.success && !Number.isFinite(sentAt))
    issues.push('providerOptions.searchSentAt:invalid');
  if (request.payment.kind !== 'agency-credit') {
    throw new TboRequestBuildError(BOOK_PATH, 'PAYMENT_MODE', ['payment.kind:not_agency_credit']);
  }
  if (issues.length > 0 || !options.success) {
    throw new TboRequestBuildError(BOOK_PATH, 'SCHEMA', issues);
  }
  return {
    bookingCode: request.offer.offerRef,
    totalFare: options.data.totalFare,
    bookingReferenceId: request.bookingReference,
    searchSentAt: sentAt,
    occupancy: options.data.rooms,
    rooms: request.rooms,
    contact: request.contact,
  };
}

// ───────────────────────── BookingDetail ─────────────────────────

/**
 * Para qué se lee: decide el cupo del limitador y cuántos intentos (01 §7.2; tabla de operaciones).
 *
 * - `recovery`: verificar un Book dentro de la misma venta (el de cierre por localizador, o uno por
 *   referencia que no pide otro propósito). Va al cupo de dinero, que no espera detrás de las
 *   búsquedas.
 * - `verification`: un job que busca, por nuestra referencia, un Book que no respondió. Pasa antes
 *   que las búsquedas pero con techo propio: una ráfaga de jobs no le quita al vendedor más que eso.
 * - `interactive`: el vendedor espera la respuesta (panel). Dos intentos.
 * - `background`: HCN, conciliación, verificación de una cancelación y la lectura previa a un Cancel.
 * - `after-cancel`: la lectura posterior a un Cancel. UN intento: la cancelación síncrona tiene que
 *   responder dentro de su presupuesto (HARD-1), y lo que esta lectura no alcance a decir lo lee
 *   `verify-cancellation` a los 2 minutos.
 */
export type TboBookingDetailPurpose =
  | 'recovery'
  | 'verification'
  | 'interactive'
  | 'background'
  | 'after-cancel';

const DETAIL_PURPOSES: Readonly<
  Record<TboBookingDetailPurpose, { readonly lane: TboLane; readonly maxAttempts: number }>
> = Object.freeze({
  recovery: { lane: 'money', maxAttempts: 3 },
  verification: { lane: 'verification', maxAttempts: 3 },
  interactive: { lane: 'sales', maxAttempts: 2 },
  background: { lane: 'background', maxAttempts: 3 },
  'after-cancel': { lane: 'background', maxAttempts: 1 },
});

/** El propósito neutral de una lectura, en el vocabulario de este ACL. */
const READ_PURPOSES: Readonly<Record<HotelBookingReadPurpose, TboBookingDetailPurpose>> =
  Object.freeze({
    interactive: 'interactive',
    booking: 'recovery',
    verification: 'verification',
    background: 'background',
  });

/** Sin propósito, o con uno que no está en el contrato, decide la forma de la lectura. */
function detailPurposeOf(
  options: HotelBookingReadOptions | undefined,
): { readonly purpose: TboBookingDetailPurpose } | Record<string, never> {
  const neutral = options?.purpose;
  const purpose =
    neutral !== undefined && Object.hasOwn(READ_PURPOSES, neutral)
      ? READ_PURPOSES[neutral]
      : undefined;
  return purpose === undefined ? {} : { purpose };
}

export type TboBookingDetailQuery = TboBookingLookup & {
  /** Por defecto `recovery` si se lee por referencia y `background` si por localizador. */
  readonly purpose?: TboBookingDetailPurpose;
  /** Señal del request del vendedor, para la lectura interactiva. */
  readonly signal?: AbortSignal;
};

interface TboCallInfo {
  readonly requestId: string;
  readonly accountRef: string;
  readonly durationMs: number;
}

export type TboBookingDetailReport =
  | (TboBookingDetailMapping &
      TboCallInfo & {
        readonly found: true;
        readonly attempts: number;
      })
  | (TboCallInfo & {
      readonly found: false;
      readonly view: HotelBookingView;
      /** El `Status.Code` con que TBO dijo que no la tiene. */
      readonly tboCode: number;
      readonly failureKind: TboFailureKind;
    });

/**
 * Qué respuesta de BookingDetail se lee como "no la tiene". El contrato no lo documenta (PV-01;
 * Q-37) y la sonda PR-05 lo va a fijar (RF-21 CA-5). Hasta entonces, provisorio: un envelope con un
 * código que dice "no hay datos" (`201`), "pedido que no entiendo" (`400`) o uno fuera de la tabla.
 * Nada de eso prueba que la reserva no exista (D-TBO-24 A): sólo que esta lectura no la encontró.
 * Todo lo demás —red, 5xx, 429, cuenta, cuerpo roto— se lanza, porque no dice nada de la reserva.
 */
const NOT_FOUND_KINDS: ReadonlySet<TboFailureKind> = new Set<TboFailureKind>([
  'NO_AVAILABILITY',
  'CLIENT_BUG',
  'UNKNOWN_CODE',
]);

/** Aviso de la vista "no encontrada" hasta que la sonda PR-05 fije la forma real. */
const NOT_FOUND_WARNING = 'NOT_FOUND_SHAPE_UNCONFIRMED';

/**
 * Sólo los identificadores de la consulta. Si llegan los dos (o ninguno), pasan así al builder, que
 * es quien se niega: elegir uno aquí escondería el error de quien llama.
 */
function lookupOf(query: TboBookingDetailQuery): TboBookingLookup {
  const { confirmationNumber, bookingReferenceId } = query;
  return {
    ...(confirmationNumber === undefined ? {} : { confirmationNumber }),
    ...(bookingReferenceId === undefined ? {} : { bookingReferenceId }),
  } as TboBookingLookup;
}

// ───────────────────────── Cancel ─────────────────────────

export interface TboCancelQuery {
  /** El localizador de TBO con que se creó la reserva (`orders.provider_order_id`). */
  readonly confirmationNumber: string;
  /**
   * El cupo de la lectura PREVIA: `interactive` si una persona espera en el panel (01 §7.2 punto 3),
   * `background` (por defecto) si es un job. El `/Cancel` sale siempre por el cupo de dinero y la
   * lectura posterior, por el de fondo.
   */
  readonly purpose?: TboCancelReadPurpose;
}

/** Los propósitos que admite la lectura previa al Cancel. */
export type TboCancelReadPurpose = Extract<TboBookingDetailPurpose, 'interactive' | 'background'>;

/**
 * Una lectura de BookingDetail dentro de la secuencia de cancelación. `failed` sólo existe para la
 * lectura POSTERIOR, que nunca lanza (04 §4.3): trae la clase y el `kind` del error, no el error.
 */
export type TboCancelReading =
  | { readonly state: 'read'; readonly view: HotelBookingView; readonly requestId: string }
  | {
      readonly state: 'failed';
      readonly errorClass: string;
      readonly kind?: TboFailureKind;
      readonly requestId?: string;
    };

export interface TboCancelReport {
  /** Lo que devuelve el puerto: `success`, `bookingStatus` y avisos (`TBO_CANCEL_WARNINGS`). */
  readonly result: HotelCancelResult;
  readonly confirmationNumber: string;
  /** Salió el `POST /Cancel`. Si no, `skipReason` dice por qué. */
  readonly sent: boolean;
  readonly skipReason?: TboCancelSkipReason;
  /** `Status.Code` de `/Cancel`: `200` (aceptada) o `479` (rechazada). Sólo si salió. */
  readonly cancelCode?: 200 | 479;
  /** El de la llamada a `/Cancel`, para ubicar el RQ/RS en la bóveda de payloads. */
  readonly cancelRequestId?: string;
  /** La lectura previa. Si falló, la cancelación lanzó antes de enviar nada. */
  readonly before: Extract<TboCancelReading, { state: 'read' }>;
  /** La lectura posterior, sólo si salió el Cancel. */
  readonly after?: TboCancelReading;
  /** Huella de la cuenta con que se canceló: tiene que ser la que reservó (RF-29). */
  readonly accountRef: string;
  readonly durationMs: number;
}

const CANCEL_PATH = TBO_OPERATIONS.cancel.path;

/** El `requestId` de un error de TBO que lo tenga, para ubicar su RQ/RS en la bóveda. */
function requestIdOf(err: unknown): string | undefined {
  return err instanceof TboApiError || err instanceof TboResponseMappingError
    ? err.requestId
    : undefined;
}

// ───────────────────────── BookingDetailsbasedondate ─────────────────────────

/** Una ventana de fechas de creación, `YYYY-MM-DD` e inclusiva, de hasta 60 días. */
export type TboBookingsByDateQuery = TboBookingDateWindow;

export interface TboBookingsByDateReport extends TboBookingsByDateMapping {
  /** El de la llamada HTTP, para ubicar el RQ/RS en la bóveda de payloads. */
  readonly requestId: string;
  /** Huella de la cuenta leída: la conciliación es por cuenta, no por tenant (04 §9.2). */
  readonly accountRef: string;
  readonly attempts: number;
  readonly durationMs: number;
}

const BY_DATE_PATH = TBO_OPERATIONS.bookingDetailsByDate.path;

// ───────────────────────── Piezas ─────────────────────────

const SEARCH_PATH = TBO_OPERATIONS.search.path;

/**
 * El `ResponseTime` que cabe en lo que le queda al deadline, sin pasar del configurado. Se
 * redondea hacia arriba porque el primer lote sale unos milisegundos después de fijar el deadline
 * y no tiene que perder un segundo entero por eso.
 *
 * Por debajo del mínimo que admite TBO el lote no sale (INFERIDO: TBO no alcanza a responder y la
 * llamada sólo gasta QPS de la cuenta). Esa puerta usa ESTE mismo redondeo: con un umbral exacto
 * de `ResponseTime` mínimo + holgura, con `responseTimeSeconds: 5` el plazo entero ES el umbral y
 * el milisegundo que pasa entre fijar el deadline y despachar dejaría fuera a todo lote.
 */
function responseTimeWithin(remainingMs: number, configured: number): number {
  const fits = Math.ceil((remainingMs - TBO_SEARCH_TIMEOUT_MARGIN_MS) / 1_000);
  return Math.min(configured, fits);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

function addCounts<K extends string>(
  target: Partial<Record<K, number>>,
  source: Readonly<Partial<Record<K, number>>>,
): void {
  for (const [key, count] of Object.entries(source) as [K, number | undefined][]) {
    if (count !== undefined) target[key] = (target[key] ?? 0) + count;
  }
}

/** Mismo techo de claves desconocidas que el mapper: el log no necesita más. */
const MAX_UNKNOWN_KEYS = 20;

function mergeDiagnostics(all: readonly TboSearchDiagnostics[]): TboSearchDiagnostics {
  const hotelsRejected: Partial<Record<TboHotelRejection, number>> = {};
  const packsRejected: Partial<Record<TboPackRejection, number>> = {};
  const unknownKeys = new Set<string>();
  const unsupportedCurrencies = new Set<string>();
  let hotelsReceived = 0;
  let packsReceived = 0;
  let packsMapped = 0;
  let unknownMealTypes = 0;
  let amountsWithPrecisionLoss = 0;
  for (const d of all) {
    hotelsReceived += d.hotelsReceived;
    packsReceived += d.packsReceived;
    packsMapped += d.packsMapped;
    unknownMealTypes += d.unknownMealTypes;
    amountsWithPrecisionLoss += d.amountsWithPrecisionLoss;
    addCounts(hotelsRejected, d.hotelsRejected);
    addCounts(packsRejected, d.packsRejected);
    for (const key of d.unknownKeys) {
      if (unknownKeys.size < MAX_UNKNOWN_KEYS) unknownKeys.add(key);
    }
    for (const currency of d.unsupportedCurrencies) unsupportedCurrencies.add(currency);
  }
  return {
    hotelsReceived,
    packsReceived,
    packsMapped,
    hotelsRejected,
    packsRejected,
    unknownKeys: [...unknownKeys],
    unknownMealTypes,
    amountsWithPrecisionLoss,
    unsupportedCurrencies: [...unsupportedCurrencies].sort(),
  };
}

/** `lote:motivo` con el vocabulario cerrado de los errores del paquete, nunca un `message`. */
function batchIssue(batch: TboSearchBatchReport): string {
  const { error } = batch;
  const reason =
    error instanceof TboApiError
      ? error.kind
      : error instanceof TboDispatchRejectedError
        ? error.reason
        : (error?.name ?? 'unknown');
  return `${batch.index}:${reason}`;
}

interface BatchOutcome extends TboSearchBatchReport {
  readonly mapping?: TboSearchMapping;
}

/** Lo que es igual para todos los lotes de UNA búsqueda. */
interface SearchRun {
  readonly searchId: string;
  readonly startedAt: number;
  readonly deadline: number;
  readonly detailed: boolean;
  readonly criteria: TboSearchCriteria;
}

/**
 * `HotelPrebookRequest` → consulta de PreBook. El `ProviderRef` tiene que ser de TBO y traer su
 * `searchId`; el instante del Search es obligatorio porque sin él no se puede garantizar la ventana
 * de 30 minutos (RF-09).
 */
function prebookQueryFromPort(request: HotelPrebookRequest): TboPrebookQuery {
  const issues: string[] = [];
  if (request.offer.name !== TBO_HOTELS_PROVIDER_CODE) issues.push('offer.name:not_tbo_hotels');
  const searchId: unknown = request.offer.raw?.['searchId'];
  if (typeof searchId !== 'string') issues.push('offer.raw.searchId:missing');
  const sentAt = request.searchSentAt === undefined ? Number.NaN : Date.parse(request.searchSentAt);
  if (request.searchSentAt === undefined) issues.push('searchSentAt:missing');
  else if (!Number.isFinite(sentAt)) issues.push('searchSentAt:invalid');
  const options = PrebookProviderOptionsSchema.safeParse(request.providerOptions ?? {});
  if (!options.success) issues.push(...zodIssueRefs(options.error, 'providerOptions'));
  if (issues.length > 0 || typeof searchId !== 'string' || !options.success) {
    throw new TboRequestBuildError(PREBOOK_PATH, 'SCHEMA', issues);
  }
  return {
    hotelCode: options.data.hotelCode,
    bookingCode: request.offer.offerRef,
    searchId,
    searchSentAt: sentAt,
    rooms: options.data.rooms,
  };
}

// ───────────────────────── Adapter ─────────────────────────

export class TboHotelsAdapter
  implements
    HotelSearchPort,
    HotelRatesDetailPort,
    HotelPrebookPort,
    HotelBookPort,
    HotelBookingReadPort,
    HotelBookingByClientReferencePort,
    HotelCancelPort
{
  // Campos `#`, como el cliente: un adapter volcado a un log no arrastra nada de la cuenta.
  readonly #client: TboHttpClient;
  readonly #policy: SearchPolicy;
  readonly #logger: LoggerPort | undefined;
  readonly #metrics: MetricsPort | undefined;
  readonly #now: () => number;
  readonly #uuid: () => string;

  /**
   * Falla al construir, con error tipado, si la cuenta no puede llamar a TBO o las opciones no
   * valen: el factory de `apps/api` pasa antes por su puerta de credenciales, y esto es la red por
   * si un cableado nuevo se la salta. Un adapter sin cuenta usable no existe.
   */
  constructor(
    config: TboHotelsConfig,
    deps: TboHttpDeps = {},
    context: TboAccountContext = {},
    options: TboHotelsAdapterOptions = {},
  ) {
    requireUsableTboConfig(config);
    this.#policy = resolvePolicy(options);
    this.#client = new TboHttpClient(config, deps, context);
    this.#logger = deps.logger;
    this.#metrics = deps.metrics;
    this.#now = deps.now ?? (() => Date.now());
    this.#uuid = deps.uuid ?? randomUUID;
  }

  /** Clave de la cuenta para el limitador, el circuito de cuenta y la huella del contexto. */
  get accountRef(): string {
    return this.#client.accountRef;
  }

  /**
   * `HotelSearchPort`. `criteria.hotelIds` son códigos de TBO en orden de relevancia; `currency`
   * no viaja porque TBO cotiza en la moneda de la cuenta (p. 13) y la puerta de moneda es del
   * servicio.
   */
  async searchAvailability(
    criteria: HotelSearchCriteria,
    ctx: SearchContext,
  ): Promise<HotelOffer[]> {
    return (await this.searchAvailabilityReport(criteria, ctx)).offers;
  }

  async searchAvailabilityReport(
    criteria: HotelSearchCriteria,
    _ctx: SearchContext,
  ): Promise<TboSearchReport> {
    return this.#search(criteria, false);
  }

  /**
   * `HotelRatesDetailPort` (D-TBO-19 A). `roompackId` no se usa: el Search de detalle emite
   * `BookingCode` nuevos y el del listado no se puede buscar entre ellos (02 §6.2).
   */
  async getHotelRates(query: HotelRatesQuery, ctx: SearchContext): Promise<HotelOffer> {
    return (await this.getHotelRatesReport(query, ctx)).offer;
  }

  async getHotelRatesReport(
    query: HotelRatesQuery,
    _ctx: SearchContext,
  ): Promise<TboHotelRatesReport> {
    const { offers, packs, ...report } = await this.#search(
      {
        hotelIds: [query.hotelId],
        checkinDate: query.checkinDate,
        checkoutDate: query.checkoutDate,
        rooms: query.rooms,
        guestNationality: query.guestNationality,
        refundableOnly: query.refundableOnly,
      },
      true,
    );
    const foreign = offers.filter((offer) => offer.hotelId !== query.hotelId).length;
    if (foreign > 0) this.#count('tbo.search.detail_foreign_hotel', foreign, { op: 'search' });
    return {
      ...report,
      offer: offers.find((offer) => offer.hotelId === query.hotelId) ?? {
        hotelId: query.hotelId,
        roompacks: [],
      },
      packs: packs.filter((pack) => pack.hotelCode === query.hotelId),
    };
  }

  /**
   * `HotelPrebookPort`. `offer.offerRef` es el `BookingCode`, `offer.raw.searchId` la búsqueda que lo
   * emitió y `searchSentAt` su instante de envío; el hotel y la ocupación van en `providerOptions`
   * ({@link TboPrebookProviderOptions}). Sin cualquiera de ellos no hay PreBook honesto: se falla
   * con `TboRequestBuildError` antes del cable.
   */
  async prebook(request: HotelPrebookRequest, ctx: SearchContext): Promise<HotelPrebookResult> {
    return (await this.prebookReport(prebookQueryFromPort(request), ctx)).result;
  }

  /**
   * PreBook con `PaymentMode: "Limit"` (D1) y la lectura completa para el servidor. Lanza, sin
   * llamar a TBO, `TboOfferExpiredError` si la oferta venció en nuestro reloj (RF-09 CA-1) y
   * `TboRequestBuildError` si la consulta no tiene forma; después, lo que decida el cliente por
   * `Status.Code` (201/207 invalidan la oferta, 315 el contexto: RF-15 CA-4) o la lectura.
   */
  async prebookReport(query: TboPrebookQuery, _ctx: SearchContext): Promise<TboPrebookReport> {
    const parsed = PrebookQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new TboRequestBuildError(PREBOOK_PATH, 'SCHEMA', zodIssueRefs(parsed.error, 'query'));
    }
    const input = parsed.data;
    const now = this.#now();
    if (input.searchSentAt > now + SEARCH_SENT_AT_MAX_SKEW_MS) {
      // Un instante en el futuro estiraría la ventana de 30 minutos más allá de la de TBO.
      throw new TboRequestBuildError(PREBOOK_PATH, 'SCHEMA', ['query.searchSentAt:in_the_future']);
    }
    const expiresAtMs = input.searchSentAt + TBO_OFFER_TTL_MS;
    if (now >= expiresAtMs) {
      this.#count('tbo.prebook.expired_locally', 1, { op: 'prebook' });
      throw new TboOfferExpiredError(new Date(expiresAtMs).toISOString());
    }

    const result = await this.#client.send(
      'prebook',
      buildTboPrebookRequest({ bookingCode: input.bookingCode }),
      {
        requestSchema: TboPrebookRequestSchema,
        responseSchema: TboPrebookEnvelopeSchema,
        ...(query.signal === undefined ? {} : { signal: query.signal }),
      },
    );
    if (result.outcome !== 'SUCCESS') {
      // Inalcanzable con la tabla actual: sólo Search lee un 201 como vacío. Si alguien cambia la
      // fila, un PreBook "vacío" no puede pasar por una revalidación.
      throw new TboResponseMappingError(
        PREBOOK_PATH,
        ['Status.Code:no_availability'],
        result.requestId,
      );
    }
    const mapping = mapTboPrebookResponse(
      result.data,
      {
        hotelCode: input.hotelCode,
        bookingCode: input.bookingCode,
        searchId: input.searchId,
        searchSentAt: input.searchSentAt,
        rooms: input.rooms,
        requestId: result.requestId,
      },
      { metrics: this.#metrics, logger: this.#logger },
    );
    return {
      ...mapping,
      requestId: result.requestId,
      accountRef: this.#client.accountRef,
      attempts: result.attempts,
      durationMs: result.durationMs,
    };
  }

  /**
   * `HotelBookPort`. `offer.offerRef` es el `BookingCode` del PreBook de revalidación,
   * `bookingReference` nuestra referencia ya persistida y `payment` tiene que ser
   * `{ kind: 'agency-credit' }`; el literal de `TotalFare`, el instante del Search y la ocupación van
   * en `providerOptions` ({@link TboBookProviderOptions}).
   *
   * Devuelve `CONFIRMED` o `UNCERTAIN`. Nunca `FAILED`: un rechazo de TBO se lanza como `TboApiError`
   * para que el breaker lo vea, y "una excepción tampoco es FAILED" (puerto). Quien llama lo
   * clasifica con `classifyTboBookOutcome`.
   */
  async book(request: HotelBookRequest, ctx: SearchContext): Promise<HotelBookResult> {
    return (await this.bookReport(bookQueryFromPort(request), ctx)).result;
  }

  /**
   * Book con `PaymentMode: "Limit"`, UN intento y 120 s (p. 8; BK-07). Lanza, sin llamar a TBO,
   * `TboOfferExpiredError` si la ventana venció en nuestro reloj y `TboRequestBuildError` si la
   * consulta no tiene forma, los huéspedes no cuadran con la ocupación, el `TotalFare` no se puede
   * mandar exacto o la referencia es de otro entorno. Después, lo que decida el cliente por
   * `Status.Code`; con `200`, la clasificación de la respuesta.
   */
  async bookReport(query: TboBookQuery, _ctx: SearchContext): Promise<TboBookReport> {
    const shape = BookQueryShapeSchema.safeParse(query);
    if (!shape.success) {
      throw new TboRequestBuildError(BOOK_PATH, 'SCHEMA', zodIssueRefs(shape.error, 'query'));
    }
    const now = this.#now();
    const { searchSentAt } = shape.data;
    if (searchSentAt > now + SEARCH_SENT_AT_MAX_SKEW_MS) {
      throw new TboRequestBuildError(BOOK_PATH, 'SCHEMA', ['query.searchSentAt:in_the_future']);
    }
    const expiresAtMs = searchSentAt + TBO_OFFER_TTL_MS;
    if (now >= expiresAtMs) {
      this.#count('tbo.book.expired_locally', 1, { op: 'book' });
      throw new TboOfferExpiredError(new Date(expiresAtMs).toISOString());
    }
    this.#requireReferenceEnvironment(BOOK_PATH, query.bookingReferenceId);

    const body = buildTboBookRequest({
      bookingCode: query.bookingCode,
      bookingReferenceId: query.bookingReferenceId,
      totalFare: query.totalFare,
      rooms: query.rooms,
      occupancy: query.occupancy,
      contact: query.contact,
    });
    const expected = { clientReferenceId: query.bookingReferenceId };
    const started = this.#now();

    let reply: TboBookReply;
    let meta: { requestId: string; attempts: number; durationMs: number };
    try {
      const result = await this.#client.send('book', body, {
        requestSchema: TboBookRequestSchema,
        responseSchema: TboBookEnvelopeSchema,
      });
      if (result.outcome !== 'SUCCESS') {
        // Inalcanzable con la tabla actual: sólo Search lee un 201 como vacío. Si alguien cambia la
        // fila, un Book "vacío" no puede pasar por confirmado.
        throw new TboResponseMappingError(
          BOOK_PATH,
          ['Status.Code:no_availability'],
          result.requestId,
        );
      }
      reply = mapTboBookResponse(result.data, {
        metrics: this.#metrics,
        logger: this.#logger,
        requestId: result.requestId,
      });
      meta = {
        requestId: result.requestId,
        attempts: result.attempts,
        durationMs: result.durationMs,
      };
    } catch (err) {
      const classification = classifyTboBookOutcome({ kind: 'threw', error: err }, expected);
      this.#logBook(classification, query.bookingReferenceId, {
        durationMs: this.#now() - started,
        ...(err instanceof TboApiError || err instanceof TboResponseMappingError
          ? { requestId: err.requestId }
          : {}),
      });
      throw err;
    }

    const classification = classifyTboBookOutcome({ kind: 'answered', reply }, expected);
    this.#logBook(classification, query.bookingReferenceId, meta);
    const confirmed = classification.outcome === 'CONFIRMED';
    const warnings: string[] = confirmed ? [] : [classification.reason];
    if (reply.diagnostics.confirmationNumberMalformed) {
      warnings.push('confirmation-number-malformed');
    }
    if (reply.diagnostics.clientReferenceIdMalformed) {
      warnings.push('client-reference-malformed');
    }
    return {
      result: {
        outcome: confirmed ? 'CONFIRMED' : 'UNCERTAIN',
        // Un localizador de un Book incierto no se adopta: puede ser de otra reserva (03 §3.9).
        ...(confirmed && classification.confirmationNumber !== undefined
          ? { providerBookingId: classification.confirmationNumber }
          : {}),
        ...(reply.clientReferenceId === undefined
          ? {}
          : { bookingReference: reply.clientReferenceId }),
        providerStatus: String(reply.tboCode),
        warnings,
      },
      classification,
      reply: {
        ...(reply.confirmationNumber === undefined
          ? {}
          : { confirmationNumber: reply.confirmationNumber }),
        ...(reply.clientReferenceId === undefined
          ? {}
          : { clientReferenceId: reply.clientReferenceId }),
      },
      bookingReferenceId: query.bookingReferenceId,
      requestId: meta.requestId,
      accountRef: this.#client.accountRef,
      attempts: meta.attempts,
      durationMs: meta.durationMs,
      diagnostics: reply.diagnostics,
    };
  }

  /**
   * `HotelBookingReadPort`: BookingDetail por el localizador de TBO. Sin propósito, por el cupo de
   * fondo.
   */
  async getBooking(
    providerBookingId: string,
    ctx: SearchContext,
    options?: HotelBookingReadOptions,
  ): Promise<HotelBookingView> {
    return (
      await this.bookingDetailReport(
        { confirmationNumber: providerBookingId, ...detailPurposeOf(options) },
        ctx,
      )
    ).view;
  }

  /**
   * `HotelBookingByClientReferencePort`: BookingDetail por NUESTRA referencia, la única forma de
   * verificar un Book cuya respuesta no llegó (p. 42; RF-21). Sin propósito, por el cupo de dinero;
   * el job que verifica pide `verification`.
   */
  async getBookingByClientReference(
    bookingReference: string,
    ctx: SearchContext,
    options?: HotelBookingReadOptions,
  ): Promise<HotelBookingView> {
    return (
      await this.bookingDetailReport(
        { bookingReferenceId: bookingReference, ...detailPurposeOf(options) },
        ctx,
      )
    ).view;
  }

  /**
   * BookingDetail con `PaymentMode: "Limit"` y exactamente un identificador (RF-24). Lanza
   * `TboRequestBuildError` sin llamar a TBO si llegan los dos o ninguno, o si la referencia es de
   * otro entorno; `TboResponseMappingError` si un `200` no trae la reserva pedida; y los
   * `TboApiError` que no son un "no la tengo" ({@link NOT_FOUND_KINDS}).
   */
  async bookingDetailReport(
    query: TboBookingDetailQuery,
    _ctx: SearchContext,
  ): Promise<TboBookingDetailReport> {
    const lookup = lookupOf(query);
    const body = buildTboBookingDetailRequest(lookup);
    if (lookup.bookingReferenceId !== undefined) {
      this.#requireReferenceEnvironment(DETAIL_PATH, lookup.bookingReferenceId);
    }
    const purpose =
      query.purpose ?? (lookup.bookingReferenceId === undefined ? 'background' : 'recovery');
    const { lane, maxAttempts } = DETAIL_PURPOSES[purpose] ?? DETAIL_PURPOSES.background;
    const started = this.#now();
    const identifier =
      lookup.bookingReferenceId === undefined
        ? { confirmationNumber: lookup.confirmationNumber }
        : { bookingReferenceId: lookup.bookingReferenceId };

    try {
      const result = await this.#client.send('bookingDetail', body, {
        requestSchema: TboBookingDetailRequestSchema,
        responseSchema: TboBookingDetailEnvelopeSchema,
        lane,
        maxAttempts,
        ...(query.signal === undefined ? {} : { signal: query.signal }),
      });
      if (result.outcome !== 'SUCCESS') {
        throw new TboResponseMappingError(
          DETAIL_PATH,
          ['Status.Code:no_availability'],
          result.requestId,
        );
      }
      const mapping = mapTboBookingDetailResponse(
        result.data,
        { lookup, requestId: result.requestId },
        { metrics: this.#metrics, logger: this.#logger },
      );
      return {
        ...mapping,
        found: true,
        requestId: result.requestId,
        accountRef: this.#client.accountRef,
        attempts: result.attempts,
        durationMs: result.durationMs,
      };
    } catch (err) {
      if (
        !(err instanceof TboApiError) ||
        err.tboCode === undefined ||
        !NOT_FOUND_KINDS.has(err.kind)
      ) {
        throw err;
      }
      this.#count('tbo.booking_detail.not_found', 1, {
        op: 'bookingDetail',
        tbo_code: String(err.tboCode),
      });
      this.#log('warn', 'tbo.booking_detail.not_found', {
        provider: TBO_HOTELS_PROVIDER_CODE,
        op: 'bookingDetail',
        requestId: err.requestId,
        accountRef: this.#client.accountRef,
        tboCode: err.tboCode,
        kind: err.kind,
        ...identifier,
      });
      return {
        found: false,
        view: {
          found: false,
          ...(lookup.bookingReferenceId === undefined
            ? {}
            : { bookingReference: lookup.bookingReferenceId }),
          providerStatus: String(err.tboCode),
          warnings: [NOT_FOUND_WARNING],
        },
        tboCode: err.tboCode,
        failureKind: err.kind,
        requestId: err.requestId,
        accountRef: this.#client.accountRef,
        durationMs: this.#now() - started,
      };
    }
  }

  /** `HotelCancelPort`: la secuencia completa por el localizador de TBO. */
  async cancelBooking(
    request: HotelCancelRequest,
    ctx: SearchContext,
    options?: HotelCancelRequestOptions,
  ): Promise<HotelCancelResult> {
    const purpose = options?.purpose === 'interactive' ? 'interactive' : undefined;
    const query: TboCancelQuery = {
      confirmationNumber: request.providerBookingId,
      ...(purpose === undefined ? {} : { purpose }),
    };
    return (await this.cancelReport(query, ctx)).result;
  }

  /**
   * La cancelación de 04 §4.4, con lo que la post-venta necesita para registrarla (`cancelCode` para
   * `OrderCancellationAttempted`, las dos lecturas y sus `requestId`).
   *
   * Lanza, y sólo en estos casos:
   * - `TboRequestBuildError` (`/Cancel`) si el localizador no tiene forma: no sale nada;
   * - lo que lance la lectura PREVIA (path `/BookingDetail`): nada salió hacia `/Cancel`, así que la
   *   política lo trata como previo al write (RF-25 CA-4);
   * - lo que lance `/Cancel` salvo el `479`: `TboCancelOutcomeUnknownError` con path `/Cancel` para
   *   todo lo que pasó por el cable (cualquier otro `Status.Code`, timeout, red, HTTP de error), que
   *   la política deja `UNVERIFIED` (HARD-1); `TboCancelMappingError` si la respuesta o su
   *   `Status.Code` no se pueden leer; `TboDispatchRejectedError` si el limitador no lo despachó.
   *
   * La lectura posterior hace un intento y nunca lanza: si falla, el resultado lo dice con un aviso
   * y el `200` sigue siendo un `200` (C-05).
   */
  async cancelReport(query: TboCancelQuery, ctx: SearchContext): Promise<TboCancelReport> {
    const started = this.#now();
    const body = buildTboCancelRequest(query.confirmationNumber);
    const confirmationNumber = body.ConfirmationNumber;
    const base = { confirmationNumber, accountRef: this.#client.accountRef };

    const before = await this.#readForCancel(confirmationNumber, ctx, query.purpose);
    const preflight = decideTboCancelPreflight(before.view);
    if (!preflight.send) {
      const report: TboCancelReport = {
        ...base,
        result: preflight.result,
        sent: false,
        skipReason: preflight.skipReason,
        before,
        durationMs: this.#now() - started,
      };
      this.#logCancel(report, preflight.skipReason);
      return report;
    }

    let observation: TboCancelObservation;
    let cancelRequestId: string | undefined;
    try {
      const sent = await this.#client.send('cancel', body, {
        requestSchema: TboCancelRequestSchema,
        responseSchema: TboCancelEnvelopeSchema,
      });
      cancelRequestId = sent.requestId;
      // Inalcanzable con la tabla actual: sólo Search lee un 201 como vacío. Si alguien cambia la
      // fila, un Cancel "vacío" no dice si se aplicó: es ilegible, no aceptado ni rechazado.
      observation =
        sent.outcome === 'SUCCESS'
          ? { kind: 'answered', envelope: sent.data }
          : {
              kind: 'threw',
              error: new TboCancelMappingError(
                CANCEL_PATH,
                ['Status.Code:no_availability'],
                sent.requestId,
              ),
            };
    } catch (err) {
      cancelRequestId = requestIdOf(err);
      observation = { kind: 'threw', error: err };
    }

    let reply: TboCancelReply;
    try {
      reply = mapTboCancelResponse(
        observation,
        {
          confirmationNumber,
          ...(cancelRequestId === undefined ? {} : { requestId: cancelRequestId }),
        },
        { metrics: this.#metrics, logger: this.#logger },
      );
    } catch (err) {
      this.#logCancelThrew(confirmationNumber, err, this.#now() - started);
      throw err;
    }

    const after = await this.#readAfterCancel(confirmationNumber, ctx);
    const report: TboCancelReport = {
      ...base,
      result: decideTboCancelResult(
        reply,
        after.state === 'read' ? { state: 'read', view: after.view } : { state: 'failed' },
      ),
      sent: true,
      cancelCode: reply.tboCode,
      ...(cancelRequestId === undefined ? {} : { cancelRequestId }),
      before,
      after,
      durationMs: this.#now() - started,
    };
    this.#logCancel(report, reply.success ? 'ACCEPTED' : 'REJECTED');
    return report;
  }

  /**
   * `BookingDetailsbasedondate` de UNA ventana de hasta 60 días (RF-28). Lanza, sin llamar a TBO,
   * `TboRequestBuildError` si la ventana no vale; después, todo lo que no sea un `200` legible
   * (nunca es "no hay reservas", PV-26) y `TboResponseMappingError` si alguna fila cae fuera de la
   * ventana o no se puede cruzar.
   */
  async listBookingsByDateReport(
    query: TboBookingsByDateQuery,
    _ctx: SearchContext,
  ): Promise<TboBookingsByDateReport> {
    const body = buildTboBookingsByDateRequest(query);
    const window = { fromDate: body.FromDate, toDate: body.ToDate };
    const result = await this.#client.send('bookingDetailsByDate', body, {
      requestSchema: TboBookingsByDateRequestSchema,
      responseSchema: TboBookingsByDateEnvelopeSchema,
    });
    if (result.outcome !== 'SUCCESS') {
      // Inalcanzable con la tabla actual; si alguien cambia la fila, un 201 tampoco es "vacío".
      throw new TboResponseMappingError(
        BY_DATE_PATH,
        ['Status.Code:no_availability'],
        result.requestId,
      );
    }
    const mapping = mapTboBookingsByDateResponse(
      result.data,
      { window, requestId: result.requestId },
      { metrics: this.#metrics, logger: this.#logger },
    );
    this.#log('info', 'tbo.bookings_by_date.read', {
      provider: TBO_HOTELS_PROVIDER_CODE,
      op: 'bookingDetailsByDate',
      requestId: result.requestId,
      accountRef: this.#client.accountRef,
      ...window,
      bookingCount: mapping.bookings.length,
      durationMs: result.durationMs,
    });
    return {
      ...mapping,
      requestId: result.requestId,
      accountRef: this.#client.accountRef,
      attempts: result.attempts,
      durationMs: result.durationMs,
    };
  }

  /** Lectura previa al Cancel. Lanza: un fallo aquí es previo al write y se puede reintentar. */
  async #readForCancel(
    confirmationNumber: string,
    ctx: SearchContext,
    purpose: TboCancelReadPurpose | 'after-cancel' = 'background',
  ): Promise<Extract<TboCancelReading, { state: 'read' }>> {
    const report = await this.bookingDetailReport({ confirmationNumber, purpose }, ctx);
    return { state: 'read', view: report.view, requestId: report.requestId };
  }

  /**
   * Lectura posterior al Cancel, con un solo intento. NUNCA lanza (04 §4.3): una excepción con path
   * `/BookingDetail` después de un write la política la leería como previa al envío y habilitaría un
   * segundo Cancel.
   */
  async #readAfterCancel(
    confirmationNumber: string,
    ctx: SearchContext,
  ): Promise<TboCancelReading> {
    try {
      return await this.#readForCancel(confirmationNumber, ctx, 'after-cancel');
    } catch (err) {
      const requestId = requestIdOf(err);
      return {
        state: 'failed',
        errorClass: err instanceof Error ? err.name : 'unknown',
        ...(err instanceof TboApiError ? { kind: err.kind } : {}),
        ...(requestId === undefined ? {} : { requestId }),
      };
    }
  }

  /** Una línea por cancelación: localizador, desenlace y códigos, nunca un cuerpo (01 §11.1). */
  #logCancel(
    report: TboCancelReport,
    outcome: TboCancelSkipReason | 'ACCEPTED' | 'REJECTED',
  ): void {
    const { result } = report;
    const settled =
      outcome === 'ACCEPTED' ||
      outcome === 'ALREADY_CANCELLED' ||
      outcome === 'ALREADY_IN_PROGRESS';
    const level = settled && report.after?.state !== 'failed' ? 'info' : 'warn';
    this.#count('tbo.cancel.outcome', 1, {
      op: 'cancel',
      outcome,
      success: String(result.success),
    });
    this.#log(level, 'tbo.cancel.outcome', {
      provider: TBO_HOTELS_PROVIDER_CODE,
      op: 'cancel',
      path: CANCEL_PATH,
      accountRef: report.accountRef,
      confirmationNumber: report.confirmationNumber,
      outcome,
      durationMs: report.durationMs,
      ...(report.cancelCode === undefined ? {} : { tboCode: report.cancelCode }),
      ...(report.cancelRequestId === undefined ? {} : { requestId: report.cancelRequestId }),
      ...(result.providerStatus === undefined ? {} : { providerStatus: result.providerStatus }),
      ...(result.warnings.length === 0 ? {} : { warnings: result.warnings }),
      ...(report.after?.state === 'failed' ? { errorClass: report.after.errorClass } : {}),
    });
  }

  /** `error`: lo que lanzó `/Cancel` puede haberse aplicado (01 §11.1). */
  #logCancelThrew(confirmationNumber: string, err: unknown, durationMs: number): void {
    const requestId = requestIdOf(err);
    this.#count('tbo.cancel.outcome', 1, { op: 'cancel', outcome: 'THREW', success: 'false' });
    this.#log('error', 'tbo.cancel.outcome', {
      provider: TBO_HOTELS_PROVIDER_CODE,
      op: 'cancel',
      path: CANCEL_PATH,
      accountRef: this.#client.accountRef,
      confirmationNumber,
      outcome: 'THREW',
      durationMs,
      errorClass: err instanceof Error ? err.name : 'unknown',
      ...(err instanceof TboApiError ? { kind: err.kind, status: err.status } : {}),
      ...(err instanceof TboApiError && err.tboCode !== undefined ? { tboCode: err.tboCode } : {}),
      ...(requestId === undefined ? {} : { requestId }),
    });
  }

  /**
   * Una referencia de producción no sale por la cuenta de test ni al revés: el entorno va escrito en
   * la propia referencia (`booking-reference.ts`). Una referencia que no es nuestra la rechaza el
   * builder con su propio motivo.
   */
  #requireReferenceEnvironment(path: string, reference: string): void {
    const environment = tboBookingReferenceEnvironment(reference);
    if (environment !== undefined && environment !== this.#client.environment) {
      throw new TboRequestBuildError(path, 'SCHEMA', ['bookingReferenceId:environment_mismatch']);
    }
  }

  /**
   * Una línea por Book: sólo path, código, duración y referencias (03 §4.2 punto 2). `error` si el
   * desenlace es incierto: hay una verificación obligatoria pendiente (01 §11.1).
   */
  #logBook(
    classification: TboBookClassification,
    bookingReferenceId: string,
    meta: { readonly requestId?: string; readonly durationMs: number },
  ): void {
    const level =
      classification.outcome === 'UNCERTAIN'
        ? 'error'
        : classification.outcome === 'FAILED'
          ? 'warn'
          : 'info';
    this.#count('tbo.book.outcome', 1, {
      op: 'book',
      outcome: classification.outcome,
      reason: classification.reason,
    });
    this.#log(level, 'tbo.book.outcome', {
      provider: TBO_HOTELS_PROVIDER_CODE,
      op: 'book',
      path: BOOK_PATH,
      accountRef: this.#client.accountRef,
      bookingReferenceId,
      outcome: classification.outcome,
      reason: classification.reason,
      durationMs: meta.durationMs,
      ...(meta.requestId === undefined ? {} : { requestId: meta.requestId }),
      ...(classification.tboCode === undefined ? {} : { tboCode: classification.tboCode }),
      ...(classification.errorClass === undefined ? {} : { errorClass: classification.errorClass }),
      ...(classification.confirmationNumber === undefined
        ? {}
        : { confirmationNumber: classification.confirmationNumber }),
    });
  }

  async #search(criteria: TboSearchCriteria, detailed: boolean): Promise<TboSearchReport> {
    const startedAt = this.#now();
    const run: SearchRun = {
      searchId: this.#uuid(),
      startedAt,
      deadline: startedAt + tboSearchTimeoutMs(this.#policy.responseTimeSeconds),
      detailed,
      criteria,
    };

    // Deduplicar ANTES de partir: un código repetido en dos lotes se pediría dos veces. Se conserva
    // el primer orden de aparición, que es el de relevancia (02 §4.3).
    const unique = [...new Set(criteria.hotelIds)];
    const limit = detailed ? 1 : this.#policy.maxHotelCodes;
    const kept = unique.slice(0, limit);
    const omittedHotelCodes = unique.length - kept.length;
    const groups = detailed ? [kept] : chunk(kept, this.#policy.batchSize);

    // Todos los bodies se arman antes de despachar nada: un criterio que TBO no admite (sin
    // nacionalidad, 5 niños, un código con coma) lanza `TboRequestBuildError` sin que haya salido
    // ningún lote. Sin códigos, el builder dice `hotelIds:too_small`.
    const bodies = (groups.length > 0 ? groups : [[]]).map((codes) =>
      this.#build(run, codes, this.#policy.responseTimeSeconds),
    );

    const outcomes: BatchOutcome[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let index = next++; index < groups.length; index = next++) {
        const codes = groups[index] ?? [];
        const body = bodies[index];
        if (body === undefined) continue;
        outcomes[index] = await this.#batch(run, index, codes, body);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#policy.concurrency, groups.length) }, worker),
    );
    const ordered = outcomes.filter((outcome): outcome is BatchOutcome => outcome !== undefined);

    const answered = ordered.filter((o) => o.status === 'ok' || o.status === 'empty');
    if (answered.length === 0) {
      // Ningún lote respondió: TBO falla entero con el motivo del primero, que es el que salió con
      // el plazo completo.
      const first = ordered.find((o) => o.error !== undefined)?.error;
      if (first !== undefined) throw first;
    }

    const report = this.#assemble(run, ordered, omittedHotelCodes);
    this.#observe(run, report, unique.length);

    // D-TBO-15 A (RF-07 CA-4): si lo único que TBO trajo está en una moneda que `Money` no
    // representa, TBO queda no disponible para esta cuenta con motivo, no "sin disponibilidad".
    if (report.offers.length === 0 && report.diagnostics.unsupportedCurrencies.length > 0) {
      this.#count('tbo.search.unsupported_currency', 1, { op: 'search' });
      throw new TboUnsupportedCurrencyError(report.diagnostics.unsupportedCurrencies);
    }
    return report;
  }

  #build(run: SearchRun, codes: readonly string[], responseTimeSeconds: number): TboSearchRequest {
    const { criteria } = run;
    return buildTboSearchRequest(
      {
        checkinDate: criteria.checkinDate,
        checkoutDate: criteria.checkoutDate,
        guestNationality: criteria.guestNationality,
        refundableOnly: criteria.refundableOnly,
        rooms: criteria.rooms,
        hotelIds: codes,
      },
      {
        detailed: run.detailed,
        responseTimeSeconds,
        emptyChildrenAges: this.#policy.emptyChildrenAges,
      },
    );
  }

  /** Un lote: nunca lanza un `TboError`, lo devuelve como estado del lote. */
  async #batch(
    run: SearchRun,
    index: number,
    codes: readonly string[],
    prebuilt: TboSearchRequest,
  ): Promise<BatchOutcome> {
    const dispatchAt = this.#now();
    const remaining = run.deadline - dispatchAt;
    const base = { index, hotelCodeCount: codes.length };
    const responseTime = responseTimeWithin(remaining, this.#policy.responseTimeSeconds);

    if (responseTime < TBO_SEARCH_RESPONSE_TIME_S.min) {
      return this.#settled(run, {
        ...base,
        status: 'not-dispatched',
        durationMs: 0,
        error: new TboDispatchRejectedError(SEARCH_PATH, 'DEADLINE', dispatchAt - run.startedAt),
      });
    }

    try {
      const body =
        responseTime === prebuilt.ResponseTime ? prebuilt : this.#build(run, codes, responseTime);
      const result = await this.#client.send('search', body, {
        timeoutMs: remaining,
        responseSchema: TboSearchEnvelopeSchema,
      });
      const durationMs = this.#now() - dispatchAt;
      if (result.outcome === 'NO_AVAILABILITY') {
        return this.#settled(run, {
          ...base,
          status: 'empty',
          requestId: result.requestId,
          durationMs,
        });
      }
      const mapping = mapTboSearchResponse(
        result.data,
        { searchId: run.searchId, searchSentAt: run.startedAt, rooms: run.criteria.rooms },
        { metrics: this.#metrics, logger: this.#logger },
      );
      return this.#settled(run, {
        ...base,
        status: 'ok',
        requestId: result.requestId,
        durationMs,
        mapping,
      });
    } catch (err) {
      // Lo que no es de TBO es un bug nuestro y no se disfraza de lote fallido.
      if (!(err instanceof TboError)) throw err;
      const requestId =
        'requestId' in err && typeof err.requestId === 'string' ? err.requestId : undefined;
      return this.#settled(run, {
        ...base,
        status: err instanceof TboDispatchRejectedError ? 'not-dispatched' : 'failed',
        ...(requestId === undefined ? {} : { requestId }),
        durationMs: this.#now() - dispatchAt,
        error: err,
      });
    }
  }

  #settled(run: SearchRun, outcome: BatchOutcome): BatchOutcome {
    this.#count('tbo.search.batch', 1, {
      op: 'search',
      detailed: String(run.detailed),
      status: outcome.status,
    });
    return outcome;
  }

  /** Une los lotes en el orden de relevancia; un hotel no se repite ni un `BookingCode` tampoco. */
  #assemble(
    run: SearchRun,
    outcomes: readonly BatchOutcome[],
    omittedHotelCodes: number,
  ): TboSearchReport {
    const offers = new Map<string, HotelOffer>();
    const packs: TboSearchPackContext[] = [];
    const seen = new Set<string>();
    const mappings: TboSearchDiagnostics[] = [];
    let duplicates = 0;

    for (const outcome of outcomes) {
      if (outcome.mapping === undefined) continue;
      mappings.push(outcome.mapping.diagnostics);
      const contexts = new Map(outcome.mapping.packs.map((pack) => [pack.bookingCode, pack]));
      for (const offer of outcome.mapping.offers) {
        for (const pack of offer.roompacks) {
          if (seen.has(pack.id)) {
            duplicates += 1;
            continue;
          }
          seen.add(pack.id);
          const context = contexts.get(pack.id);
          if (context !== undefined) packs.push(context);
          const merged = offers.get(offer.hotelId);
          if (merged === undefined) {
            offers.set(offer.hotelId, { ...offer, roompacks: [pack] });
          } else {
            merged.roompacks.push(pack);
          }
        }
      }
    }

    const diagnostics = mergeDiagnostics(mappings);
    const reports: TboSearchBatchReport[] = outcomes.map(
      ({ mapping: _mapping, ...report }) => report,
    );
    return {
      offers: [...offers.values()],
      searchId: run.searchId,
      searchSentAt: run.startedAt,
      accountRef: this.#client.accountRef,
      packs,
      batches: reports,
      partial: outcomes.some((o) => o.status === 'failed' || o.status === 'not-dispatched'),
      omittedHotelCodes,
      diagnostics:
        duplicates === 0
          ? diagnostics
          : {
              ...diagnostics,
              packsMapped: diagnostics.packsMapped - duplicates,
              packsRejected: {
                ...diagnostics.packsRejected,
                DUPLICATE_BOOKING_CODE:
                  (diagnostics.packsRejected.DUPLICATE_BOOKING_CODE ?? 0) + duplicates,
              },
            },
    };
  }

  #observe(run: SearchRun, report: TboSearchReport, hotelCodeCount: number): void {
    const meta = {
      provider: TBO_HOTELS_PROVIDER_CODE,
      op: 'search',
      detailed: run.detailed,
      searchId: run.searchId,
      accountRef: report.accountRef,
      hotelCodeCount,
      batchCount: report.batches.length,
    };
    if (report.omittedHotelCodes > 0) {
      this.#count('tbo.search.codes_omitted', report.omittedHotelCodes, { op: 'search' });
      this.#log('warn', 'tbo.search.codes_omitted', {
        ...meta,
        omittedHotelCodeCount: report.omittedHotelCodes,
      });
    }
    if (report.partial) {
      const failed = report.batches.filter((b) => b.error !== undefined);
      this.#count('tbo.search.partial', 1, { op: 'search', detailed: String(run.detailed) });
      this.#log('warn', 'tbo.search.partial', {
        ...meta,
        failedBatchCount: failed.length,
        issues: failed.map(batchIssue),
      });
    }
  }

  #count(name: string, value: number, tags: Record<string, string>): void {
    this.#safely(() => this.#metrics?.counter(name, value, tags));
  }

  #log(level: 'info' | 'warn' | 'error', message: string, meta: Record<string, unknown>): void {
    const logger = this.#logger;
    if (logger === undefined) return;
    this.#safely(() => logger[level](message, pickTboLogMeta(meta)));
  }

  /** La observabilidad nunca cambia el desenlace: un logger que lanza no le quita tarifas a nadie. */
  #safely(run: () => void): void {
    try {
      run();
    } catch {
      // Se descarta a propósito: no hay a dónde reportar un fallo del propio canal de reporte.
    }
  }
}
