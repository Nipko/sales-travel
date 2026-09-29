import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TBO_BASE_URLS, TBO_OPERATIONS, type TboFetch } from '@sales-travel/tbo-hotels';

/**
 * Un TBO falso para los tests, armado con los fixtures del ACL (`providers/tbo-hotels/src/
 * __fixtures__`, derivados del PDF con sus correcciones declaradas). Se leen, no se copian: si la
 * sonda de certificación los reemplaza por respuestas reales, estos tests pasan a usarlas solos.
 *
 * Cada respuesta parte del ejemplo de su método y sólo cambia lo que el escenario necesita (códigos,
 * nombres, coordenadas), así la forma —tipos raros incluidos— es la del contrato.
 */

export const ACL_FIXTURES_DIR = fileURLToPath(
  new URL('../../../../providers/tbo-hotels/src/__fixtures__/', import.meta.url),
);

export function aclFixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(ACL_FIXTURES_DIR, relativePath), 'utf8')) as unknown;
}

export type StaticOp =
  | 'countryList'
  | 'cityList'
  | 'tboHotelCodeList'
  | 'hotelDetails'
  | 'hotelCodeList';

export interface FakeCity {
  readonly code: string;
  readonly name: string;
}

export interface FakeHotel {
  readonly code: string;
  readonly name?: string;
  readonly lat?: number;
  readonly lng?: number;
  readonly rating?: string;
  /** Claves crudas que pisan a las de la plantilla: un `HotelCode` ilegible, un campo raro. */
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** HotelDetails (p. 56-62): por defecto devuelve todos los códigos pedidos, en el idioma pedido. */
export interface FakeDetails {
  /** Códigos que vuelven fuera de la respuesta con `200`: TBO no dice por qué (Q-62). */
  readonly omit?: readonly string[];
  /** Claves crudas que pisan a las de la plantilla para ese código (un `script`, otro nombre). */
  readonly raw?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface FakeTboWorld {
  /** Códigos de `CountryList`; sin valor, los del ejemplo del PDF (p. 52). */
  readonly countries?: readonly string[];
  readonly cities: Readonly<Record<string, readonly FakeCity[]>>;
  readonly hotels: Readonly<Record<string, readonly FakeHotel[]>>;
  /** `hotelcodelist`; sin valor, responde 404 como un método que no existe (CE-05). */
  readonly codelist?: readonly string[];
  readonly details?: FakeDetails;
  /** Respuesta forzada: `undefined` deja pasar la del mundo. */
  readonly override?: (
    op: StaticOp,
    body: Readonly<Record<string, unknown>> | undefined,
    attempt: number,
  ) => Response | Promise<Response> | undefined;
}

export interface FakeCall {
  readonly op: StaticOp | 'unknown';
  readonly body: Readonly<Record<string, unknown>> | undefined;
  readonly headers: Readonly<Record<string, string>>;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Un sobre de error de TBO dentro de un HTTP 200, como los de la tabla de p. 8-10. */
export function tboStatus(code: number, description: string): Response {
  return jsonResponse({ Status: { Code: code, Description: description } });
}

interface ObservedEnvelopeFixture {
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly bodyText: string;
  };
}

/**
 * La ciudad sin hoteles tal como la contestó TBO en producción (2026-09-29): HTTP 200 con
 * `Status.Code` 500 "No Hotels Found", del fixture del ACL (`envelope/83-500-no-hotels-found.json`).
 */
export function tboNoHotelsFound(): Response {
  const { response } = aclFixture(
    'envelope/83-500-no-hotels-found.json',
  ) as ObservedEnvelopeFixture;
  return new Response(response.bodyText, { status: response.status, headers: response.headers });
}

interface NoHotelsFoundTimingFixture {
  readonly calls: readonly {
    readonly requestId: string;
    readonly noHotelsFoundMs: readonly number[];
  }[];
}

/**
 * Lo que tardó cada "No Hotels Found" de una llamada del log del 2026-09-29, por el prefijo de su
 * `requestId` (`observed/tbo-hotel-code-list.no-hotels-found-timing.json` del ACL).
 */
export function observedNoHotelsFoundMs(requestId: string): readonly number[] {
  const { calls } = aclFixture(
    'observed/tbo-hotel-code-list.no-hotels-found-timing.json',
  ) as NoHotelsFoundTimingFixture;
  const call = calls.find((candidate) => candidate.requestId === requestId);
  if (call === undefined) throw new Error(`la llamada ${requestId} no está en el log`);
  return call.noHotelsFoundMs;
}

interface CountryListFixture {
  readonly Status: unknown;
  readonly CountryList: readonly { readonly Code: string; readonly Name: string }[];
}

interface CityListFixture {
  readonly Status: unknown;
}

interface HotelsFixture {
  readonly Status: unknown;
  readonly Hotels: readonly Readonly<Record<string, unknown>>[];
}

interface HotelDetailsFixture {
  readonly Status: unknown;
  readonly HotelDetails: readonly Readonly<Record<string, unknown>>[];
}

/** Los códigos de `Hotelcodes`, el string CSV que manda el ACL (p. 56; Postman). */
export function requestedHotelCodes(body: Readonly<Record<string, unknown>> | undefined): string[] {
  const raw = body?.['Hotelcodes'];
  return typeof raw === 'string' && raw.length > 0 ? raw.split(',') : [];
}

const OPS_BY_PATH: ReadonlyMap<string, StaticOp> = new Map([
  [TBO_OPERATIONS.countryList.path, 'countryList'],
  [TBO_OPERATIONS.cityList.path, 'cityList'],
  [TBO_OPERATIONS.tboHotelCodeList.path, 'tboHotelCodeList'],
  [TBO_OPERATIONS.hotelDetails.path, 'hotelDetails'],
  [TBO_OPERATIONS.hotelCodeList.path, 'hotelCodeList'],
]);

function headersOf(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function bodyOf(init: RequestInit): Readonly<Record<string, unknown>> | undefined {
  return typeof init.body === 'string'
    ? (JSON.parse(init.body) as Readonly<Record<string, unknown>>)
    : undefined;
}

function countryOfCity(world: FakeTboWorld, cityCode: string): string | undefined {
  for (const [country, cities] of Object.entries(world.cities)) {
    if (cities.some((city) => city.code === cityCode)) return country;
  }
  return undefined;
}

function respond(
  world: FakeTboWorld,
  op: StaticOp,
  body: Readonly<Record<string, unknown>> | undefined,
): Response {
  switch (op) {
    case 'countryList': {
      const fixture = aclFixture('pdf/country-list.p52.json') as CountryListFixture;
      if (world.countries === undefined) return jsonResponse(fixture);
      const names = new Map(fixture.CountryList.map((c) => [c.Code, c.Name]));
      return jsonResponse({
        Status: fixture.Status,
        CountryList: world.countries.map((code) => ({ Code: code, Name: names.get(code) ?? code })),
      });
    }
    case 'cityList': {
      const fixture = aclFixture('pdf/city-list.p54.json') as CityListFixture;
      const country = typeof body?.['CountryCode'] === 'string' ? body['CountryCode'] : '';
      const cities = world.cities[country] ?? [];
      return jsonResponse({
        Status: fixture.Status,
        CityList: cities.map((city) => ({ Code: city.code, Name: city.name })),
      });
    }
    case 'tboHotelCodeList': {
      const fixture = aclFixture('pdf/tbo-hotel-code-list.p67.json') as HotelsFixture;
      const template = fixture.Hotels[0] ?? {};
      const cityCode = typeof body?.['CityCode'] === 'string' ? body['CityCode'] : '';
      const country = countryOfCity(world, cityCode);
      const hotels = (world.hotels[cityCode] ?? []).map((hotel) => ({
        ...template,
        HotelCode: hotel.code,
        HotelName: hotel.name ?? `Hotel ${hotel.code}`,
        ...(hotel.rating === undefined ? {} : { HotelRating: hotel.rating }),
        Map:
          hotel.lat === undefined || hotel.lng === undefined ? '0|0' : `${hotel.lat}|${hotel.lng}`,
        ...(country === undefined ? {} : { CountryCode: country }),
        ...hotel.raw,
      }));
      return jsonResponse({ Status: fixture.Status, Hotels: hotels });
    }
    case 'hotelDetails': {
      const fixture = aclFixture('pdf/hotel-details.p59.json') as HotelDetailsFixture;
      const template = fixture.HotelDetails[0] ?? {};
      const language = typeof body?.['Language'] === 'string' ? body['Language'] : '';
      const omitted = new Set(world.details?.omit ?? []);
      const hotels = requestedHotelCodes(body)
        .filter((code) => !omitted.has(code))
        .map((code) => ({
          ...template,
          HotelCode: code,
          // El idioma en el nombre, para ver en qué fila terminó cada respuesta.
          HotelName: `Hotel ${code} ${language}`,
          ...world.details?.raw?.[code],
        }));
      return jsonResponse({ Status: fixture.Status, HotelDetails: hotels });
    }
    case 'hotelCodeList': {
      if (world.codelist === undefined) {
        return new Response('Not Found', {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        });
      }
      // Enteros, como el ejemplo de p. 55: el ACL los normaliza a string.
      return jsonResponse({ HotelCodes: world.codelist.map((code) => Number(code)) });
    }
  }
}

export interface FakeTbo {
  readonly fetch: TboFetch;
  readonly calls: FakeCall[];
  callsTo(op: StaticOp): FakeCall[];
}

export function fakeTbo(world: FakeTboWorld): FakeTbo {
  const calls: FakeCall[] = [];
  const attempts = new Map<string, number>();
  const fetch: TboFetch = async (url, init) => {
    const path = url.startsWith(TBO_BASE_URLS.test) ? url.slice(TBO_BASE_URLS.test.length) : url;
    const op = OPS_BY_PATH.get(path);
    const body = bodyOf(init);
    calls.push({ op: op ?? 'unknown', body, headers: headersOf(init) });
    if (op === undefined) return new Response('Not Found', { status: 404 });
    const key = `${op}:${JSON.stringify(body ?? null)}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const forced = await world.override?.(op, body, attempt);
    return forced ?? respond(world, op, body);
  };
  return {
    fetch,
    calls,
    callsTo: (op) => calls.filter((call) => call.op === op),
  };
}
