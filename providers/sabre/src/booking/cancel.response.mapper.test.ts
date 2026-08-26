import { describe, expect, it } from 'vitest';
import {
  SABRE_CURRENCY_EXPONENTS,
  SabreCancelMappingError,
  mapSabreCancelResponse,
  parseSabreDecimalToMinor,
  sabreCurrencyExponent,
  toOrderCancelResult,
} from './cancel.response.mapper';

/**
 * Ejemplo oficial de éxito: cancelación total + void. El cuerpo entero son el eco de la request y
 * los billetes anulados; **no hay campo booleano de éxito**
 * (`help-documentation-cancel-booking-examples.txt`).
 */
const OFFICIAL_VOID_SUCCESS = {
  request: {
    confirmationId: 'MFKUYN',
    retrieveBooking: false,
    flightTicketOperation: 'VOID',
    cancelAll: true,
  },
  voidedTickets: ['6071237703374', '6071237560445', '6071237560446'],
};

/** Ejemplo oficial de cancelación parcial fallida con `HALT_ON_ERROR`: nada se canceló. */
const OFFICIAL_HALT_FAILURE = {
  request: { confirmationId: 'MFKUYN' },
  errors: [
    {
      category: 'WARNING',
      type: 'NO_ITEMS_CANCELLED',
      description: 'Nothing was cancelled - cancellation was interrupted due to errors',
    },
    {
      category: 'CANCELLATION_ERROR',
      type: 'UNABLE_TO_VOID_TICKET',
      description: 'The ticket does not match the segments selected for cancellation.',
      fieldPath: 'cancelBookingRequest.flights',
      fieldName: 'itemId',
      fieldValue: '[1251237703376, 6071237703375]',
    },
  ],
};

/** Ejemplo oficial de reembolso LCC: importe por reserva de aerolínea. */
const OFFICIAL_LCC_REFUND = {
  flightRefunds: [
    {
      airlineCode: 'U2',
      confirmationId: 'K9HZQ2S',
      refundTotals: { total: '66.00', currencyCode: 'PLN' },
    },
  ],
};

describe('cancelBooking — el éxito se lee de errors[], no del HTTP', () => {
  it('el ejemplo oficial de void es CANCELLED y éxito', () => {
    const result = mapSabreCancelResponse(OFFICIAL_VOID_SUCCESS);
    expect(result.outcome).toBe('CANCELLED');
    expect(result.success).toBe(true);
    expect(result.voidedTickets).toEqual(['6071237703374', '6071237560445', '6071237560446']);
  });

  it('un cuerpo con sólo el eco es éxito: no hay campo booleano que mirar', () => {
    const result = mapSabreCancelResponse({ request: { confirmationId: 'MFKUYN' } });
    expect(result.outcome).toBe('CANCELLED');
    expect(result.success).toBe(true);
  });

  it('el ejemplo oficial de fallo con HALT_ON_ERROR es FAILED', () => {
    const result = mapSabreCancelResponse(OFFICIAL_HALT_FAILURE);
    expect(result.outcome).toBe('FAILED');
    expect(result.success).toBe(false);
    expect(result.errors.map((issue) => issue.type)).toEqual(['UNABLE_TO_VOID_TICKET']);
    expect(result.warnings.map((issue) => issue.type)).toEqual(['NO_ITEMS_CANCELLED']);
  });

  it('un NO_ITEMS_CANCELLED suelto es NOTHING_CANCELLED, y no es éxito', () => {
    const result = mapSabreCancelResponse({
      errors: [{ category: 'WARNING', type: 'NO_ITEMS_CANCELLED' }],
    });
    expect(result.outcome).toBe('NOTHING_CANCELLED');
    expect(result.success).toBe(false);
  });

  it('la clasificación mira category, NUNCA type: el mismo type cambia de significado', () => {
    const asError = mapSabreCancelResponse({
      errors: [{ category: 'CANCELLATION_ERROR', type: 'UNABLE_TO_CANCEL' }],
    });
    const asWarning = mapSabreCancelResponse(
      { errors: [{ category: 'WARNING', type: 'UNABLE_TO_CANCEL' }] },
      { requestedPolicy: 'ALLOW_PARTIAL_CANCEL' },
    );
    expect(asError.outcome).toBe('FAILED');
    expect(asWarning.outcome).toBe('PARTIALLY_CANCELLED');
  });

  it('un fallo parcial nunca es éxito, ni siquiera cuando llega como WARNING (RF-10 CA-1)', () => {
    const result = mapSabreCancelResponse(
      { errors: [{ category: 'WARNING', type: 'NDC_CANCEL_PROBLEM' }] },
      { requestedPolicy: 'ALLOW_PARTIAL_CANCEL' },
    );
    expect(result.success).toBe(false);
  });

  it('un fallo parcial bajo HALT_ON_ERROR es una anomalía del proveedor y se marca', () => {
    // Pedimos rollback: si aun así llega un fallo parcial, el estado de la reserva no es el que
    // creemos. Tratarlo como aviso convertiría una cancelación a medias en un éxito.
    const result = mapSabreCancelResponse({
      errors: [{ category: 'WARNING', type: 'UNABLE_TO_CANCEL' }],
    });
    expect(result.outcome).toBe('PARTIALLY_CANCELLED');
    expect(result.mapWarnings).toContain('partial-cancel-under-halt-policy');
  });
});

describe('cancelBooking — los warnings que OBLIGAN a releer', () => {
  it.each([
    'END_TRANSACTION_PROBLEM',
    'UNABLE_TO_RETRIEVE_BOOKING',
    'SYSTEM_SLOW_DOWN',
    'INTERNAL_PROCESSING_TIMEOUT',
  ])('%s ⇒ UNVERIFIED, y no es éxito', (type) => {
    // La operación PROBABLEMENTE sí ocurrió: reintentar la escritura duplicaría el efecto. Hay
    // que hacer getBooking y comparar (05 §9.4).
    const result = mapSabreCancelResponse({ errors: [{ category: 'WARNING', type }] });
    expect(result.outcome).toBe('UNVERIFIED');
    expect(result.success).toBe(false);
  });

  it('UNVERIFIED gana a un fallo parcial: primero hay que saber qué pasó', () => {
    const result = mapSabreCancelResponse({
      errors: [
        { category: 'WARNING', type: 'OTA_CANCEL_PROBLEM' },
        { category: 'WARNING', type: 'END_TRANSACTION_PROBLEM' },
      ],
    });
    expect(result.outcome).toBe('UNVERIFIED');
  });
});

describe('cancelBooking — idempotencia: cancelar dos veces da el mismo resultado', () => {
  const first = mapSabreCancelResponse({
    ...OFFICIAL_LCC_REFUND,
    refundedTickets: ['0167489825830'],
  });
  const second = mapSabreCancelResponse({
    errors: [
      {
        category: 'CANCELLATION_ERROR',
        type: 'BOOKING_ALREADY_CANCELED',
        description: 'U2 booking has already been canceled by the airline.',
      },
    ],
  });

  it('la segunda cancelación también es éxito: el estado final es el mismo', () => {
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.outcome).toBe('ALREADY_CANCELLED');
  });

  it('pero NO vuelve a reembolsar: el dinero se cuenta una sola vez', () => {
    expect(first.refunds).toHaveLength(1);
    expect(second.refunds).toEqual([]);
    const total =
      (toOrderCancelResult(first).refundAmount?.amountMinor ?? 0) +
      (toOrderCancelResult(second).refundAmount?.amountMinor ?? 0);
    expect(total).toBe(6600);
  });

  it('la forma en WARNING de BOOKING_ALREADY_CANCELED se lee igual', () => {
    const asWarning = mapSabreCancelResponse({
      errors: [{ category: 'WARNING', type: 'BOOKING_ALREADY_CANCELED' }],
    });
    expect(asWarning.outcome).toBe('ALREADY_CANCELLED');
    expect(asWarning.success).toBe(true);
  });

  it('ya-cancelada acompañada de OTRO error sí es fallo', () => {
    const result = mapSabreCancelResponse({
      errors: [
        { category: 'CANCELLATION_ERROR', type: 'BOOKING_ALREADY_CANCELED' },
        { category: 'CANCELLATION_ERROR', type: 'UNABLE_TO_VOID_TICKET' },
      ],
    });
    expect(result.outcome).toBe('FAILED');
  });
});

describe('cancelBooking — el dinero', () => {
  it('el ejemplo oficial LCC: 66.00 PLN son 6600 unidades menores', () => {
    const result = mapSabreCancelResponse(OFFICIAL_LCC_REFUND);
    expect(result.refunds).toEqual([
      {
        airlineCode: 'U2',
        confirmationId: 'K9HZQ2S',
        amountMinor: 6600,
        currency: 'PLN',
        rawAmount: '66.00',
      },
    ]);
  });

  it('las estimaciones por billete NO se suman al reembolso: son cosas distintas', () => {
    // `tickets[]` es elegibilidad ("Estimates assume the highest possible refund penalty is
    // applied"); `flightRefunds[]` es lo que se reembolsó. Sumarlas duplica cada billete.
    const result = mapSabreCancelResponse({
      tickets: [
        {
          number: '0167489825830',
          isRefundable: true,
          refundTotals: { total: '66.00', currencyCode: 'PLN' },
        },
      ],
      ...OFFICIAL_LCC_REFUND,
    });
    expect(result.refunds).toHaveLength(1);
    expect(result.estimates).toHaveLength(1);
    expect(toOrderCancelResult(result).refundAmount).toEqual({
      amountMinor: 6600,
      currency: 'PLN',
    });
  });

  it('sólo con estimaciones, el puerto NO declara importe reembolsado', () => {
    const result = mapSabreCancelResponse({
      tickets: [{ number: '0167489825830', refundTotals: { total: '99.99', currencyCode: 'USD' } }],
    });
    expect(toOrderCancelResult(result).refundAmount).toBeUndefined();
    expect(result.mapWarnings).toContain('ticket-estimate-only');
  });

  it('reembolsos en varias divisas NO se suman', () => {
    const result = mapSabreCancelResponse({
      flightRefunds: [
        { airlineCode: 'U2', refundTotals: { total: '66.00', currencyCode: 'PLN' } },
        { airlineCode: 'LA', refundTotals: { total: '10.00', currencyCode: 'USD' } },
      ],
    });
    const port = toOrderCancelResult(result);
    // No hay tipo de cambio en este contexto: un total en la divisa equivocada es peor que ninguno.
    expect(port.refundAmount).toBeUndefined();
    expect(port.warnings).toContain('refund-currency-mixed');
    expect(result.refunds).toHaveLength(2);
  });

  it('varios reembolsos de la MISMA divisa sí se suman', () => {
    const result = mapSabreCancelResponse({
      flightRefunds: [
        { refundTotals: { total: '66.00', currencyCode: 'PLN' } },
        { refundTotals: { total: '10.50', currencyCode: 'PLN' } },
      ],
    });
    expect(toOrderCancelResult(result).refundAmount).toEqual({
      amountMinor: 7650,
      currency: 'PLN',
    });
  });
});

describe('cancelBooking — decimal en string a unidades menores, sin coma flotante', () => {
  it.each([
    ['100.00', 'USD', 10_000],
    ['100', 'USD', 10_000],
    ['100.5', 'USD', 10_050],
    ['0.01', 'USD', 1],
    ['0', 'USD', 0],
    // Divisas de 0 decimales: multiplicar por 100 un peso chileno lo multiplica por cien.
    ['66', 'CLP', 66],
    ['66.00', 'CLP', 66],
    ['1500000', 'PYG', 1_500_000],
    // Divisas de 3 decimales.
    ['12.345', 'KWD', 12_345],
    ['12.3', 'KWD', 12_300],
  ])('%s %s ⇒ %i', (amount, currency, expected) => {
    expect(parseSabreDecimalToMinor(amount, currency)).toBe(expected);
  });

  it('un importe con más decimales de los que la divisa admite NO se redondea en silencio', () => {
    // Redondear dinero sin decirlo es invisible; dejarlo fuera con un aviso, no.
    expect(parseSabreDecimalToMinor('10.555', 'USD')).toBeUndefined();
    expect(parseSabreDecimalToMinor('66.50', 'CLP')).toBeUndefined();
  });

  it('los ceros de más sí son inocuos', () => {
    expect(parseSabreDecimalToMinor('10.500', 'USD')).toBe(1050);
  });

  it.each(['-1.00', '1,00', 'NaN', '1e3', '', '1.2345'])('rechaza %s', (amount) => {
    expect(parseSabreDecimalToMinor(amount, 'USD')).toBeUndefined();
  });

  it('un importe no representable deja el reembolso fuera, con aviso', () => {
    const result = mapSabreCancelResponse({
      flightRefunds: [{ refundTotals: { total: '10.555', currencyCode: 'USD' } }],
    });
    expect(result.refunds).toEqual([]);
    expect(result.mapWarnings).toContain('refund-amount-not-representable');
  });

  it('un refundTotals sin divisa se marca como malformado', () => {
    const result = mapSabreCancelResponse({
      flightRefunds: [{ refundTotals: { total: '66.00' } }],
    });
    expect(result.refunds).toEqual([]);
    expect(result.mapWarnings).toContain('refund-amount-malformed');
  });

  it('la tabla de exponentes cubre las divisas de LATAM que no son de 2 decimales', () => {
    expect(sabreCurrencyExponent('CLP')).toBe(0);
    expect(sabreCurrencyExponent('PYG')).toBe(0);
    expect(sabreCurrencyExponent('COP')).toBe(2);
    expect(sabreCurrencyExponent('BRL')).toBe(2);
    expect(sabreCurrencyExponent('PEN')).toBe(2);
    expect(Object.isFrozen(SABRE_CURRENCY_EXPONENTS)).toBe(true);
  });
});

describe('cancelBooking — lo que quedó vivo', () => {
  it('mapea booking con el mapper de getBooking cuando se pidió retrieveBooking', () => {
    const result = mapSabreCancelResponse({
      request: { confirmationId: 'GLEBNY', retrieveBooking: true },
      booking: {
        bookingId: 'GLEBNY',
        flights: [
          {
            itemId: '1',
            airlineCode: 'AA',
            confirmationId: 'NIEBNY',
            flightStatusName: 'Cancelled',
          },
        ],
        hotels: [{ itemId: '42', hotelStatusName: 'Confirmed' }],
      },
    });
    expect(result.remaining?.status).toBe('ACTIVE');
    expect(result.remaining?.items).toHaveLength(2);
  });

  it('si lo que quedó vivo no se puede leer, la cancelación sigue valiendo', () => {
    const result = mapSabreCancelResponse({ booking: 'no-es-un-objeto' });
    expect(result.outcome).toBe('CANCELLED');
    expect(result.mapWarnings).toContain('remaining-booking-unmappable');
  });
});

describe('cancelBooking — el resultado no puede llevar PII ni texto del proveedor', () => {
  it('la description del proveedor no se copia a ningún sitio', () => {
    const description = 'Cancelacion de PAM THOMPSON, pasaporte X1234567, tarjeta 4111111111111111';
    const result = mapSabreCancelResponse({
      errors: [{ category: 'CANCELLATION_ERROR', type: 'UNABLE_TO_CANCEL', description }],
    });
    const serialized = JSON.stringify(result) + JSON.stringify(toOrderCancelResult(result));
    expect(serialized).not.toContain('THOMPSON');
    expect(serialized).not.toContain('X1234567');
    expect(serialized).not.toContain('4111111111111111');
    // El `type` sí viaja: es vocabulario cerrado del proveedor y es lo que explica el fallo.
    expect(serialized).toContain('UNABLE_TO_CANCEL');
  });

  it('fieldValue tampoco: el ejemplo oficial mete números de billete ahí', () => {
    const result = mapSabreCancelResponse(OFFICIAL_HALT_FAILURE);
    expect(JSON.stringify(result)).not.toContain('1251237703376');
    expect(result.errors[0]?.fieldPath).toBe('cancelBookingRequest.flights');
  });

  it('la vista del puerto describe el fallo con outcome y type', () => {
    const port = toOrderCancelResult(mapSabreCancelResponse(OFFICIAL_HALT_FAILURE));
    expect(port.success).toBe(false);
    expect(port.error).toBe('FAILED:UNABLE_TO_VOID_TICKET');
  });
});

describe('cancelBooking — el borde rechaza lo que no encaja', () => {
  it('un escalar no es una respuesta', () => {
    expect(() => mapSabreCancelResponse(42)).toThrow(SabreCancelMappingError);
  });

  it('el mensaje del error de mapeo lleva rutas de Zod, no valores', () => {
    try {
      mapSabreCancelResponse({ voidedTickets: [{ number: '0167489825830' }] });
      expect.unreachable('debería haber lanzado');
    } catch (error) {
      expect((error as Error).message).toContain('voidedTickets');
      expect((error as Error).message).not.toContain('0167489825830');
    }
  });

  it('un número de billete fuera de patrón no se publica', () => {
    const result = mapSabreCancelResponse({ voidedTickets: ['0167489825830', 'no válido'] });
    expect(result.voidedTickets).toEqual(['0167489825830']);
  });
});
