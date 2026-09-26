import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import { TboResponseMappingError } from '../errors';
import {
  mapTboBookingDetailResponse,
  type TboBookingDetailMapContext,
  type TboBookingDetailMapDeps,
} from './response.mapper';
import { TboBookingDetailEnvelopeSchema } from './response.schema';

/**
 * Lectura de BookingDetail (docs/tbo/04 §3.3-§3.7 y §6.3; 08 RF-24 CA 1 a 3).
 */

type Json = Record<string, unknown>;

const DETAIL_1021 = JSON.parse(
  readFileSync(join(__dirname, '..', '__fixtures__', 'pdf', 'booking-detail.p49.json'), 'utf8'),
) as Json;

const BY_CN: TboBookingDetailMapContext = {
  lookup: { confirmationNumber: 'YOSUR8' },
  requestId: 'req-1',
};
const REFERENCE = 'STT7K2M9QX4D8R1VZ6AB';
const BY_REFERENCE: TboBookingDetailMapContext = { lookup: { bookingReferenceId: REFERENCE } };

/** Los nombres de los huéspedes del ejemplo (p. 50-51). Ninguno puede salir de la lectura. */
const GUEST_NAMES = /Shubham|Gupta|Kunal|Agrawal|FirstName|LastName|CustomerNames/;

function clone(): Json {
  return JSON.parse(JSON.stringify(DETAIL_1021)) as Json;
}

function withDetail(patch: Json, rooms?: unknown): Json {
  const body = clone();
  const detail = body['BookingDetail'] as Json;
  body['BookingDetail'] = { ...detail, ...patch, ...(rooms === undefined ? {} : { Rooms: rooms }) };
  return body;
}

function room(patch: Json = {}): Json {
  const detail = DETAIL_1021['BookingDetail'] as Json;
  const [first] = detail['Rooms'] as Json[];
  return { ...(first ?? {}), ...patch };
}

function read(
  body: unknown,
  context: TboBookingDetailMapContext = BY_CN,
  deps: TboBookingDetailMapDeps = {},
) {
  return mapTboBookingDetailResponse(TboBookingDetailEnvelopeSchema.parse(body), context, deps);
}

function spies(): {
  logger: LoggerPort;
  metrics: MetricsPort;
  logs: { level: string; message: string; meta: unknown }[];
  counters: { name: string; tags: Record<string, string> | undefined }[];
} {
  const logs: { level: string; message: string; meta: unknown }[] = [];
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
  const counters: { name: string; tags: Record<string, string> | undefined }[] = [];
  const metrics: MetricsPort = {
    counter: (name, _value, tags) => counters.push({ name, tags }),
    gauge: () => undefined,
    histogram: () => undefined,
  };
  return { logger, metrics, logs, counters };
}

describe('10.2.1 (p. 49-51), comillas normalizadas (RF-24 CA-1)', () => {
  it('se lee como confirmada, con su localizador', () => {
    const { view } = read(DETAIL_1021);
    expect(view).toEqual({
      found: true,
      providerBookingId: 'YOSUR8',
      status: 'CONFIRMED',
      providerStatus: 'Confirmed',
      warnings: [],
    });
  });

  it('el BookingDate imposible (`2021-07-1317T00:00:00`) no rompe: queda vacío y se cuenta', () => {
    const { logger, metrics, counters } = spies();
    const { detail, diagnostics } = read(DETAIL_1021, BY_CN, { logger, metrics });
    expect(detail.bookingDate).toBeUndefined();
    expect(diagnostics.bookingDateMalformed).toBe(true);
    expect(counters.map((c) => c.name)).toContain('tbo.booking_detail.booking_date_malformed');
  });

  it('las fechas de la estadía salen como YYYY-MM-DD aunque lleguen con hora (PV-03)', () => {
    const { detail } = read(DETAIL_1021);
    expect(detail).toMatchObject({ checkIn: '2021-10-16', checkOut: '2021-10-17' });
  });

  it('el resumen para la post-venta', () => {
    const { detail } = read(DETAIL_1021);
    expect(detail).toMatchObject({
      confirmationNumber: 'YOSUR8',
      providerStatus: 'Confirmed',
      voucherStatus: 'VOUCHERED',
      invoiceNumber: 'MW34325',
      noOfRooms: 1,
      hotel: {
        name: 'Golden Sands Hotel Apartments',
        stars: 3,
        map: '25.251559|55.295027',
        city: 'Dubai',
      },
      rooms: [
        {
          currency: 'USD',
          names: ['STUDIO STANDARD'],
          totalFare: '107.14',
          totalTax: '0',
          mealType: 'Room_Only',
          inclusion: 'ROOM ONLY',
          isRefundable: false,
        },
      ],
      total: { amountMinor: 10714, currency: 'USD' },
    });
    expect(detail.hotelConfirmationNumber).toBeUndefined();
  });

  it('las normas salen saneadas y con sus señales: el voucher las muestra (p. 51)', () => {
    const { detail } = read(DETAIL_1021);
    expect(detail.rateConditions).toHaveLength(3);
    expect(detail.signals).toEqual(['NO_NAME_CHANGE', 'MARKET_RESTRICTION']);
    // El carácter de reemplazo que trae el PDF se conserva: no se inventa el apóstrofo.
    expect(detail.rateConditions[1]?.raw).toContain('hotel�s time');
  });

  it('las claves de los huéspedes y de la tarjeta no se reportan como contrato nuevo', () => {
    const { diagnostics } = read(DETAIL_1021);
    expect(diagnostics.unknownKeys).toEqual([]);
  });
});

describe('los huéspedes no salen de la lectura (RF-24 CA-3)', () => {
  it('un logger espía no recibe ningún nombre', () => {
    const { logger, metrics, logs, counters } = spies();
    read(
      withDetail({ BookingStatus: 'Mystery', HotelDetails: { HotelName: 'X', Extra: 'y' } }),
      BY_CN,
      { logger, metrics },
    );
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toMatch(GUEST_NAMES);
    expect(JSON.stringify(counters)).not.toMatch(GUEST_NAMES);
  });

  it('el resultado tampoco los lleva, en ninguna parte', () => {
    expect(JSON.stringify(read(DETAIL_1021))).not.toMatch(GUEST_NAMES);
  });

  it('ni con CustomerDetails a nivel de reserva, donde la tabla plana podría ponerlos (PV-06)', () => {
    const body = withDetail({
      CustomerDetails: [{ CustomerNames: [{ FirstName: 'Shubham', LastName: 'Gupta' }] }],
      CreditCardOptions: [{ CardNumber: '4111111111111111' }],
    });
    const mapping = read(body);
    expect(JSON.stringify(mapping)).not.toMatch(GUEST_NAMES);
    expect(JSON.stringify(mapping)).not.toContain('4111');
    expect(mapping.diagnostics.unknownKeys).toEqual([]);
  });
});

describe('estado de la reserva (04 §6.3)', () => {
  it('CancelledAndRefundAwaited es cancelada, con el reembolso pendiente (RF-24 CA-2)', () => {
    expect(read(withDetail({ BookingStatus: 'CancelledAndRefundAwaited' })).view).toMatchObject({
      status: 'CANCELLED',
      providerStatus: 'CancelledAndRefundAwaited',
      refundAwaited: true,
    });
  });

  it('Vouchered es Confirmed (p. 64)', () => {
    expect(read(withDetail({ BookingStatus: 'Vouchered' })).view.status).toBe('CONFIRMED');
  });

  it('un estado fuera del enum escala sin adivinar, y sale como código', () => {
    const { logger, logs } = spies();
    const { view, diagnostics } = read(withDetail({ BookingStatus: 'On Request' }), BY_CN, {
      logger,
    });
    expect(view).toMatchObject({ status: 'UNKNOWN', providerStatus: 'On_Request' });
    expect(view.warnings).toContain('BOOKING_STATUS_UNKNOWN');
    expect(diagnostics.bookingStatusUnknown).toBe(true);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'tbo.booking_detail.status_unknown',
        meta: expect.objectContaining({ providerStatus: 'On_Request' }) as unknown,
      }),
    );
  });

  it.each([false, 'Confirm'])(
    'confirmada con VoucherStatus %j: sigue confirmada, con aviso (PV-02)',
    (voucher) => {
      const { view, detail } = read(withDetail({ VoucherStatus: voucher }));
      expect(view.status).toBe('CONFIRMED');
      expect(view.warnings).toEqual(['VOUCHER_NOT_ISSUED']);
      expect(detail.voucherStatus).toBe('NOT_VOUCHERED');
    },
  );

  it('VoucherStatus "Voucher" es emitido; un valor raro se avisa aparte', () => {
    expect(read(withDetail({ VoucherStatus: 'Voucher' })).detail.voucherStatus).toBe('VOUCHERED');
    expect(read(withDetail({ VoucherStatus: 'Maybe' })).view.warnings).toEqual([
      'VOUCHER_STATUS_UNKNOWN',
    ]);
  });
});

describe('HCN (PV-05)', () => {
  it('vacío o sólo espacios es "todavía sin HCN"', () => {
    for (const value of ['', '   ', null]) {
      expect(
        read(withDetail({ HotelConfirmationNumber: value })).view.hotelConfirmationNumber,
      ).toBe(undefined);
    }
  });

  it('cuando llega, sale recortado en la vista y en el resumen', () => {
    const { view, detail } = read(withDetail({ HotelConfirmationNumber: '  HCN-778899 ' }));
    expect(view.hotelConfirmationNumber).toBe('HCN-778899');
    expect(detail.hotelConfirmationNumber).toBe('HCN-778899');
  });
});

describe('Rooms en sus dos formas (PV-07)', () => {
  it('una habitación por elemento: el total suma las dos', () => {
    const { detail } = read(
      withDetail({ NoOfRooms: 2 }, [room({ TotalFare: 107.14 }), room({ TotalFare: '92.86' })]),
    );
    expect(detail.rooms).toHaveLength(2);
    expect(detail.total).toEqual({ amountMinor: 20000, currency: 'USD' });
  });

  it('un elemento con un nombre por habitación', () => {
    const { detail } = read(
      withDetail({ NoOfRooms: 2 }, [room({ Name: ['STUDIO STANDARD', 'STUDIO DELUXE'] })]),
    );
    expect(detail.rooms[0]?.names).toEqual(['STUDIO STANDARD', 'STUDIO DELUXE']);
    expect(detail.noOfRooms).toBe(2);
  });

  it('monedas mezcladas: no se inventa un total', () => {
    const { detail, diagnostics } = read(withDetail({}, [room(), room({ Currency: 'EUR' })]));
    expect(detail.total).toBeUndefined();
    expect(diagnostics.totalUnavailable).toBe('MIXED_CURRENCY');
  });

  it('sin habitaciones la reserva se lee igual, sin total', () => {
    const { view, diagnostics } = read(withDetail({ Rooms: null }));
    expect(view.found).toBe(true);
    expect(diagnostics.totalUnavailable).toBe('NO_ROOMS');
  });
});

describe('el voucher se lee por partes: lo ilegible no tapa el estado (RF-24)', () => {
  it('una estrella numérica (HotelRating llega como número en p. 62 y 67) se lee igual', () => {
    const { detail, view } = read(
      withDetail({ HotelDetails: { HotelName: 'Golden Sands', Rating: 3 } }),
    );
    expect(detail.hotel).toEqual({ name: 'Golden Sands', stars: 3 });
    expect(view.warnings).toEqual([]);
  });

  it('las estrellas salen normalizadas a 1-5 como en el catálogo (RF-32; 08 §10, StarRating)', () => {
    const { metrics, counters } = spies();
    const stars = (Rating: unknown): number | undefined =>
      read(withDetail({ HotelDetails: { Rating } }), BY_CN, { metrics }).detail.hotel.stars;
    expect(stars('FiveStar')).toBe(5);
    expect(stars('4.5')).toBe(4.5);
    expect(stars('All')).toBeUndefined();
    expect(counters.map((c) => c.name)).not.toContain('tbo.booking_detail.rating_unknown');
    expect(stars('SevenStar')).toBeUndefined();
    expect(counters.map((c) => c.name)).toContain('tbo.booking_detail.rating_unknown');
  });

  it('IsRefundable como texto "false" se lee como false', () => {
    const { detail } = read(withDetail({}, [room({ IsRefundable: 'false' })]));
    expect(detail.rooms[0]?.isRefundable).toBe(false);
  });

  it('una norma null se descarta y las demás se leen', () => {
    const body = clone();
    const detailBody = body['BookingDetail'] as Json;
    detailBody['RateConditions'] = [...(detailBody['RateConditions'] as unknown[]), null, 42];
    const { view, detail, diagnostics } = read(body);
    expect(view.status).toBe('CONFIRMED');
    expect(detail.rateConditions).toHaveLength(3);
    expect(view.warnings).toEqual(['DETAIL_PARTIALLY_UNREADABLE']);
    expect(diagnostics.unreadable).toEqual(['BookingDetail.RateConditions:invalid_type']);
  });

  it('un HotelDetails que no es objeto deja el hotel vacío y el estado leído', () => {
    const { view, detail, diagnostics } = read(withDetail({ HotelDetails: 'Golden Sands' }));
    expect(view).toMatchObject({ status: 'CONFIRMED', providerBookingId: 'YOSUR8' });
    expect(detail.hotel).toEqual({});
    expect(diagnostics.unreadable).toEqual(['BookingDetail.HotelDetails:invalid_type']);
  });

  it('una habitación ilegible se descarta, sin total: la recuperación por referencia concluye igual', () => {
    const { logger, logs } = spies();
    const { view, detail, diagnostics } = read(
      withDetail({ NoOfRooms: 2 }, [room({ TotalFare: '107,14' }), room({ TotalFare: 92.86 })]),
      BY_REFERENCE,
      { logger },
    );
    expect(view).toMatchObject({
      found: true,
      status: 'CONFIRMED',
      providerBookingId: 'YOSUR8',
      bookingReference: REFERENCE,
      warnings: ['DETAIL_PARTIALLY_UNREADABLE'],
    });
    // Sumar sólo la habitación legible daría un total falso.
    expect(detail.rooms).toHaveLength(1);
    expect(detail.total).toBeUndefined();
    expect(diagnostics.totalUnavailable).toBe('ROOM_UNREADABLE');
    expect(diagnostics.unreadable).toEqual(['BookingDetail.Rooms.0.TotalFare:invalid_string']);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'tbo.booking_detail.partially_unreadable',
      }),
    );
    expect(JSON.stringify(logs)).not.toContain('107,14');
  });

  it('una habitación descartada no filtra sus huéspedes a ninguna parte', () => {
    const { logger, logs } = spies();
    const mapping = read(withDetail({}, [room({ Name: 42 }), 'no-es-una-habitacion']), BY_CN, {
      logger,
    });
    expect(mapping.view.status).toBe('CONFIRMED');
    expect(JSON.stringify(mapping)).not.toMatch(GUEST_NAMES);
    expect(JSON.stringify(logs)).not.toMatch(GUEST_NAMES);
  });

  it('Rooms como un escalar: sin habitaciones ni total, con el estado leído', () => {
    const { view, diagnostics } = read(withDetail({ Rooms: 'STUDIO' }));
    expect(view.status).toBe('CONFIRMED');
    expect(diagnostics.totalUnavailable).toBe('ROOM_UNREADABLE');
    expect(diagnostics.unreadable).toEqual(['BookingDetail.Rooms:invalid_type']);
  });
});

describe('la reserva tiene que ser la pedida', () => {
  it('leída por localizador, otro localizador es otra reserva: ilegible', () => {
    expect(() => read(withDetail({ ConfirmationNumber: 'ABC123' }))).toThrow(
      TboResponseMappingError,
    );
  });

  it('la comparación del localizador no distingue mayúsculas', () => {
    expect(read(withDetail({ ConfirmationNumber: 'yosur8' })).view.providerBookingId).toBe(
      'yosur8',
    );
  });

  it('leída por nuestra referencia, el localizador que vuelve es el que se adopta', () => {
    expect(read(DETAIL_1021, BY_REFERENCE).view).toMatchObject({
      found: true,
      providerBookingId: 'YOSUR8',
      bookingReference: REFERENCE,
    });
  });

  it('un localizador sin forma de uno no se adopta', () => {
    try {
      read(withDetail({ ConfirmationNumber: 'YO SUR8' }), BY_REFERENCE);
      throw new Error('no lanzó');
    } catch (err) {
      expect(err).toBeInstanceOf(TboResponseMappingError);
      expect((err as TboResponseMappingError).issues).toEqual([
        'BookingDetail.ConfirmationNumber:invalid_format',
      ]);
    }
  });
});

describe('ilegible es ilegible', () => {
  it('un 200 sin BookingDetail no pasa el sobre: el cliente lo lanza como error de mapeo', () => {
    expect(
      TboBookingDetailEnvelopeSchema.safeParse({ Status: { Code: 200, Description: 'Successful' } })
        .success,
    ).toBe(false);
  });

  it('sin BookingStatus o sin ConfirmationNumber no hay reserva que leer', () => {
    for (const patch of [{ BookingStatus: '' }, { ConfirmationNumber: undefined }]) {
      expect(() => read(withDetail(patch))).toThrow(TboResponseMappingError);
    }
  });

  it('los issues dicen dónde, nunca qué valor', () => {
    try {
      read(withDetail({ BookingStatus: 42 }));
      throw new Error('no lanzó');
    } catch (err) {
      expect((err as TboResponseMappingError).issues).toEqual([
        'BookingDetail.BookingStatus:invalid_type',
      ]);
      expect((err as TboResponseMappingError).requestId).toBe('req-1');
    }
  });

  it('las claves nuevas se reportan por nombre, también cuando la lectura falla', () => {
    const { logger, logs } = spies();
    expect(() =>
      read(withDetail({ BookingStatus: 42, NewField: 'valor-secreto' }), BY_CN, { logger }),
    ).toThrow(TboResponseMappingError);
    expect(JSON.stringify(logs)).toContain('BookingDetail.NewField');
    expect(JSON.stringify(logs)).not.toContain('valor-secreto');
  });
});
