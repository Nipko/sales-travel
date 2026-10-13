import { describe, expect, it } from 'vitest';
import {
  TEST_CONTENT_NOTICE,
  TEST_CONTENT_SUBJECT_PREFIX,
  TEST_QUOTE_NOTICE,
  orderConfirmationEmailHtml,
  quotationEmailHtml,
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

describe('quotationEmailHtml — tarifa de una cuenta de pruebas', () => {
  const COTIZACION = {
    quoteNumber: 31,
    customerName: 'Ana',
    searchCriteria: { origin: 'BOG', destination: 'LIM', departureDate: '2026-12-01' },
    selectedOffer: { total: { amountMinor: 50_000, currency: 'USD' } },
  };

  it('el cliente la recibe marcada en el asunto, arriba del cuerpo y en el texto plano', () => {
    const mail = quotationEmailHtml({ ...COTIZACION, testContent: true });

    expect(mail.subject).toBe('[PRUEBA] Tu cotización de vuelo #31 · BOG → LIM');
    expect(mail.html).toContain(TEST_QUOTE_NOTICE);
    expect(mail.html.indexOf(TEST_QUOTE_NOTICE)).toBeLessThan(mail.html.indexOf('Hola Ana'));
    expect(mail.text.startsWith(`${TEST_QUOTE_NOTICE}\n\nCotización #31`)).toBe(true);
  });

  it('una cotización real no cambia', () => {
    for (const mail of [
      quotationEmailHtml(COTIZACION),
      quotationEmailHtml({ ...COTIZACION, testContent: false }),
    ]) {
      expect(mail.subject).toBe('Tu cotización de vuelo #31 · BOG → LIM');
      expect(mail.html).not.toContain(TEST_QUOTE_NOTICE);
      expect(mail.text.startsWith('Cotización #31')).toBe(true);
    }
  });
});
