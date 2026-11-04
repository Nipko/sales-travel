import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_MESSAGES,
  parsePaymentOptions,
  type OrderPaymentOptions,
} from '../../../../lib/order-payment';
import { OrderPaymentDialog, type OrderPaymentOrder } from './order-payment-dialog';

/*
 * El diálogo de «Pagar» en su primer pintado: sólo las formas que el gobierno habilitó, la primera
 * elegida, y sin ninguna, a quién pedirlas y sin botón de pagar.
 */

const ORDEN: OrderPaymentOrder = {
  id: 'o-1',
  orderNumber: 12,
  totalAmount: 34012,
  currency: 'USD',
  contactInfo: { email: 'ana@correo.com' },
  searchCriteria: { origin: 'BOG', destination: 'LIM' },
};

const LINK = {
  code: 'payment_link',
  use: 'order-payment-link',
  label: 'Enlace de pago LATAM',
  description: 'LATAM le envía al pagador un enlace para pagar en su sitio.',
  pci: 'saq-a',
};
const CASH = {
  code: 'cash',
  use: 'order-pay',
  label: 'Efectivo / BSP',
  description: 'Pago de agencia (Cash), liquidado por BSP.',
  pci: 'none',
};
const GOV = { code: 'gov', use: 'order-pay', label: 'GOV', description: '', pci: 'none' };
const CARD = {
  code: 'card',
  use: 'order-pay',
  label: 'Tarjeta digitada en la plataforma',
  description: 'Fuera de PCI SAQ-A.',
  pci: 'out-of-scope',
};

function opciones(...methods: unknown[]): OrderPaymentOptions {
  return parsePaymentOptions({ provider: 'latam-ndc', methods })!;
}

function pintar(initialOptions?: OrderPaymentOptions, order: OrderPaymentOrder = ORDEN): string {
  return renderToStaticMarkup(
    createElement(OrderPaymentDialog, {
      order,
      onClose: () => undefined,
      onPaid: () => undefined,
      onLinkSent: () => undefined,
      ...(initialOptions ? { initialOptions } : {}),
    }),
  );
}

describe('OrderPaymentDialog', () => {
  it('al abrir busca las formas habilitadas y no ofrece pagar todavía', () => {
    const html = pintar();

    expect(html).toContain('Pagar reserva #12');
    expect(html).toContain('BOG → LIM');
    expect(html).toContain('340,12');
    expect(html).toContain(PAYMENT_MESSAGES.loading);
    expect(html).not.toContain('Confirmar pago');
    expect(html).toMatch(/role="dialog"/);
  });

  it('sin formas habilitadas dice a quién pedirlas y no hay botón de pagar', () => {
    const html = pintar(opciones());

    expect(html).toContain(PAYMENT_MESSAGES.none);
    expect(html).not.toContain('Confirmar pago');
    expect(html).not.toContain('Enviar enlace');
    expect(html).toContain('>Cancelar<');
  });

  it('ofrece cada forma habilitada como opción, con el enlace elegido primero', () => {
    const html = pintar(opciones(CARD, GOV, CASH, LINK));

    const orden = ['Enviar enlace de pago', 'Efectivo / BSP', '>GOV<', '>Tarjeta<'].map((t) =>
      html.indexOf(t),
    );
    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*value="payment_link"/);
    expect(html).not.toMatch(/<input type="radio"[^>]*checked=""[^>]*value="card"/);
  });

  it('el enlace pide el correo, con el del contacto ya puesto, y explica que la tarjeta no pasa', () => {
    const html = pintar(opciones(LINK, CASH));

    expect(html).toContain('Correo del pagador');
    expect(html).toContain('value="ana@correo.com"');
    expect(html).toContain(PAYMENT_MESSAGES.linkExplain);
    expect(html).toContain('Enviar enlace');
    expect(html).not.toContain('Número de tarjeta');
  });

  it('efectivo sin tarjeta: sólo confirma el total', () => {
    const html = pintar(opciones(CASH, CARD));

    expect(html).toContain(PAYMENT_MESSAGES.accountNote);
    expect(html).toContain('Confirmar pago');
    expect(html).not.toContain('Número de tarjeta');
    expect(html).not.toContain('Correo del pagador');
  });

  it('la tarjeta digitada avisa que queda fuera de PCI SAQ-A', () => {
    const html = pintar(opciones(CARD));

    expect(html).toContain('Número de tarjeta');
    expect(html).toContain(PAYMENT_MESSAGES.cardOutOfScope);
    // Sin la tarjeta completa, el botón no se puede apretar.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Confirmar pago/s);
  });

  it('sin correo de contacto el campo arranca vacío y el envío deshabilitado', () => {
    const html = pintar(opciones(LINK), { ...ORDEN, contactInfo: {} });

    expect(html).toMatch(/<input[^>]*type="email"[^>]*value=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Enviar enlace/s);
  });
});

describe('Reservas paga con el diálogo gobernado', () => {
  const page = readFileSync(fileURLToPath(new URL('../page.tsx', import.meta.url)), 'utf8');

  it('usa el diálogo y ya no arma el pago con tarjeta por su cuenta', () => {
    expect(page).toContain('<OrderPaymentDialog');
    expect(page).not.toContain('<PaymentForm');
    expect(page).not.toContain('handlePaySubmit');
  });
});
