import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { z, type ZodType, type ZodTypeDef } from 'zod';
import { requireUsableTboConfig, type TboHotelsConfig } from './config';
import {
  TboApiError,
  TboConfigError,
  TboDispatchRejectedError,
  TboRequestBuildError,
  TboResponseMappingError,
  type TboFailureKind,
} from './errors';
import { TBO_OPERATIONS } from './http/operations';
import {
  TBO_SLOW_NO_HOTELS_FOUND_MS,
  TboHttpClient,
  type TboAccountContext,
  type TboHttpDeps,
  type TboHttpResult,
} from './http/tbo-http.client';
import { zodIssueRefs } from './internal/zod-issues';
import { TBO_HOTELS_PROVIDER_CODE } from './provider-code';
import { pickTboLogMeta } from './redaction';
import { buildTboCityListRequest } from './static/city-list.request.builder';
import { mapTboCityListResponse } from './static/city-list.response.mapper';
import type {
  TboCityHotelsMapping,
  TboCityListMapping,
  TboContentLanguage,
  TboCountryListMapping,
  TboHotelCodeListMapping,
  TboHotelDetailsMapping,
} from './static/content.types';
import { mapTboCountryListResponse } from './static/country-list.response.mapper';
import { mapTboHotelCodeListResponse } from './static/hotel-code-list.response.mapper';
import { buildTboHotelDetailsRequest } from './static/hotel-details.request.builder';
import {
  emptyTboHotelDetailsMapping,
  mapTboHotelDetailsResponse,
} from './static/hotel-details.response.mapper';
import type { TboStaticOperation } from './static/observer';
import {
  TBO_PROCESS_ROOM_DETAIL_GATE,
  TBO_ROOM_DETAILS_SWITCH_VALUES,
  TboRoomDetailGate,
  type TboRoomDetailRejectionReason,
  type TboRoomDetailStatus,
  type TboRoomDetailsSwitch,
} from './static/room-detail.gate';
import {
  TboCityHotelsEnvelopeSchema,
  TboCityListEnvelopeSchema,
  TboCountryListEnvelopeSchema,
  TboHotelCodeListEnvelopeSchema,
  TboHotelDetailsEnvelopeSchema,
} from './static/response.schema';
import { buildTboCityHotelsRequest } from './static/tbo-hotel-code-list.request.builder';
import {
  emptyTboCityHotelsMapping,
  mapTboCityHotelsResponse,
} from './static/tbo-hotel-code-list.response.mapper';

export type { TboStaticOperation } from './static/observer';

/**
 * Cliente de contenido estático de TBO (docs/tbo/09 PR-3.1; 06 §4.2; 05 §2 y §6; 08 RF-30 y
 * RF-32). Es la superficie que usa el sync de catálogo, y la única que necesita.
 *
 * - **Sólo métodos de contenido, sin venta.** El sync corre en otro proceso y con la cuenta de
 *   plataforma (05 §6.6): exponerle sólo `CountryList`, `CityList`, `TBOHotelCodeList`,
 *   `HotelDetails` y `hotelcodelist` hace que no pueda buscar, reservar ni cancelar aunque alguien
 *   lo cablee mal. El cliente HTTP vive en un campo privado y no se alcanza desde fuera.
 * - **Todo sale normalizado** a los tipos de `static/content.types.ts`: HTML saneado, estrellas
 *   1-5, coordenadas validadas, imágenes `https`. El JSON de TBO no sale de aquí (RF-07 CA-6).
 * - **Cupo de fondo.** Las cinco operaciones van al cupo `background` del limitador de la cuenta,
 *   así que una corrida del sync nunca le quita capacidad a una búsqueda o a un Book (01 §7.2).
 * - **Reintentos**: los del cliente HTTP, que en lecturas sólo repite ante 429, 500, cuerpo roto o
 *   fallos de transporte y con backoff (06 §4.3 regla 7). Partir un lote de HotelDetails que falla
 *   es del sync; pedir el respaldo en inglés o partir un lote sin contenido, de
 *   `resolveTboHotelDetails`.
 * - **Ciudad sin hoteles**: TBOHotelCodeList la contesta con `Status.Code` 500 "No Hotels Found"
 *   (producción, 2026-09-29). Si llega antes de `slowNoHotelsFoundMs` es una lista vacía en UNA
 *   llamada, sin reintento ni `warn`; si tarda eso o más es el plazo interno de TBO vencido y se
 *   reintenta como el `UPSTREAM` que es: agotados los intentos, la ciudad falla, no queda vacía
 *   (01 §8.5).
 * - **Lote sin contenido**: HotelDetails contesta igual un lote del que no tiene nada en ese idioma
 *   (producción, 2026-09-30; 05 CE-23). Con la misma regla de tiempo sale como resultado tipado
 *   `NO_HOTELS_FOUND`, sin reintento, sin error y sin sumar al breaker ni a la racha del sync; lento
 *   sigue siendo `UPSTREAM`.
 * - **Detalle por habitación** (`roomDetail`, p. 56-57; Q-65): sólo si quien llama lo pide, con el
 *   interruptor `roomDetails` encendido y la compuerta del proceso abierta (`static/room-detail.gate`).
 *   El contenido del hotel nunca empeora por pedirlo: si con la clave TBO falla, contesta "No
 *   Hotels Found" o le faltan hoteles, el mismo lote se repite SIN la clave y se devuelve lo que
 *   traiga; si sin la clave trae hoteles que con ella no vinieron, es un rechazo, y tres seguidos
 *   la suspenden en el proceso.
 */

/**
 * Timeouts de partida de 05 §10 (INFERIDO; Q-09). La configuración del sync sólo puede ACORTARLOS:
 * el techo de cada operación es el de `TBO_OPERATIONS` (08 §9 C-14). El de HotelDetails queda por
 * debajo de sus 60 s.
 */
export const TBO_STATIC_TIMEOUTS_MS: Readonly<Record<TboStaticOperation, number>> = Object.freeze({
  countryList: 30_000,
  cityList: 30_000,
  tboHotelCodeList: 60_000,
  hotelDetails: 45_000,
  hotelCodeList: 180_000,
});

export interface TboStaticContentOptions {
  /** Por operación; sólo acortan (el cliente HTTP recorta al techo de la tabla). */
  readonly timeoutsMs?: Partial<Record<TboStaticOperation, number>>;
  /** `IsDetailedResponse` de TBOHotelCodeList; `true` por defecto hasta cerrar Q-63. */
  readonly detailedCityHotels?: boolean;
  /**
   * Desde cuántos ms el "No Hotels Found" de TBOHotelCodeList deja de ser la ciudad sin hoteles y
   * se reintenta como `UPSTREAM` (01 §8.5). Por defecto `TBO_SLOW_NO_HOTELS_FOUND_MS` (4.500),
   * elegido con el log del 2026-09-29; se mide por intento, del envío al último byte del cuerpo.
   */
  readonly slowNoHotelsFoundMs?: number;
  /**
   * Interruptor del detalle por habitación (`TBO_ROOM_DETAILS`): `on` por defecto. Con `off` nunca
   * sale `IsRoomDetailRequired`, aunque quien llama lo pida.
   */
  readonly roomDetails?: TboRoomDetailsSwitch;
  /** La racha de rechazos del detalle por habitación: la del proceso, o una propia en los tests. */
  readonly roomDetailGate?: TboRoomDetailGate;
}

/** Lo que se le pide a HotelDetails además de los códigos y el idioma. */
export interface TboHotelDetailsOptions {
  /**
   * Pedir el detalle por habitación (`IsRoomDetailRequired: true`). Lo que se obtuvo lo dice
   * `roomDetail` del resultado: sólo con `served` las habitaciones son la respuesta de TBO.
   */
  readonly roomDetail?: boolean;
}

/** Por llamada: la señal de quien corta la corrida y, si hace falta, un plazo o intentos menores. */
export interface TboStaticCallOptions {
  readonly signal?: AbortSignal;
  /** Sólo acorta el timeout configurado. */
  readonly timeoutMs?: number;
  /** Sólo acorta los intentos de la tabla. */
  readonly maxAttempts?: number;
}

/** De la llamada HTTP: para ubicar el RQ/RS en la bóveda de payloads y medir la corrida. */
export interface TboStaticCall {
  readonly requestId: string;
  readonly durationMs: number;
  readonly attempts: number;
}

export type TboCountryListResult = TboCountryListMapping & TboStaticCall;
export type TboCityListResult = TboCityListMapping & TboStaticCall;
export type TboCityHotelsResult = TboCityHotelsMapping & TboStaticCall;
export type TboHotelDetailsResult = TboHotelDetailsMapping &
  TboStaticCall & {
    /** Qué pasó con el detalle por habitación (`static/room-detail.gate.ts`). */
    readonly roomDetail: TboRoomDetailStatus;
  };
export type TboHotelCodeListResult = TboHotelCodeListMapping & TboStaticCall;

export interface TboCityHotelsQuery {
  /** ISO2 del país de la ciudad: respaldo del `CountryCode` de cada hotel (05 §3). */
  readonly countryCode?: string;
}

const PositiveMs = z.number().int().min(1);

const OptionsSchema = z
  .object({
    timeoutsMs: z
      .object({
        countryList: PositiveMs.optional(),
        cityList: PositiveMs.optional(),
        tboHotelCodeList: PositiveMs.optional(),
        hotelDetails: PositiveMs.optional(),
        hotelCodeList: PositiveMs.optional(),
      })
      .strict()
      .optional(),
    detailedCityHotels: z.boolean().optional(),
    slowNoHotelsFoundMs: PositiveMs.optional(),
    roomDetails: z.enum(TBO_ROOM_DETAILS_SWITCH_VALUES).optional(),
    roomDetailGate: z.instanceof(TboRoomDetailGate).optional(),
  })
  .strict();

interface StaticPolicy {
  readonly timeoutsMs: Readonly<Record<TboStaticOperation, number>>;
  readonly detailedCityHotels: boolean;
  readonly slowNoHotelsFoundMs: number;
  readonly roomDetails: TboRoomDetailsSwitch;
  readonly roomDetailGate: TboRoomDetailGate;
}

/**
 * Fallos de la llamada con `IsRoomDetailRequired` que no se repiten sin la clave: son de la cuenta
 * o del cupo, no de la clave, y el lote sin ella fallaría igual.
 */
const ACCOUNT_FAILURES: ReadonlySet<TboFailureKind> = new Set<TboFailureKind>([
  'CREDENTIALS_INVALID',
  'ACCOUNT_BLOCKED',
  'THROTTLED',
]);

/** Opciones inválidas son un error de configuración del despliegue: sólo `ruta:código`. */
function resolvePolicy(options: TboStaticContentOptions): StaticPolicy {
  const parsed = OptionsSchema.safeParse(options);
  if (!parsed.success) throw new TboConfigError(zodIssueRefs(parsed.error, 'options'));
  const configured = parsed.data.timeoutsMs ?? {};
  const timeoutsMs = { ...TBO_STATIC_TIMEOUTS_MS };
  for (const op of Object.keys(timeoutsMs) as TboStaticOperation[]) {
    const value = configured[op];
    if (value !== undefined) timeoutsMs[op] = Math.min(value, TBO_STATIC_TIMEOUTS_MS[op]);
  }
  return Object.freeze({
    timeoutsMs: Object.freeze(timeoutsMs),
    detailedCityHotels: parsed.data.detailedCityHotels ?? true,
    slowNoHotelsFoundMs: parsed.data.slowNoHotelsFoundMs ?? TBO_SLOW_NO_HOTELS_FOUND_MS,
    roomDetails: parsed.data.roomDetails ?? 'on',
    roomDetailGate: parsed.data.roomDetailGate ?? TBO_PROCESS_ROOM_DETAIL_GATE,
  });
}

/** La clase y el `kind` del fallo con la clave, para el log. Nunca su mensaje. */
function failureMeta(failure: unknown): Record<string, string> {
  if (failure instanceof TboApiError) return { errorClass: failure.name, kind: failure.kind };
  if (failure instanceof Error) return { errorClass: failure.name };
  return {};
}

function callMeta(result: TboHttpResult<unknown>): TboStaticCall {
  return {
    requestId: result.requestId,
    durationMs: result.durationMs,
    attempts: result.attempts,
  };
}

export class TboStaticContentClient {
  // Campos `#`, como el adapter: no se ven en `JSON.stringify` ni en `util.inspect`, y el cliente
  // HTTP —que sí sabe llamar a Book— no se alcanza desde fuera.
  readonly #client: TboHttpClient;
  readonly #policy: StaticPolicy;
  readonly #logger: LoggerPort | undefined;
  readonly #metrics: MetricsPort | undefined;

  /**
   * Falla al construir, con error tipado, si la cuenta no puede llamar a TBO o las opciones no
   * valen. El sync decide antes si hay credenciales (`skip`, 05 §6.6); esto es la red.
   */
  constructor(
    config: TboHotelsConfig,
    deps: TboHttpDeps = {},
    context: TboAccountContext = {},
    options: TboStaticContentOptions = {},
  ) {
    requireUsableTboConfig(config);
    this.#policy = resolvePolicy(options);
    this.#client = new TboHttpClient(config, deps, context);
    this.#logger = deps.logger;
    this.#metrics = deps.metrics;
  }

  /** Huella de la cuenta (`tboAccountRef`), nunca el usuario. */
  get accountRef(): string {
    return this.#client.accountRef;
  }

  /**
   * Si un `getHotelDetails` con `roomDetail` saldría hoy con `IsRoomDetailRequired`: el interruptor
   * en `on` y la compuerta del proceso abierta. Con `false`, pedir habitaciones sería gastar un
   * HotelDetails para traer sólo el contenido del hotel: quien sólo quiere las habitaciones no llama.
   */
  get roomDetailAvailable(): boolean {
    return this.#policy.roomDetails === 'on' && !this.#policy.roomDetailGate.suspended;
  }

  /** `GET CountryList` (p. 51). */
  async listCountries(call: TboStaticCallOptions = {}): Promise<TboCountryListResult> {
    const result = await this.#send('countryList', undefined, TboCountryListEnvelopeSchema, call);
    return { ...mapTboCountryListResponse(result.data, this.#mapDeps()), ...callMeta(result) };
  }

  /** `POST CityList` de un país ISO2 (p. 53). */
  async listCities(
    countryCode: string,
    call: TboStaticCallOptions = {},
  ): Promise<TboCityListResult> {
    const body = buildTboCityListRequest(countryCode);
    const result = await this.#send('cityList', body, TboCityListEnvelopeSchema, call);
    return {
      ...mapTboCityListResponse(result.data, { countryCode }, this.#mapDeps()),
      ...callMeta(result),
    };
  }

  /** `POST TBOHotelCodeList` de una ciudad (p. 65). */
  async listCityHotels(
    cityCode: string,
    query: TboCityHotelsQuery = {},
    call: TboStaticCallOptions = {},
  ): Promise<TboCityHotelsResult> {
    // El país sólo lo usa el mapper, pero se valida ANTES de gastar la llamada.
    if (query.countryCode !== undefined && !/^[A-Z]{2}$/.test(query.countryCode)) {
      throw new TboRequestBuildError(TBO_OPERATIONS.tboHotelCodeList.path, 'SCHEMA', [
        'query.countryCode:invalid_string',
      ]);
    }
    const body = buildTboCityHotelsRequest(cityCode, {
      detailedResponse: this.#policy.detailedCityHotels,
    });
    const context = {
      cityCode,
      ...(query.countryCode === undefined ? {} : { countryCode: query.countryCode }),
    };
    const result = await this.#call('tboHotelCodeList', body, TboCityHotelsEnvelopeSchema, call);
    if (result.outcome === 'NO_AVAILABILITY') {
      // Un "No Hotels Found" rápido: la ciudad existe y no tiene hoteles (01 §8.5). El lento ya
      // salió del cliente HTTP como `UPSTREAM`. Una línea `info` con la ciudad y lo que tardó, no
      // un `warn`: no es un fallo de TBO.
      const empty = emptyTboCityHotelsMapping(context, this.#mapDeps());
      this.#info('tbo.static.city_without_hotels', {
        op: 'tboHotelCodeList',
        cityCode: empty.cityCode,
        requestId: result.requestId,
        tboCode: result.tboCode,
        durationMs: result.durationMs,
        attempt: result.attempts,
      });
      return { ...empty, ...callMeta(result) };
    }
    return {
      ...mapTboCityHotelsResponse(result.data, context, this.#mapDeps()),
      ...callMeta(result),
    };
  }

  /**
   * `POST HotelDetails` de hasta 13 códigos en un idioma (p. 56). Un "No Hotels Found" rápido vuelve
   * con `outcome: 'NO_HOTELS_FOUND'` y todos los códigos en `missingHotelCodes`, no como error
   * (05 CE-23): qué hacer con ellos (respaldo en inglés, partir el lote) es de quien llama.
   *
   * Con `roomDetail` pide además el detalle por habitación, con las dos llaves del encabezado: lo
   * que se obtuvo lo dice `roomDetail` del resultado, y el contenido del hotel es, como mínimo, el
   * del pedido sin la clave.
   */
  async getHotelDetails(
    hotelCodes: readonly string[],
    lang: TboContentLanguage,
    call: TboStaticCallOptions = {},
    options: TboHotelDetailsOptions = {},
  ): Promise<TboHotelDetailsResult> {
    if (options.roomDetail !== true) {
      return this.#hotelDetails(hotelCodes, lang, call, false, 'not_requested');
    }
    if (this.#policy.roomDetails === 'off') {
      return this.#hotelDetails(hotelCodes, lang, call, false, 'switched_off');
    }
    const gate = this.#policy.roomDetailGate;
    if (gate.suspended) return this.#hotelDetails(hotelCodes, lang, call, false, 'suspended');
    return this.#hotelDetailsWithRooms(hotelCodes, lang, call, gate);
  }

  /**
   * El lote con `IsRoomDetailRequired` y, si TBO no lo acepta, el mismo lote sin la clave. La
   * llamada con la clave va con UN intento: el respaldo sin ella hace de reintento, y repetir con la
   * clave lo que TBO acaba de rechazar sólo gasta el plazo de quien espera.
   */
  async #hotelDetailsWithRooms(
    hotelCodes: readonly string[],
    lang: TboContentLanguage,
    call: TboStaticCallOptions,
    gate: TboRoomDetailGate,
  ): Promise<TboHotelDetailsResult> {
    // Un código ilegible es un bug de quien llama: falla aquí, antes del cable y sin respaldo.
    buildTboHotelDetailsRequest(hotelCodes, lang, { roomDetail: true });
    let withRooms: TboHotelDetailsResult | undefined;
    let failure: unknown;
    try {
      withRooms = await this.#hotelDetails(
        hotelCodes,
        lang,
        { ...call, maxAttempts: 1 },
        true,
        'served',
      );
    } catch (err) {
      if (!this.#roomDetailFallbackAllowed(err, call)) throw err;
      failure = err;
    }
    if (
      withRooms !== undefined &&
      withRooms.outcome === 'DETAILS' &&
      withRooms.missingHotelCodes.length === 0
    ) {
      gate.recordSuccess();
      return withRooms;
    }

    const reason: TboRoomDetailRejectionReason =
      withRooms === undefined
        ? 'error'
        : withRooms.outcome === 'NO_HOTELS_FOUND'
          ? 'no_hotels_found'
          : 'missing_hotels';
    let plain: TboHotelDetailsResult;
    try {
      plain = await this.#hotelDetails(hotelCodes, lang, call, false, 'fallback');
    } catch (err) {
      // Con la clave ya vino contenido de hotel: un fallo del respaldo no se lo quita a quien
      // espera. Los hoteles que faltaron siguen en `missingHotelCodes` para su respaldo de siempre.
      if (withRooms === undefined || withRooms.contents.length === 0) throw err;
      this.#count('tbo.hotelDetails.room_detail_fallback_failed', { reason });
      this.#log('info', 'tbo.static.room_detail_fallback_failed', {
        op: 'hotelDetails',
        lang,
        reason,
        requestId: withRooms.requestId,
        ...failureMeta(err),
      });
      return withRooms;
    }
    const served = new Set(withRooms?.contents.map((content) => content.hotelId) ?? []);
    const recovered = plain.contents.filter((content) => !served.has(content.hotelId)).length;
    // Sin la clave tampoco vino más: TBO no tiene ese contenido y la respuesta con la clave vale.
    if (withRooms !== undefined && recovered === 0) return withRooms;

    const suspended = recovered > 0 && gate.recordRejection();
    const meta = {
      op: 'hotelDetails',
      lang,
      reason,
      hotelCodeCount: plain.contents.length + plain.missingHotelCodes.length,
      requestId: plain.requestId,
      consecutiveRejections: gate.consecutiveRejections,
      rejectionLimit: gate.limit,
      ...failureMeta(failure),
    };
    this.#count('tbo.hotelDetails.room_detail_fallback', { reason });
    this.#log('info', 'tbo.static.room_detail_fallback', meta);
    if (suspended) this.#log('warn', 'tbo.static.room_detail_suspended', meta);

    const kept = new Set(plain.contents.map((content) => content.hotelId));
    return {
      ...plain,
      roomContents: (withRooms?.roomContents ?? []).filter((rooms) => kept.has(rooms.hotelId)),
    };
  }

  /**
   * Qué fallos de la llamada con la clave se repiten sin ella: casi todos, porque el caso a cubrir es
   * justo que TBO no la entienda (un 400, un 500, un cuerpo raro, un plazo vencido por una
   * respuesta más pesada). No se repite si quien espera ya cortó, ni ante un fallo de la cuenta o
   * del cupo.
   */
  #roomDetailFallbackAllowed(err: unknown, call: TboStaticCallOptions): boolean {
    if (call.signal?.aborted === true) return false;
    if (err instanceof TboRequestBuildError) return false;
    if (err instanceof TboDispatchRejectedError) return false;
    return !(err instanceof TboApiError && ACCOUNT_FAILURES.has(err.kind));
  }

  async #hotelDetails(
    hotelCodes: readonly string[],
    lang: TboContentLanguage,
    call: TboStaticCallOptions,
    roomDetail: boolean,
    status: TboRoomDetailStatus,
  ): Promise<TboHotelDetailsResult> {
    const body = buildTboHotelDetailsRequest(hotelCodes, lang, { roomDetail });
    const context = { lang, hotelCodes: body.Hotelcodes.split(','), roomDetail };
    const result = await this.#call('hotelDetails', body, TboHotelDetailsEnvelopeSchema, call);
    if (result.outcome === 'NO_AVAILABILITY') {
      // `debug` y no `info`: quien llama escribe UNA línea por lote con lo que resolvió al final.
      this.#log('debug', 'tbo.static.details_without_content', {
        op: 'hotelDetails',
        lang,
        hotelCodeCount: context.hotelCodes.length,
        requestId: result.requestId,
        tboCode: result.tboCode,
        durationMs: result.durationMs,
        attempt: result.attempts,
      });
      return {
        ...emptyTboHotelDetailsMapping(context, this.#mapDeps()),
        ...callMeta(result),
        roomDetail: status,
      };
    }
    return {
      ...mapTboHotelDetailsResponse(result.data, context, this.#mapDeps()),
      ...callMeta(result),
      roomDetail: status,
    };
  }

  /** `GET hotelcodelist`: todos los códigos de TBO (p. 55). Sólo lo usa la etapa de bajas. */
  async listAllHotelCodes(call: TboStaticCallOptions = {}): Promise<TboHotelCodeListResult> {
    const result = await this.#send(
      'hotelCodeList',
      undefined,
      TboHotelCodeListEnvelopeSchema,
      call,
    );
    return { ...mapTboHotelCodeListResponse(result.data, this.#mapDeps()), ...callMeta(result) };
  }

  /**
   * La salida al cable de las operaciones sin resultado vacío. De las cinco, TBOHotelCodeList y
   * HotelDetails admiten uno (el "No Hotels Found" rápido, 01 §8.5) y lo tratan `listCityHotels` y
   * `getHotelDetails`; en las demás un vacío es inalcanzable con la tabla actual.
   */
  async #send<T>(
    operation: Exclude<TboStaticOperation, 'tboHotelCodeList' | 'hotelDetails'>,
    body: unknown,
    responseSchema: ZodType<T, ZodTypeDef, unknown>,
    call: TboStaticCallOptions,
  ): Promise<Extract<TboHttpResult<T>, { outcome: 'SUCCESS' }>> {
    const result = await this.#call(operation, body, responseSchema, call);
    if (result.outcome !== 'SUCCESS') {
      // Si alguien cambia la tabla, se falla como respuesta ilegible en vez de inventar una lista
      // vacía: una lista de ciudades o de códigos vacía se leería como "TBO ya no tiene nada".
      throw new TboResponseMappingError(
        TBO_OPERATIONS[operation].path,
        ['Status.Code:unexpected_no_availability'],
        result.requestId,
      );
    }
    return result;
  }

  /**
   * La única salida al cable, tipada a las cinco operaciones estáticas: `'book'` o `'search'` no
   * compilan aquí.
   */
  async #call<T>(
    operation: TboStaticOperation,
    body: unknown,
    responseSchema: ZodType<T, ZodTypeDef, unknown>,
    call: TboStaticCallOptions,
  ): Promise<TboHttpResult<T>> {
    const configured = this.#policy.timeoutsMs[operation];
    const timeoutMs =
      call.timeoutMs !== undefined && Number.isFinite(call.timeoutMs)
        ? Math.min(configured, call.timeoutMs)
        : configured;
    return this.#client.send(operation, body, {
      responseSchema,
      timeoutMs,
      lane: 'background',
      slowNoHotelsFoundMs: this.#policy.slowNoHotelsFoundMs,
      ...(call.maxAttempts === undefined ? {} : { maxAttempts: call.maxAttempts }),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
    });
  }

  /** Por la lista blanca del log (01 §11.1). La observabilidad nunca cambia el resultado. */
  #info(message: string, meta: Record<string, unknown>): void {
    this.#log('info', message, meta);
  }

  #count(name: string, tags: Record<string, string>): void {
    try {
      this.#metrics?.counter(name, 1, tags);
    } catch {
      // Se descarta a propósito: una métrica nunca cambia el resultado.
    }
  }

  #log(level: 'debug' | 'info' | 'warn', message: string, meta: Record<string, unknown>): void {
    const logger = this.#logger;
    if (logger === undefined) return;
    try {
      logger[level](message, pickTboLogMeta({ provider: TBO_HOTELS_PROVIDER_CODE, ...meta }));
    } catch {
      // Se descarta a propósito: no hay a dónde reportar un fallo del propio canal de reporte.
    }
  }

  #mapDeps(): { readonly logger?: LoggerPort; readonly metrics?: MetricsPort } {
    return {
      ...(this.#logger === undefined ? {} : { logger: this.#logger }),
      ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
    };
  }
}
