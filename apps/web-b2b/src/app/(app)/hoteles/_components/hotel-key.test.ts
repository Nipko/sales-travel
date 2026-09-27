import { describe, expect, it } from 'vitest';
import type { HotelOffer, HotelRoompack } from '../actions';
import { decodeHotelKey, encodeHotelKey, hotelRefsOf, MAX_HOTEL_KEY_PROVIDERS } from './hotel-key';

function pack(id: string, provider?: string): HotelRoompack {
  return {
    id,
    ...(provider === undefined ? {} : { provider: { name: provider, offerRef: `${id}-REF` } }),
    board: 'RO',
    rooms: [{ name: 'Doble', reference: 1, bedOptions: [] }],
    cancellation: { refundable: false, status: 'non_refundable', rules: [] },
    price: { total: { amountMinor: 100_00, currency: 'USD' }, taxesDetail: [] },
  };
}

function offer(extra: Partial<HotelOffer>): HotelOffer {
  return { hotelId: '1402689', roompacks: [], ...extra };
}

describe('encodeHotelKey / decodeHotelKey — la clave del detalle', () => {
  it('ida y vuelta conserva los hoteles y su orden', () => {
    const refs = [
      { provider: 'despegar-hotels', hotelId: '987_12.a-b' },
      { provider: 'tbo-hotels', hotelId: '1402689' },
    ];
    const key = encodeHotelKey(refs);
    expect(key).toBeDefined();
    expect(decodeHotelKey(key ?? '')).toEqual(refs);
  });

  it('no deja el código del proveedor legible en la URL (RF-40, divulgación oculta)', () => {
    const key = encodeHotelKey([{ provider: 'tbo-hotels', hotelId: '1402689' }]) ?? '';
    expect(key).not.toContain('tbo');
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rechaza listas que la ruta del API no aceptaría', () => {
    expect(encodeHotelKey([])).toBeUndefined();
    expect(encodeHotelKey([{ provider: 'TBO', hotelId: '1' }])).toBeUndefined();
    expect(encodeHotelKey([{ provider: 'tbo-hotels', hotelId: '1/../2' }])).toBeUndefined();
    expect(
      encodeHotelKey([
        { provider: 'tbo-hotels', hotelId: '1' },
        { provider: 'tbo-hotels', hotelId: '2' },
      ]),
    ).toBeUndefined();
    const many = Array.from({ length: MAX_HOTEL_KEY_PROVIDERS + 1 }, (_, i) => ({
      provider: `prov-${i}`,
      hotelId: String(i),
    }));
    expect(encodeHotelKey(many)).toBeUndefined();
  });

  it('una clave que no es nuestra no se adivina', () => {
    expect(decodeHotelKey('')).toBeUndefined();
    expect(decodeHotelKey('no es base64!')).toBeUndefined();
    // "tbo-hotels" sin id.
    expect(decodeHotelKey(btoa('tbo-hotels').replace(/=+$/, ''))).toBeUndefined();
    // Un id con una barra no llega a la ruta del API.
    expect(decodeHotelKey(btoa('tbo-hotels~1/2').replace(/=+$/, ''))).toBeUndefined();
  });
});

describe('hotelRefsOf — con qué id pedirle el hotel a cada proveedor', () => {
  it('tarjeta agrupada: los de `providerHotels`, en su orden', () => {
    const o = offer({
      roompacks: [pack('A', 'despegar-hotels'), pack('B', 'tbo-hotels')],
      providerHotels: [
        { provider: 'despegar-hotels', hotelId: '555' },
        { provider: 'tbo-hotels', hotelId: '1402689' },
      ],
    });
    expect(hotelRefsOf(o)).toEqual([
      { provider: 'despegar-hotels', hotelId: '555' },
      { provider: 'tbo-hotels', hotelId: '1402689' },
    ]);
  });

  it('un solo proveedor: el de sus tarifas con el id del hotel', () => {
    const o = offer({ roompacks: [pack('A', 'tbo-hotels'), pack('B', 'tbo-hotels')] });
    expect(hotelRefsOf(o)).toEqual([{ provider: 'tbo-hotels', hotelId: '1402689' }]);
  });

  it('sin proveedor en las tarifas, o con dos sin `providerHotels`, no hay detalle', () => {
    expect(hotelRefsOf(offer({ roompacks: [pack('A')] }))).toEqual([]);
    expect(
      hotelRefsOf(offer({ roompacks: [pack('A', 'tbo-hotels'), pack('B', 'despegar-hotels')] })),
    ).toEqual([]);
  });
});
