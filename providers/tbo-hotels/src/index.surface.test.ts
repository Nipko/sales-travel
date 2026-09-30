import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as index from './index';

import * as bookBuilder from './booking/book.request.builder';
import * as bookMapper from './booking/book.response.mapper';
import * as bookSchema from './booking/book.response.schema';
import * as bookingReference from './booking/booking-reference';
import * as classifyBook from './booking/classify-book-outcome';
import * as cancelDecision from './cancel/cancel-decision';
import * as cancelBuilder from './cancel/cancel.request.builder';
import * as cancelMapper from './cancel/response.mapper';
import * as cancelSchema from './cancel/response.schema';
import * as policyMapper from './cancellation/policy.mapper';
import * as config from './config';
import * as detailBuilder from './detail/booking-detail.request.builder';
import * as bookingStatus from './detail/booking-status';
import * as detailMapper from './detail/response.mapper';
import * as detailSchema from './detail/response.schema';
import * as errors from './errors';
import * as limiter from './http/limiter';
import * as operations from './http/operations';
import * as statusEnvelope from './http/status-envelope';
import * as httpClient from './http/tbo-http.client';
import * as prebookCompare from './prebook/compare';
import * as prebookBuilder from './prebook/prebook.request.builder';
import * as rateConditions from './prebook/rate-conditions';
import * as prebookMapper from './prebook/response.mapper';
import * as prebookSchema from './prebook/response.schema';
import * as providerCode from './provider-code';
import * as redaction from './redaction';
import * as byDateBuilder from './reports/booking-by-date.request.builder';
import * as byDateMapper from './reports/booking-by-date.response.mapper';
import * as byDateSchema from './reports/booking-by-date.response.schema';
import * as roompackMapper from './roompack/roompack.mapper';
import * as mealType from './search/meal-type';
import * as offerWindow from './search/offer-window';
import * as searchMapper from './search/response.mapper';
import * as searchSchema from './search/response.schema';
import * as searchBuilder from './search/search.request.builder';
import * as cityListBuilder from './static/city-list.request.builder';
import * as cityListMapper from './static/city-list.response.mapper';
import * as contentHash from './static/content-hash';
import * as contentTypes from './static/content.types';
import * as countryListMapper from './static/country-list.response.mapper';
import * as hotelCodeListMapper from './static/hotel-code-list.response.mapper';
import * as hotelDetailsBuilder from './static/hotel-details.request.builder';
import * as hotelDetailsMapper from './static/hotel-details.response.mapper';
import * as hotelRecord from './static/hotel-record';
import * as htmlSanitizer from './static/html-sanitizer';
import * as imageHosts from './static/image-hosts';
import * as staticNormalize from './static/normalize';
import * as staticObserver from './static/observer';
import * as staticSchema from './static/response.schema';
import * as cityHotelsBuilder from './static/tbo-hotel-code-list.request.builder';
import * as cityHotelsMapper from './static/tbo-hotel-code-list.response.mapper';
import * as adapter from './tbo-hotels.adapter';
import * as staticClient from './tbo-static-content.client';

/**
 * La SONDA del entry público, sobre el modelo de `providers/sabre/src/index.surface.test.ts`.
 *
 * Comprueba tres cosas que el typecheck no ve:
 *
 *  1. IDENTIDAD: lo que `src/index.ts` publica es el MISMO objeto que define su módulo, no una copia
 *     escrita otra vez. Una copia deriva en la siguiente edición y deja a los tests midiendo una
 *     regla y a producción ejecutando otra.
 *  2. CIERRE: no se publica nada fuera de la lista. `src/internal/**` y los tipos crudos de TBO no
 *     salen del paquete (08 RF-07 CA-6); un `export *` que arrastrara un helper interno pondría
 *     esto rojo.
 *  3. FUENTE: el entry no declara nada ni usa `export *`. La identidad no distingue dos strings con
 *     el mismo valor, así que el hueco de la copia todavía idéntica se tapa prohibiendo declarar.
 *
 * Los `export type` no existen en tiempo de ejecución: de ésos responde el `typecheck`.
 */

interface ProbedModule {
  readonly name: string;
  readonly module: Record<string, unknown>;
  /** Exports del módulo que el entry NO publica, con el motivo. Una omisión es una decisión escrita. */
  readonly notPublished?: Readonly<Record<string, string>>;
}

const RAW_SCHEMA = 'esquema crudo de TBO (08 RF-07 CA-6)';
const NORMALIZER = 'lo aplican los mappers; fuera se leen los tipos ya normalizados';
const SANITIZER =
  'se aplica al ingerir, dentro del cliente: lo que sale ya es HTML seguro (RNF-16)';
const RAW_RATE_CONDITIONS =
  'recibe el texto crudo de TBO; fuera se leen las condiciones ya saneadas del reporte (RF-16)';

const PROBED: readonly ProbedModule[] = [
  { name: 'config', module: config },
  { name: 'errors', module: errors },
  { name: 'http/operations', module: operations },
  { name: 'http/tbo-http.client', module: httpClient },
  { name: 'http/limiter', module: limiter },
  {
    name: 'http/status-envelope',
    module: statusEnvelope,
    notPublished: {
      classifyTboResponse:
        'la única regla que decide éxito o error; sólo la ejecuta el cliente, nunca un llamador',
      TBO_STATUS_CODES: 'tabla interna del clasificador; fuera se razona por `failure.kind`',
      TBO_DESCRIPTION_LOG_MAX: 'detalle del log del cliente',
    },
  },
  {
    name: 'redaction',
    module: redaction,
    notPublished: {
      normalizeTboKey: 'helper de la guarda D1 y de la exportación; sin uso fuera del paquete',
      isTboCardKey: 'la guarda D1 vive en el cliente; fuera no hay nada que decidir con esto',
      isTboSensitiveKey: 'lo aplica `redactTboPayload`, que es la superficie de exportación',
      TBO_LOG_FIELDS: 'la lista blanca la aplica el cliente al loguear; no es configurable',
      pickTboLogMeta: 'ídem: el cliente es el único que escribe logs con datos de TBO',
    },
  },
  { name: 'provider-code', module: providerCode },
  {
    name: 'search/search.request.builder',
    module: searchBuilder,
    notPublished: {
      buildTboSearchRequest:
        'arma el body crudo de TBO; lo usa el adapter del paquete y el arnés pasa por el adapter',
    },
  },
  { name: 'search/offer-window', module: offerWindow },
  {
    name: 'search/response.schema',
    module: searchSchema,
    notPublished: {
      TboDecimalSchema: 'esquema crudo de TBO (08 RF-07 CA-6)',
      TboSupplementSchema: 'esquema crudo de TBO (08 RF-07 CA-6)',
      TboCancelPolicySchema: 'esquema crudo de TBO (08 RF-07 CA-6)',
      TboSearchRoomSchema: 'esquema crudo de TBO (08 RF-07 CA-6)',
      TboSearchHotelSchema: 'esquema crudo de TBO (08 RF-07 CA-6)',
      TboSearchEnvelopeSchema: 'esquema crudo de TBO; lo pasa el adapter como responseSchema',
      TBO_SEARCH_ROOT_KEYS: 'detalle de la detección de claves desconocidas del mapper',
      TBO_SEARCH_HOTEL_KEYS: 'ídem',
      TBO_SEARCH_ROOM_KEYS: 'ídem',
      TBO_SUPPLEMENT_KEYS: 'ídem',
      TBO_CANCEL_POLICY_KEYS: 'ídem',
      TBO_DAY_RATE_KEYS: 'ídem',
    },
  },
  {
    name: 'search/response.mapper',
    module: searchMapper,
    notPublished: {
      mapTboSearchResponse:
        'recibe el sobre crudo de TBO; fuera del paquete la salida es el adapter (PR-1.5)',
    },
  },
  {
    name: 'search/meal-type',
    module: mealType,
    notPublished: {
      TBO_MEAL_PLANS: 'vocabulario del request de TBO; fuera se filtra por BoardType',
      mapTboMealType: 'lo aplica el mapper; fuera se lee board, boardLabel y mealTypeRaw',
    },
  },
  { name: 'tbo-hotels.adapter', module: adapter },
  {
    name: 'cancellation/policy.mapper',
    module: policyMapper,
    notPublished: {
      mapTboCancellation:
        'recibe tramos crudos de TBO; lo comparten los mappers de Search y PreBook',
    },
  },
  {
    name: 'roompack/roompack.mapper',
    module: roompackMapper,
    notPublished: {
      mapTboRoompack: 'recibe la habitación cruda de TBO; lo comparten Search y PreBook',
      readTboHotelCurrency: 'recibe la moneda cruda de un HotelResult',
      rejectTbo: 'helper de los mappers',
      tboDecimalText: 'helper de los mappers: el literal sale ya en TboSearchPackContext',
    },
  },
  // ───────────── PreBook (PR-4.1) ─────────────
  {
    name: 'prebook/prebook.request.builder',
    module: prebookBuilder,
    notPublished: {
      buildTboPrebookRequest: 'arma el body crudo de TBO; fuera se llama al adapter',
      TboPrebookRequestSchema: RAW_SCHEMA,
      TBO_PREBOOK_PAYMENT_MODE: 'el modo no se elige fuera del builder: siempre "Limit" (D1)',
    },
  },
  {
    name: 'prebook/response.schema',
    module: prebookSchema,
    notPublished: {
      TboPrebookEnvelopeSchema: 'esquema crudo de TBO; lo pasa el adapter como responseSchema',
      TboPrebookRoomSchema: RAW_SCHEMA,
      TboPrebookHotelSchema: RAW_SCHEMA,
      TBO_PREBOOK_IGNORED_HOTEL_KEYS: 'detalle de la detección de claves desconocidas del mapper',
      TBO_PREBOOK_ROOT_KEYS: 'ídem',
      TBO_PREBOOK_HOTEL_KEYS: 'ídem',
      TBO_PREBOOK_ROOM_KEYS: 'ídem',
    },
  },
  {
    name: 'prebook/response.mapper',
    module: prebookMapper,
    notPublished: {
      mapTboPrebookResponse:
        'recibe el sobre crudo de TBO; fuera del paquete la salida es el adapter',
    },
  },
  {
    name: 'prebook/rate-conditions',
    module: rateConditions,
    notPublished: {
      TBO_RATE_SIGNALS: 'el vocabulario es el de HotelRateSignal del dominio',
      readTboRateConditions: RAW_RATE_CONDITIONS,
      tboRateConditionToText: RAW_RATE_CONDITIONS,
      classifyTboRateCondition: RAW_RATE_CONDITIONS,
      detectTboRateSignals: RAW_RATE_CONDITIONS,
    },
  },
  { name: 'prebook/compare', module: prebookCompare },
  // ───────────── Book y BookingDetail (PR-4.2) ─────────────
  { name: 'booking/booking-reference', module: bookingReference },
  {
    name: 'booking/book.request.builder',
    module: bookBuilder,
    notPublished: {
      buildTboBookRequest: 'arma el body crudo de TBO; fuera se llama al adapter',
      TboBookRequestSchema: RAW_SCHEMA,
      TBO_BOOK_PAYMENT_MODE: 'el modo no se elige fuera del builder: siempre "Limit" (D1)',
      TBO_BOOK_BOOKING_TYPE: 'constante del contrato (p. 33): fuera no hay nada que elegir',
      normalizeTboGuestName:
        'la aplica `checkTboBookGuests`, que devuelve los nombres ya normalizados',
    },
  },
  {
    name: 'booking/book.response.schema',
    module: bookSchema,
    notPublished: {
      TboBookEnvelopeSchema: 'esquema crudo de TBO; lo pasa el adapter como responseSchema',
      TBO_BOOK_ROOT_KEYS: 'detalle de la detección de claves desconocidas del mapper',
    },
  },
  {
    name: 'booking/book.response.mapper',
    module: bookMapper,
    notPublished: {
      mapTboBookResponse: 'recibe el sobre crudo de TBO; fuera del paquete la salida es el adapter',
    },
  },
  { name: 'booking/classify-book-outcome', module: classifyBook },
  {
    name: 'detail/booking-detail.request.builder',
    module: detailBuilder,
    notPublished: {
      buildTboBookingDetailRequest: 'arma el body crudo de TBO; fuera se llama al adapter',
      TboBookingDetailRequestSchema: RAW_SCHEMA,
      TBO_BOOKING_DETAIL_PAYMENT_MODE:
        'el modo no se elige fuera del builder: siempre "Limit" (D1)',
    },
  },
  {
    name: 'detail/response.schema',
    module: detailSchema,
    notPublished: {
      TboBookingDetailEnvelopeSchema:
        'esquema crudo de TBO; lo pasa el adapter como responseSchema',
      TboBookingDetailSchema: RAW_SCHEMA,
      TboBookedRoomSchema: RAW_SCHEMA,
      TboBookedHotelSchema: RAW_SCHEMA,
      TBO_BOOKING_DETAIL_ROOT_KEYS: 'detalle de la detección de claves desconocidas del mapper',
      TBO_BOOKING_DETAIL_KEYS: 'ídem',
      TBO_BOOKED_HOTEL_KEYS: 'ídem',
      TBO_BOOKED_ROOM_KEYS: 'ídem',
    },
  },
  {
    name: 'detail/booking-status',
    module: bookingStatus,
    notPublished: {
      readTboBookingStatus: 'recibe el valor crudo de TBO; fuera se lee `status` de la vista',
    },
  },
  {
    name: 'detail/response.mapper',
    module: detailMapper,
    notPublished: {
      mapTboBookingDetailResponse:
        'recibe el sobre crudo de TBO; fuera del paquete la salida es el adapter',
    },
  },
  // ───────────── Cancel y BookingDetailsbasedondate (PR-5.1) ─────────────
  {
    name: 'cancel/cancel.request.builder',
    module: cancelBuilder,
    notPublished: {
      buildTboCancelRequest: 'arma el body crudo de TBO; fuera se llama al adapter',
      TboCancelRequestSchema: RAW_SCHEMA,
    },
  },
  {
    name: 'cancel/response.schema',
    module: cancelSchema,
    notPublished: {
      TboCancelEnvelopeSchema: 'esquema crudo de TBO; lo pasa el adapter como responseSchema',
      TBO_CANCEL_ROOT_KEYS: 'detalle de la detección de claves desconocidas del mapper',
    },
  },
  {
    name: 'cancel/response.mapper',
    module: cancelMapper,
    notPublished: {
      mapTboCancelResponse:
        'recibe el sobre crudo de TBO o lo que lanzó el cliente; fuera la salida es el adapter',
    },
  },
  {
    name: 'cancel/cancel-decision',
    module: cancelDecision,
    notPublished: {
      decideTboCancelPreflight: 'la aplica el adapter; fuera se lee el resultado del puerto',
      decideTboCancelResult: 'ídem',
    },
  },
  {
    name: 'reports/booking-by-date.request.builder',
    module: byDateBuilder,
    notPublished: {
      buildTboBookingsByDateRequest: 'arma el body crudo de TBO; fuera se llama al adapter',
      TboBookingsByDateRequestSchema: RAW_SCHEMA,
    },
  },
  {
    name: 'reports/booking-by-date.response.schema',
    module: byDateSchema,
    notPublished: {
      TboBookingsByDateEnvelopeSchema:
        'esquema crudo de TBO; lo pasa el adapter como responseSchema',
      TboBookingByDateRowSchema: RAW_SCHEMA,
      TBO_BOOKINGS_BY_DATE_ROOT_KEYS: 'detalle de la detección de claves desconocidas del mapper',
      TBO_BOOKING_BY_DATE_ROW_KEYS: 'ídem',
    },
  },
  {
    name: 'reports/booking-by-date.response.mapper',
    module: byDateMapper,
    notPublished: {
      mapTboBookingsByDateResponse:
        'recibe el sobre crudo de TBO; fuera del paquete la salida es el adapter',
    },
  },
  // ───────────── Contenido estático (PR-3.1) ─────────────
  { name: 'tbo-static-content.client', module: staticClient },
  { name: 'static/content.types', module: contentTypes },
  { name: 'static/content-hash', module: contentHash },
  { name: 'static/image-hosts', module: imageHosts },
  {
    name: 'static/hotel-details.request.builder',
    module: hotelDetailsBuilder,
    notPublished: {
      buildTboHotelDetailsRequest: 'arma el body crudo de TBO; fuera se llama al cliente',
    },
  },
  {
    name: 'static/city-list.request.builder',
    module: cityListBuilder,
    notPublished: {
      buildTboCityListRequest: 'arma el body crudo de TBO; fuera se llama al cliente',
    },
  },
  {
    name: 'static/tbo-hotel-code-list.request.builder',
    module: cityHotelsBuilder,
    notPublished: {
      buildTboCityHotelsRequest: 'arma el body crudo de TBO; fuera se llama al cliente',
    },
  },
  {
    name: 'static/country-list.response.mapper',
    module: countryListMapper,
    notPublished: { mapTboCountryListResponse: 'recibe el sobre crudo de TBO' },
  },
  {
    name: 'static/city-list.response.mapper',
    module: cityListMapper,
    notPublished: { mapTboCityListResponse: 'recibe el sobre crudo de TBO' },
  },
  {
    name: 'static/tbo-hotel-code-list.response.mapper',
    module: cityHotelsMapper,
    notPublished: {
      mapTboCityHotelsResponse: 'recibe el sobre crudo de TBO',
      emptyTboCityHotelsMapping: 'la usa el cliente de contenido ante un "No Hotels Found"',
    },
  },
  {
    name: 'static/hotel-details.response.mapper',
    module: hotelDetailsMapper,
    notPublished: { mapTboHotelDetailsResponse: 'recibe el sobre crudo de TBO' },
  },
  {
    name: 'static/hotel-code-list.response.mapper',
    module: hotelCodeListMapper,
    notPublished: { mapTboHotelCodeListResponse: 'recibe el sobre crudo de TBO' },
  },
  {
    name: 'static/response.schema',
    module: staticSchema,
    notPublished: {
      TboCountryListEnvelopeSchema: RAW_SCHEMA,
      TboCityListEnvelopeSchema: RAW_SCHEMA,
      TboCityHotelsEnvelopeSchema: RAW_SCHEMA,
      TboHotelDetailsEnvelopeSchema: RAW_SCHEMA,
      TboHotelCodeListEnvelopeSchema: RAW_SCHEMA,
      TboStaticCodeSchema: RAW_SCHEMA,
      TboCountryItemSchema: RAW_SCHEMA,
      TboCityItemSchema: RAW_SCHEMA,
      TboHotelItemSchema: RAW_SCHEMA,
      TboTextFieldSchema: RAW_SCHEMA,
      TboRatingFieldSchema: RAW_SCHEMA,
      TboListFieldSchema: RAW_SCHEMA,
      TboAttractionsFieldSchema: RAW_SCHEMA,
      TboCoordinateFieldSchema: RAW_SCHEMA,
      TBO_STATIC_ROOT_KEYS: 'detalle de la detección de claves desconocidas de los mappers',
      TBO_COUNTRY_ITEM_KEYS: 'ídem',
      TBO_CITY_ITEM_KEYS: 'ídem',
      TBO_HOTEL_FIELD_KEYS: 'ídem',
      TBO_CITY_HOTEL_FIELD_KEYS: 'ídem',
    },
  },
  {
    name: 'static/observer',
    module: staticObserver,
    notPublished: { TboStaticObserver: 'contador interno de los mappers de contenido estático' },
  },
  {
    name: 'static/hotel-record',
    module: hotelRecord,
    notPublished: { readTboHotelRecord: 'recibe un hotel crudo de TBO' },
  },
  {
    name: 'static/normalize',
    module: staticNormalize,
    notPublished: {
      normalizeTboText: NORMALIZER,
      stripTboControlChars: NORMALIZER,
      normalizeTboStars: NORMALIZER,
      normalizeTboMap: NORMALIZER,
      normalizeTboLatLng: NORMALIZER,
      normalizeTboCountryCode: NORMALIZER,
      normalizeTboCheckTime: NORMALIZER,
      normalizeTboImageUrl: NORMALIZER,
      normalizeTboWebsiteUrl: NORMALIZER,
      toTboTextList: NORMALIZER,
      joinTboAttractions: NORMALIZER,
    },
  },
  {
    name: 'static/html-sanitizer',
    module: htmlSanitizer,
    notPublished: {
      TBO_HTML_ALLOWED_TAGS: SANITIZER,
      decodeTboHtmlEntities: 'la usan el saneador y las condiciones de PreBook, dentro del paquete',
      sanitizeTboHtml: SANITIZER,
      tboHtmlToText: SANITIZER,
      splitTboDescriptionSections: SANITIZER,
      classifyTboFacility: SANITIZER,
    },
  },
];

const surface = index as unknown as Record<string, unknown>;

describe('el entry público republica los módulos, no copias de ellos', () => {
  for (const probed of PROBED) {
    describe(probed.name, () => {
      const exported = Object.keys(probed.module).filter((key) => key !== 'default');

      it('exporta algo (si no, el módulo cambió de forma y el test se volvió vacuo)', () => {
        expect(exported.length).toBeGreaterThan(0);
      });

      it.each(exported)('%s es el MISMO objeto en el entry', (name) => {
        const reason = probed.notPublished?.[name];
        if (reason !== undefined) {
          expect(
            Object.is(surface[name], probed.module[name]),
            `'${name}' está en \`notPublished\` (${reason}) pero el entry SÍ lo publica.`,
          ).toBe(false);
          return;
        }
        expect(
          Object.hasOwn(surface, name),
          `src/index.ts no publica '${name}' de ${probed.name}. Añadilo al entry o declaralo en ` +
            `\`notPublished\` con el motivo.`,
        ).toBe(true);
        expect(
          Object.is(surface[name], probed.module[name]),
          `src/index.ts publica un '${name}' que NO es el de ${probed.name}: es una copia.`,
        ).toBe(true);
      });
    });
  }
});

describe('el entry no publica nada fuera de los módulos sondeados', () => {
  it('cada nombre del entry sale de un módulo sondeado', () => {
    const allowed = new Set(
      PROBED.flatMap((probed) =>
        Object.keys(probed.module).filter((key) => probed.notPublished?.[key] === undefined),
      ),
    );
    const extra = Object.keys(surface).filter((key) => !allowed.has(key));
    expect(
      extra,
      `src/index.ts publica nombres que no vienen de un módulo sondeado (${extra.join(', ')}). ` +
        `Si es superficie nueva, sumá su módulo a PROBED; si es un helper interno, no se publica.`,
    ).toEqual([]);
  });

  it('los helpers de src/internal no son alcanzables desde fuera', () => {
    for (const name of [
      'decimalToMinor',
      'toMinorUnits',
      'minorUnitExponent',
      'optionalString',
      'optionalInteger',
      'toList',
      'parseTboCancelPolicyDate',
      'isTboIsoDate',
      'zodIssueRef',
      'zodIssueRefs',
      'compareDecimals',
    ]) {
      expect(Object.hasOwn(surface, name), `'${name}' es interno y no debe publicarse`).toBe(false);
    }
  });
});

describe('la fuente del entry', () => {
  const source = readFileSync(findEntry(), 'utf8');

  it('no declara nada: sólo re-exporta', () => {
    const declarations = [
      ...source.matchAll(/^export\s+(?:declare\s+)?(const|let|var|function|class|enum)\s+(\w+)/gm),
    ].map((match) => `${String(match[1])} ${String(match[2])}`);
    expect(declarations).toEqual([]);
  });

  it('no usa export *: la superficie se nombra entera', () => {
    expect(source).not.toMatch(/^export\s+\*/m);
    expect(source).not.toMatch(/^export\s+type\s+\*/m);
  });

  it('no re-exporta nada de src/internal', () => {
    expect(source).not.toMatch(/from\s+'\.\/internal\//);
  });

  it('no re-exporta los builders, esquemas, mappers ni normalizadores del contenido estático', () => {
    expect(source).not.toMatch(
      /from\s+'\.\/static\/(response\.schema|observer|hotel-record|normalize|html-sanitizer|[\w-]+\.response\.mapper)'/,
    );
    expect(source).not.toMatch(/\bbuildTbo(CityList|CityHotels|HotelDetails)Request\b/);
  });

  it('no re-exporta el builder, el esquema, el saneo ni el mapeo de PreBook (08 RF-07 CA-6)', () => {
    expect(source).not.toMatch(
      /from\s+'\.\/prebook\/(response\.schema|prebook\.request\.builder)'/,
    );
    expect(source).not.toMatch(/from\s+'\.\/roompack\//);
    expect(source).not.toMatch(
      /\b(mapTboPrebookResponse|buildTboPrebookRequest|TboPrebookRequest|readTboRateConditions)\b/,
    );
  });

  it('no re-exporta el builder, los esquemas ni los mappers de Book y BookingDetail (08 RF-07 CA-6)', () => {
    expect(source).not.toMatch(/from\s+'\.\/booking\/book\.response\.(schema|mapper)'/);
    expect(source).not.toMatch(
      /from\s+'\.\/detail\/(response\.schema|booking-detail\.request\.builder)'/,
    );
    expect(source).not.toMatch(
      /\b(buildTboBookRequest|TboBookRequest|TboBookRequestSchema|buildTboBookingDetailRequest|TboBookingDetailRequest|mapTboBookResponse|mapTboBookingDetailResponse|readTboBookingStatus|normalizeTboGuestName)\b/,
    );
  });

  it('no re-exporta el builder, los esquemas ni los mappers de Cancel y BookingDetailsbasedondate (08 RF-07 CA-6)', () => {
    expect(source).not.toMatch(
      /from\s+'\.\/cancel\/(response\.(schema|mapper)|cancel\.request\.builder)'/,
    );
    expect(source).not.toMatch(/from\s+'\.\/reports\/booking-by-date\.response\.(schema|mapper)'/);
    expect(source).not.toMatch(
      /\b(buildTboCancelRequest|TboCancelRequest|TboCancelRequestSchema|TboCancelEnvelope|mapTboCancelResponse|decideTboCancelPreflight|decideTboCancelResult|buildTboBookingsByDateRequest|TboBookingsByDateRequest|TboBookingsByDateRequestSchema|TboBookingsByDateEnvelope|TboBookingByDateRow|mapTboBookingsByDateResponse)\b/,
    );
  });

  it('no re-exporta los esquemas crudos de TBO ni los mappers que los reciben (08 RF-07 CA-6)', () => {
    expect(source).not.toMatch(/from\s+'\.\/search\/response\.(schema|mapper)'/);
    expect(source).not.toMatch(/from\s+'\.\/search\/meal-type'/);
    expect(source).not.toMatch(/from\s+'\.\/cancellation\//);
    expect(source).not.toMatch(/\bbuildTboSearchRequest\b|\bTboSearchRequest\b/);
  });
});

/** La raíz del paquete desde el cwd de vitest, igual que en Sabre. */
function findEntry(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const name = (JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }).name;
      if (name === '@sales-travel/tbo-hotels') return join(dir, 'src', 'index.ts');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolvePath(process.cwd(), 'providers', 'tbo-hotels', 'src', 'index.ts');
}
