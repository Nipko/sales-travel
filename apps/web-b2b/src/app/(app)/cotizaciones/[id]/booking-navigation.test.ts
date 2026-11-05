import { describe, expect, it } from 'vitest';
import {
  bookingToast,
  createdOrderId,
  paxCountLabel,
  reservationHref,
  totalPassengers,
} from './booking-navigation';

const ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

describe('createdOrderId', () => {
  it('lee el id de la reserva local de la respuesta', () => {
    expect(createdOrderId({ order: { id: ID } })).toBe(ID);
    expect(createdOrderId({ orderId: ID })).toBe(ID);
  });

  it('no inventa una ruta con algo que no es un id', () => {
    expect(createdOrderId({})).toBeUndefined();
    expect(createdOrderId({ order: { id: '../admin' } })).toBeUndefined();
  });
});

describe('reservationHref — sólo una reserva creada abre su detalle', () => {
  it('CONFIRMED y PARTIAL con reserva local van a /reservas/[id]', () => {
    expect(reservationHref({ outcome: 'CONFIRMED', orderId: ID })).toBe(`/reservas/${ID}`);
    expect(reservationHref({ outcome: 'PARTIAL', orderId: ID })).toBe(`/reservas/${ID}`);
  });

  it('pendiente, incierta o fallida se quedan en el checkout', () => {
    expect(reservationHref({ outcome: 'PENDING', orderId: ID })).toBeNull();
    expect(reservationHref({ outcome: 'UNCERTAIN', orderId: ID })).toBeNull();
    expect(reservationHref({ outcome: 'FAILED', orderId: ID })).toBeNull();
    expect(reservationHref({ outcome: 'CONFIRMED' })).toBeNull();
    expect(reservationHref(null)).toBeNull();
  });
});

describe('bookingToast', () => {
  it('confirmada sin novedades: «Reserva creada» en verde', () => {
    expect(bookingToast({ outcome: 'CONFIRMED', orderId: ID })).toEqual({
      tone: 'success',
      title: 'Reserva creada',
    });
  });

  it('lo que no quedó confirmado viaja en el aviso', () => {
    expect(
      bookingToast({
        outcome: 'CONFIRMED',
        orderId: ID,
        seatNotices: ['La aerolínea no confirmó el asiento 12C.'],
      }),
    ).toEqual({
      tone: 'warning',
      title: 'Reserva creada',
      description: 'La aerolínea no confirmó el asiento 12C.',
    });
    expect(bookingToast({ outcome: 'PARTIAL', orderId: ID }).tone).toBe('warning');
  });
});

describe('pasajeros', () => {
  it('nombra cada tipo con su plural', () => {
    expect(paxCountLabel({ adults: 1, children: 0, infants: 0 })).toBe('1 adulto');
    expect(paxCountLabel({ adults: 2, children: 1, infants: 2 })).toBe(
      '2 adultos, 1 niño, 2 infantes',
    );
    expect(totalPassengers({ adults: 2, children: 1, infants: 2 })).toBe(5);
  });
});
