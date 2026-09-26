import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TboResponseMappingError } from '../errors';
import { mapTboCountryListResponse } from './country-list.response.mapper';
import { TboCountryListEnvelopeSchema, type TboCountryListEnvelope } from './response.schema';

/** CountryList contra el ejemplo de p. 52 (normalizado, ver __fixtures__/README.md). */

function envelope(raw: unknown): TboCountryListEnvelope {
  return TboCountryListEnvelopeSchema.parse(raw);
}

const P52 = JSON.parse(
  readFileSync(join(__dirname, '..', '__fixtures__', 'pdf', 'country-list.p52.json'), 'utf8'),
) as unknown;

describe('mapTboCountryListResponse', () => {
  it('p. 52: los cinco países del ejemplo, en orden', () => {
    const mapping = mapTboCountryListResponse(envelope(P52));
    expect(mapping.countries).toEqual([
      { code: 'AL', name: 'Albania' },
      { code: 'AD', name: 'Andorra' },
      { code: 'AG', name: 'Antigua' },
      { code: 'AR', name: 'Argentina' },
      { code: 'AW', name: 'Aruba' },
    ]);
    expect(mapping.diagnostics).toEqual({
      received: 5,
      mapped: 5,
      rejected: {},
      notes: {},
      unknownKeys: [],
    });
  });

  it('un código que no es ISO2 o sin nombre se descarta; el repetido también; el resto sigue', () => {
    const mapping = mapTboCountryListResponse(
      envelope({
        Status: { Code: 200, Description: 'Success' },
        CountryList: [
          { Code: 'co', Name: ' Colombia ' },
          { Code: 'COL', Name: 'Colombia' },
          { Code: 'PE' },
          { Code: 'CO', Name: 'Colombia otra vez' },
          'BR',
          { Code: 'BR', Name: 'Brazil', Region: 'SA' },
        ],
      }),
    );
    expect(mapping.countries).toEqual([
      { code: 'CO', name: 'Colombia' },
      { code: 'BR', name: 'Brazil' },
    ]);
    expect(mapping.diagnostics.rejected).toEqual({ ITEM_SCHEMA: 3, DUPLICATE: 1 });
    expect(mapping.diagnostics.unknownKeys).toEqual(['CountryList[].Region']);
  });

  it('el contenedor declarado Object que llega como objeto único es una lista de uno (CE-01)', () => {
    const mapping = mapTboCountryListResponse(
      envelope({ Status: { Code: 200 }, CountryList: { Code: 'PE', Name: 'Peru' } }),
    );
    expect(mapping.countries).toEqual([{ code: 'PE', name: 'Peru' }]);
    expect(mapping.diagnostics.notes).toEqual({ CONTAINER_SINGLE_OBJECT: 1 });
  });

  it('sin contenedor es lista vacía, marcada', () => {
    const mapping = mapTboCountryListResponse(envelope({ Status: { Code: 200 } }));
    expect(mapping.countries).toEqual([]);
    expect(mapping.diagnostics.notes).toEqual({ CONTAINER_MISSING: 1 });
  });

  it('un escalar en el contenedor no pasa el sobre', () => {
    expect(TboCountryListEnvelopeSchema.safeParse({ CountryList: 'AL' }).success).toBe(false);
  });

  it('un Status.Code que no es 200 es un error de cableado', () => {
    expect(() => mapTboCountryListResponse(envelope({ Status: { Code: 500 } }))).toThrow(
      TboResponseMappingError,
    );
  });
});
