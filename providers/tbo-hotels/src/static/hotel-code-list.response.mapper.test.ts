import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapTboHotelCodeListResponse } from './hotel-code-list.response.mapper';
import {
  TboHotelCodeListEnvelopeSchema,
  TboStaticCodeSchema,
  type TboHotelCodeListEnvelope,
} from './response.schema';

/** hotelcodelist contra el ejemplo de p. 55 (normalizado, ver __fixtures__/README.md). */

function envelope(raw: unknown): TboHotelCodeListEnvelope {
  return TboHotelCodeListEnvelopeSchema.parse(raw);
}

const P55 = JSON.parse(
  readFileSync(join(__dirname, '..', '__fixtures__', 'pdf', 'hotelcodelist.p55.json'), 'utf8'),
) as unknown;

describe('mapTboHotelCodeListResponse', () => {
  it('p. 55: enteros sin `Status` → strings', () => {
    const mapping = mapTboHotelCodeListResponse(envelope(P55));
    expect(mapping.hotelCodes).toEqual(['1000000', '1000001', '1000002', '5000008']);
    expect(mapping.diagnostics).toMatchObject({ received: 4, mapped: 4, rejected: {} });
  });

  it('acepta también strings, deduplica y cuenta los ilegibles aparte de los repetidos', () => {
    const mapping = mapTboHotelCodeListResponse(
      envelope({ HotelCodes: ['1000000', 1000000, -1, 1.5, '', null, '12 3', 7] }),
    );
    expect(mapping.hotelCodes).toEqual(['1000000', '7']);
    expect(mapping.diagnostics.rejected).toEqual({ DUPLICATE: 1, ITEM_SCHEMA: 5 });
  });

  it('el atajo de los enteros da exactamente lo mismo que el esquema', () => {
    for (const value of [0, -0, 7, 1_000_000, Number.MAX_SAFE_INTEGER, 1e20, -3, 2.5, '0042']) {
      const viaSchema = TboStaticCodeSchema.safeParse(value);
      const mapping = mapTboHotelCodeListResponse(envelope({ HotelCodes: [value] }));
      expect(mapping.hotelCodes, String(value)).toEqual(viaSchema.success ? [viaSchema.data] : []);
    }
  });

  it('sin `HotelCodes` no hay lista: el sobre no pasa (E5 no puede desactivar nada con esto)', () => {
    expect(TboHotelCodeListEnvelopeSchema.safeParse({}).success).toBe(false);
    expect(TboHotelCodeListEnvelopeSchema.safeParse({ HotelCodes: null }).success).toBe(false);
    expect(
      TboHotelCodeListEnvelopeSchema.safeParse({ Status: { Code: 200 }, HotelCodes: [] }).success,
    ).toBe(true);
  });
});
