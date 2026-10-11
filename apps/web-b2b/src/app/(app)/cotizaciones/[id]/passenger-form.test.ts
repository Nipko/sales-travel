import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildEmptyPassengers, PassengerForm } from './passenger-form';
import { PaymentForm } from './payment-form';

describe('buildEmptyPassengers', () => {
  it('asigna el índice global que Sabre Offer Price usa en orden ADT → CHD → INF', () => {
    const passengers = buildEmptyPassengers({ adults: 2, children: 1, infants: 1 });

    expect(
      passengers.map(({ paxType, requestedTravelerIndex }) => ({
        paxType,
        requestedTravelerIndex,
      })),
    ).toEqual([
      { paxType: 'ADT', requestedTravelerIndex: 0 },
      { paxType: 'ADT', requestedTravelerIndex: 1 },
      { paxType: 'CHD', requestedTravelerIndex: 2 },
      { paxType: 'INF', requestedTravelerIndex: 3 },
    ]);
  });
});

/*
 * D1: la plataforma nunca recibe un PAN ni un CVV. createOrder no cobra y el API rechaza
 * `payment` (`orders/dto.ts`, schema strict), así que el checkout de vuelos no puede tener ni un
 * campo capaz de recibir una tarjeta. Había uno escondido detrás de `paymentSupported`, una prop
 * que nadie pasaba: código muerto que bastaba con encender para que un PAN viajara al servidor.
 */

/** Rastros de un formulario de tarjeta en el HTML pintado. */
const CARD_MARKERS: readonly RegExp[] = [
  /autocomplete="cc-/i,
  /tarjeta/i,
  /\bcvv\b/i,
  /c[oó]digo de seguridad/i,
  /datos de pago/i,
  /pagar ahora/i,
];

function cardTraces(html: string): string[] {
  return CARD_MARKERS.filter((re) => re.test(html)).map((re) => re.source);
}

function renderCheckout(paxCount = { adults: 2, children: 1, infants: 1 }): string {
  return renderToStaticMarkup(
    createElement(PassengerForm, {
      paxCount,
      customerName: 'Juan Carlos Pérez Gómez',
      contactEmail: 'juan@example.com',
      contactPhone: '3001234567',
      onSubmit: async () => {},
    }),
  );
}

describe('PassengerForm — el checkout de vuelos no pide tarjeta (D1)', () => {
  it('no pinta ningún campo de tarjeta', () => {
    expect(cardTraces(renderCheckout())).toEqual([]);
  });

  it('CONTROL: el detector sí ve el formulario de tarjeta que había', () => {
    const tarjeta = renderToStaticMarkup(
      createElement(PaymentForm, {
        totalAmountMinor: 120_000,
        currency: 'USD',
        onPaymentChange: () => {},
      }),
    );
    expect(cardTraces(tarjeta)).toEqual(
      expect.arrayContaining(['autocomplete="cc-', 'tarjeta', '\\bcvv\\b']),
    );
  });

  it('dice que la reserva sale sin cobro y que el pago y la emisión se hacen en Reservas', () => {
    const html = renderCheckout({ adults: 1, children: 0, infants: 0 });
    expect(html).toContain('Pago y emisión');
    expect(html).toContain('Reserva sin cobro');
    expect(html).toContain('El pago y la emisión se hacen después desde');
    expect(html).toMatch(/<button[^>]*>.*Crear reserva<\/button>/);
    expect(html).not.toContain('BNPL');
  });

  it('el único campo de teclado numérico es la fecha de nacimiento', () => {
    const html = renderCheckout({ adults: 1, children: 0, infants: 0 });
    const numericos = html.match(/<input[^>]*inputmode="numeric"[^>]*>/gi) ?? [];
    expect(numericos).toHaveLength(1);
    expect(numericos[0]).toMatch(/autocomplete="bday"/i);
  });

  it('ni el formulario ni la página del checkout importan el formulario de tarjeta', () => {
    for (const file of ['./passenger-form.tsx', './page.tsx']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source, file).not.toMatch(/payment-form/);
      expect(source, file).not.toMatch(/\bpayment\s*[?:]|body\.payment/);
    }
  });
});
