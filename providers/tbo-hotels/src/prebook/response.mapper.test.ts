import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HotelRoompackSchema, type HotelRoomOccupancy } from '@sales-travel/canonical';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import { TboResponseMappingError, TboUnsupportedCurrencyError } from '../errors';
import { TBO_OFFER_TTL_MS } from '../search/offer-window';
import {
  mapTboPrebookResponse,
  type TboPrebookMapContext,
  type TboPrebookMapDeps,
  type TboPrebookMapping,
} from './response.mapper';
import { TboPrebookEnvelopeSchema, type TboPrebookEnvelope } from './response.schema';

/**
 * El mapper de PreBook contra los ejemplos 7.2.1 y 7.2.2 del PDF (p. 23-32, normalizados en
 * `src/__fixtures__/pdf/`) y contra las respuestas que el contrato no promete pero puede mandar
 * (docs/tbo/03 §2.2-§2.11; 08 RF-15 a RF-17).
 */

const FIXTURES = join(__dirname, '..', '__fixtures__', 'pdf');
const SEARCH_ID = 'srch_0001';
const SENT_AT = Date.parse('2026-09-25T15:00:00.000Z');
const TWO_ROOMS: HotelRoomOccupancy[] = [
  { adults: 2, childrenAges: [] },
  { adults: 2, childrenAges: [] },
];
const ONE_ROOM: HotelRoomOccupancy[] = [{ adults: 2, childrenAges: [] }];

const MULTI_ROOM_CODE = '1120548!TB!4!TB!9a47646b-1bba-4746-91d5-969149db1185';
const SINGLE_ROOM_CODE = '1435427!TB!2!TB!a5419e54-559d-4607-a8ee-ce743288bd51';

function raw(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
}

/** El sobre como lo entrega el cliente HTTP: validado con el mismo esquema de salida. */
function envelope(value: unknown): TboPrebookEnvelope {
  return TboPrebookEnvelopeSchema.parse(value);
}

const MULTI: TboPrebookMapContext = {
  hotelCode: '1120548',
  bookingCode: MULTI_ROOM_CODE,
  searchId: SEARCH_ID,
  searchSentAt: SENT_AT,
  rooms: TWO_ROOMS,
  requestId: 'req-1',
};

const SINGLE: TboPrebookMapContext = {
  ...MULTI,
  hotelCode: '1435427',
  bookingCode: SINGLE_ROOM_CODE,
  rooms: ONE_ROOM,
};

interface Recorded {
  readonly counters: { name: string; tags: Record<string, string> | undefined }[];
  readonly logs: { level: string; message: string; meta: Record<string, unknown> | undefined }[];
  readonly deps: TboPrebookMapDeps;
}

function recorder(): Recorded {
  const counters: Recorded['counters'] = [];
  const logs: Recorded['logs'] = [];
  const metrics: MetricsPort = {
    counter: (name, _value, tags) => counters.push({ name, tags }),
    gauge: () => undefined,
    histogram: () => undefined,
  };
  const at =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      logs.push({ level, message, meta });
    };
  const logger: LoggerPort = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return { counters, logs, deps: { metrics, logger } };
}

/** Una copia del ejemplo 7.2.2 con la habitación o el hotel tocados. */
function multiRoomWith(
  room: Record<string, unknown> = {},
  hotel: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = raw('prebook-limit-multi-room.p28.json') as {
    HotelResult: [Record<string, unknown> & { Rooms: [Record<string, unknown>] }];
  };
  const [first] = base.HotelResult;
  return {
    ...base,
    HotelResult: [{ ...first, Rooms: [{ ...first.Rooms[0], ...room }], ...hotel }],
  };
}

function mappingError(run: () => unknown): TboResponseMappingError {
  try {
    run();
  } catch (err) {
    if (err instanceof TboResponseMappingError) return err;
    throw err;
  }
  throw new Error('se esperaba TboResponseMappingError');
}

describe('7.2.2 (p. 28-32): dos habitaciones, modo Limit', () => {
  const mapping: TboPrebookMapping = mapTboPrebookResponse(
    envelope(raw('prebook-limit-multi-room.p28.json')),
    MULTI,
  );
  const pack = mapping.result.roompack;

  it('el pack cumple el contrato neutral y dice de dónde es (RF-40)', () => {
    expect(pack).toBeDefined();
    expect(HotelRoompackSchema.safeParse(pack).success).toBe(true);
    expect(pack?.provider).toEqual({
      name: 'tbo-hotels',
      offerRef: MULTI_ROOM_CODE,
      raw: { searchId: SEARCH_ID },
    });
  });

  it('neto revalidado exacto y piso de venta de PreBook (RF-12: se reaplica con este valor)', () => {
    expect(mapping.result.total).toEqual({ amountMinor: 30575, currency: 'USD' });
    expect(pack?.price.minimumSellingPrice).toEqual({ amountMinor: 32134, currency: 'USD' });
    expect(pack?.price.taxes).toEqual({ amountMinor: 5624, currency: 'USD' });
  });

  it('el Book reenvía el BookingCode de PreBook y el LITERAL de su TotalFare (03 §3.4)', () => {
    expect(mapping.pack).toEqual({
      hotelCode: '1120548',
      bookingCode: MULTI_ROOM_CODE,
      totalFare: '305.75',
      currency: 'USD',
    });
    expect(mapping.diagnostics.bookingCodeChanged).toBe(false);
  });

  it('políticas FINALES (KP-3, p. 71): origen prebook-final, con el tramo del 100 %', () => {
    expect(pack?.cancellation).toMatchObject({
      refundable: false,
      status: 'non_refundable',
      policySource: 'prebook-final',
      rules: [
        {
          type: 'Percentage',
          penaltyPercentage: 100,
          fromLocalDateTime: '2022-05-05T00:00:00',
          fromDateRaw: '05-05-2022 00:00:00',
        },
      ],
    });
  });

  it('dos cargos AED 20.00 en el hotel, uno por habitación, fuera del total (RF-10)', () => {
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
  });

  it('un nombre por habitación, con la ocupación pedida en su orden', () => {
    expect(pack?.rooms.map((room) => [room.name, room.occupancy])).toEqual([
      ['Luxury Room, 2 Twin Beds', { adults: 2, childrenAges: [] }],
      ['Luxury Room, 2 Twin Beds', { adults: 2, childrenAges: [] }],
    ]);
  });

  it('las 13 condiciones saneadas, con el original, y la marca de solo paquete (RF-17)', () => {
    expect(mapping.result.rateConditions).toHaveLength(13);
    expect(mapping.result.rateConditions.every((c) => !/[<>]/.test(c.text))).toBe(true);
    expect(mapping.result.signals).toEqual(['PACKAGE_WITH_FLIGHT_ONLY']);
    expect(mapping.rateConditionsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('vence cuando vencía la búsqueda: PreBook no renueva el reloj (Q-29)', () => {
    const expected = new Date(SENT_AT + TBO_OFFER_TTL_MS).toISOString();
    expect(mapping.result.expiresAt).toBe(expected);
    expect(pack?.expiresAt).toBe(expected);
  });

  it('los Amenities salen aparte, en texto plano', () => {
    expect(mapping.amenities).toHaveLength(42);
    expect(mapping.amenities[0]).toBe('Non-Smoking');
  });

  it('sin avisos ni claves desconocidas; estado del proveedor como código', () => {
    expect(mapping.result.warnings).toEqual([]);
    expect(mapping.result.providerStatus).toBe('200');
    expect(mapping.diagnostics.unknownKeys).toEqual([]);
    expect(mapping.diagnostics.cardBillingOptionsIgnored).toBe(false);
  });
});

describe('7.2.1 (p. 23-27): CreditCardBillingOptions se descarta (03 §2.8)', () => {
  it('no llega a ningún resultado, se cuenta sin contenido y se avisa', () => {
    const recorded = recorder();
    const mapping = mapTboPrebookResponse(
      envelope(raw('prebook-newcard-single-room.p23.json')),
      SINGLE,
      recorded.deps,
    );
    const dump = JSON.stringify(mapping);
    expect(dump).not.toContain('CreditCardBillingOptions');
    expect(dump).not.toContain('ConvenienceCharges');
    expect(dump).not.toContain('85.822');
    expect(dump).not.toContain('GBP');
    expect(mapping.result.warnings).toEqual(['CARD_BILLING_OPTIONS_IGNORED']);
    expect(mapping.diagnostics.cardBillingOptionsIgnored).toBe(true);
    // Una clave conocida y descartada a propósito no es una clave desconocida.
    expect(mapping.diagnostics.unknownKeys).toEqual([]);
    expect(recorded.counters.map((c) => c.name)).toContain('tbo.prebook.card_billing_options');
    const logged = JSON.stringify(recorded.logs);
    expect(logged).not.toContain('85.822');
    expect(logged).not.toContain('GBP');
  });

  it('el resto del ejemplo se lee: reembolsable con dos tramos y la marca de p. 25', () => {
    const mapping = mapTboPrebookResponse(
      envelope(raw('prebook-newcard-single-room.p23.json')),
      SINGLE,
    );
    expect(mapping.result.total).toEqual({ amountMinor: 1710, currency: 'USD' });
    expect(mapping.pack.totalFare).toBe('17.1');
    expect(mapping.result.roompack?.cancellation).toMatchObject({
      refundable: true,
      status: 'fully_refundable',
      policySource: 'prebook-final',
      freeCancellationUntilLocal: '2022-05-12T00:00:00',
    });
    expect(mapping.result.signals).toEqual(['PACKAGE_WITH_FLIGHT_ONLY']);
    expect(mapping.result.rateConditions.map((c) => c.category)).toContain('minCheckInAge');
  });
});

describe('BookingCode distinto del enviado (RF-15 CA-2; Q-30)', () => {
  it('se usa el de PreBook y se alerta, sin fallar', () => {
    const recorded = recorder();
    const changed = '1120548!TB!4!TB!00000000-0000-4000-8000-000000000000';
    const mapping = mapTboPrebookResponse(
      envelope(multiRoomWith({ BookingCode: changed })),
      MULTI,
      recorded.deps,
    );
    expect(mapping.pack.bookingCode).toBe(changed);
    expect(mapping.result.roompack?.provider.offerRef).toBe(changed);
    expect(mapping.result.warnings).toEqual(['BOOKING_CODE_CHANGED']);
    expect(mapping.diagnostics.bookingCodeChanged).toBe(true);
    expect(recorded.counters.map((c) => c.name)).toContain('tbo.prebook.booking_code_changed');
    const alert = recorded.logs.find((log) => log.message === 'tbo.prebook.booking_code_changed');
    expect(alert?.level).toBe('warn');
    // El log no lleva ninguno de los dos códigos: son la llave de la reserva.
    expect(JSON.stringify(alert)).not.toContain(changed);
    expect(JSON.stringify(alert)).not.toContain(MULTI_ROOM_CODE);
  });
});

describe('estricto donde hay dinero: una respuesta que no se puede leer no pasa', () => {
  it('más de un HotelResult o ninguno lo rechaza ya el esquema del cliente', () => {
    const base = raw('prebook-limit-multi-room.p28.json') as { HotelResult: unknown[] };
    for (const hotels of [[], [base.HotelResult[0], base.HotelResult[0]]]) {
      const parsed = TboPrebookEnvelopeSchema.safeParse({ ...base, HotelResult: hotels });
      expect(parsed.success).toBe(false);
    }
    expect(TboPrebookEnvelopeSchema.safeParse({ Status: { Code: 200 } }).success).toBe(false);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, string]>([
    ['otro hotel', {}, { HotelCode: '9999999' }, 'HotelResult.0.HotelCode:not_the_requested_hotel'],
    ['dos elementos en Rooms', {}, { Rooms: [{}, {}] }, 'HotelResult.0.Rooms:too_big'],
    ['sin moneda', {}, { Currency: undefined }, 'HotelResult.Currency:missing'],
    ['moneda en minúsculas', {}, { Currency: 'usd' }, 'HotelResult.Currency:invalid_string'],
    [
      'una norma que no es texto',
      {},
      { RateConditions: ['ok', { text: 'x' }] },
      'HotelResult.0.RateConditions.1:invalid_type',
    ],
    [
      'un nombre de habitación de menos',
      { Name: ['Luxury Room, 2 Twin Beds'] },
      {},
      'HotelResult.0.Rooms.Name:length_differs_from_request',
    ],
    ['TotalFare negativo', { TotalFare: -1 }, {}, 'HotelResult.0.TotalFare:negative'],
    ['TotalFare cero', { TotalFare: 0 }, {}, 'HotelResult.0.TotalFare:zero'],
    [
      'un suplemento de una habitación que no existe',
      { Supplements: [[{ Index: 3, Type: 'AtProperty', Price: 1, Currency: 'AED' }]] },
      {},
      'HotelResult.0.Supplements.0.Index:out_of_range',
    ],
  ])('%s → TboResponseMappingError con ruta:código', (_label, room, hotel, issue) => {
    const error = mappingError(() =>
      mapTboPrebookResponse(envelope(multiRoomWith(room, hotel)), MULTI),
    );
    expect(error.issues).toContain(issue);
    expect(error.path).toBe('/PreBook');
    expect(error.requestId).toBe('req-1');
  });

  it('una moneda con otro exponente deja a TBO no disponible para la cuenta (D-TBO-15 A)', () => {
    expect(() =>
      mapTboPrebookResponse(envelope(multiRoomWith({}, { Currency: 'KWD' })), MULTI),
    ).toThrow(TboUnsupportedCurrencyError);
  });

  it('un Status.Code que no es 200 no se lee como éxito (error de cableado)', () => {
    const error = mappingError(() =>
      mapTboPrebookResponse(
        envelope({ ...multiRoomWith(), Status: { Code: 201, Description: 'x' } }),
        MULTI,
      ),
    );
    expect(error.issues).toEqual(['Status.Code:not_a_success_code']);
  });

  it.each<[string, Partial<TboPrebookMapContext>, string]>([
    ['sin hotel', { hotelCode: '' }, 'context.hotelCode:invalid'],
    ['sin BookingCode', { bookingCode: '' }, 'context.bookingCode:invalid'],
    ['sin searchId', { searchId: '' }, 'context.searchId:invalid'],
    ['instante inválido', { searchSentAt: Number.NaN }, 'context.searchSentAt:invalid'],
    ['sin habitaciones', { rooms: [] }, 'context.rooms:too_small'],
  ])('contexto %s: se falla cerrado', (_label, override, issue) => {
    const error = mappingError(() =>
      mapTboPrebookResponse(envelope(multiRoomWith()), { ...MULTI, ...override }),
    );
    expect(error.issues).toContain(issue);
  });

  it('los issues nunca llevan valores de la respuesta', () => {
    const error = mappingError(() =>
      mapTboPrebookResponse(envelope(multiRoomWith({}, { HotelCode: 'SECRET-HOTEL' })), MULTI),
    );
    expect(error.message).not.toContain('SECRET-HOTEL');
    expect(JSON.stringify(error.toLogMeta())).not.toContain('SECRET-HOTEL');
  });
});

describe('tolerante donde el contrato se contradice', () => {
  it('importes como string, Supplements plano e Index como texto', () => {
    const mapping = mapTboPrebookResponse(
      envelope(
        multiRoomWith({
          TotalFare: '305.750',
          Supplements: [
            {
              Index: '1',
              Type: 'AtProperty',
              Description: 'mandatory_tax',
              Price: '20.00',
              Currency: 'AED',
            },
          ],
        }),
      ),
      MULTI,
    );
    expect(mapping.result.total).toEqual({ amountMinor: 30575, currency: 'USD' });
    expect(mapping.pack.totalFare).toBe('305.750');
    expect(mapping.result.roompack?.atPropertyCharges).toHaveLength(1);
  });

  it('RateConditions ausente o null es []', () => {
    for (const value of [undefined, null]) {
      const mapping = mapTboPrebookResponse(
        envelope(multiRoomWith({}, { RateConditions: value })),
        MULTI,
      );
      expect(mapping.result.rateConditions).toEqual([]);
      expect(mapping.result.signals).toEqual([]);
    }
  });

  it('las claves desconocidas se registran por NOMBRE, nunca por valor (C-12)', () => {
    const recorded = recorder();
    const mapping = mapTboPrebookResponse(
      envelope({
        ...multiRoomWith({ NewRoomField: 'valor-secreto-1' }, { NewHotelField: 'valor-secreto-2' }),
        NewRootField: 'valor-secreto-3',
      }),
      MULTI,
      recorded.deps,
    );
    expect(mapping.diagnostics.unknownKeys).toEqual([
      'NewRootField',
      'HotelResult[].NewHotelField',
      'HotelResult[].Rooms[].NewRoomField',
    ]);
    expect(JSON.stringify(recorded)).not.toContain('valor-secreto');
    expect(JSON.stringify(mapping)).not.toContain('valor-secreto');
  });

  it('un MealType desconocido → RO con la métrica de PreBook (RF-11 CA-3)', () => {
    const recorded = recorder();
    const mapping = mapTboPrebookResponse(
      envelope(multiRoomWith({ MealType: 'Brunch_Only' })),
      MULTI,
      recorded.deps,
    );
    expect(mapping.result.roompack?.board).toBe('RO');
    expect(mapping.diagnostics.unknownMealTypes).toBe(1);
    expect(recorded.counters).toContainEqual({
      name: 'tbo.unknown_meal_type',
      tags: { op: 'prebook', kind: 'unknown' },
    });
  });

  it('un logger y unas métricas que lanzan no le quitan a nadie la revalidación', () => {
    const throwing: TboPrebookMapDeps = {
      metrics: {
        counter: () => {
          throw new Error('metrics caído');
        },
        gauge: () => undefined,
        histogram: () => undefined,
      },
      logger: {
        debug: () => {
          throw new Error('logger caído');
        },
        info: () => undefined,
        warn: () => {
          throw new Error('logger caído');
        },
        error: () => undefined,
        child: () => throwing.logger as LoggerPort,
      },
    };
    const mapping = mapTboPrebookResponse(
      envelope(multiRoomWith({ BookingCode: 'otro!TB!1' })),
      MULTI,
      throwing,
    );
    expect(mapping.result.total.amountMinor).toBe(30575);
  });
});
