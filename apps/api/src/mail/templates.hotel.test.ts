import { describe, expect, it } from 'vitest';
import { hotelOrderConfirmationEmailHtml, hotelOrderIsNonRefundable } from './templates.js';

/**
 * La confirmación de una reserva de hotel al huésped, con el aviso de tarifa no reembolsable
 * (pedido del founder del 2026-09-29, punto d).
 */

const BASE = {
  orderNumber: 7,
  locator: '1234567',
  searchCriteria: { checkinDate: '2026-11-10', checkoutDate: '2026-11-12' },
  passengers: [
    {
      room: 0,
      guests: [
        { firstName: 'José', lastName: 'Núñez' },
        { firstName: 'Ana', lastName: '<b>Pérez</b>' },
      ],
    },
  ],
  totalAmount: 36000,
  currency: 'USD',
};

describe('hotelOrderIsNonRefundable', () => {
  it('lo que guardó la orden o la política declarada', () => {
    expect(hotelOrderIsNonRefundable({ nonRefundable: { reason: 'declared' } })).toBe(true);
    expect(hotelOrderIsNonRefundable({ roompack: { cancellation: { refundable: false } } })).toBe(
      true,
    );
    expect(
      hotelOrderIsNonRefundable({ roompack: { cancellation: { status: 'non_refundable' } } }),
    ).toBe(true);
    expect(
      hotelOrderIsNonRefundable({
        roompack: { cancellation: { refundable: true, status: 'fully_refundable' } },
      }),
    ).toBe(false);
    expect(hotelOrderIsNonRefundable(null)).toBe(false);
  });
});

describe('hotelOrderConfirmationEmailHtml', () => {
  it('no reembolsable: el recuadro con el 100 % y el asunto que lo dice', () => {
    const mail = hotelOrderConfirmationEmailHtml({
      ...BASE,
      selectedOffer: {
        roompack: { rooms: [{ name: 'Doble' }, { name: 'Twin' }] },
        nonRefundable: { reason: 'declared' },
      },
      brand: { name: 'Agencia Sur', color: '#123456' },
    });
    expect(mail.subject).toBe('Reserva de hotel confirmada #7 · No reembolsable');
    expect(mail.html).toContain('Tarifa no reembolsable');
    expect(mail.html).toMatch(/se cobra el 100 % \(US\$\s?360,00\) y no hay reembolso/);
    expect(mail.html).toContain('Doble · Twin');
    expect(mail.html).toContain('Habitaciones');
    expect(mail.html).toContain('10 nov 2026');
    expect(mail.html).toContain('#123456');
    expect(mail.html).toContain('Enviado por Agencia Sur');
    // El nombre que escribió el vendedor no se interpreta como HTML.
    expect(mail.html).not.toContain('<b>Pérez</b>');
    expect(mail.html).toContain('&lt;b&gt;Pérez&lt;/b&gt;');
    expect(mail.text).toContain('TARIFA NO REEMBOLSABLE');
    expect(mail.text).toContain('Localizador 1234567');
  });

  it('reembolsable y sin localizador ni habitaciones: sin el aviso ni esos renglones', () => {
    const mail = hotelOrderConfirmationEmailHtml({
      ...BASE,
      locator: null,
      searchCriteria: {},
      passengers: [],
      selectedOffer: {
        checkinDate: '2026-11-10',
        roompack: { rooms: [{ name: 'Doble' }], cancellation: { refundable: true } },
      },
    });
    expect(mail.subject).toBe('Reserva de hotel confirmada #7');
    expect(mail.html).not.toContain('no reembolsable');
    expect(mail.html).not.toContain('Localizador');
    expect(mail.html).toContain('Habitación');
    expect(mail.html).toContain('Según la política de la reserva');
    expect(mail.html).toContain('Enviado por tu agencia');
    expect(mail.text).not.toContain('Salida');
  });

  it('el 100 % sale con sus centavos: el monto exacto, no redondeado', () => {
    const mail = hotelOrderConfirmationEmailHtml({
      ...BASE,
      totalAmount: 32_134,
      selectedOffer: { nonRefundable: { reason: 'declared' } },
    });
    expect(mail.html).toMatch(/se cobra el 100 % \(US\$\s?321,34\)/);
    expect(mail.text).toMatch(/Total: US\$\s?321,34/);
  });

  it('una fecha que no es de calendario sale tal cual', () => {
    const mail = hotelOrderConfirmationEmailHtml({
      ...BASE,
      searchCriteria: { checkinDate: 'pronto', checkoutDate: '2026-11-12' },
      selectedOffer: {},
    });
    expect(mail.html).toContain('pronto');
  });
});
