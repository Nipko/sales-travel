import { describe, expect, it } from 'vitest';
import type { Offer } from '../../cotizaciones/actions';
import type { HotelOffer, HotelRoompack } from '../../hoteles/actions';
import type { CarOffer } from '../../autos/actions';
import {
  buildItinerary,
  carItem,
  carSearchFor,
  flightItem,
  hotelItem,
  hotelSnapshot,
  packageCurrency,
  packageTitle,
  paxFromRooms,
  payingTravelers,
  plainDescription,
  priceDelta,
  recommendCar,
  recommendFlight,
  recommendHotel,
} from './package-model';

function offer(
  id: string,
  finalMinor: number,
  stops: number,
  minutes: number,
  currency = 'COP',
): Offer {
  return {
    id,
    tenantId: 't',
    products: ['flight'],
    provider: { name: 'sabre', offerRef: `ref-${id}` },
    total: { amountMinor: finalMinor - 1000, currency },
    baseFare: { amountMinor: finalMinor - 3000, currency },
    taxes: { amountMinor: 2000, currency },
    pricing: { costMinor: finalMinor - 1000, finalMinor, ownMarkupMinor: 1000, currency },
    itineraries: [
      {
        segments: [
          {
            carrier: 'AV',
            flightNumber: '9',
            origin: 'BOG',
            destination: 'CTG',
            departureAt: '2026-12-10T06:00:00-05:00',
            arrivalAt: '2026-12-10T07:30:00-05:00',
            durationMinutes: 90,
            cabin: 'Y',
            bookingClass: 'Y',
          },
        ],
        totalDurationMinutes: minutes,
        stops,
      },
      {
        segments: [
          {
            carrier: 'AV',
            flightNumber: '10',
            origin: 'CTG',
            destination: 'BOG',
            departureAt: '2026-12-15T18:00:00-05:00',
            arrivalAt: '2026-12-15T19:30:00-05:00',
            durationMinutes: 90,
            cabin: 'Y',
            bookingClass: 'Y',
          },
        ],
        totalDurationMinutes: minutes,
        stops: 0,
      },
    ],
    fetchedAt: '',
    expiresAt: '',
  };
}

function pack(
  id: string,
  sale: number,
  currency = 'COP',
  extra: Partial<HotelRoompack> = {},
): HotelRoompack {
  return {
    id,
    provider: { name: 'despegar-hotels', offerRef: `r-${id}` },
    board: 'BB',
    rooms: [{ name: 'Doble estándar', reference: 1, bedOptions: [] }],
    cancellation: { refundable: true, status: 'fully_refundable', rules: [] },
    price: { total: { amountMinor: sale - 100, currency }, taxesDetail: [] },
    pricing: { costMinor: sale - 100, finalMinor: sale, ownMarkupMinor: 100, currency },
    ...extra,
  };
}

function hotel(id: string, stars: number, packs: HotelRoompack[]): HotelOffer {
  return { hotelId: id, name: `Hotel ${id}`, stars, roompacks: packs };
}

function car(code: string, sale: number, currency = 'COP'): CarOffer {
  return {
    category: 'Económico',
    sippCode: 'ECMR',
    companyCode: code,
    companyName: code,
    rateAmount: { amountMinor: sale - 10, currency },
    paymentOption: 'ppd',
    carModel: 'Kia Picanto',
    doors: 4,
    passengers: 4,
    bags: 1,
    trans: 'Manual',
    air: true,
    kmIncluded: 'unlimited',
    base: { amountMinor: sale - 20, currency },
    tax: { amountMinor: 10, currency },
    pricing: { costMinor: sale - 10, finalMinor: sale, ownMarkupMinor: 10, currency },
  };
}

describe('recommendFlight', () => {
  it('prefiere el directo si cuesta hasta un 15 % más que el más barato con escala', () => {
    const cheap = offer('a', 100_000, 1, 300);
    const direct = offer('b', 112_000, 0, 90);
    expect(recommendFlight([cheap, direct], 'COP')?.id).toBe('b');
  });

  it('no recomienda el directo si cuesta bastante más', () => {
    const cheap = offer('a', 100_000, 1, 300);
    const direct = offer('b', 140_000, 0, 90);
    expect(recommendFlight([cheap, direct], 'COP')?.id).toBe('a');
  });

  it('ignora las ofertas en otra moneda', () => {
    expect(recommendFlight([offer('a', 1, 0, 60, 'BRL')], 'COP')).toBeUndefined();
  });
});

describe('recommendHotel', () => {
  it('sube a 4★ cuando cuesta hasta un 30 % más que el 3★ más barato', () => {
    const three = hotel('3', 3, [pack('p3', 100_000)]);
    const four = hotel('4', 4, [pack('p4', 125_000)]);
    const two = hotel('2', 2, [pack('p2', 50_000)]);
    expect(recommendHotel([three, four, two], 'COP')?.hotel.hotelId).toBe('4');
  });

  it('se queda con el 3★ si el 4★ se dispara, y elige la tarifa más barata del hotel', () => {
    const three = hotel('3', 3, [pack('caro', 150_000), pack('barato', 100_000)]);
    const four = hotel('4', 4, [pack('p4', 200_000)]);
    const choice = recommendHotel([three, four], 'COP');
    expect(choice?.hotel.hotelId).toBe('3');
    expect(choice?.pack.id).toBe('barato');
  });
});

describe('recommendCar y priceDelta', () => {
  it('el auto más barato en la moneda del paquete', () => {
    expect(
      recommendCar([car('HZ', 90_000), car('AV', 70_000), car('X', 1, 'USD')], 'COP')?.companyCode,
    ).toBe('AV');
  });

  it('la diferencia sólo existe en la misma moneda', () => {
    expect(
      priceDelta({ amountMinor: 120, currency: 'COP' }, { amountMinor: 100, currency: 'COP' }),
    ).toBe(20);
    expect(
      priceDelta({ amountMinor: 120, currency: 'USD' }, { amountMinor: 100, currency: 'COP' }),
    ).toBeUndefined();
  });
});

describe('pasajeros', () => {
  it('reparte las edades de las habitaciones como pasajeros de avión', () => {
    const pax = paxFromRooms([
      { adults: 2, childrenAges: [1, 7, 13] },
      { adults: 1, childrenAges: [] },
    ]);
    expect(pax).toEqual({ adults: 4, children: 1, infants: 1, childAges: [7] });
    expect(payingTravelers([{ adults: 2, childrenAges: [1, 7] }])).toBe(3);
  });
});

describe('carSearchFor', () => {
  it('retira una hora después de aterrizar y devuelve tres horas antes del regreso', () => {
    const v = carSearchFor({
      airportCode: 'CTG',
      countryCode: 'co',
      departureDate: '2026-12-10',
      returnDate: '2026-12-15',
      flight: offer('a', 1, 0, 90),
    });
    expect(v).toMatchObject({
      pickUpLocation: 'CTG',
      dropOffLocation: 'CTG',
      country: 'CO',
      pickUpDate: '2026-12-10',
      pickUpHour: '0830',
      dropOffDate: '2026-12-15',
      dropOffHour: '1500',
    });
  });

  it('sin vuelo, las fechas del viaje a las 10:00', () => {
    const v = carSearchFor({
      airportCode: 'CTG',
      countryCode: 'CO',
      departureDate: '2026-12-10',
      returnDate: '2026-12-15',
    });
    expect(v.pickUpHour).toBe('1000');
    expect(v.dropOffDate).toBe('2026-12-15');
  });
});

describe('ítems que van al API', () => {
  it('mandan el NETO: el API aplica la cascada una sola vez', () => {
    const f = flightItem(offer('a', 100_000, 0, 90));
    expect(f.baseFareMinor + f.taxesMinor).toBe(99_000);
    expect(f.providerItemId).toBe('ref-a');

    const p = pack('p', 50_000, 'COP', {
      price: {
        total: { amountMinor: 49_900, currency: 'COP' },
        taxesDetail: [],
        minimumSellingPrice: { amountMinor: 55_000, currency: 'COP' },
      },
    });
    const h = hotelItem(
      p,
      hotelSnapshot({
        hotel: hotel('1', 4, [p]),
        pack: p,
        checkin: '2026-12-10',
        checkout: '2026-12-15',
        images: [],
      }),
    );
    expect(h.baseFareMinor).toBe(49_900);
    expect(h.minimumSellingMinor).toBe(55_000);

    const search = carSearchFor({
      airportCode: 'CTG',
      countryCode: 'CO',
      departureDate: '2026-12-10',
      returnDate: '2026-12-15',
    });
    expect(carItem(car('AV', 70_000), search).baseFareMinor).toBe(69_990);
  });

  it('el snapshot del hotel sólo guarda fotos del proxy propio', () => {
    const p = pack('p', 1);
    const snap = hotelSnapshot({
      hotel: { ...hotel('1', 4, [p]), mainImage: { url: '/api/hotels/images/abc' } },
      pack: p,
      checkin: '2026-12-10',
      checkout: '2026-12-15',
      images: ['https://proveedor.example/foto.jpg', '/api/hotels/images/def'],
    });
    expect(snap.images).toEqual(['/api/hotels/images/abc', '/api/hotels/images/def']);
  });
});

describe('textos', () => {
  it('título y descripción en texto plano', () => {
    expect(packageTitle('Cartagena, Bolívar, Colombia', 5)).toBe('Cartagena · 5 noches');
    expect(packageTitle('Lima', 1)).toBe('Lima · 1 noche');
    expect(plainDescription('<p>Frente al&nbsp;mar <b>y</b> la ciudad</p>')).toBe(
      'Frente al mar y la ciudad',
    );
    expect(plainDescription('')).toBeUndefined();
  });

  it('la moneda del paquete es la de venta de la agencia', () => {
    expect(packageCurrency({ flightSaleCurrency: 'cop', flights: [], hotels: [], cars: [] })).toBe(
      'COP',
    );
    expect(
      packageCurrency({ flights: [], hotels: [hotel('1', 3, [pack('p', 1, 'USD')])], cars: [] }),
    ).toBe('USD');
  });
});

describe('buildItinerary', () => {
  it('cuenta el viaje día a día y deja libres los días sin nada', () => {
    const p = pack('p', 1);
    const days = buildItinerary('2026-12-10', '2026-12-12', [
      {
        kind: 'flight',
        carriers: ['AV'],
        itineraries: [
          {
            segments: [
              {
                carrier: 'AV',
                flightNumber: '9',
                origin: 'BOG',
                destination: 'CTG',
                departureAt: '2026-12-10T06:00:00-05:00',
                arrivalAt: '2026-12-10T07:30:00-05:00',
              },
            ],
            totalDurationMinutes: 90,
            stops: 0,
          },
        ],
      },
      hotelSnapshot({
        hotel: hotel('1', 4, [p]),
        pack: p,
        checkin: '2026-12-10',
        checkout: '2026-12-12',
        images: [],
      }),
      { kind: 'manual', title: 'Tour Islas del Rosario', date: '2026-12-11' },
    ]);
    expect(days).toHaveLength(3);
    expect(days[0]?.events.map((e) => e.text)).toEqual(['Vuelo BOG → CTG', 'Check-in en Hotel 1']);
    expect(days[1]?.events[0]?.text).toBe('Tour Islas del Rosario');
    expect(days[2]?.events[0]?.text).toBe('Check-out de Hotel 1');
  });
});
