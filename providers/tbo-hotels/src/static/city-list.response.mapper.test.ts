import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TboResponseMappingError } from '../errors';
import { mapTboCityListResponse } from './city-list.response.mapper';
import { TboCityListEnvelopeSchema, type TboCityListEnvelope } from './response.schema';

/** CityList contra el ejemplo de p. 54 (normalizado, ver __fixtures__/README.md). */

function envelope(raw: unknown): TboCityListEnvelope {
  return TboCityListEnvelopeSchema.parse(raw);
}

const P54 = JSON.parse(
  readFileSync(join(__dirname, '..', '__fixtures__', 'pdf', 'city-list.p54.json'), 'utf8'),
) as unknown;

describe('mapTboCityListResponse', () => {
  it('p. 54: `Code` string (la tabla dice Integer) y el país de la REQUEST', () => {
    const mapping = mapTboCityListResponse(envelope(P54), { countryCode: 'AT' });
    expect(mapping.countryCode).toBe('AT');
    expect(mapping.cities).toEqual([
      { code: '100758', name: 'Abersee', countryCode: 'AT' },
      { code: '100117', name: 'Abfaltersbach', countryCode: 'AT' },
      { code: '100443', name: 'Absam', countryCode: 'AT' },
      { code: '100650', name: 'Abtenau', countryCode: 'AT' },
    ]);
    expect(mapping.diagnostics).toMatchObject({ received: 4, mapped: 4, rejected: {}, notes: {} });
  });

  it('un código entero, como dice la tabla, sale string (05 §3)', () => {
    const mapping = mapTboCityListResponse(
      envelope({ Status: { Code: 200 }, CityList: [{ Code: 130452, Name: 'New York' }] }),
      { countryCode: 'US' },
    );
    expect(mapping.cities).toEqual([{ code: '130452', name: 'New York', countryCode: 'US' }]);
  });

  it('sin código legible o sin nombre se descarta (`name` es NOT NULL); el repetido también', () => {
    const mapping = mapTboCityListResponse(
      envelope({
        Status: { Code: 200 },
        CityList: [
          { Code: '', Name: 'Vacía' },
          { Code: '12,3', Name: 'Coma' },
          { Code: '1', Name: '   ' },
          { Code: '2', Name: 'Lima' },
          { Code: '2', Name: 'Lima bis' },
        ],
      }),
      { countryCode: 'PE' },
    );
    expect(mapping.cities).toEqual([{ code: '2', name: 'Lima', countryCode: 'PE' }]);
    expect(mapping.diagnostics.rejected).toEqual({ ITEM_SCHEMA: 3, DUPLICATE: 1 });
  });

  it('el contexto sin país ISO2 es un error de cableado', () => {
    expect(() => mapTboCityListResponse(envelope(P54), { countryCode: 'at' })).toThrow(
      TboResponseMappingError,
    );
  });
});
