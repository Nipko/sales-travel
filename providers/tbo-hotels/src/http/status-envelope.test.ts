import { describe, expect, it } from 'vitest';
import { TBO_OPERATIONS } from './operations';
import {
  TBO_DESCRIPTION_LOG_MAX,
  TBO_STATUS_CODES,
  classifyTboResponse,
  type TboEnvelopeVerdict,
} from './status-envelope';

/**
 * El clasificador a solas. Las filas completas de 01 §8.3-§8.4 se prueban por la puerta pública del
 * cliente con los fixtures de `src/__fixtures__/envelope/`; aquí van los bordes del parseo que un
 * fixture por fila no cubre.
 */

const SEARCH = TBO_OPERATIONS.search;
const PREBOOK = TBO_OPERATIONS.prebook;

function classify(
  body: unknown,
  httpStatus = 200,
  operation: typeof SEARCH = SEARCH,
): TboEnvelopeVerdict {
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
  return classifyTboResponse({ httpStatus, bodyText, operation });
}

describe('la tabla de códigos (01 §8.2)', () => {
  it('son exactamente los 12 códigos del PDF', () => {
    expect([...TBO_STATUS_CODES.keys()]).toEqual([
      200, 201, 207, 405, 479, 401, 400, 500, 429, 315, 300, 402,
    ]);
  });
});

describe('dónde está el envelope', () => {
  it('sin distinguir mayúsculas, y lo marca como variante', () => {
    const verdict = classify({ STATUS: { cOdE: 207 } }, 200, PREBOOK);
    expect(verdict).toMatchObject({ ok: false, kind: 'RATE_UNAVAILABLE', casingVariant: true });
  });

  it('con el casing del PDF no hay variante', () => {
    expect(classify({ Status: { Code: 200 } })).toMatchObject({ ok: true, casingVariant: false });
  });

  it('dos claves Status con distinto casing son ambiguas: no se elige una', () => {
    const verdict = classify({ Status: { Code: 200 }, status: { Code: 500 } });
    expect(verdict).toMatchObject({ ok: false, kind: 'MALFORMED_RESPONSE', tboCode: undefined });
  });

  it('dos claves Code dentro de Status también son ambiguas', () => {
    expect(classify({ Status: { Code: 200, code: 201 } })).toMatchObject({
      ok: false,
      kind: 'MALFORMED_RESPONSE',
    });
  });

  it('Status que no es objeto es envelope inválido', () => {
    expect(classify({ Status: 200 })).toMatchObject({ ok: false, kind: 'MALFORMED_RESPONSE' });
    expect(classify({ Status: [{ Code: 200 }] })).toMatchObject({
      ok: false,
      kind: 'MALFORMED_RESPONSE',
    });
  });

  it('un array en la raíz no tiene envelope', () => {
    expect(classify([{ Status: { Code: 200 } }])).toMatchObject({
      ok: false,
      kind: 'MALFORMED_RESPONSE',
    });
  });

  it('un cuerpo sólo de espacios es un cuerpo vacío', () => {
    expect(classify('  \n\t ')).toMatchObject({ ok: false, kind: 'MALFORMED_RESPONSE' });
  });
});

describe('forma de Code', () => {
  it.each([
    [200, true],
    ['200', true],
    [200.0, true],
    ['2000', false],
    ['20', false],
    [' 200', false],
    [200.5, false],
    [null, false],
    [true, false],
  ])('Code %j legible: %s', (code, readable) => {
    const verdict = classify({ Status: { Code: code } });
    if (readable) expect(verdict).toMatchObject({ ok: true, tboCode: 200 });
    else expect(verdict).toMatchObject({ ok: false, kind: 'MALFORMED_RESPONSE' });
  });

  it('un entero fuera de la tabla es UNKNOWN_CODE con su código, no MALFORMED', () => {
    expect(classify({ Status: { Code: 1234 } })).toMatchObject({
      ok: false,
      kind: 'UNKNOWN_CODE',
      tboCode: 1234,
    });
  });
});

describe('201 depende de la operación', () => {
  it('en Search es vacío y es éxito', () => {
    expect(classify({ Status: { Code: 201 } })).toMatchObject({
      ok: true,
      outcome: 'NO_AVAILABILITY',
    });
  });

  it('en PreBook es error de negocio', () => {
    expect(classify({ Status: { Code: 201 } }, 200, PREBOOK)).toMatchObject({
      ok: false,
      kind: 'NO_AVAILABILITY',
    });
  });

  it('con HTTP no-2xx y envelope, también manda el código del cuerpo', () => {
    expect(classify({ Status: { Code: 201 } }, 404)).toMatchObject({
      ok: true,
      outcome: 'NO_AVAILABILITY',
      tboCode: 201,
    });
  });
});

describe('hotelcodelist: envelope opcional (p. 55)', () => {
  const HOTEL_CODE_LIST = TBO_OPERATIONS.hotelCodeList;

  it('sin Status es éxito y entrega el JSON entero', () => {
    const verdict = classify({ HotelCodes: [1, 2] }, 200, HOTEL_CODE_LIST);
    expect(verdict).toMatchObject({ ok: true, outcome: 'SUCCESS', tboCode: undefined });
    expect(verdict.ok && verdict.data).toEqual({ HotelCodes: [1, 2] });
  });

  it('con Status se clasifica como cualquier otra', () => {
    expect(classify({ Status: { Code: 401 } }, 200, HOTEL_CODE_LIST)).toMatchObject({
      ok: false,
      kind: 'CREDENTIALS_INVALID',
    });
  });

  it('con Status roto no se perdona', () => {
    expect(classify({ Status: {} }, 200, HOTEL_CODE_LIST)).toMatchObject({
      ok: false,
      kind: 'MALFORMED_RESPONSE',
    });
  });

  it('sin JSON no es éxito aunque el envelope sea opcional', () => {
    expect(classify('<html/>', 200, HOTEL_CODE_LIST)).toMatchObject({
      ok: false,
      kind: 'MALFORMED_RESPONSE',
    });
  });

  it('un HTTP no-2xx sin envelope se clasifica por el HTTP', () => {
    expect(classify({ HotelCodes: [] }, 503, HOTEL_CODE_LIST)).toMatchObject({
      ok: false,
      kind: 'UPSTREAM',
    });
  });
});

describe('TBOHotelCodeList: 500 "No Hotels Found" es la ciudad sin hoteles (01 §8.5)', () => {
  const CITY_HOTELS = TBO_OPERATIONS.tboHotelCodeList;
  const noHotels = (description: unknown): unknown => ({
    Status: { Code: 500, Description: description },
  });

  it.each(['No Hotels Found', 'no hotels found', '  NO  HOTELS\tFOUND ', 'NoHotelsFound'])(
    '%j, con HTTP 200: resultado vacío que conserva código y texto',
    (description) => {
      expect(classify(noHotels(description), 200, CITY_HOTELS)).toMatchObject({
        ok: true,
        outcome: 'NO_AVAILABILITY',
        tboCode: 500,
      });
    },
  );

  it('el envelope con otro casing y el código como string también', () => {
    expect(
      classify({ status: { code: '500', description: 'No Hotels Found' } }, 200, CITY_HOTELS),
    ).toMatchObject({ ok: true, outcome: 'NO_AVAILABILITY', casingVariant: true });
  });

  it.each([
    'Unexpected Error',
    'No Hotels Found.',
    'No Hotel Found',
    'No Hotels Found for this city',
    '',
    null,
    42,
  ])('otro 500 (%j) sigue siendo UPSTREAM: la excepción no se amplía', (description) => {
    expect(classify(noHotels(description), 200, CITY_HOTELS)).toMatchObject({
      ok: false,
      kind: 'UPSTREAM',
    });
  });

  it('sin Description, un 500 es UPSTREAM', () => {
    expect(classify({ Status: { Code: 500 } }, 200, CITY_HOTELS)).toMatchObject({
      ok: false,
      kind: 'UPSTREAM',
    });
  });

  it('el texto sólo cuenta con Code 500', () => {
    expect(
      classify({ Status: { Code: 400, Description: 'No Hotels Found' } }, 200, CITY_HOTELS),
    ).toMatchObject({ ok: false, kind: 'CLIENT_BUG' });
  });

  it('con HTTP de error el mismo cuerpo sigue la regla general: no es lo observado', () => {
    for (const status of [500, 502, 404]) {
      expect(classify(noHotels('No Hotels Found'), status, CITY_HOTELS)).toMatchObject({
        ok: false,
        kind: 'UPSTREAM',
      });
    }
  });

  it.each([
    'cityList',
    'hotelDetails',
    'countryList',
    'search',
    'prebook',
    'book',
    'cancel',
  ] as const)('en %s, sin evidencia, es UPSTREAM', (name) => {
    expect(classify(noHotels('No Hotels Found'), 200, TBO_OPERATIONS[name])).toMatchObject({
      ok: false,
      kind: 'UPSTREAM',
    });
  });
});

describe('Status.Description (01 §8.6)', () => {
  it('no decide nada: el mismo código con otro texto da el mismo desenlace', () => {
    const a = classify({ Status: { Code: 207, Description: 'Successful' } }, 200, PREBOOK);
    const b = classify({ Status: { Code: 207, Description: 'Rate gone' } }, 200, PREBOOK);
    expect(a).toMatchObject({ ok: false, kind: 'RATE_UNAVAILABLE' });
    expect(b).toMatchObject({ ok: false, kind: 'RATE_UNAVAILABLE' });
  });

  it('se entrega en una línea y recortada', () => {
    const verdict = classify({ Status: { Code: 200, Description: `a\n\tb ${'x'.repeat(500)}` } });
    expect(verdict.description?.startsWith('a b x')).toBe(true);
    expect(verdict.description).toHaveLength(TBO_DESCRIPTION_LOG_MAX);
  });

  it('una Description que no es texto se ignora', () => {
    expect(classify({ Status: { Code: 200, Description: { x: 1 } } }).description).toBeUndefined();
  });
});
