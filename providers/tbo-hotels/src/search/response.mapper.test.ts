import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HotelOfferSchema,
  HotelRoompackSchema,
  type HotelRoomOccupancy,
  type HotelRoompack,
} from '@sales-travel/canonical';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import { parseTboConfig } from '../config';
import { TboResponseMappingError } from '../errors';
import { TboHttpClient } from '../http/tbo-http.client';
import { TBO_OFFER_TTL_MS } from './offer-window';
import {
  mapTboSearchResponse,
  type TboSearchMapContext,
  type TboSearchMapDeps,
  type TboSearchMapping,
} from './response.mapper';
import { TboSearchEnvelopeSchema } from './response.schema';

/**
 * El mapper de Search contra los ejemplos del PDF (p. 15-18, normalizados en
 * `src/__fixtures__/pdf/`) y contra las variantes que el contrato admite (docs/tbo/02 §9-§10;
 * 08 RF-07, RF-09, RF-10 y RF-11).
 */

const FIXTURES = join(__dirname, '..', '__fixtures__', 'pdf');
const SEARCH_ID = 'srch_0001';
const SENT_AT = Date.parse('2026-09-25T15:00:00.000Z');
const ONE_ADULT: HotelRoomOccupancy[] = [{ adults: 1, childrenAges: [] }];
const TWO_ROOMS: HotelRoomOccupancy[] = [
  { adults: 2, childrenAges: [7] },
  { adults: 1, childrenAges: [] },
];

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
}

function context(rooms: readonly HotelRoomOccupancy[] = ONE_ADULT): TboSearchMapContext {
  return { searchId: SEARCH_ID, searchSentAt: SENT_AT, rooms };
}

interface Recorded {
  readonly counters: { name: string; tags: Record<string, string> | undefined }[];
  readonly logs: { level: string; message: string; meta: Record<string, unknown> | undefined }[];
  readonly deps: TboSearchMapDeps;
}

function recorder(): Recorded {
  const counters: Recorded['counters'] = [];
  const logs: Recorded['logs'] = [];
  const metrics: MetricsPort = {
    counter: (name, _value, tags) => counters.push({ name, tags }),
    gauge: () => undefined,
    histogram: () => undefined,
  };
  const logger: LoggerPort = {
    debug: (message, meta) => logs.push({ level: 'debug', message, meta }),
    info: (message, meta) => logs.push({ level: 'info', message, meta }),
    warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
    error: (message, meta) => logs.push({ level: 'error', message, meta }),
    child: () => logger,
  };
  return { counters, logs, deps: { metrics, logger } };
}

function map(
  body: unknown,
  rooms: readonly HotelRoomOccupancy[] = ONE_ADULT,
  deps: TboSearchMapDeps = {},
): TboSearchMapping {
  return mapTboSearchResponse(TboSearchEnvelopeSchema.parse(body), context(rooms), deps);
}

/** Un `HotelResult` de una habitación con el pack de p. 15 y lo que se quiera pisar. */
function oneHotel(
  room: Record<string, unknown> = {},
  hotel: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    Status: { Code: 200, Description: 'Successful' },
    HotelResult: [
      {
        HotelCode: '1120548',
        Currency: 'USD',
        Rooms: [
          {
            Name: ['Luxury Room, 1 King Bed'],
            BookingCode: '1120548!TB!2!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b',
            Inclusion: 'Free WiFi',
            TotalFare: 152.88,
            TotalTax: 28.12,
            MealType: 'Room_Only',
            IsRefundable: false,
            WithTransfers: false,
            ...room,
          },
        ],
        ...hotel,
      },
    ],
  };
}

function onlyPack(mapping: TboSearchMapping): HotelRoompack {
  const [offer] = mapping.offers;
  const [pack] = offer?.roompacks ?? [];
  if (pack === undefined) throw new Error('se esperaba un pack');
  return pack;
}

function countersNamed(recorded: Recorded, name: string) {
  return recorded.counters.filter((entry) => entry.name === name).map((entry) => entry.tags);
}

describe('los ejemplos del PDF producen ofertas válidas contra hotel-offer.ts (RF-07 CA-1)', () => {
  it('6.2.1, una habitación (p. 15-16): un hotel con dos packs', () => {
    const mapping = map(fixture('search-single-room.p15.json'));
    expect(mapping.offers).toHaveLength(1);
    for (const offer of mapping.offers)
      expect(HotelOfferSchema.safeParse(offer).success).toBe(true);

    const [offer] = mapping.offers;
    expect(offer?.hotelId).toBe('1120548');
    expect(offer?.roompacks.map((pack) => pack.id)).toEqual([
      '1120548!TB!2!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b',
      '1120548!TB!4!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b',
    ]);
    expect(offer?.roompacks[0]).toEqual({
      id: '1120548!TB!2!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b',
      provider: {
        name: 'tbo-hotels',
        offerRef: '1120548!TB!2!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b',
        raw: { searchId: SEARCH_ID },
      },
      board: 'RO',
      boardLabel: 'Solo alojamiento',
      mealTypeRaw: 'Room_Only',
      rooms: [
        {
          name: 'Luxury Room, 1 King Bed',
          reference: 1,
          bedOptions: [],
          occupancy: { adults: 1, childrenAges: [] },
          promotions: ['Private sale'],
        },
      ],
      cancellation: {
        refundable: false,
        status: 'non_refundable',
        rules: [],
        policySource: 'none',
      },
      price: {
        total: { amountMinor: 15288, currency: 'USD' },
        taxesDetail: [],
        taxes: { amountMinor: 2812, currency: 'USD' },
        minimumSellingPrice: { amountMinor: 16067, currency: 'USD' },
        extraGuestCharges: { amountMinor: 1722, currency: 'USD' },
      },
      expiresAt: '2026-09-25T15:27:00.000Z',
      atPropertyCharges: [
        {
          roomIndex: 1,
          description: 'Impuesto obligatorio',
          descriptionRaw: 'mandatory_tax',
          amount: { amountMinor: 2000, currency: 'AED' },
        },
      ],
      includedSupplements: [],
      includesTransfers: false,
      inclusionText: 'Free WiFi',
    });
  });

  it('6.2.2, dos habitaciones (p. 16-18): cada combinación es UN pack con dos rooms', () => {
    const mapping = map(fixture('search-multi-room.p16.json'), TWO_ROOMS);
    const [offer] = mapping.offers;
    expect(offer?.roompacks).toHaveLength(2);
    for (const pack of offer?.roompacks ?? []) {
      expect(HotelRoompackSchema.safeParse(pack).success).toBe(true);
      expect(pack.rooms.map((room) => room.reference)).toEqual([1, 2]);
      // La ocupación de cada habitación es la pedida, en su orden: el Book nombra por habitación.
      expect(pack.rooms.map((room) => room.occupancy)).toEqual(TWO_ROOMS);
      expect(pack.rooms.every((room) => room.choiceId === undefined)).toBe(true);
      expect(pack.price.total).toEqual({ amountMinor: 30575, currency: 'USD' });
    }
  });

  it('6.2.3, sin disponibilidad (p. 18): `201` es una lista vacía y no un error', () => {
    const recorded = recorder();
    const mapping = map(fixture('search-no-availability.p18.json'), ONE_ADULT, recorded.deps);
    expect(mapping.offers).toEqual([]);
    expect(mapping.packs).toEqual([]);
    expect(recorded.logs.filter((log) => log.level === 'warn')).toEqual([]);
  });

  it('sin HotelResult y sin Status también es vacío', () => {
    expect(map({}).offers).toEqual([]);
    expect(map({ Status: { Code: 200 }, HotelResult: null }).offers).toEqual([]);
  });
});

describe('cada tarifa dice de dónde es (RF-40, D-TBO-06 A)', () => {
  it("todo pack lleva provider.name 'tbo-hotels' y el BookingCode como offerRef", () => {
    const mapping = map(fixture('search-multi-room.p16.json'), TWO_ROOMS);
    const packs = mapping.offers.flatMap((offer) => offer.roompacks);
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      expect(pack.provider.name).toBe('tbo-hotels');
      expect(pack.provider.offerRef).toBe(pack.id);
      // `raw` viaja al navegador: sólo nuestra clave, ni HotelCode ni importes (08 §9 C-11).
      expect(pack.provider.raw).toEqual({ searchId: SEARCH_ID });
    }
  });
});

describe('moneda (RF-07 CA-2 y CA-4)', () => {
  it('un HotelResult sin Currency se descarta y se mide; nunca USD por defecto', () => {
    const recorded = recorder();
    const body = oneHotel({}, { Currency: undefined });
    const mapping = map(body, ONE_ADULT, recorded.deps);
    expect(mapping.offers).toEqual([]);
    expect(mapping.diagnostics.hotelsRejected).toEqual({ CURRENCY_MISSING: 1 });
    expect(countersNamed(recorded, 'tbo.search.hotel_rejected')).toEqual([
      { reason: 'CURRENCY_MISSING' },
    ]);
  });

  it('los demás hoteles de la respuesta siguen, cada uno en su moneda', () => {
    const body = oneHotel({}, { Currency: '' });
    const hotels = (body['HotelResult'] as Record<string, unknown>[]).concat({
      HotelCode: '1247101',
      Currency: 'EUR',
      Rooms: [
        {
          Name: ['Double'],
          BookingCode: '1247101!TB!1!TB!x',
          TotalFare: '99.10',
          MealType: 'BreakFast',
        },
      ],
    });
    const mapping = map({ ...body, HotelResult: hotels });
    expect(mapping.offers.map((offer) => offer.hotelId)).toEqual(['1247101']);
    expect(onlyPack(mapping).price.total).toEqual({ amountMinor: 9910, currency: 'EUR' });
  });

  it.each([
    ['usd', 'CURRENCY_INVALID'],
    [840, 'CURRENCY_INVALID'],
    ['KWD', 'UNSUPPORTED_CURRENCY'],
    ['CLP', 'UNSUPPORTED_CURRENCY'],
    ['XAU', 'UNSUPPORTED_CURRENCY'],
  ])('Currency %j → hotel descartado con %s, sin convertir nada', (currency, reason) => {
    const mapping = map(oneHotel({}, { Currency: currency }));
    expect(mapping.offers).toEqual([]);
    expect(mapping.diagnostics.hotelsRejected).toEqual({ [reason]: 1 });
  });

  it('nombra las monedas de exponente distinto de 2, y sólo ésas, para el motivo del adapter', () => {
    const body = oneHotel({}, { Currency: 'KWD' });
    const hotels = (body['HotelResult'] as Record<string, unknown>[]).concat(
      { HotelCode: '2', Currency: 'CLP', Rooms: [] },
      { HotelCode: '3', Currency: 'KWD', Rooms: [] },
      { HotelCode: '4', Currency: 'usd', Rooms: [] },
      { HotelCode: '5', Rooms: [] },
    );
    const mapping = map({ ...body, HotelResult: hotels });
    expect(mapping.diagnostics.unsupportedCurrencies).toEqual(['CLP', 'KWD']);
    expect(map(oneHotel()).diagnostics.unsupportedCurrencies).toEqual([]);
  });
});

describe('importes (RF-07 CA-3)', () => {
  it('"17.22" y 17.22 producen el mismo Money', () => {
    const asText = onlyPack(map(oneHotel({ ExtraGuestCharges: '17.22', TotalFare: '152.88' })));
    const asNumber = onlyPack(map(oneHotel({ ExtraGuestCharges: 17.22, TotalFare: 152.88 })));
    expect(asText.price).toEqual(asNumber.price);
    expect(asText.price.extraGuestCharges).toEqual({ amountMinor: 1722, currency: 'USD' });
  });

  it('un pack con un importe negativo se descarta y se mide; el otro pack sigue', () => {
    const recorded = recorder();
    const body = oneHotel();
    const [hotel] = body['HotelResult'] as { Rooms: Record<string, unknown>[] }[];
    if (hotel === undefined) throw new Error('fixture sin hotel');
    hotel.Rooms.push({ ...hotel.Rooms[0], BookingCode: 'NEG', TotalFare: -1 });
    const mapping = map(body, ONE_ADULT, recorded.deps);
    expect(mapping.offers[0]?.roompacks.map((pack) => pack.id)).toEqual([
      '1120548!TB!2!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b',
    ]);
    expect(mapping.diagnostics.packsRejected).toEqual({ AMOUNT_NEGATIVE: 1 });
    expect(countersNamed(recorded, 'tbo.search.pack_rejected')).toEqual([
      { reason: 'AMOUNT_NEGATIVE' },
    ]);
  });

  it.each([0, '0.00', '0.004'])('TotalFare %j (neto cero) invalida el pack y se mide', (fare) => {
    const recorded = recorder();
    const mapping = map(oneHotel({ TotalFare: fare }), ONE_ADULT, recorded.deps);
    expect(mapping.offers).toEqual([]);
    expect(mapping.packs).toEqual([]);
    expect(mapping.diagnostics.packsRejected).toEqual({ AMOUNT_INVALID: 1 });
    expect(countersNamed(recorded, 'tbo.search.pack_rejected')).toEqual([
      { reason: 'AMOUNT_INVALID' },
    ]);
  });

  it.each([
    ['separador de miles', { TotalFare: '1,234.00' }],
    ['signo en un string', { RecommendedSellingRate: '-5' }],
    ['texto', { TotalTax: 'N/A' }],
  ])('%s invalida el pack por esquema', (_name, room) => {
    const mapping = map(oneHotel(room));
    expect(mapping.offers).toEqual([]);
    expect(mapping.diagnostics.packsRejected).toEqual({ PACK_SCHEMA: 1 });
  });

  it('vacío o null en un importe opcional es "no vino", no cero', () => {
    const pack = onlyPack(map(oneHotel({ RecommendedSellingRate: '', ExtraGuestCharges: null })));
    expect(pack.price.minimumSellingPrice).toBeUndefined();
    expect(pack.price.extraGuestCharges).toBeUndefined();
  });

  it('un importe con más decimales que la moneda se redondea half-up y se mide', () => {
    const recorded = recorder();
    const pack = onlyPack(map(oneHotel({ TotalFare: '17.095' }), ONE_ADULT, recorded.deps));
    expect(pack.price.total.amountMinor).toBe(1710);
    expect(countersNamed(recorded, 'tbo.amount_precision_loss')).toEqual([
      { op: 'search', field: 'TotalFare' },
    ]);
  });
});

describe('el literal de TotalFare queda en el servidor (RF-07 CA-5)', () => {
  it('va en `packs`, junto a su BookingCode, y no en el pack público', () => {
    const mapping = map(fixture('search-multi-room.p16.json'), TWO_ROOMS);
    expect(mapping.packs).toEqual([
      {
        hotelCode: '1120548',
        bookingCode: '1120548!TB!2!TB!9a47646b-1bba-4746-91d5-969149db1185',
        totalFare: '305.75',
        currency: 'USD',
      },
      {
        hotelCode: '1120548',
        bookingCode: '1120548!TB!4!TB!9a47646b-1bba-4746-91d5-969149db1185',
        totalFare: '305.75',
        currency: 'USD',
      },
    ]);
    expect(JSON.stringify(mapping.offers)).not.toContain('305.75');
  });

  it('un TotalFare en texto se conserva tal cual llegó', () => {
    expect(map(oneHotel({ TotalFare: ' 305.750 ' })).packs[0]?.totalFare).toBe('305.750');
  });
});

describe('suplementos: visibles y nunca sumados (RF-10)', () => {
  it('p. 17: dos cargos AED 20.00 con Index 1 y 2; el total del pack no cambia (CA-1)', () => {
    const [pack] = map(fixture('search-multi-room.p16.json'), TWO_ROOMS).offers[0]?.roompacks ?? [];
    expect(pack?.atPropertyCharges).toEqual([
      {
        roomIndex: 1,
        description: 'Impuesto obligatorio',
        descriptionRaw: 'mandatory_tax',
        amount: { amountMinor: 2000, currency: 'AED' },
      },
      {
        roomIndex: 2,
        description: 'Impuesto obligatorio',
        descriptionRaw: 'mandatory_tax',
        amount: { amountMinor: 2000, currency: 'AED' },
      },
    ]);
    expect(pack?.price.total).toEqual({ amountMinor: 30575, currency: 'USD' });
    expect(pack?.price.chargeAtDestination).toBeUndefined();
  });

  it('acepta el array plano de la tabla y normaliza por Index (CA-3)', () => {
    const supplement = (index: number) => ({
      Index: index,
      Type: 'AtProperty',
      Description: 'mandatory_tax',
      Price: '20.00',
      Currency: 'AED',
    });
    const nested = onlyPack(
      map(
        oneHotel({ Name: ['A', 'B'], Supplements: [[supplement(1)], [supplement(2)]] }),
        TWO_ROOMS,
      ),
    );
    const flat = onlyPack(
      map(oneHotel({ Name: ['A', 'B'], Supplements: [supplement(2), supplement(1)] }), TWO_ROOMS),
    );
    expect(flat.atPropertyCharges).toEqual(nested.atPropertyCharges);
    expect(flat.atPropertyCharges?.map((fee) => fee.roomIndex)).toEqual([1, 2]);
  });

  it('Included va aparte; un Type desconocido se trata como AtProperty y se mide', () => {
    const recorded = recorder();
    const pack = onlyPack(
      map(
        oneHotel({
          Supplements: [
            [
              { Index: 1, Type: 'Included', Description: 'city_fee', Price: 3, Currency: 'USD' },
              { Index: '1', Type: 'Mandatory', Price: 4.5, Currency: 'EUR' },
            ],
          ],
        }),
        ONE_ADULT,
        recorded.deps,
      ),
    );
    expect(pack.includedSupplements).toEqual([
      {
        roomIndex: 1,
        description: 'city_fee',
        descriptionRaw: 'city_fee',
        amount: { amountMinor: 300, currency: 'USD' },
      },
    ]);
    expect(pack.atPropertyCharges).toEqual([
      {
        roomIndex: 1,
        description: 'Cargo a pagar en el hotel',
        amount: { amountMinor: 450, currency: 'EUR' },
      },
    ]);
    expect(countersNamed(recorded, 'tbo.search.unknown_supplement_type')).toHaveLength(1);
  });

  it('en una moneda de 3 decimales guarda el decimal para mostrar, no un Money mal escalado', () => {
    const pack = onlyPack(
      map(
        oneHotel({
          Supplements: [[{ Index: 1, Type: 'AtProperty', Price: '25.81', Currency: 'KWD' }]],
        }),
      ),
    );
    expect(pack.atPropertyCharges).toEqual([
      {
        roomIndex: 1,
        description: 'Cargo a pagar en el hotel',
        amount: { amountMinor: 25810, currency: 'KWD' },
        amountText: '25.810',
      },
    ]);
  });

  it.each([
    ['un Index fuera del pack', { Index: 2, Type: 'AtProperty', Price: 1, Currency: 'AED' }],
    ['una moneda sin unidad menor', { Index: 1, Type: 'AtProperty', Price: 1, Currency: 'XAU' }],
  ])('%s invalida el pack: TBO exige que se vean (KP-4)', (_name, supplement) => {
    const mapping = map(oneHotel({ Supplements: [[supplement]] }));
    expect(mapping.offers).toEqual([]);
    expect(mapping.diagnostics.packsRejected).toEqual({ SUPPLEMENT_INVALID: 1 });
  });

  it('sin la clave Supplements, los campos quedan ausentes: "no informado" no es "no hay"', () => {
    const pack = onlyPack(map(oneHotel()));
    expect(pack.atPropertyCharges).toBeUndefined();
    expect(pack.includedSupplements).toBeUndefined();
  });
});

describe('atributos de la tarifa sin datos inventados (RF-11)', () => {
  it('IsRefundable true sin tramos → partially_refundable con origen none (CA-1)', () => {
    const pack = onlyPack(map(oneHotel({ IsRefundable: true })));
    expect(pack.cancellation).toEqual({
      refundable: true,
      status: 'partially_refundable',
      rules: [],
      policySource: 'none',
    });
  });

  it('IsRefundable ausente se lee como false: lo conservador', () => {
    expect(onlyPack(map(oneHotel({ IsRefundable: undefined }))).cancellation.status).toBe(
      'non_refundable',
    );
  });

  it('Breakfast_For_1 → BB con la etiqueta "Desayuno para 1 persona" (CA-2)', () => {
    const pack = onlyPack(map(oneHotel({ MealType: 'Breakfast_For_1' })));
    expect([pack.board, pack.boardLabel, pack.mealTypeRaw]).toEqual([
      'BB',
      'Desayuno para 1 persona',
      'Breakfast_For_1',
    ]);
  });

  it('un MealType desconocido → RO y métrica tbo.unknown_meal_type (CA-3)', () => {
    const recorded = recorder();
    const pack = onlyPack(map(oneHotel({ MealType: 'Brunch_Only' }), ONE_ADULT, recorded.deps));
    expect([pack.board, pack.boardLabel, pack.mealTypeRaw]).toEqual([
      'RO',
      'Brunch_Only',
      'Brunch_Only',
    ]);
    expect(countersNamed(recorded, 'tbo.unknown_meal_type')).toEqual([
      { op: 'search', kind: 'unknown' },
    ]);
    expect(map(oneHotel({ MealType: 'Brunch_Only' })).diagnostics.unknownMealTypes).toBe(1);
  });

  it('ExtraGuestCharges no entra en ningún total (CA-4)', () => {
    const without = onlyPack(map(oneHotel({ ExtraGuestCharges: undefined })));
    const withCharges = onlyPack(map(oneHotel({ ExtraGuestCharges: '999.99' })));
    expect(withCharges.price.total).toEqual(without.price.total);
    expect(withCharges.price.extraGuestCharges).toEqual({ amountMinor: 99999, currency: 'USD' });
    expect(withCharges.pricing).toBeUndefined();
  });

  it('RoomID distinto de 0 es el roomTypeId; 0 es "sin mapeo" (p. 57)', () => {
    const pack = onlyPack(map(oneHotel({ Name: ['A', 'B'], RoomID: ['197354', '0'] }), TWO_ROOMS));
    expect(pack.rooms.map((room) => room.roomTypeId)).toEqual(['197354', undefined]);
    const hotelDetailsCasing = onlyPack(map(oneHotel({ RoomId: [197354] })));
    expect(hotelDetailsCasing.rooms[0]?.roomTypeId).toBe('197354');
  });

  it('WithTransfers true se muestra; Inclusion no se parte', () => {
    const pack = onlyPack(
      map(oneHotel({ WithTransfers: true, Inclusion: 'Free WiFi, Breakfast' })),
    );
    expect(pack.includesTransfers).toBe(true);
    expect(pack.inclusionText).toBe('Free WiFi, Breakfast');
  });

  it('RoomPromotion también como "List of String Array" (C-18)', () => {
    const pack = onlyPack(
      map(oneHotel({ Name: ['A', 'B'], RoomPromotion: [['Early bird'], []] }), TWO_ROOMS),
    );
    expect(pack.rooms.map((room) => room.promotions)).toEqual([['Early bird'], undefined]);
  });
});

describe('detalle de un hotel (IsDetailedResponse: true)', () => {
  it('DayRates va al desglose por noche, redondeado y medido; nunca al total', () => {
    const recorded = recorder();
    const pack = onlyPack(
      map(
        oneHotel({
          Name: ['A', 'B'],
          DayRates: [[{ BasePrice: 124.756485 }], [{ BasePrice: '124.7564850' }]],
          TotalFare: 305.75,
        }),
        TWO_ROOMS,
        recorded.deps,
      ),
    );
    expect(pack.price.nightly).toEqual([
      [{ amountMinor: 12476, currency: 'USD' }],
      [{ amountMinor: 12476, currency: 'USD' }],
    ]);
    expect(pack.price.total.amountMinor).toBe(30575);
    expect(countersNamed(recorded, 'tbo.amount_precision_loss')).toHaveLength(2);
  });

  it('un DayRates vacío no es un desglose: se omite', () => {
    expect(onlyPack(map(oneHotel({ DayRates: [[]] }))).price.nightly).toBeUndefined();
    expect(onlyPack(map(oneHotel({ DayRates: [] }))).price.nightly).toBeUndefined();
  });

  it('las políticas de p. 24 salen indicativas, con la cancelación gratuita derivada', () => {
    const pack = onlyPack(
      map(
        oneHotel({
          IsRefundable: true,
          CancelPolicies: [
            { FromDate: '05-05-2022 00:00:00', ChargeType: 'Fixed', CancellationCharge: 0.0 },
            {
              FromDate: '12-05-2022 00:00:00',
              ChargeType: 'Percentage',
              CancellationCharge: 100.0,
            },
          ],
        }),
      ),
    );
    expect(pack.cancellation).toEqual({
      refundable: true,
      status: 'fully_refundable',
      policySource: 'search-indicative',
      freeCancellationUntilLocal: '2022-05-12T00:00:00',
      rules: [
        {
          type: 'Fixed',
          fromLocalDateTime: '2022-05-05T00:00:00',
          fromDateRaw: '05-05-2022 00:00:00',
          penaltyAmount: { amountMinor: 0, currency: 'USD' },
        },
        {
          type: 'Percentage',
          fromLocalDateTime: '2022-05-12T00:00:00',
          fromDateRaw: '12-05-2022 00:00:00',
          penaltyPercentage: 100,
        },
      ],
    });
  });

  it('una política ilegible invalida el pack', () => {
    const mapping = map(
      oneHotel({
        CancelPolicies: [
          { FromDate: '31-02-2022 00:00:00', ChargeType: 'Fixed', CancellationCharge: 0 },
        ],
      }),
    );
    expect(mapping.diagnostics.packsRejected).toEqual({ CANCEL_POLICY: 1 });
  });
});

describe('packs que no se pueden leer', () => {
  it('Name con otra cantidad de habitaciones que la pedida → descartado', () => {
    const mapping = map(fixture('search-multi-room.p16.json'), ONE_ADULT);
    expect(mapping.offers).toEqual([]);
    expect(mapping.diagnostics.packsRejected).toEqual({ ROOM_COUNT_MISMATCH: 2 });
  });

  it('un BookingCode repetido: gana el primero y el otro se mide', () => {
    const body = fixture('search-single-room.p15.json') as {
      HotelResult: { Rooms: { BookingCode: string }[] }[];
    };
    const rooms = body.HotelResult[0]?.Rooms ?? [];
    if (rooms[1] !== undefined && rooms[0] !== undefined)
      rooms[1].BookingCode = rooms[0].BookingCode;
    const mapping = map(body);
    expect(mapping.offers[0]?.roompacks).toHaveLength(1);
    expect(mapping.diagnostics.packsRejected).toEqual({ DUPLICATE_BOOKING_CODE: 1 });
    expect(mapping.packs).toHaveLength(1);
  });

  it('un HotelResult sin HotelCode se descarta sin tirar la respuesta', () => {
    const body = oneHotel();
    const hotels = (body['HotelResult'] as Record<string, unknown>[]).concat({
      Currency: 'USD',
      Rooms: [],
    });
    const mapping = map({ ...body, HotelResult: hotels });
    expect(mapping.offers).toHaveLength(1);
    expect(mapping.diagnostics.hotelsRejected).toEqual({ HOTEL_SCHEMA: 1 });
  });

  it('dos HotelResult del mismo hotel se funden en una oferta', () => {
    const first = oneHotel();
    const second = oneHotel({ BookingCode: 'otro' });
    const mapping = map({
      ...first,
      HotelResult: [
        ...(first['HotelResult'] as unknown[]),
        ...(second['HotelResult'] as unknown[]),
      ],
    });
    expect(mapping.offers).toHaveLength(1);
    expect(mapping.offers[0]?.roompacks.map((pack) => pack.id)).toEqual([
      '1120548!TB!2!TB!4ee85bb9-9ca6-4c66-8a8a-524bfdd5ae2b',
      'otro',
    ]);
  });

  it('un hotel cuyos packs se descartaron todos no se ofrece', () => {
    expect(map(oneHotel({ TotalFare: -3 })).offers).toEqual([]);
  });
});

describe('claves desconocidas: se registran sus nombres, nunca sus valores (RNF-12, C-12)', () => {
  it('en cada nivel, con su ruta', () => {
    const recorded = recorder();
    const secret = 'valor-que-no-puede-llegar-al-log';
    const body = oneHotel(
      {
        Amenities: [secret],
        Supplements: [[{ Index: 1, Type: 'AtProperty', Price: 1, Currency: 'AED', Unit: secret }]],
      },
      { HotelName: secret },
    );
    const mapping = map({ ...body, TraceId: secret }, ONE_ADULT, recorded.deps);
    expect(mapping.diagnostics.unknownKeys).toEqual([
      'TraceId',
      'HotelResult[].HotelName',
      'HotelResult[].Rooms[].Amenities',
      'HotelResult[].Rooms[].Supplements[].Unit',
    ]);
    // El pack se lee igual: una clave nueva no es un pack roto.
    expect(mapping.offers).toHaveLength(1);
    expect(JSON.stringify(recorded.logs)).not.toContain(secret);
    expect(JSON.stringify(recorded.counters)).not.toContain(secret);
    const warning = recorded.logs.find((log) => log.message === 'tbo.search.unknown_keys');
    expect(warning?.meta).toMatchObject({ provider: 'tbo-hotels', op: 'search' });
    expect(warning?.meta?.['unknownKeys']).toEqual(mapping.diagnostics.unknownKeys);
  });

  it('los descartes se loguean como `motivo ruta:código`, sin valores', () => {
    const recorded = recorder();
    map(oneHotel({ TotalFare: -152.88 }), ONE_ADULT, recorded.deps);
    const warning = recorded.logs.find((log) => log.message === 'tbo.search.rejected');
    expect(warning?.meta?.['issues']).toEqual(['AMOUNT_NEGATIVE TotalFare:negative']);
    expect(JSON.stringify(recorded.logs)).not.toContain('152.88');
  });
});

describe('vencimiento (RF-09)', () => {
  it('expiresAt = searchSentAt + 27 min en todos los packs', () => {
    const mapping = map(fixture('search-multi-room.p16.json'), TWO_ROOMS);
    const expected = new Date(SENT_AT + 27 * 60_000).toISOString();
    expect(TBO_OFFER_TTL_MS).toBe(27 * 60_000);
    for (const pack of mapping.offers.flatMap((offer) => offer.roompacks)) {
      expect(pack.expiresAt).toBe(expected);
    }
  });
});

describe('entradas que no se leen como éxito', () => {
  it('un Status.Code de error no se mapea como disponibilidad', () => {
    expect(() => map({ Status: { Code: 207 }, HotelResult: [] })).toThrow(TboResponseMappingError);
  });

  it('un contexto inválido es TboResponseMappingError con ruta:código', () => {
    const envelope = TboSearchEnvelopeSchema.parse(fixture('search-single-room.p15.json'));
    const run = (ctx: Partial<TboSearchMapContext>) => () =>
      mapTboSearchResponse(envelope, { ...context(), ...ctx });
    expect(run({ searchSentAt: Number.NaN })).toThrow(/context\.searchSentAt:invalid/);
    expect(run({ searchId: '' })).toThrow(/context\.searchId:invalid/);
    expect(run({ rooms: [] })).toThrow(TboResponseMappingError);
  });

  it('una observabilidad que lanza no cambia el resultado', () => {
    const exploding = () => {
      throw new Error('boom');
    };
    const deps: TboSearchMapDeps = {
      metrics: { counter: exploding, gauge: exploding, histogram: exploding },
      logger: {
        debug: exploding,
        info: exploding,
        warn: exploding,
        error: exploding,
        child: () => {
          throw new Error('boom');
        },
      },
    };
    const quiet = map(oneHotel({ MealType: 'Nope', TraceX: 1 }));
    const loud = map(oneHotel({ MealType: 'Nope', TraceX: 1 }), ONE_ADULT, deps);
    expect(loud).toEqual(quiet);
  });
});

describe('por la puerta pública del cliente HTTP', () => {
  const config = parseTboConfig({ environment: 'test', username: 'demo', password: 'x' });

  function clientAnswering(body: unknown): TboHttpClient {
    return new TboHttpClient(config, {
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      uuid: () => '00000000-0000-4000-8000-000000000001',
    });
  }

  it('el sobre es el responseSchema de Search y la salida del cliente se mapea tal cual', async () => {
    const client = clientAnswering(fixture('search-multi-room.p16.json'));
    const result = await client.send('search', {}, { responseSchema: TboSearchEnvelopeSchema });
    if (result.outcome !== 'SUCCESS') throw new Error('se esperaba SUCCESS');
    const mapping = mapTboSearchResponse(result.data, context(TWO_ROOMS));
    expect(mapping.offers[0]?.roompacks).toHaveLength(2);
  });

  it('el 201 de p. 18 llega como NO_AVAILABILITY, sin datos que mapear', async () => {
    const client = clientAnswering(fixture('search-no-availability.p18.json'));
    const result = await client.send('search', {}, { responseSchema: TboSearchEnvelopeSchema });
    expect(result.outcome).toBe('NO_AVAILABILITY');
  });

  it('un Rooms con un pack roto no hace ilegible la respuesta: el sobre pasa y el pack se descarta', async () => {
    const body = oneHotel();
    const [hotel] = body['HotelResult'] as { Rooms: unknown[] }[];
    hotel?.Rooms.push({ Name: 'no es una lista' });
    const client = clientAnswering(body);
    const result = await client.send('search', {}, { responseSchema: TboSearchEnvelopeSchema });
    if (result.outcome !== 'SUCCESS') throw new Error('se esperaba SUCCESS');
    const mapping = mapTboSearchResponse(result.data, context());
    expect(mapping.offers[0]?.roompacks).toHaveLength(1);
    expect(mapping.diagnostics.packsRejected).toEqual({ PACK_SCHEMA: 1 });
  });
});
