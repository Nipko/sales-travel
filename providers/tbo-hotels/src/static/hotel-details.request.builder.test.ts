import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TboRequestBuildError } from '../errors';
import { TBO_OPERATIONS } from '../http/operations';
import {
  TBO_HOTEL_DETAILS_LIMITS,
  buildTboHotelDetailsRequest,
} from './hotel-details.request.builder';

/** El body de HotelDetails contra docs/tbo/05 §2.6.1 y §10 (p. 56-58; Postman: `Hotel Details`). */

/** Los 13 códigos del body de la colección (Postman: `Hotel Details`). */
const POSTMAN_CODES = [
  '376565',
  '1345318',
  '1345320',
  '1200255',
  '1128760',
  '1250333',
  '1078234',
  '1347149',
  '1358855',
  '1345321',
  '1108025',
  '1356271',
  '1267547',
];

function buildError(run: () => unknown): TboRequestBuildError {
  try {
    run();
  } catch (err) {
    if (err instanceof TboRequestBuildError) return err;
    throw err;
  }
  throw new Error('el builder no lanzó');
}

describe('buildTboHotelDetailsRequest', () => {
  it('Postman: `Hotel Details` — los 13 códigos en UN string CSV con `Hotelcodes` y `EN`', () => {
    expect(buildTboHotelDetailsRequest(POSTMAN_CODES, 'en')).toEqual({
      Hotelcodes: POSTMAN_CODES.join(','),
      Language: 'EN',
    });
  });

  it('p. 58: difiere del ejemplo SÓLO en que `Hotelcodes` va como string y no como número', () => {
    const pdf = JSON.parse(
      readFileSync(
        join(__dirname, '..', '__fixtures__', 'pdf', 'hotel-details-request.p58.json'),
        'utf8',
      ),
    ) as { Hotelcodes: number; Language: string };
    const ours = buildTboHotelDetailsRequest([String(pdf.Hotelcodes)], 'en');
    expect(Object.keys(ours)).toEqual(Object.keys(pdf));
    expect(ours.Language).toBe(pdf.Language);
    expect(typeof pdf.Hotelcodes).toBe('number');
    expect(ours.Hotelcodes).toBe(String(pdf.Hotelcodes));
  });

  it.each([
    ['es', 'ES'],
    ['pt', 'PT'],
    ['en', 'EN'],
  ] as const)('idioma %s → %s en mayúsculas (p. 58; Q-66)', (lang, code) => {
    expect(buildTboHotelDetailsRequest(['1000000'], lang).Language).toBe(code);
  });

  it('nunca pide el detalle por habitación: sin `IsRoomDetailRequired` (RF-32; Q-65)', () => {
    expect(buildTboHotelDetailsRequest(['1000000'], 'es')).not.toHaveProperty(
      'IsRoomDetailRequired',
    );
  });

  it('deduplica conservando el orden y no recorta', () => {
    expect(buildTboHotelDetailsRequest(['3', '1', '3', '2', '1'], 'en').Hotelcodes).toBe('3,1,2');
  });

  it(`acepta ${TBO_HOTEL_DETAILS_LIMITS.maxCodesPerRequest} y se niega a ${TBO_HOTEL_DETAILS_LIMITS.maxCodesPerRequest + 1} (Q-62)`, () => {
    const codes = Array.from({ length: 14 }, (_, i) => String(1_000_000 + i));
    expect(() => buildTboHotelDetailsRequest(codes.slice(0, 13), 'en')).not.toThrow();
    const error = buildError(() => buildTboHotelDetailsRequest(codes, 'en'));
    expect(error.reason).toBe('SCHEMA');
    expect(error.issues).toEqual(['hotelCodes:too_many_codes']);
    expect(error.path).toBe(TBO_OPERATIONS.hotelDetails.path);
  });

  it('el lote por defecto del sync cabe en el techo', () => {
    expect(TBO_HOTEL_DETAILS_LIMITS.defaultBatchSize).toBeLessThanOrEqual(
      TBO_HOTEL_DETAILS_LIMITS.maxCodesPerRequest,
    );
  });

  it.each([
    [[], 'hotelCodes:too_small'],
    [['12,34'], 'hotelCodes.0:invalid_code'],
    [['1 2'], 'hotelCodes.0:invalid_code'],
    [[''], 'hotelCodes.0:invalid_code'],
    [['x'.repeat(65)], 'hotelCodes.0:invalid_code'],
  ])('%j se rechaza antes del cable (%s)', (codes, issue) => {
    expect(buildError(() => buildTboHotelDetailsRequest(codes, 'en')).issues).toEqual([issue]);
  });

  it('un idioma fuera de la lista se rechaza', () => {
    const error = buildError(() =>
      buildTboHotelDetailsRequest(
        ['1'],
        'fr' as unknown as Parameters<typeof buildTboHotelDetailsRequest>[1],
      ),
    );
    expect(error.issues).toEqual(['lang:invalid_enum_value']);
  });
});
