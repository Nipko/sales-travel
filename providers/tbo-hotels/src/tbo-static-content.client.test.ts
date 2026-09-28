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
import type { TboFetch, TboHttpDeps } from './http/tbo-http.client';
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
