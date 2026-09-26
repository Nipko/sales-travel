import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Un TBO falso con forma de `fetch`, para correr el arnés sin credenciales ni red. Las respuestas
 * de éxito son los fixtures del PDF que usa el propio ACL (`providers/tbo-hotels/src/__fixtures__`),
 * así que lo que el ACL lee aquí es lo que ya sabe leer. Las de error son las posturas de
 * docs/tbo/01 §8: nadie sabe todavía qué manda TBO, que es justo lo que las sondas van a contestar.
 */

const PDF_FIXTURES = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'providers',
  'tbo-hotels',
  'src',
  '__fixtures__',
  'pdf',
);

function fixture(name) {
  return JSON.parse(readFileSync(join(PDF_FIXTURES, name), 'utf8'));
}

export const TEST_USERNAME = 'cert-user-7';
// Con espacio y comillas: la redacción tiene que encontrarla también escapada dentro de un JSON.
export const TEST_PASSWORD = 'pa ss"word-9Q';
export const TEST_TOKEN = Buffer.from(`${TEST_USERNAME}:${TEST_PASSWORD}`, 'utf8').toString(
  'base64',
);

function envelope(code, description, extra = {}) {
  return JSON.stringify({ Status: { Code: code, Description: description }, ...extra });
}

function respond(status, body, contentType = 'application/json; charset=utf-8') {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function searchResponse(firstCode) {
  const body = fixture('search-single-room.p15.json');
  body.HotelResult[0].HotelCode = firstCode;
  return JSON.stringify(body);
}

/**
 * @param {object} [behavior]
 * @param {boolean} [behavior.tls] `https://` responde; si no, la conexión se rechaza.
 * @param {boolean} [behavior.caseSensitive] El routing distingue mayúsculas (`/search` da 404).
 * @param {boolean} [behavior.rejectEmptyAges] `ChildrenAges: []` sin niños da 400.
 * @param {boolean} [behavior.rejectOmittedAges] Sin `ChildrenAges` da 400.
 * @param {boolean} [behavior.acceptMealOrdinal] `MealType: 0` pasa.
 * @param {number} [behavior.maxHotelCodes] Más códigos que esto da 400.
 * @param {number} [behavior.searchCode] `Status.Code` de un Search válido (200 o 201).
 * @param {string} [behavior.searchDescription] `Status.Description` de un Search válido.
 * @param {string} [behavior.searchCurrency] `Currency` del hotel en un Search válido.
 * @param {string} [behavior.searchBody] Cuerpo literal de un Search válido, en lugar del fixture.
 * @param {string} [behavior.expectedToken] El Basic que acepta; por defecto el de las constantes.
 * @param {number} [behavior.cityHotels] Hoteles de `TBOHotelCodeList`; por defecto el del fixture.
 */
export function createFakeTbo(behavior = {}) {
  const b = {
    tls: false,
    caseSensitive: true,
    rejectEmptyAges: false,
    rejectOmittedAges: true,
    acceptMealOrdinal: false,
    maxHotelCodes: 100,
    searchCode: 200,
    searchDescription: 'Successful',
    searchCurrency: 'USD',
    searchBody: undefined,
    expectedToken: TEST_TOKEN,
    ...behavior,
  };
  const requests = [];

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const authorization = new Headers(init.headers).get('authorization');
    requests.push({
      url: url.href,
      method: init.method ?? 'GET',
      body: init.body,
      authorization,
      redirect: init.redirect,
    });

    if (url.protocol === 'https:' && !b.tls) {
      const cause = Object.assign(new Error('connect ECONNREFUSED 203.0.113.7:443'), {
        code: 'ECONNREFUSED',
      });
      throw new TypeError('fetch failed', { cause });
    }
    if (authorization !== `Basic ${b.expectedToken}`) {
      return respond(401, envelope(401, 'Access Credentials is incorrect'));
    }

    const segment = url.pathname.split('/').pop() ?? '';
    const route = b.caseSensitive ? segment : segment.toLowerCase();
    const is = (name) => route === (b.caseSensitive ? name : name.toLowerCase());
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;

    if (is('Search')) {
      const codes = String(body.HotelCodes).split(',');
      if (codes.length > b.maxHotelCodes)
        return respond(200, envelope(400, 'HotelCodes limit exceeded'));
      if (typeof body.Filters?.MealType === 'number' && !b.acceptMealOrdinal) {
        return respond(200, envelope(400, 'Invalid MealType'));
      }
      for (const room of body.PaxRooms) {
        if (room.Children !== 0) continue;
        if (room.ChildrenAges === undefined && b.rejectOmittedAges) {
          return respond(200, envelope(400, 'ChildrenAges is required'));
        }
        if (
          Array.isArray(room.ChildrenAges) &&
          room.ChildrenAges.length === 0 &&
          b.rejectEmptyAges
        ) {
          return respond(200, envelope(400, 'ChildrenAges is invalid'));
        }
      }
      if (b.searchCode === 201) {
        return respond(200, envelope(201, 'No Available rooms for given criteria'));
      }
      if (b.searchBody !== undefined) return respond(200, b.searchBody);
      const payload = JSON.parse(searchResponse(codes[0]));
      payload.Status.Description = b.searchDescription;
      payload.HotelResult[0].Currency = b.searchCurrency;
      return respond(200, JSON.stringify(payload));
    }
    if (is('HotelDetails')) {
      const payload = fixture('hotel-details.p59.json');
      payload.HotelDetails[0].HotelCode = String(body.Hotelcodes).split(',')[0];
      return respond(200, JSON.stringify(payload));
    }
    if (is('BookingDetailsbasedondate')) return respond(200, envelope(201, 'No booking found'));
    if (is('hotelcodelist')) {
      const codes = Array.from({ length: 150 }, (_, i) => 1_000_000 + i);
      return respond(200, JSON.stringify({ HotelCodes: codes }));
    }
    if (is('TBOHotelCodeList')) {
      const payload = fixture('tbo-hotel-code-list.p67.json');
      if (b.cityHotels !== undefined) {
        const [model] = payload.Hotels;
        payload.Hotels = Array.from({ length: b.cityHotels }, (_, i) => ({
          ...model,
          HotelCode: String(3_000_000 + i),
        }));
      }
      return respond(200, JSON.stringify(payload));
    }
    if (is('BookingDetail')) return respond(200, envelope(400, 'Booking not found'));
    if (is('PreBook')) return respond(200, envelope(207, 'Rate is not available'));
    return respond(
      404,
      '<html><body>404 - File or directory not found.</body></html>',
      'text/html',
    );
  }

  return { fetch, requests };
}
