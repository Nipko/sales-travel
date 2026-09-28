import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoggerPort, MetricsPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import { TboResponseMappingError } from '../errors';
import type { TboBookingDateWindow } from './booking-by-date.request.builder';
import { mapTboBookingsByDateResponse } from './booking-by-date.response.mapper';
import {
  TboBookingsByDateEnvelopeSchema,
  type TboBookingsByDateEnvelope,
} from './booking-by-date.response.schema';

/**
 * La lectura de BookingDetailsbasedondate (docs/tbo/04 §5.4 y §9.5; 08 RF-28 CA): la ventana vale
 * entera o no vale, `TripName` no sale y lo comercial es tolerante.
 */

const RESPONSE_1521 = JSON.parse(
  readFileSync(join(__dirname, '..', '__fixtures__', 'pdf', 'booking-by-date.p64.json'), 'utf8'),
) as { Status: unknown; BookingDetail: Record<string, unknown>[] };

const [ROW_1, ROW_2] = RESPONSE_1521.BookingDetail as [
  Record<string, unknown>,
  Record<string, unknown>,
];

const WINDOW: TboBookingDateWindow = { fromDate: '2023-11-09', toDate: '2023-11-10' };

function envelope(raw: unknown): TboBookingsByDateEnvelope {
  return TboBookingsByDateEnvelopeSchema.parse(raw);
}

function withRows(...rows: unknown[]): TboBookingsByDateEnvelope {
  return envelope({ Status: { Code: 200 }, BookingDetail: rows });
}

function map(raw: TboBookingsByDateEnvelope, window = WINDOW) {
  return mapTboBookingsByDateResponse(raw, { window, requestId: 'req-bd-1' });
}

function issuesOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(TboResponseMappingError);
    const error = err as TboResponseMappingError;
    expect(error.name).toBe('TboResponseMappingError');
    expect(error.path).toBe('/BookingDetailsbasedondate');
    expect(error.requestId).toBe('req-bd-1');
    return error.issues;
  }
  throw new Error('el mapper no lanzó');
}

describe('15.2.1 Sample Response (p. 64)', () => {
  it('las dos reservas, en vocabulario nuestro', () => {
    const mapping = map(envelope(RESPONSE_1521));
    expect(mapping.window).toEqual(WINDOW);
    expect(mapping.bookings).toEqual([
      {
        confirmationNumber: 'GOF05R',
        bookingDate: '2023-11-10',
        clientReferenceNumber: '123680',
        bookingId: '264056',
        status: 'CONFIRMED',
        providerStatus: 'Vouchered',
        currency: 'USD',
        bookingPrice: { amountMinor: 58_389, currency: 'USD' },
        agentMarkup: { amountMinor: 0, currency: 'USD' },
        agencyName: 'ATravels',
        hotelCode: '1022623',
        checkIn: '2023-12-02',
        checkOut: '2023-12-10',
      },
      {
        confirmationNumber: '7L4F4E',
        bookingDate: '2023-11-09',
        clientReferenceNumber: '20230320978y8',
        bookingId: '263915',
        status: 'CONFIRMED',
        providerStatus: 'Vouchered',
        currency: 'USD',
        bookingPrice: { amountMinor: 98_323, currency: 'USD' },
        agentMarkup: { amountMinor: 0, currency: 'USD' },
        agencyName: 'ATravels',
        hotelCode: '1407362',
        checkIn: '2023-11-20',
        checkOut: '2023-11-21',
      },
    ]);
    expect(mapping.diagnostics).toEqual({
      unknownKeys: [],
      rowsReceived: 2,
      statusMissing: 0,
      statusUnknown: 0,
      clientReferenceMissing: 0,
      amountsUnreadable: 0,
      amountsWithPrecisionLoss: 0,
      stayDatesUnreadable: 0,
      duplicateConfirmationNumbers: 0,
    });
  });

  it('TripName se descarta: ni la clave ni su valor salen (RF-28; 04 §9.5 punto 6)', () => {
    const out = JSON.stringify(map(envelope(RESPONSE_1521)));
    expect(out).not.toMatch(/TripName|Sharma|One_20Nov_London|Index/);
  });
});

describe('la ventana vale entera o no vale (RF-28 CA: una fila fuera invalida la corrida)', () => {
  it('una fila creada fuera de la ventana pedida', () => {
    expect(
      issuesOf(() =>
        map(envelope(RESPONSE_1521), { fromDate: '2023-11-10', toDate: '2023-11-10' }),
      ),
    ).toEqual(['BookingDetail.1.BookingDate:outside_window']);
  });

  it('también después del final', () => {
    expect(
      issuesOf(() =>
        map(envelope(RESPONSE_1521), { fromDate: '2023-11-01', toDate: '2023-11-09' }),
      ),
    ).toEqual(['BookingDetail.0.BookingDate:outside_window']);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['BookingDate en otro formato', { BookingDate: '2023-11-10' }, 'BookingDate:invalid_date'],
    ['BookingDate imposible', { BookingDate: '31-Nov-2023' }, 'BookingDate:invalid_date'],
    ['mes en otro idioma', { BookingDate: '10-Nov.-2023' }, 'BookingDate:invalid_date'],
    ['sin BookingDate', { BookingDate: undefined }, 'BookingDate:invalid_type'],
    ['sin ConfirmationNo', { ConfirmationNo: undefined }, 'ConfirmationNo:invalid_type'],
    ['ConfirmationNo vacío', { ConfirmationNo: '  ' }, 'ConfirmationNo:too_small'],
    ['ConfirmationNo sin forma', { ConfirmationNo: 'GOF 05R' }, 'ConfirmationNo:invalid_format'],
  ])('%s: no se puede cruzar ni comprobar', (_name, patch, issue) => {
    expect(issuesOf(() => map(withRows(ROW_1, { ...ROW_2, ...patch })))).toEqual([
      `BookingDetail.1.${issue}`,
    ]);
  });

  it('una fila que no es un objeto', () => {
    expect(issuesOf(() => map(withRows(ROW_1, 'GOF05R')))).toEqual([
      'BookingDetail.1:invalid_type',
    ]);
  });

  it('un BookingDetail escalar es una forma que el contrato no admite', () => {
    expect(issuesOf(() => map(envelope({ Status: { Code: 200 }, BookingDetail: 'none' })))).toEqual(
      ['BookingDetail:invalid_type'],
    );
  });

  it('un Status.Code que no es 200 nunca es "no hay reservas" (PV-26)', () => {
    expect(issuesOf(() => map(envelope({ Status: { Code: 201 }, BookingDetail: [] })))).toEqual([
      'Status.Code:not_a_success_code',
    ]);
  });

  it('el log dice qué ventana se descartó y nunca los datos de las filas', () => {
    const logs: unknown[] = [];
    const logger: LoggerPort = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message, meta) => logs.push({ message, meta }),
      error: () => undefined,
      child: () => logger,
    };
    expect(() =>
      mapTboBookingsByDateResponse(
        envelope(RESPONSE_1521),
        { window: { fromDate: '2023-11-10', toDate: '2023-11-10' }, requestId: 'req-bd-1' },
        { logger },
      ),
    ).toThrow(TboResponseMappingError);
    expect(logs).toContainEqual({
      message: 'tbo.bookings_by_date.invalid_window',
      meta: expect.objectContaining({
        fromDate: '2023-11-10',
        toDate: '2023-11-10',
        issues: ['BookingDetail.1.BookingDate:outside_window'],
      }) as unknown,
    });
    expect(JSON.stringify(logs)).not.toMatch(/ATravels|Sharma|583\.89|123680/);
  });
});

describe('vacío con 200 es "no hay reservas" (PV-26)', () => {
  it.each([
    ['ausente', { Status: { Code: 200 } }],
    ['null', { Status: { Code: 200 }, BookingDetail: null }],
    ['array vacío', { Status: { Code: 200 }, BookingDetail: [] }],
  ])('%s', (_name, raw) => {
    const mapping = map(envelope(raw));
    expect(mapping.bookings).toEqual([]);
    expect(mapping.diagnostics.rowsReceived).toBe(0);
  });

  it('un objeto único en lugar del array es una reserva (PV-27)', () => {
    const mapping = map(envelope({ Status: { Code: 200 }, BookingDetail: ROW_1 }));
    expect(mapping.bookings.map((b) => b.confirmationNumber)).toEqual(['GOF05R']);
  });
});

describe('lo comercial es tolerante: queda ausente y se cuenta', () => {
  it.each<[string, string, 'CANCELLED' | 'CANCELLATION_IN_PROGRESS' | 'UNKNOWN', boolean]>([
    ['Cancelled', 'Cancelled', 'CANCELLED', false],
    ['CancelledAndRefundAwaited', 'CancelledAndRefundAwaited', 'CANCELLED', true],
    ['CxlRequestSentToHotel', 'CxlRequestSentToHotel', 'CANCELLATION_IN_PROGRESS', false],
    ['un valor fuera del enum (R7)', 'On Hold!', 'UNKNOWN', false],
  ])('BookingStatus %s', (_name, raw, status, refundAwaited) => {
    const mapping = map(withRows({ ...ROW_1, BookingStatus: raw }));
    const [booking] = mapping.bookings;
    expect(booking?.status).toBe(status);
    expect(booking?.refundAwaited ?? false).toBe(refundAwaited);
    expect(mapping.diagnostics.statusUnknown).toBe(status === 'UNKNOWN' ? 1 : 0);
    if (status === 'UNKNOWN') expect(booking?.providerStatus).toBe('On_Hold');
  });

  it('sin BookingStatus (no está en la tabla, PV-28): la fila vale y el estado queda ausente', () => {
    const mapping = map(withRows({ ...ROW_1, BookingStatus: undefined }));
    expect(mapping.bookings[0]).not.toHaveProperty('status');
    expect(mapping.bookings[0]).not.toHaveProperty('providerStatus');
    expect(mapping.diagnostics.statusMissing).toBe(1);
  });

  it('sin ClientReferenceNumber legible: la fila vale y se cuenta (no se puede descartar como ajena)', () => {
    const mapping = map(
      withRows(
        { ...ROW_1, ClientReferenceNumber: undefined },
        { ...ROW_2, ClientReferenceNumber: 'con espacios no' },
      ),
    );
    expect(mapping.bookings).toHaveLength(2);
    expect(mapping.bookings.every((b) => b.clientReferenceNumber === undefined)).toBe(true);
    expect(mapping.diagnostics.clientReferenceMissing).toBe(2);
  });

  it('un ClientReferenceNumber numérico es el mismo texto', () => {
    const mapping = map(withRows({ ...ROW_1, ClientReferenceNumber: 123680 }));
    expect(mapping.bookings[0]?.clientReferenceNumber).toBe('123680');
  });

  it.each<[string, Record<string, unknown>, number]>([
    ['sin moneda', { Currency: undefined }, 2],
    ['moneda sin dos decimales', { Currency: 'KWD' }, 2],
    ['moneda en minúsculas', { Currency: 'usd' }, 2],
    ['un monto con separador de miles', { BookingPrice: '1,583.89' }, 1],
  ])('montos ilegibles: %s', (_name, patch, unreadable) => {
    const mapping = map(withRows({ ...ROW_1, ...patch }));
    expect(mapping.bookings).toHaveLength(1);
    expect(mapping.diagnostics.amountsUnreadable).toBe(unreadable);
  });

  it('fechas de estadía ilegibles: la fila vale sin ellas', () => {
    const mapping = map(withRows({ ...ROW_1, CheckInDate: '2023-12-02', CheckOutDate: null }));
    expect(mapping.bookings[0]).not.toHaveProperty('checkIn');
    expect(mapping.bookings[0]).not.toHaveProperty('checkOut');
    expect(mapping.diagnostics.stayDatesUnreadable).toBe(1);
  });

  it('un localizador repetido se cuenta', () => {
    expect(map(withRows(ROW_1, ROW_1)).diagnostics.duplicateConfirmationNumbers).toBe(1);
  });

  it('una clave nueva se registra por su NOMBRE; TripName e Index no son nuevas', () => {
    const counters: { name: string; tags?: Record<string, string> }[] = [];
    const metrics: MetricsPort = {
      counter: (name, _value, tags) => counters.push({ name, ...(tags ? { tags } : {}) }),
      gauge: () => undefined,
      histogram: () => undefined,
    };
    const mapping = mapTboBookingsByDateResponse(
      withRows({ ...ROW_1, GuestEmail: 'x@y.example' }),
      { window: WINDOW },
      { metrics },
    );
    expect(mapping.diagnostics.unknownKeys).toEqual(['BookingDetail[].GuestEmail']);
    expect(JSON.stringify(mapping)).not.toContain('x@y.example');
    expect(counters).toContainEqual({
      name: 'tbo.contract.unknown_key',
      tags: { op: 'bookingDetailsByDate', key: 'BookingDetail[].GuestEmail' },
    });
  });
});
