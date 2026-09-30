import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import type { LoggerPort } from '@sales-travel/core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TBO_BASE_URLS, parseTboConfig, type TboHotelsConfig } from './config';
import {
  TboApiError,
  TboConfigError,
  TboCredentialsMissingError,
  TboRequestBuildError,
  TboResponseMappingError,
} from './errors';
import { TBO_OPERATIONS, type TboLane } from './http/operations';
import type { TboRateLimiter } from './http/limiter';
import {
  TBO_SLOW_NO_HOTELS_FOUND_MS,
  type TboFetch,
  type TboHttpDeps,
} from './http/tbo-http.client';
import { resolveTboHotelDetails, type TboDetailsFetch } from './static/hotel-details.resolver';
import {
  TBO_STATIC_TIMEOUTS_MS,
  TboStaticContentClient,
  type TboStaticContentOptions,
} from './tbo-static-content.client';

/**
 * El cliente de contenido estático por su puerta pública (docs/tbo/09 PR-3.1; 06 §4.2), con
 * `fetch` espiado: lo que se mide es lo que sale al cable y lo que vuelve normalizado.
 */

// Valores con forma reconocible para buscarlos en cualquier salida. No son credenciales.
const USERNAME = 'sync-plataforma-demo';
const PASSWORD = 'Pa55w0rd-static';
const FIXTURES = join(__dirname, '__fixtures__', 'pdf');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
}

function config(overrides: Record<string, unknown> = {}): TboHotelsConfig {
  return parseTboConfig({
    environment: 'test',
    username: USERNAME,
    password: PASSWORD,
    ...overrides,
  });
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Responde según el path; lo que no está en el mapa es un 404 sin cuerpo de TBO. */
function spyFetch(routes: Record<string, () => Response>): { fetch: TboFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: TboFetch = (url, init) => {
    calls.push({ url, init });
    const path = url.slice(TBO_BASE_URLS.test.length);
    const route = routes[path];
    return Promise.resolve(route === undefined ? new Response('', { status: 404 }) : route());
  };
  return { fetch, calls };
}

const ROUTES: Record<string, () => Response> = {
  [TBO_OPERATIONS.countryList.path]: () => json(fixture('country-list.p52.json')),
  [TBO_OPERATIONS.cityList.path]: () => json(fixture('city-list.p54.json')),
  [TBO_OPERATIONS.tboHotelCodeList.path]: () => json(fixture('tbo-hotel-code-list.p67.json')),
  [TBO_OPERATIONS.hotelDetails.path]: () => json(fixture('hotel-details.p59.json')),
  [TBO_OPERATIONS.hotelCodeList.path]: () => json(fixture('hotelcodelist.p55.json')),
};

interface Harness {
  readonly client: TboStaticContentClient;
  readonly calls: FetchCall[];
  readonly lanes: TboLane[];
  readonly timeouts: number[];
  readonly logs: string[];
}

function harness(
  routes: Record<string, () => Response> = ROUTES,
  options: TboStaticContentOptions = {},
  extra: Partial<TboHttpDeps> = {},
): Harness {
  const { fetch, calls } = spyFetch(routes);
  const lanes: TboLane[] = [];
  const timeouts: number[] = [];
  const logs: string[] = [];
  const limiter: TboRateLimiter = {
    acquire: (request) => {
      lanes.push(request.lane);
      return Promise.resolve({ granted: true, permit: { release: () => undefined } });
    },
    reportThrottled: () => undefined,
  };
  const record =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      logs.push(JSON.stringify({ level, message, meta }));
    };
  const logger: LoggerPort = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  const client = new TboStaticContentClient(
    config(),
    {
      fetch,
      limiter,
      logger,
      sleep: () => Promise.resolve(),
      timeoutSignal: (ms) => {
        timeouts.push(ms);
        return new AbortController().signal;
      },
      ...extra,
    },
    { credentialSource: 'env' },
    options,
  );
  return { client, calls, lanes, timeouts, logs };
}

function bodyOf(call: FetchCall | undefined): unknown {
  return typeof call?.init.body === 'string' ? (JSON.parse(call.init.body) as unknown) : undefined;
}

describe('TboStaticContentClient: una operación por método', () => {
  it('listCountries: GET CountryList sin cuerpo (p. 51) → países', async () => {
    const h = harness();
    const result = await h.client.listCountries();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe(`${TBO_BASE_URLS.test}${TBO_OPERATIONS.countryList.path}`);
    expect(h.calls[0]?.init.method).toBe('GET');
    expect(h.calls[0]?.init.body).toBeUndefined();
    expect(result.countries.map((country) => country.code)).toEqual(['AL', 'AD', 'AG', 'AR', 'AW']);
    expect(result.attempts).toBe(1);
    expect(typeof result.requestId).toBe('string');
  });

  it('listCities: POST CityList con el ISO2 (p. 53) → ciudades con su país', async () => {
    const h = harness();
    const result = await h.client.listCities('AT');
    expect(h.calls[0]?.init.method).toBe('POST');
    expect(bodyOf(h.calls[0])).toEqual({ CountryCode: 'AT' });
    expect(result.cities[0]).toEqual({ code: '100758', name: 'Abersee', countryCode: 'AT' });
  });

  it('listCityHotels: POST TBOHotelCodeList con "true" (p. 65) → catálogo + contenido listing', async () => {
    const h = harness();
    const result = await h.client.listCityHotels('130452', { countryCode: 'US' });
    expect(bodyOf(h.calls[0])).toEqual({ CityCode: '130452', IsDetailedResponse: 'true' });
    expect(result.hotels[0]).toMatchObject({ hotelId: '1010099', stars: 3, cityCode: '130452' });
    expect(result.listingContents[0]?.source).toBe('listing');
  });

  it('`detailedCityHotels: false` cambia sólo el string del request (Q-63)', async () => {
    const h = harness(ROUTES, { detailedCityHotels: false });
    await h.client.listCityHotels('130452');
    expect(bodyOf(h.calls[0])).toEqual({ CityCode: '130452', IsDetailedResponse: 'false' });
  });

  it('getHotelDetails: POST HotelDetails con CSV e idioma en mayúsculas (p. 56) → contenido', async () => {
    const h = harness();
    const result = await h.client.getHotelDetails(['1000000', '2000000', '1000000'], 'es');
    expect(bodyOf(h.calls[0])).toEqual({ Hotelcodes: '1000000,2000000', Language: 'ES' });
    expect(result.lang).toBe('es');
    expect(result.contents[0]).toMatchObject({ hotelId: '1000000', lang: 'es', source: 'details' });
    expect(result.hotels[0]?.stars).toBe(5);
    expect(result.missingHotelCodes).toEqual(['2000000']);
  });

  it('listAllHotelCodes: GET hotelcodelist sin `Status` (p. 55) → códigos string', async () => {
    const h = harness();
    const result = await h.client.listAllHotelCodes();
    expect(h.calls[0]?.init.method).toBe('GET');
    expect(result.hotelCodes).toEqual(['1000000', '1000001', '1000002', '5000008']);
  });

  it('un body inválido se corta antes del cable', async () => {
    const h = harness();
    await expect(h.client.listCities('at')).rejects.toBeInstanceOf(TboRequestBuildError);
    await expect(h.client.getHotelDetails([], 'en')).rejects.toBeInstanceOf(TboRequestBuildError);
    await expect(h.client.listCityHotels('130452', { countryCode: 'usa' })).rejects.toBeInstanceOf(
      TboRequestBuildError,
    );
    expect(h.calls).toHaveLength(0);
  });
});

describe('TboStaticContentClient: cupo, timeouts e intentos', () => {
  it('las cinco operaciones van al cupo de fondo: nunca le quitan cupo a una venta', async () => {
    const h = harness();
    await h.client.listCountries();
    await h.client.listCities('AT');
    await h.client.listCityHotels('130452');
    await h.client.getHotelDetails(['1000000'], 'en');
    await h.client.listAllHotelCodes();
    expect(h.lanes).toEqual(['background', 'background', 'background', 'background', 'background']);
  });

  it('timeouts de partida de 05 §10, con HotelDetails en 45 s', async () => {
    const h = harness();
    await h.client.listCountries();
    await h.client.listCities('AT');
    await h.client.listCityHotels('130452');
    await h.client.getHotelDetails(['1000000'], 'en');
    await h.client.listAllHotelCodes();
    expect(h.timeouts).toEqual([30_000, 30_000, 60_000, 45_000, 180_000]);
    expect(TBO_STATIC_TIMEOUTS_MS.hotelDetails).toBeLessThan(
      TBO_OPERATIONS.hotelDetails.maxTimeoutMs,
    );
  });

  it('la configuración y la llamada sólo ACORTAN (08 §9 C-14)', async () => {
    const h = harness(ROUTES, { timeoutsMs: { hotelDetails: 90_000, cityList: 5_000 } });
    await h.client.getHotelDetails(['1000000'], 'en');
    await h.client.listCities('AT');
    await h.client.listCities('AT', { timeoutMs: 2_000 });
    await h.client.listCities('AT', { timeoutMs: 99_000 });
    expect(h.timeouts).toEqual([45_000, 5_000, 2_000, 5_000]);
  });

  it('una lectura se reintenta ante un 429 y respeta un tope de intentos menor', async () => {
    let served = 0;
    const throttled = (): Response => {
      served += 1;
      return json({ Status: { Code: 429, Description: 'Limit exceeded' } });
    };
    const h = harness({ ...ROUTES, [TBO_OPERATIONS.cityList.path]: throttled });
    const error = await h.client.listCities('AT', { maxAttempts: 2 }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TboApiError);
    expect((error as TboApiError).kind).toBe('THROTTLED');
    expect(served).toBe(2);
  });

  it('un 201 en una operación estática es un error, nunca una lista vacía', async () => {
    const h = harness({
      ...ROUTES,
      [TBO_OPERATIONS.tboHotelCodeList.path]: () =>
        json({ Status: { Code: 201, Description: 'No data' } }),
    });
    const error = await h.client.listCityHotels('130452').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TboApiError);
    expect((error as TboApiError).kind).toBe('NO_AVAILABILITY');
  });

  it('un contenedor con forma imposible es una respuesta ilegible', async () => {
    const h = harness({
      ...ROUTES,
      [TBO_OPERATIONS.hotelCodeList.path]: () => json({ HotelCodes: 'todos' }),
    });
    await expect(h.client.listAllHotelCodes({ maxAttempts: 1 })).rejects.toBeInstanceOf(
      TboResponseMappingError,
    );
  });
});

describe('TboStaticContentClient: la ciudad sin hoteles y las coordenadas (producción, 2026-09-29)', () => {
  // El cuerpo que TBO devolvió en 16 ciudades de CO (envelope/83-500-no-hotels-found.json).
  const observed = JSON.parse(
    readFileSync(
      join(__dirname, '__fixtures__', 'envelope', '83-500-no-hotels-found.json'),
      'utf8',
    ),
  ) as { response: { bodyText: string } };
  const noHotelsFound = (): Response =>
    new Response(observed.response.bodyText, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('"No Hotels Found": lista vacía en UNA llamada, sin warn y con una línea info de la ciudad', async () => {
    let served = 0;
    const h = harness({
      ...ROUTES,
      [TBO_OPERATIONS.tboHotelCodeList.path]: () => {
        served += 1;
        return noHotelsFound();
      },
    });
    const result = await h.client.listCityHotels('130452', { countryCode: 'US' });

    expect(served).toBe(1);
    expect(result).toMatchObject({
      cityCode: '130452',
      hotels: [],
      listingContents: [],
      attempts: 1,
    });
    expect(result.diagnostics).toEqual({
      received: 0,
      mapped: 0,
      rejected: {},
      notes: {},
      unknownKeys: [],
    });
    const logs = h.logs.map(
      (line) => JSON.parse(line) as { level: string; message: string; meta: unknown },
    );
    expect(logs.filter((log) => log.level === 'warn' || log.level === 'error')).toEqual([]);
    expect(logs.filter((log) => log.level === 'info')).toEqual([
      {
        level: 'info',
        message: 'tbo.static.city_without_hotels',
        meta: {
          provider: 'tbo-hotels',
          op: 'tboHotelCodeList',
          cityCode: '130452',
          requestId: result.requestId,
          tboCode: 500,
          durationMs: result.durationMs,
          attempt: 1,
        },
      },
    ]);
  });

  it('cualquier otro 500 sigue siendo un error con sus reintentos: nunca una lista vacía', async () => {
    let served = 0;
    const h = harness({
      ...ROUTES,
      [TBO_OPERATIONS.tboHotelCodeList.path]: () => {
        served += 1;
        return json({ Status: { Code: 500, Description: 'Unexpected Error' } });
      },
    });
    const error = await h.client.listCityHotels('130452').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TboApiError);
    expect((error as TboApiError).kind).toBe('UPSTREAM');
    expect(served).toBe(TBO_OPERATIONS.tboHotelCodeList.maxAttempts);
  });

  it('el mismo cuerpo en CityList, sin evidencia, es un error y no una lista de ciudades vacía', async () => {
    const h = harness({ ...ROUTES, [TBO_OPERATIONS.cityList.path]: noHotelsFound });
    const error = await h.client.listCities('CO', { maxAttempts: 1 }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TboApiError);
    expect((error as TboApiError).kind).toBe('UPSTREAM');
  });

  it('Latitude/Longitude mandan sobre Map y ya no se registran como claves desconocidas', async () => {
    const h = harness({
      ...ROUTES,
      [TBO_OPERATIONS.tboHotelCodeList.path]: () =>
        json(
          JSON.parse(
            readFileSync(
              join(
                __dirname,
                '__fixtures__',
                'observed',
                'tbo-hotel-code-list.latitude-longitude.json',
              ),
              'utf8',
            ),
          ),
        ),
    });
    const result = await h.client.listCityHotels('130452', { countryCode: 'US' });
    expect(result.hotels.map((hotel) => hotel.location)).toEqual([
      { lat: 40.764167, lng: -73.994468 },
      { lat: 40.758, lng: -73.9855 },
      { lat: 40.7484, lng: -73.9857 },
      { lat: 40.7527, lng: -73.9772 },
    ]);
    expect(result.diagnostics.unknownKeys).toEqual([]);
    expect(h.logs.join('\n')).not.toContain('tbo.static.unknown_keys');
  });
});

describe('TboStaticContentClient: un "No Hotels Found" lento se reintenta (01 §8.5; log del 2026-09-29)', () => {
  const observed = JSON.parse(
    readFileSync(
      join(__dirname, '__fixtures__', 'envelope', '83-500-no-hotels-found.json'),
      'utf8',
    ),
  ) as { response: { bodyText: string } };

  /** Las 20 llamadas del log con "No Hotels Found", con lo que tardó cada intento. */
  interface ObservedCall {
    readonly requestId: string;
    readonly noHotelsFoundMs: readonly number[];
    readonly then: 'failed' | 'hotels';
    readonly hotelsAtMostMs?: number;
  }
  const timing = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '__fixtures__',
        'observed',
        'tbo-hotel-code-list.no-hotels-found-timing.json',
      ),
      'utf8',
    ),
  ) as { calls: readonly ObservedCall[] };

  function observedCall(requestId: string): ObservedCall {
    const call = timing.calls.find((candidate) => candidate.requestId === requestId);
    if (call === undefined) throw new Error(`no está la llamada ${requestId} en el log`);
    return call;
  }

  /**
   * TBOHotelCodeList contesta como en el log: cada intento registrado es un "No Hotels Found" que
   * adelanta el reloj del cliente lo que tardó; el siguiente, si la llamada terminó con hoteles, es
   * la lista del ejemplo de p. 67. Pedir un intento que el log no tiene es un error del test.
   */
  function replay(
    call: ObservedCall,
    options: TboStaticContentOptions = {},
  ): Harness & { readonly served: () => number } {
    let clock = 0;
    let served = 0;
    const h = harness(
      {
        ...ROUTES,
        [TBO_OPERATIONS.tboHotelCodeList.path]: () => {
          const ms = call.noHotelsFoundMs[served];
          served += 1;
          if (ms !== undefined) {
            clock += ms;
            return new Response(observed.response.bodyText, {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (call.then !== 'hotels') throw new Error(`${call.requestId}: el log no tiene más`);
          clock += call.hotelsAtMostMs ?? 0;
          return json(fixture('tbo-hotel-code-list.p67.json'));
        },
      },
      options,
      { now: () => clock },
    );
    return { ...h, served: () => served };
  }

  function parsedLogs(
    h: Harness,
  ): { level: string; message: string; meta: Record<string, unknown> }[] {
    return h.logs.map(
      (line) =>
        JSON.parse(line) as { level: string; message: string; meta: Record<string, unknown> },
    );
  }

  it('rápido, aun el más lento de los rápidos (4.279 ms): la ciudad vacía en UNA llamada', async () => {
    const h = replay(observedCall('4a18fcdf'));
    const result = await h.client.listCityHotels('130452', { countryCode: 'US' });

    expect(h.served()).toBe(1);
    expect(result).toMatchObject({ hotels: [], attempts: 1 });
    const logs = parsedLogs(h);
    expect(logs.filter((log) => log.message === 'tbo.http.error')).toEqual([]);
    expect(
      logs.find((log) => log.message === 'tbo.static.city_without_hotels')?.meta,
    ).toMatchObject({ cityCode: '130452', attempt: 1 });
  });

  it('lento (5.088 y 5.092 ms): se reintenta con backoff y el tercer intento trae los hoteles', async () => {
    const h = replay(observedCall('d121e5da'));
    const result = await h.client.listCityHotels('130452', { countryCode: 'US' });

    expect(h.served()).toBe(3);
    expect(result.attempts).toBe(3);
    expect(result.hotels.map((hotel) => hotel.hotelId)).toEqual(['1010099']);
    const logs = parsedLogs(h);
    expect(logs.filter((log) => log.message === 'tbo.http.error')).toEqual([
      expect.objectContaining({
        level: 'warn',
        meta: expect.objectContaining({
          attempt: 1,
          durationMs: 5_088,
          kind: 'UPSTREAM',
          retry: 'RETRY_BACKOFF',
          circuit: 'COUNT',
          reason: 'slow_no_hotels_found',
        }) as unknown,
      }),
      expect.objectContaining({
        meta: expect.objectContaining({
          attempt: 2,
          durationMs: 5_092,
          reason: 'slow_no_hotels_found',
        }) as unknown,
      }),
    ]);
    expect(logs.map((log) => log.message)).not.toContain('tbo.static.city_without_hotels');
  });

  it('lento en los 5 intentos: TboApiError UPSTREAM, nunca una lista vacía', async () => {
    const h = replay(observedCall('57ed77c7'));
    const error = await h.client.listCityHotels('130452').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TboApiError);
    expect(error).toMatchObject({ kind: 'UPSTREAM', status: 200, tboCode: 500 });
    expect((error as TboApiError).failure.circuit).toBe('COUNT');
    expect(h.served()).toBe(TBO_OPERATIONS.tboHotelCodeList.maxAttempts);
    expect(h.logs.join('\n')).not.toContain('tbo.static.city_without_hotels');
  });

  it('el umbral es una opción del cliente: con 6 s, el mismo "No Hotels Found" es la ciudad vacía', async () => {
    const h = replay(observedCall('57ed77c7'), { slowNoHotelsFoundMs: 6_000 });
    await expect(h.client.listCityHotels('130452')).resolves.toMatchObject({
      hotels: [],
      attempts: 1,
    });
    expect(h.served()).toBe(1);
  });

  it('las 20 llamadas del log con el umbral: 11 vacías, 4 con hoteles y 5 fallidas', async () => {
    const outcomes: Record<string, string[]> = { empty: [], hotels: [], failed: [] };
    for (const call of timing.calls) {
      const h = replay(call);
      const outcome = await h.client.listCityHotels('130452').then(
        (result) => (result.hotels.length > 0 ? 'hotels' : 'empty'),
        (err: unknown) => {
          if (err instanceof TboApiError && err.kind === 'UPSTREAM') return 'failed';
          throw err;
        },
      );
      outcomes[outcome]?.push(call.requestId);
    }

    // Las cuatro que en el log devolvieron hoteles, los devuelven; antes quedaban vacías.
    expect(outcomes['hotels']).toEqual(
      timing.calls.filter((call) => call.then === 'hotels').map((call) => call.requestId),
    );
    // Las cinco que contestaron a los ≈ 5,09 s en los 5 intentos quedan fallidas, no vacías.
    expect(outcomes['failed']).toEqual([
      '8e8495bc',
      '0409db89',
      '66e997d9',
      '57ed77c7',
      '24eef3e4',
    ]);
    expect(outcomes['empty']).toHaveLength(11);
  });

  it('el umbral separa los dos grupos del log, con margen a los dos lados', () => {
    const all = timing.calls.flatMap((call) => call.noHotelsFoundMs);
    const recovered = timing.calls
      .filter((call) => call.then === 'hotels')
      .flatMap((call) => call.noHotelsFoundMs);
    expect(all).toHaveLength(86);
    // Todo "No Hotels Found" de una ciudad que después devolvió hoteles es lento.
    expect(Math.min(...recovered)).toBeGreaterThanOrEqual(TBO_SLOW_NO_HOTELS_FOUND_MS);
    // Entre la más lenta de las rápidas y la más rápida del grupo de ≈ 5,09 s no hay nada.
    const fast = all.filter((ms) => ms < TBO_SLOW_NO_HOTELS_FOUND_MS);
    const slow = all.filter((ms) => ms >= TBO_SLOW_NO_HOTELS_FOUND_MS);
    expect([fast.length, Math.max(...fast)]).toEqual([50, 4_279]);
    expect([slow.length, Math.min(...slow)]).toEqual([36, 5_084]);
  });
});

describe('TboStaticContentClient: construcción', () => {
  it('sin credenciales usables no existe', () => {
    expect(() => new TboStaticContentClient(parseTboConfig({ environment: 'test' }))).toThrow(
      TboCredentialsMissingError,
    );
  });

  it.each([
    { timeoutsMs: { hotelDetails: 0 } },
    { timeoutsMs: { search: 1_000 } },
    { detailedCityHotels: 'true' },
    { slowNoHotelsFoundMs: 0 },
    { slowNoHotelsFoundMs: 4_500.5 },
    { extra: true },
  ])('opciones inválidas son un TboConfigError con ruta:código (%j)', (options) => {
    let caught: unknown;
    try {
      harness(ROUTES, options as TboStaticContentOptions);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TboConfigError);
    expect((caught as TboConfigError).issues.every((issue) => issue.startsWith('options'))).toBe(
      true,
    );
  });
});

describe('TboStaticContentClient: sólo contenido, sin venta (06 §4.2)', () => {
  const SALES = /search|prebook|book|cancel|booking|rates|availability|send/i;

  it('su superficie son exactamente los cinco métodos de contenido', () => {
    const own = Object.getOwnPropertyNames(TboStaticContentClient.prototype).sort();
    expect(own).toEqual(
      [
        'accountRef',
        'constructor',
        'getHotelDetails',
        'listAllHotelCodes',
        'listCities',
        'listCityHotels',
        'listCountries',
      ].sort(),
    );
    expect(own.filter((name) => SALES.test(name))).toEqual([]);
  });

  it('el cliente HTTP, la cuenta y las credenciales no se alcanzan ni se vuelcan', () => {
    const { client } = harness();
    expect(Object.keys(client)).toEqual([]);
    expect(JSON.stringify(client)).toBe('{}');
    const dumped = inspect(client, { depth: 5, showHidden: true });
    expect(dumped).not.toContain(PASSWORD);
    expect(dumped).not.toContain(USERNAME);
    expect('send' in client).toBe(false);
    expect(client.accountRef).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ningún método alcanza un path de venta: todo el tráfico va a las cinco operaciones', async () => {
    const h = harness();
    await h.client.listCountries();
    await h.client.listCities('AT');
    await h.client.listCityHotels('130452');
    await h.client.getHotelDetails(['1000000'], 'en');
    await h.client.listAllHotelCodes();
    const staticPaths = new Set(
      (
        ['countryList', 'cityList', 'tboHotelCodeList', 'hotelDetails', 'hotelCodeList'] as const
      ).map((name) => `${TBO_BASE_URLS.test}${TBO_OPERATIONS[name].path}`),
    );
    expect(h.calls.map((call) => call.url).filter((url) => !staticPaths.has(url))).toEqual([]);
    expect(new Set(h.calls.map((call) => call.url)).size).toBe(5);
  });

  it('la fuente no nombra ninguna operación de venta ni importa el adapter o Search', () => {
    const file = join(__dirname, 'tbo-static-content.client.ts');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022);
    const literals: string[] = [];
    const imports: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
        return;
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        literals.push(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    const sales = ['search', 'prebook', 'book', 'cancel', 'bookingDetail', 'bookingDetailsByDate'];
    expect(literals.filter((literal) => sales.includes(literal))).toEqual([]);
    expect(literals).toContain('countryList');
    expect(imports.filter((specifier) => /search|adapter|cancel|booking/i.test(specifier))).toEqual(
      [],
    );
  });

  it('el tipo tampoco deja pedir una operación de venta', () => {
    const { client } = harness();
    // @ts-expect-error — el cliente de contenido no busca disponibilidad.
    expect(client.searchAvailability).toBeUndefined();
    // @ts-expect-error — ni reserva.
    expect(client.book).toBeUndefined();
  });
});

describe('TboStaticContentClient: RF-32 CA por la puerta pública', () => {
  it('"ThreeStar" → 3 y `Map` "0|0" → sin coordenadas, sin perder el hotel', async () => {
    const h = harness({
      ...ROUTES,
      [TBO_OPERATIONS.tboHotelCodeList.path]: () => {
        const body = fixture('tbo-hotel-code-list.p67.json') as {
          Hotels: Record<string, unknown>[];
        };
        const hotel = body.Hotels[0] ?? {};
        return json({ ...body, Hotels: [hotel, { ...hotel, HotelCode: '1010100', Map: '0|0' }] });
      },
    });
    const result = await h.client.listCityHotels('130452', { countryCode: 'US' });
    expect(result.hotels.map((hotel) => [hotel.hotelId, hotel.stars, hotel.location])).toEqual([
      ['1010099', 3, { lat: 40.764167, lng: -73.994468 }],
      ['1010100', 3, null],
    ]);
    expect(result.diagnostics.notes).toMatchObject({ MAP_ZERO: 1 });
  });

  it('`5` → 5 y un <script> se elimina al ingerir, con su contenido, en todo lo que sale', async () => {
    const h = harness({
      ...ROUTES,
      [TBO_OPERATIONS.hotelDetails.path]: () => {
        const body = fixture('hotel-details.p59.json') as {
          HotelDetails: Record<string, unknown>[];
        };
        const hotel = body.HotelDetails[0] ?? {};
        return json({
          ...body,
          HotelDetails: [
            {
              ...hotel,
              Description: `<p>HeadLine : Cerca</p><SCRIPT>alert(document.cookie)</SCRIPT>${String(hotel['Description'])}`,
              Attractions: { '1) ': '<p>Museo<script src="//evil.test/x.js"></script></p>' },
              HotelFacilities: ['<script>alert(1)</script>Free WiFi', 'Wheelchair accessible – no'],
            },
          ],
        });
      },
    });
    const result = await h.client.getHotelDetails(['1000000'], 'es');
    expect(result.hotels[0]?.stars).toBe(5);
    const [content] = result.contents;
    expect(content?.descriptionHtml?.startsWith('<p>HeadLine : Cerca</p><p>HeadLine : Near')).toBe(
      true,
    );
    expect(content?.attractionsHtml).toBe('<p>Museo</p>');
    expect(content?.facilities).toEqual(['Free WiFi']);
    expect(content?.unavailableFacilities).toEqual(['Wheelchair accessible']);
    expect(JSON.stringify(result)).not.toMatch(/<\/?script|alert\(|cookie|evil\.test/i);
    expect(result.diagnostics.notes).toMatchObject({ HTML_SANITIZED: 2 });
  });
});

describe('TboStaticContentClient: logs', () => {
  it('ni Authorization, ni la cuenta, ni nombres o textos de hotel', async () => {
    const h = harness({
      ...ROUTES,
      [TBO_OPERATIONS.hotelDetails.path]: () => {
        const body = fixture('hotel-details.p59.json') as {
          HotelDetails: Record<string, unknown>[];
        };
        const hotel = body.HotelDetails[0] ?? {};
        return json({ ...body, HotelDetails: [{ ...hotel, Map: '0|0', Extra: 'x' }] });
      },
    });
    await h.client.getHotelDetails(['1000000'], 'en');
    await h.client.listCityHotels('130452');
    const log = h.logs.join('\n');
    expect(log).toContain('tbo.static.anomalies');
    expect(log).not.toMatch(/authorization|basic /i);
    expect(log).not.toContain(PASSWORD);
    expect(log).not.toContain(USERNAME);
    expect(log).not.toMatch(/Sofitel|Holiday Inn|Abtal|West 48th|Nubian|Gershwin/);
  });
});

describe('TboStaticContentClient: HotelDetails sin contenido (producción, 2026-09-30; 05 CE-23)', () => {
  const observed = JSON.parse(
    readFileSync(
      join(__dirname, '__fixtures__', 'envelope', '83-500-no-hotels-found.json'),
      'utf8',
    ),
  ) as { response: { bodyText: string } };
  const detalle = fixture('hotel-details.p59.json') as {
    Status: unknown;
    HotelDetails: Record<string, unknown>[];
  };
  const plantilla = detalle.HotelDetails[0] ?? {};

  interface DetailsCall {
    readonly codes: string[];
    readonly language: string;
  }

  /**
   * Un HotelDetails de mentira: `tiene` dice qué códigos tienen contenido en cada `Language` y
   * `malos` qué códigos tumban el lote entero (H2). Sin contenido contesta "No Hotels Found" con el
   * cuerpo observado. Cada respuesta adelanta el reloj del cliente lo que diga `tarda` (en orden;
   * 150 ms por defecto) y las primeras `vaciasAntes` son "No Hotels Found" pase lo que pase.
   */
  function detailsTbo(opts: {
    readonly tiene: Readonly<Record<string, readonly string[]>>;
    readonly malos?: readonly string[];
    readonly tarda?: number[];
    readonly vaciasAntes?: number;
  }): { h: Harness; calls: DetailsCall[] } {
    const calls: DetailsCall[] = [];
    let clock = 0;
    const fetch: TboFetch = (url, init) => {
      const body = bodyOf({ url, init }) as { Hotelcodes: string; Language: string };
      const codes = body.Hotelcodes.split(',');
      calls.push({ codes, language: body.Language });
      clock += opts.tarda?.shift() ?? 150;
      const found = codes.filter((code) => opts.tiene[body.Language]?.includes(code));
      const empty =
        calls.length <= (opts.vaciasAntes ?? 0) ||
        found.length === 0 ||
        codes.some((code) => opts.malos?.includes(code));
      if (empty) {
        return Promise.resolve(
          new Response(observed.response.bodyText, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        json({
          Status: detalle.Status,
          HotelDetails: found.map((code) => ({ ...plantilla, HotelCode: code })),
        }),
      );
    };
    return { h: harness(ROUTES, {}, { fetch, now: () => clock }), calls };
  }

  /** Cada llamada por el cliente real, con sus reintentos; un fallo vuelve como valor. */
  function viaClient(client: TboStaticContentClient): TboDetailsFetch<unknown> {
    return (codes, lang) =>
      client.getHotelDetails(codes, lang, { maxAttempts: 2 }).then(
        (result) => ({ ok: true as const, result }),
        (failure: unknown) => ({ ok: false as const, failure }),
      );
  }

  function logsOf(h: Harness): { level: string; message: string; meta: Record<string, unknown> }[] {
    return h.logs.map(
      (line) =>
        JSON.parse(line) as { level: string; message: string; meta: Record<string, unknown> },
    );
  }

  it('"No Hotels Found" rápido: resultado tipado en UNA llamada, sin error, reintento ni warn', async () => {
    const { h, calls } = detailsTbo({ tiene: {} });

    const result = await h.client.getHotelDetails(['1000000', '1000001'], 'es');

    expect(calls).toEqual([{ codes: ['1000000', '1000001'], language: 'ES' }]);
    expect(result).toMatchObject({
      lang: 'es',
      outcome: 'NO_HOTELS_FOUND',
      contents: [],
      hotels: [],
      missingHotelCodes: ['1000000', '1000001'],
      attempts: 1,
    });
    const logs = logsOf(h);
    expect(logs.filter((log) => log.level === 'warn' || log.level === 'error')).toEqual([]);
    // No hubo `TboApiError`: nada que el breaker cuente ni que la racha del sync sume.
    expect(JSON.stringify(logs)).not.toMatch(/"circuit"|"retry"|tbo\.http\.error/);
    expect(logs.find((log) => log.message === 'tbo.static.details_without_content')).toEqual({
      level: 'debug',
      message: 'tbo.static.details_without_content',
      meta: {
        provider: 'tbo-hotels',
        op: 'hotelDetails',
        lang: 'es',
        hotelCodeCount: 2,
        requestId: result.requestId,
        tboCode: 500,
        durationMs: result.durationMs,
        attempt: 1,
      },
    });
  });

  it('un 200 sigue siendo `DETAILS`, con lo que no volvió en `missingHotelCodes`', async () => {
    const { h } = detailsTbo({ tiene: { ES: ['1000000'] } });
    const result = await h.client.getHotelDetails(['1000000', '1000001'], 'es');
    expect(result).toMatchObject({ outcome: 'DETAILS', missingHotelCodes: ['1000001'] });
  });

  it('lento (≥ 4.500 ms): se reintenta como UPSTREAM y el reintento con contenido es un éxito', async () => {
    const { h, calls } = detailsTbo({
      tiene: { ES: ['1000000'] },
      tarda: [5_088],
      vaciasAntes: 1,
    });

    const result = await h.client.getHotelDetails(['1000000'], 'es');

    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ outcome: 'DETAILS', attempts: 2 });
    expect(logsOf(h).filter((log) => log.message === 'tbo.http.error')).toEqual([
      expect.objectContaining({
        level: 'warn',
        meta: expect.objectContaining({
          attempt: 1,
          durationMs: 5_088,
          kind: 'UPSTREAM',
          reason: 'slow_no_hotels_found',
          circuit: 'COUNT',
        }) as unknown,
      }),
    ]);
  });

  it('lento en todos los intentos: TboApiError UPSTREAM, nunca "sin contenido"', async () => {
    const { h, calls } = detailsTbo({ tiene: {}, tarda: [5_090, 5_091] });
    const error = await h.client
      .getHotelDetails(['1000000'], 'es', { maxAttempts: 2 })
      .catch((err: unknown) => err);
    expect(calls).toHaveLength(2);
    expect(error).toBeInstanceOf(TboApiError);
    expect(error).toMatchObject({ kind: 'UPSTREAM', tboCode: 500 });
  });

  it('H1 — ES sin contenido, EN con contenido: el respaldo trae el lote en inglés', async () => {
    const codes = ['1000000', '1000001', '1000002'];
    const { h, calls } = detailsTbo({ tiene: { EN: codes } });

    const r = await resolveTboHotelDetails(codes, 'es', viaClient(h.client));

    expect(calls).toEqual([
      { codes, language: 'ES' },
      { codes, language: 'EN' },
    ]);
    expect(r).toMatchObject({ foundInLang: [], foundInFallback: codes, withoutContent: [] });
    expect(r.contents.map((c) => [c.hotelId, c.lang, c.source])).toEqual(
      codes.map((code) => [code, 'en', 'details']),
    );
    expect(r.contents[0]?.images.length).toBeGreaterThan(0);
  });

  it('H2 — un código malo tumba el lote: "No Hotels Found" junto, contenido por separado', async () => {
    const codes = ['1000000', '1000001', '1000002', '1000003'];
    const { h, calls } = detailsTbo({
      tiene: { ES: codes.slice(0, 3), EN: codes.slice(0, 3) },
      malos: ['1000003'],
    });

    const r = await resolveTboHotelDetails(codes, 'es', viaClient(h.client));

    expect(calls.map((c) => [c.language, c.codes])).toEqual([
      ['ES', codes],
      ['EN', codes],
      ['EN', codes.slice(0, 2)],
      ['EN', codes.slice(2)],
      ['EN', ['1000002']],
      ['EN', ['1000003']],
      ['ES', codes.slice(0, 3)],
    ]);
    expect(r).toMatchObject({
      foundInLang: codes.slice(0, 3),
      withoutContent: ['1000003'],
      unresolved: [],
      calls: { primary: 1, fallback: 1, isolation: 5 },
    });
    // Ni un reintento del cliente: cada "No Hotels Found" rápido es un valor, no un 500.
    expect(logsOf(h).filter((log) => log.message === 'tbo.http.error')).toEqual([]);
  });
});
