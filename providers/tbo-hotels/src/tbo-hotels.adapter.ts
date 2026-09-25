import type { HotelOffer, HotelRatesQuery, HotelSearchCriteria } from '@sales-travel/canonical';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import type { HotelRatesDetailPort, HotelSearchPort, SearchContext } from '@sales-travel/domain';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireUsableTboConfig, type TboHotelsConfig } from './config';
import {
  TboApiError,
  TboConfigError,
  TboDispatchRejectedError,
  TboError,
  TboUnsupportedCurrencyError,
} from './errors';
import { TBO_LIMITER_DEFAULTS } from './http/limiter';
import {
  TBO_OPERATIONS,
  TBO_SEARCH_RESPONSE_TIME_S,
  TBO_SEARCH_TIMEOUT_MARGIN_MS,
  tboSearchTimeoutMs,
} from './http/operations';
import { TboHttpClient, type TboAccountContext, type TboHttpDeps } from './http/tbo-http.client';
import { zodIssueRefs } from './internal/zod-issues';
import { TBO_HOTELS_PROVIDER_CODE } from './provider-code';
import { pickTboLogMeta } from './redaction';
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

// Tipos NUESTROS que produce el mapper, no crudos de TBO: el reporte de búsqueda los expone para
// el contexto del servidor (RF-08). El mapper, que recibe el sobre crudo, sigue sin publicarse.
export type {
  TboHotelRejection,
  TboPackRejection,
  TboSearchDiagnostics,
  TboSearchPackContext,
} from './search/response.mapper';

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

// ───────────────────────── Adapter ─────────────────────────

export class TboHotelsAdapter implements HotelSearchPort, HotelRatesDetailPort {
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

  #log(level: 'warn', message: string, meta: Record<string, unknown>): void {
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
