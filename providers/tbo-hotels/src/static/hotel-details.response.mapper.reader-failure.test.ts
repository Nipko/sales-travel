import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mapTboHotelDetailsResponse } from './hotel-details.response.mapper';
import { TboHotelDetailsEnvelopeSchema } from './response.schema';

/**
 * La última red del mapper: aunque el lector de habitaciones lanzara (no lo hace; se fuerza aquí),
 * el hotel conserva su contenido y sólo pierde las habitaciones. Va en su propio archivo porque el
 * `vi.mock` alcanza a todo el módulo.
 */

vi.mock('./room-detail.reader', () => ({
  readTboRoomDetails: () => {
    throw new Error('lector roto');
  },
}));

const P59 = JSON.parse(
  readFileSync(join(__dirname, '..', '__fixtures__', 'pdf', 'hotel-details.p59.json'), 'utf8'),
) as unknown;

describe('mapTboHotelDetailsResponse con un lector de habitaciones que lanza', () => {
  it('el contenido del hotel sale igual y sus habitaciones quedan `unreadable`', () => {
    const envelope = TboHotelDetailsEnvelopeSchema.parse(P59);
    const plain = mapTboHotelDetailsResponse(envelope, { lang: 'en', hotelCodes: ['1000000'] });
    const mapping = mapTboHotelDetailsResponse(envelope, {
      lang: 'en',
      hotelCodes: ['1000000'],
      roomDetail: true,
    });
    expect(mapping.contents).toEqual(plain.contents);
    expect(mapping.hotels).toEqual(plain.hotels);
    expect(mapping.roomContents).toEqual([{ hotelId: '1000000', rooms: [], shape: 'unreadable' }]);
    expect(mapping.diagnostics.notes).toMatchObject({ FIELD_INVALID: 1 });
  });
});
