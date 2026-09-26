import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  HotelBookIntentClosedError,
  HotelBookRepricedError,
  HotelGuestsInvalidError,
} from './hotel-booking-errors.js';

/**
 * Los rechazos de la reserva con órdenes: el mensaje es para el vendedor y el `reason` para la web.
 */

describe('HotelGuestsInvalidError: el primer motivo que el vendedor puede corregir', () => {
  it.each([
    ['rooms.0.guests.1:duplicate_guest', 'distinguirlos'],
    ['rooms.0.guests.0.title:required', 'Sr. (Mr), Sra. (Mrs) o Srta. (Ms)'],
    ['rooms.0.guests.0.title:not_allowed', 'Sr. (Mr), Sra. (Mrs) o Srta. (Ms)'],
    ['rooms.1.guests.0:lead_not_adult', 'tiene que ser un adulto'],
    ['rooms.0:adults_mismatch', 'no coinciden con las habitaciones'],
    ['rooms.0:children_mismatch', 'no coinciden con las habitaciones'],
    ['rooms:count_mismatch', 'no coinciden con las habitaciones'],
    ['rooms.0.guests.0.firstName:contains_digits', 'sin números'],
    ['rooms.0.guests.0.lastName:invalid_characters', 'sin números'],
    ['rooms.0.guests.0.firstName:too_short', 'al menos 2 letras'],
    ['rooms.0.guests.0.lastName:required', 'al menos 2 letras'],
    ['rooms.0.guests.0.lastName:too_long', 'hasta 40 caracteres'],
    ['rooms.0.guests:too_many', 'no cumplen lo que el proveedor exige'],
  ])('%s → "%s"', (issue, texto) => {
    const err = new HotelGuestsInvalidError([issue]);

    expect(err.message).toContain(texto);
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.reason).toBe('GUESTS_INVALID');
    expect(err.publicDetails).toEqual({ issues: [issue] });
  });

  it('los duplicados ganan: sin distinguirlos, lo demás no alcanza', () => {
    expect(
      new HotelGuestsInvalidError(['rooms.0:adults_mismatch', 'rooms.0.guests.2:duplicate_guest'])
        .message,
    ).toContain('distinguirlos');
  });
});

describe('HotelBookRepricedError: 409 con el motivo y los valores nuevos', () => {
  it.each([
    ['PRICE_INCREASED', 'subió'],
    ['CONDITIONS_CHANGED', 'condiciones'],
    ['PACKAGE_ONLY_RATE', 'paquete con aéreo'],
  ] as const)('%s', (reason, texto) => {
    const details = {
      outcome: 'INCREASED' as const,
      price: 'UP' as const,
      changes: [],
      acceptedTotal: { amountMinor: 100, currency: 'USD' },
      currentTotal: { amountMinor: 120, currency: 'USD' },
    };
    const err = new HotelBookRepricedError(reason, details);

    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.reason).toBe(reason);
    expect(err.message).toContain(texto);
    expect(err.publicDetails).toBe(details);
  });
});

describe('HotelBookIntentClosedError', () => {
  it('lleva la orden y las marcas que impiden reintentar', () => {
    const err = new HotelBookIntentClosedError('33333333-3333-4333-8333-333333333333');

    expect(err.reason).toBe('BOOKING_NOT_OPEN');
    expect(err.getResponse()).toMatchObject({
      statusCode: 409,
      orderId: '33333333-3333-4333-8333-333333333333',
      retryForbidden: true,
      reconciliationRequired: true,
    });
  });
});
