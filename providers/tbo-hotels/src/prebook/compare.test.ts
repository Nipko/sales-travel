import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HotelRoomOccupancy, HotelRoompack } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import { mapTboSearchResponse } from '../search/response.mapper';
import { TboSearchEnvelopeSchema } from '../search/response.schema';
import { compareTboRates, type TboRateSnapshot } from './compare';
import { mapTboPrebookResponse, type TboPrebookMapping } from './response.mapper';
import { TboPrebookEnvelopeSchema } from './response.schema';

/**
 * Comparación C1/C2 (docs/tbo/03 §2.9; 08 RF-15 CA-3). Función pura: se prueba con lecturas reales
 * de los mappers, no con packs escritos a mano, para que un cambio en el mapeo que rompa la
 * comparación se vea aquí.
 */

const FIXTURES = join(__dirname, '..', '__fixtures__', 'pdf');
const SEARCH_ID = 'srch_0001';
const SENT_AT = Date.parse('2026-09-25T15:00:00.000Z');
const TWO_ROOMS: HotelRoomOccupancy[] = [
  { adults: 2, childrenAges: [] },
  { adults: 2, childrenAges: [] },
];
/** El único par comparable del PDF: Search 6.2.2 (p. 17) y PreBook 7.2.2 (p. 28). */
const BOOKING_CODE = '1120548!TB!4!TB!9a47646b-1bba-4746-91d5-969149db1185';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
}

/** La tarifa de Search tal como la guarda el contexto del servidor: pack + literal. */
function searchSnapshot(): TboRateSnapshot {
  const mapping = mapTboSearchResponse(
    TboSearchEnvelopeSchema.parse(fixture('search-multi-room.p16.json')),
    { searchId: SEARCH_ID, searchSentAt: SENT_AT, rooms: TWO_ROOMS },
  );
  const pack = mapping.offers[0]?.roompacks.find((p) => p.id === BOOKING_CODE);
  const context = mapping.packs.find((p) => p.bookingCode === BOOKING_CODE);
  if (pack === undefined || context === undefined) throw new Error('falta el pack de p. 17');
  return { totalFare: context.totalFare, roompack: pack };
}

function prebook(
  room: Record<string, unknown> = {},
  hotel: Record<string, unknown> = {},
): TboPrebookMapping {
  const base = fixture('prebook-limit-multi-room.p28.json') as {
    HotelResult: [Record<string, unknown> & { Rooms: [Record<string, unknown>] }];
  };
  const [first] = base.HotelResult;
  const envelope = TboPrebookEnvelopeSchema.parse({
    ...base,
    HotelResult: [{ ...first, Rooms: [{ ...first.Rooms[0], ...room }], ...hotel }],
  });
  return mapTboPrebookResponse(envelope, {
    hotelCode: '1120548',
    bookingCode: BOOKING_CODE,
    searchId: SEARCH_ID,
    searchSentAt: SENT_AT,
    rooms: TWO_ROOMS,
  });
}

function prebookSnapshot(mapping: TboPrebookMapping): TboRateSnapshot {
  const roompack: HotelRoompack | undefined = mapping.result.roompack;
  if (roompack === undefined) throw new Error('PreBook sin pack');
  return {
    totalFare: mapping.pack.totalFare,
    roompack,
    signals: mapping.result.signals,
    rateConditionsHash: mapping.rateConditionsHash,
  };
}

describe('C1: el PreBook de la pantalla contra la tarifa de Search', () => {
  it('el par del PDF (p. 17 y p. 28) es UNCHANGED: ExtraGuestCharges no entra en la comparación', () => {
    const result = compareTboRates('C1', searchSnapshot(), prebookSnapshot(prebook()));
    expect(result).toEqual({
      stage: 'C1',
      outcome: 'UNCHANGED',
      price: 'SAME',
      changes: [],
      previousTotal: { amountMinor: 30575, currency: 'USD' },
      currentTotal: { amountMinor: 30575, currency: 'USD' },
    });
  });

  it('decimal exacto sin tolerancia: 305.750 es igual; 305.76 sube; 305.74 baja', () => {
    const search = searchSnapshot();
    expect(
      compareTboRates('C1', search, prebookSnapshot(prebook({ TotalFare: '305.750' }))).outcome,
    ).toBe('UNCHANGED');
    const up = compareTboRates('C1', search, prebookSnapshot(prebook({ TotalFare: 305.76 })));
    expect(up).toMatchObject({ outcome: 'INCREASED', price: 'UP', changes: [] });
    expect(up.currentTotal).toEqual({ amountMinor: 30576, currency: 'USD' });
    expect(
      compareTboRates('C1', search, prebookSnapshot(prebook({ TotalFare: 305.74 }))).outcome,
    ).toBe('DECREASED');
  });

  it('sin redondeo: una diferencia en la tercera cifra decimal también es un cambio', () => {
    const result = compareTboRates(
      'C1',
      searchSnapshot(),
      prebookSnapshot(prebook({ TotalFare: '305.751' })),
    );
    // Mismas unidades menores, distinto literal: el Book reenviaría otro TotalFare.
    expect(result.currentTotal.amountMinor).toBe(30575);
    expect(result.outcome).toBe('INCREASED');
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, string]>([
    ['IsRefundable', { IsRefundable: true }, {}, 'REFUNDABLE'],
    ['MealType', { MealType: 'Breakfast_For_2' }, {}, 'MEAL_TYPE'],
    [
      'el importe de un cargo en el hotel',
      {
        Supplements: [
          [
            {
              Index: 1,
              Type: 'AtProperty',
              Description: 'mandatory_tax',
              Price: 25,
              Currency: 'AED',
            },
          ],
          [
            {
              Index: 2,
              Type: 'AtProperty',
              Description: 'mandatory_tax',
              Price: 20,
              Currency: 'AED',
            },
          ],
        ],
      },
      {},
      'AT_PROPERTY_CHARGES',
    ],
    ['los cargos en el hotel desaparecen', { Supplements: [] }, {}, 'AT_PROPERTY_CHARGES'],
    ['la moneda', {}, { Currency: 'EUR' }, 'CURRENCY'],
  ])('cambia %s → CONDITIONS_CHANGED', (_label, room, hotel, change) => {
    const result = compareTboRates('C1', searchSnapshot(), prebookSnapshot(prebook(room, hotel)));
    expect(result.outcome).toBe('CONDITIONS_CHANGED');
    expect(result.changes).toContain(change);
  });

  it('MealType sin distinguir mayúsculas ni guiones bajos (02 §9.8)', () => {
    const result = compareTboRates(
      'C1',
      searchSnapshot(),
      prebookSnapshot(prebook({ MealType: 'room_only' })),
    );
    expect(result.outcome).toBe('UNCHANGED');
  });

  it('si cambian a la vez precio y condiciones, prevalece CONDITIONS_CHANGED y se informa la subida', () => {
    const result = compareTboRates(
      'C1',
      searchSnapshot(),
      prebookSnapshot(prebook({ TotalFare: 400, IsRefundable: true })),
    );
    expect(result).toMatchObject({
      outcome: 'CONDITIONS_CHANGED',
      price: 'UP',
      changes: ['REFUNDABLE'],
    });
  });

  it('otra moneda no se compara como precio', () => {
    const result = compareTboRates(
      'C1',
      searchSnapshot(),
      prebookSnapshot(prebook({}, { Currency: 'EUR' })),
    );
    expect(result.price).toBe('NOT_COMPARABLE');
  });

  it('C1 no compara políticas, señales ni texto: Search no los trae (03 §2.9)', () => {
    const current = prebookSnapshot(prebook({}, { RateConditions: ['Other norms'] }));
    const result = compareTboRates('C1', searchSnapshot(), current);
    expect(result.outcome).toBe('UNCHANGED');
  });
});

describe('C2: la revalidación antes del Book contra el snapshot que aceptó el vendedor', () => {
  const accepted = prebookSnapshot(prebook());

  it('la misma respuesta es UNCHANGED', () => {
    expect(compareTboRates('C2', accepted, prebookSnapshot(prebook())).outcome).toBe('UNCHANGED');
  });

  it('una política de cancelación distinta es CONDITIONS_CHANGED', () => {
    const result = compareTboRates(
      'C2',
      accepted,
      prebookSnapshot(
        prebook({
          CancelPolicies: [
            { FromDate: '04-05-2022 00:00:00', ChargeType: 'Percentage', CancellationCharge: 100 },
          ],
        }),
      ),
    );
    expect(result).toMatchObject({ outcome: 'CONDITIONS_CHANGED', changes: ['CANCEL_POLICIES'] });
  });

  it('una señal nueva o perdida es CONDITIONS_CHANGED', () => {
    const lost = prebookSnapshot(prebook({}, { RateConditions: [] }));
    const result = compareTboRates('C2', accepted, lost);
    expect(result.outcome).toBe('CONDITIONS_CHANGED');
    expect(result.changes).toEqual(['SIGNALS', 'RATE_CONDITIONS']);
  });

  it('un texto saneado distinto, sin señal nueva, es CONDITIONS_CHANGED por RATE_CONDITIONS', () => {
    const base = fixture('prebook-limit-multi-room.p28.json') as {
      HotelResult: [{ RateConditions: string[] }];
    };
    const edited = [...base.HotelResult[0].RateConditions, 'Pets not allowed'];
    const result = compareTboRates(
      'C2',
      accepted,
      prebookSnapshot(prebook({}, { RateConditions: edited })),
    );
    expect(result.changes).toEqual(['RATE_CONDITIONS']);
  });

  it('el mismo texto con otro formato de origen no es un cambio (se compara lo saneado)', () => {
    const base = fixture('prebook-limit-multi-room.p28.json') as {
      HotelResult: [{ RateConditions: string[] }];
    };
    const reformatted = base.HotelResult[0].RateConditions.map((item) => `  ${item}  `);
    const result = compareTboRates(
      'C2',
      accepted,
      prebookSnapshot(prebook({}, { RateConditions: reformatted })),
    );
    expect(result.outcome).toBe('UNCHANGED');
  });

  it('sin huella en un lado no se puede demostrar que el texto sea el mismo', () => {
    const { rateConditionsHash: _dropped, ...withoutHash } = accepted;
    const result = compareTboRates('C2', withoutHash, prebookSnapshot(prebook()));
    expect(result.changes).toEqual(['RATE_CONDITIONS']);
  });

  it('sin huella en NINGÚN lado tampoco: C2 no da por igual un texto que no comparó', () => {
    const { rateConditionsHash: _a, ...acceptedWithoutHash } = accepted;
    const { rateConditionsHash: _b, ...currentWithoutHash } = prebookSnapshot(prebook());
    const result = compareTboRates('C2', acceptedWithoutHash, currentWithoutHash);
    expect(result).toMatchObject({ outcome: 'CONDITIONS_CHANGED', changes: ['RATE_CONDITIONS'] });
  });

  it('si sólo baja el precio es DECREASED: avisar y seguir es decisión del servidor (D-TBO-20 A)', () => {
    const result = compareTboRates('C2', accepted, prebookSnapshot(prebook({ TotalFare: 300 })));
    expect(result).toMatchObject({ outcome: 'DECREASED', price: 'DOWN', changes: [] });
    expect(result.previousTotal).toEqual({ amountMinor: 30575, currency: 'USD' });
    expect(result.currentTotal).toEqual({ amountMinor: 30000, currency: 'USD' });
  });
});

describe('el resultado sirve para el evento sin texto del proveedor', () => {
  it('sólo códigos cerrados e importes en unidades menores', () => {
    const result = compareTboRates('C2', prebookSnapshot(prebook()), prebookSnapshot(prebook()));
    const dump = JSON.stringify(result);
    expect(dump).not.toMatch(/Tourism|package|Luxury/i);
  });
});
