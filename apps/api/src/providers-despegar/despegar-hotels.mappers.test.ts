import {
  buildAvailabilityQuery,
  buildDetailQuery,
  buildDistribution,
  mapAvailability,
  mapHotelDetail,
  mapMealPlan,
  mapSuggestions,
} from '@sales-travel/despegar-hotels';
import { describe, expect, it } from 'vitest';

describe('buildDistribution', () => {
  it('una habitación sólo adultos', () => {
    expect(buildDistribution([{ adults: 2, childrenAges: [] }])).toBe('2');
  });

  it('dos habitaciones, la segunda con un niño', () => {
    expect(
      buildDistribution([
        { adults: 2, childrenAges: [] },
        { adults: 2, childrenAges: [10] },
      ]),
    ).toBe('2!2-10');
  });

  it('varios niños se encadenan con guiones', () => {
    expect(buildDistribution([{ adults: 3, childrenAges: [5, 8] }])).toBe('3-5-8');
  });

  it('fuerza mínimo 1 adulto', () => {
    expect(buildDistribution([{ adults: 0, childrenAges: [] }])).toBe('1');
  });
});

describe('buildAvailabilityQuery', () => {
  it('mapea camelCase → snake_case y une hoteles por coma', () => {
    expect(
      buildAvailabilityQuery({
        checkinDate: '2026-07-01',
        checkoutDate: '2026-07-05',
        currency: 'USD',
        hotelIds: ['1', '2', '3'],
        rooms: [{ adults: 2, childrenAges: [] }],
        countryCode: 'CO',
        language: 'ES',
        refundableOnly: true,
      }),
    ).toEqual({
      checkin_date: '2026-07-01',
      checkout_date: '2026-07-05',
      currency: 'USD',
      hotels: '1,2,3',
      distribution: '2',
      country_code: 'CO',
      language: 'ES',
      ttl: undefined,
      refundable_only: true,
    });
  });
});

describe('buildDetailQuery', () => {
  it('no incluye hotels y agrega roompack_id', () => {
    const q = buildDetailQuery({
      hotelId: '12345',
      checkinDate: '2026-07-01',
      checkoutDate: '2026-07-05',
      currency: 'BRL',
      rooms: [{ adults: 2, childrenAges: [4] }],
      roompackId: 'rp-9',
    });
    expect(q).not.toHaveProperty('hotels');
    expect(q['distribution']).toBe('2-4');
    expect(q['roompack_id']).toBe('rp-9');
    expect(q['currency']).toBe('BRL');
  });
});

describe('mapMealPlan', () => {
  it.each([
    ['ALL_INCLUSIVE', 'AI'],
    ['FULL_BOARD', 'FB'],
    ['HALF_BOARD', 'HB'],
    ['BREAKFAST', 'BB'],
    ['DESAYUNO', 'BB'],
    ['BB', 'BB'],
    ['ROOM_ONLY', 'RO'],
    [undefined, 'RO'],
  ])('%s → %s', (input, expected) => {
    expect(mapMealPlan(input)).toBe(expected);
  });
});

describe('mapSuggestions', () => {
  it('mapea items con gid y descarta los que no tienen gid', () => {
    const result = mapSuggestions({
      items: [
        {
          id: 111,
          target: {
            id: 555,
            gid: 'CITY_222',
            type: 1,
            parents: { city: 'Lima', country: 'Peru' },
          },
          display: 'Lima, Peru',
          highlight: '<b>Lima</b>, Peru',
        },
        { id: 999, target: { id: 999, type: 2 }, display: 'No GID' },
      ],
    });

    // id = target.id (geo/city id), no el id del item.
    expect(result).toEqual([
      { id: 555, gid: 'CITY_222', type: 1, display: 'Lima, Peru', city: 'Lima', country: 'Peru' },
    ]);
  });

  it('respuesta vacía → arreglo vacío', () => {
    expect(mapSuggestions({})).toEqual([]);
  });
});

describe('mapAvailability', () => {
  const raw = {
    items: [
      {
        id: 12345,
        hotel_info: {
          name: 'Hotel Test',
          type: 'HOTEL',
          stars: 4,
          location: { latitude: -12.1, longitude: -77.03 },
        },
        roompacks: [
          {
            id: 'rp-1',
            meal_plan: { id: 'BREAKFAST' },
            rooms: [
              {
                name: 'Double Room',
                reference: 1,
                room_type_id: 'DBL',
                max_capacity: 2,
                bed_options: [{ id: 1, description: '1 King Bed' }],
              },
            ],
            cancellation_policy: {
              status: 'fully_refundable',
              hours_before_penalty: 48,
              vendor_notes: 'Free cancellation until 48h',
              cancellation_policy_rules: [
                {
                  type: 'NO_PENALTY',
                  penalty: { percentage: 0, night_count: 0 },
                  anticipation: { from: 48, to: 9999 },
                },
                {
                  type: 'PENALTY',
                  penalty: { percentage: 100, night_count: 1 },
                  anticipation: { from: 0, to: 48 },
                },
              ],
            },
            price_detail: {
              currency: 'USD',
              total: 200.5,
              taxes: 30,
              taxes_detail: [{ code: 'VAT', amount: 30 }],
              charge_at_destination: 15,
              agency_commission: { amount: 20.05, percentage: 10 },
            },
          },
        ],
      },
    ],
  };

  it('mapea un hotel con su roompack a canónico', () => {
    const [hotel] = mapAvailability(raw);
    expect(hotel?.hotelId).toBe('12345');
    expect(hotel?.name).toBe('Hotel Test');
    expect(hotel?.stars).toBe(4);
    expect(hotel?.type).toBe('HOTEL');
    expect(hotel?.location).toEqual({ lat: -12.1, lng: -77.03 });

    const pack = hotel?.roompacks[0];
    expect(pack?.id).toBe('rp-1');
    expect(pack?.board).toBe('BB');
    expect(pack?.rooms[0]).toEqual({
      name: 'Double Room',
      reference: 1,
      roomTypeId: 'DBL',
      maxCapacity: 2,
      bedOptions: ['1 King Bed'],
      choiceId: undefined,
    });
  });

  it('mapea la política de cancelación con sus reglas', () => {
    const pack = mapAvailability(raw)[0]?.roompacks[0];
    expect(pack?.cancellation.refundable).toBe(true);
    expect(pack?.cancellation.status).toBe('fully_refundable');
    expect(pack?.cancellation.hoursBeforePenalty).toBe(48);
    expect(pack?.cancellation.rules).toHaveLength(2);
    expect(pack?.cancellation.rules[1]).toEqual({
      type: 'PENALTY',
      penaltyPercentage: 100,
      penaltyNights: 1,
      fromHours: 0,
      toHours: 48,
    });
  });

  it('convierte montos a Money incluyendo comisión y cargo en destino', () => {
    const price = mapAvailability(raw)[0]?.roompacks[0]?.price;
    expect(price?.total).toEqual({ amountMinor: 20050, currency: 'USD' });
    expect(price?.taxes).toEqual({ amountMinor: 3000, currency: 'USD' });
    expect(price?.taxesDetail).toEqual([
      { code: 'VAT', amount: { amountMinor: 3000, currency: 'USD' } },
    ]);
    expect(price?.chargeAtDestination).toEqual({ amountMinor: 1500, currency: 'USD' });
    expect(price?.agencyCommission).toEqual({
      amount: { amountMinor: 2005, currency: 'USD' },
      percentage: 10,
    });
  });

  it('respuesta vacía → arreglo vacío', () => {
    expect(mapAvailability({})).toEqual([]);
  });
});

describe('mapHotelDetail', () => {
  const raw = {
    id: 12345,
    hotel_info: { type: 'HOTEL' },
    roompacks: [
      {
        id: 'rp-9',
        meal_plan: { id: 'ALL_INCLUSIVE' },
        rooms: [
          {
            name: 'Suite',
            reference: 1,
            room_type_id: 'STE',
            max_capacity: 3,
            bed_options: [{ id: 2, description: '2 Beds' }],
            choice_id: 'CHOICE-XYZ',
          },
        ],
        cancellation_policy: { status: 'non_refundable', cancellation_policy_rules: [] },
        price_detail: { currency: 'BRL', total: '1000', taxes_detail: [] },
      },
    ],
  };

  it('mapea un único hotel y conserva el choice_id bookable', () => {
    const hotel = mapHotelDetail(raw);
    expect(hotel.hotelId).toBe('12345');
    expect(hotel.type).toBe('HOTEL');
    expect(hotel.roompacks).toHaveLength(1);

    const pack = hotel.roompacks[0];
    expect(pack?.board).toBe('AI');
    expect(pack?.rooms[0]?.choiceId).toBe('CHOICE-XYZ');
    expect(pack?.cancellation.refundable).toBe(false);
    expect(pack?.cancellation.status).toBe('non_refundable');
    expect(pack?.price.total).toEqual({ amountMinor: 100000, currency: 'BRL' });
  });

  it('detalle sin roompacks → arreglo vacío', () => {
    expect(mapHotelDetail({ id: 1, hotel_info: { type: 'HOTEL' } }).roompacks).toEqual([]);
  });
});
