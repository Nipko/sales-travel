import { describe, expect, it } from 'vitest';
import {
  TEST_CONTENT_NOTICE,
  TEST_CONTENT_SUBJECT_PREFIX,
  orderConfirmationEmailHtml,
} from './templates.js';

/**
 * La confirmación de una reserva de vuelo cuando es de la cuenta de pruebas del proveedor: sólo
 * sale si el vendedor la reenvía, y tiene que decirlo en el asunto, en el HTML y en el texto plano.
 */

const BASE = {
  orderNumber: 12,
  pnr: 'ABC123',
  searchCriteria: { origin: 'BOG', destination: 'LIM', departureDate: '2026-12-01' },
  passengers: [{ givenName: 'Ana', surname: 'Ríos' }],
  totalAmount: 50_000,
  currency: 'USD',
};

describe('orderConfirmationEmailHtml — reserva de prueba', () => {
  it('lleva el prefijo en el asunto y el aviso arriba del cuerpo', () => {
    const mail = orderConfirmationEmailHtml({ ...BASE, testContent: true });

    expect(TEST_CONTENT_SUBJECT_PREFIX).toBe('[PRUEBA] ');
    expect(mail.subject).toBe('[PRUEBA] Reserva registrada #12 · PNR ABC123');
    expect(mail.html).toContain('Reserva de prueba: no es un tiquete válido para viajar.');
    // Antes que el PNR: quien abra el correo lee primero que no le sirve para viajar.
    expect(mail.html.indexOf(TEST_CONTENT_NOTICE)).toBeLessThan(mail.html.indexOf('ABC123'));
    expect(mail.text.startsWith(`${TEST_CONTENT_NOTICE}\n\n`)).toBe(true);
  });

  it('también con el billete emitido', () => {
    const mail = orderConfirmationEmailHtml({ ...BASE, ticketed: true, testContent: true });

    expect(mail.subject.startsWith('[PRUEBA] Billete emitido')).toBe(true);
    expect(mail.html).toContain(TEST_CONTENT_NOTICE);
  });

  it('una reserva real no cambia: sin prefijo ni aviso', () => {
    for (const mail of [
      orderConfirmationEmailHtml(BASE),
      orderConfirmationEmailHtml({ ...BASE, testContent: false }),
    ]) {
      expect(mail.subject).toBe('Reserva registrada #12 · PNR ABC123');
      expect(mail.html).not.toContain(TEST_CONTENT_NOTICE);
      expect(mail.text).not.toContain(TEST_CONTENT_NOTICE);
    }
  });
});
