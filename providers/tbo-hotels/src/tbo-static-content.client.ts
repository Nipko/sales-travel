import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { z, type ZodType, type ZodTypeDef } from 'zod';
import { requireUsableTboConfig, type TboHotelsConfig } from './config';
import { TboConfigError, TboRequestBuildError, TboResponseMappingError } from './errors';
import { TBO_OPERATIONS } from './http/operations';
import {
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
import { mapTboHotelDetailsResponse } from './static/hotel-details.response.mapper';
import type { TboStaticOperation } from './static/observer';
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
 * - **Reintentos**: los del cliente HTTP, que en lecturas sólo repite ante 429 o fallos de
 *   transporte y con backoff (06 §4.3 regla 7). Partir un lote de HotelDetails que falla es del sync.
 * - **Ciudad sin hoteles**: TBOHotelCodeList la contesta con `Status.Code` 500 "No Hotels Found"
 *   (producción, 2026-09-29). Es una lista vacía en UNA llamada, sin reintento ni `warn` (01 §8.5).
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
export type TboHotelDetailsResult = TboHotelDetailsMapping & TboStaticCall;
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
  })
  .strict();

interface StaticPolicy {
  readonly timeoutsMs: Readonly<Record<TboStaticOperation, number>>;
  readonly detailedCityHotels: boolean;
}

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
  });
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
      // "No Hotels Found": la ciudad existe y no tiene hoteles (01 §8.5). Una línea `info` con la
      // ciudad y lo que tardó, no un `warn`: no es un fallo de TBO.
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

  /** `POST HotelDetails` de hasta 13 códigos en un idioma (p. 56). */
  async getHotelDetails(
    hotelCodes: readonly string[],
    lang: TboContentLanguage,
    call: TboStaticCallOptions = {},
  ): Promise<TboHotelDetailsResult> {
    const body = buildTboHotelDetailsRequest(hotelCodes, lang);
    const result = await this.#send('hotelDetails', body, TboHotelDetailsEnvelopeSchema, call);
    return {
      ...mapTboHotelDetailsResponse(
        result.data,
        { lang, hotelCodes: body.Hotelcodes.split(',') },
        this.#mapDeps(),
      ),
      ...callMeta(result),
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
   * La salida al cable de las operaciones sin resultado vacío. De las cinco, sólo TBOHotelCodeList
   * admite uno (el "No Hotels Found" de una ciudad sin hoteles, 01 §8.5) y lo trata
   * `listCityHotels`; en las demás un vacío es inalcanzable con la tabla actual.
   */
  async #send<T>(
    operation: Exclude<TboStaticOperation, 'tboHotelCodeList'>,
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
      ...(call.maxAttempts === undefined ? {} : { maxAttempts: call.maxAttempts }),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
    });
  }

  /** Por la lista blanca del log (01 §11.1). La observabilidad nunca cambia el resultado. */
  #info(message: string, meta: Record<string, unknown>): void {
    const logger = this.#logger;
    if (logger === undefined) return;
    try {
      logger.info(message, pickTboLogMeta({ provider: TBO_HOTELS_PROVIDER_CODE, ...meta }));
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
