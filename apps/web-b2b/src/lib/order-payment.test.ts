import { describe, expect, it } from 'vitest';
import {
  PAYMENT_MESSAGES,
  accountPaymentBody,
  choiceKind,
  choiceLabel,
  defaultPaymentMethod,
  errorMessageOf,
  linkSentMessage,
  normalizeEmail,
  parsePaymentOptions,
  paymentLinkBody,
  paymentLinkOutcomeOf,
  payOutcomeOf,
  type OrderPaymentMethod,
} from './order-payment';

const CARD = {
  code: 'card',
  use: 'order-pay',
  label: 'Tarjeta digitada en la plataforma',
  description: 'Fuera de PCI SAQ-A.',
  pci: 'out-of-scope',
};
const CASH = {
  code: 'cash',
  use: 'order-pay',
  label: 'Efectivo / BSP',
  description: 'Pago de agencia.',
  pci: 'none',
};
const GOV = { code: 'gov', use: 'order-pay', label: 'GOV', description: '', pci: 'none' };
const LINK = {
  code: 'payment_link',
  use: 'order-payment-link',
  label: 'Enlace de pago LATAM',
  description: 'LATAM le envía al pagador un enlace.',
  pci: 'saq-a',
};

function methods(...raw: unknown[]): readonly OrderPaymentMethod[] {
  return parsePaymentOptions({ provider: 'latam-ndc', methods: raw })!.methods;
}

describe('parsePaymentOptions', () => {
  it('ordena: enlace, efectivo, GOV y la tarjeta al final', () => {
    const parsed = parsePaymentOptions({ provider: 'latam-ndc', methods: [CARD, GOV, CASH, LINK] });
    expect(parsed?.provider).toBe('latam-ndc');
    expect(parsed?.methods.map((m) => m.code)).toEqual(['payment_link', 'cash', 'gov', 'card']);
  });

  it('descarta lo que la pantalla no sabe cobrar, usos de otro momento y duplicados', () => {
    const parsed = methods(
      CASH,
      { ...CASH, label: 'otra vez' },
      { code: 'on_account', use: 'ticket-issue', label: 'A cuenta', description: '', pci: 'none' },
      { code: 'bitcoin', use: 'order-pay', label: 'BTC', description: '', pci: 'none' },
      { code: 'other_link', use: 'order-payment-link', label: 'X', description: '', pci: 'saq-a' },
      'basura',
      null,
    );
    expect(parsed.map((m) => m.code)).toEqual(['cash']);
    expect(parsed[0]?.label).toBe('Efectivo / BSP');
  });

  it('una lista vacía es una respuesta válida: nada habilitado', () => {
    expect(parsePaymentOptions({ provider: 'sabre', methods: [] })).toEqual({
      provider: 'sabre',
      methods: [],
    });
  });

  it('sin lista no se puede leer', () => {
    expect(parsePaymentOptions(null)).toBeNull();
    expect(parsePaymentOptions({ provider: 'x' })).toBeNull();
    expect(parsePaymentOptions([])).toBeNull();
  });

  it('un alcance PCI desconocido no se inventa como fuera de alcance', () => {
    expect(methods({ ...CASH, pci: 'raro' })[0]?.pci).toBe('none');
  });
});

describe('forma por defecto y etiquetas', () => {
  it('la primera es la que menos expone la tarjeta', () => {
    expect(defaultPaymentMethod(methods(CARD, CASH))).toBe('cash');
    expect(defaultPaymentMethod(methods(CARD, LINK))).toBe('payment_link');
    expect(defaultPaymentMethod(methods(CARD))).toBe('card');
    expect(defaultPaymentMethod([])).toBeNull();
  });

  it('cada forma tiene su etiqueta y su formulario', () => {
    const [link, cash, gov, card] = methods(LINK, CASH, GOV, CARD);
    expect([link, cash, gov, card].map((m) => choiceLabel(m!))).toEqual([
      'Enviar enlace de pago',
      'Efectivo / BSP',
      'GOV',
      'Tarjeta',
    ]);
    expect([link, cash, gov, card].map((m) => choiceKind(m!))).toEqual([
      'link',
      'account',
      'account',
      'card',
    ]);
  });
});

describe('correo del enlace', () => {
  it('recorta y valida', () => {
    expect(normalizeEmail('  ana@correo.com ')).toBe('ana@correo.com');
    expect(paymentLinkBody(' ana@correo.com')).toEqual({ email: 'ana@correo.com' });
  });

  it('rechaza lo que no es un correo', () => {
    for (const raw of ['', '   ', 'ana', 'ana@', 'ana@correo', 'a b@c.co', 42, null]) {
      expect(normalizeEmail(raw)).toBeNull();
    }
    expect(normalizeEmail(`${'a'.repeat(250)}@c.co`)).toBeNull();
    expect(paymentLinkBody('nope')).toBeNull();
  });

  it('el mensaje de enviado dice a quién y qué hacer después', () => {
    expect(linkSentMessage('ana@correo.com')).toBe(
      'Enlace enviado a ana@correo.com. Cuando el cliente pague, usa «Consultar estado» para ver la reserva emitida.',
    );
  });
});

describe('accountPaymentBody', () => {
  const order = { totalAmount: 34012, currency: 'USD' };

  it('efectivo y GOV pagan el total de la orden, sin tarjeta', () => {
    expect(accountPaymentBody('cash', order)).toEqual({
      payment: { type: 'Cash', amount: 34012, currency: 'USD' },
    });
    expect(accountPaymentBody('gov', order)).toEqual({
      payment: { type: 'GOV', amount: 34012, currency: 'USD' },
    });
  });

  it('la tarjeta y lo desconocido no se arman aquí', () => {
    expect(accountPaymentBody('card', order)).toBeNull();
    expect(accountPaymentBody('payment_link', order)).toBeNull();
  });
});

describe('respuestas del API', () => {
  it('enlace enviado', () => {
    expect(
      paymentLinkOutcomeOf(201, { success: true, warnings: ['w1', { message: 'w2' }] }),
    ).toEqual({ ok: true, warnings: ['w1', 'w2'] });
  });

  it('el proveedor no lo envió', () => {
    expect(paymentLinkOutcomeOf(200, { success: false, error: 'Correo rechazado' })).toEqual({
      ok: false,
      message: 'Correo rechazado',
    });
    expect(paymentLinkOutcomeOf(200, { success: false })).toEqual({
      ok: false,
      message: PAYMENT_MESSAGES.sendFailed,
    });
  });

  it('403 y 409 llegan con su texto', () => {
    const habilitar = 'La forma de pago payment_link no está habilitada para tu red.';
    expect(paymentLinkOutcomeOf(403, { statusCode: 403, message: habilitar })).toEqual({
      ok: false,
      message: habilitar,
    });
    expect(
      paymentLinkOutcomeOf(409, {
        statusCode: 409,
        message: 'Sólo se envía enlace de pago a una reserva sin pagar.',
      }),
    ).toEqual({ ok: false, message: 'Sólo se envía enlace de pago a una reserva sin pagar.' });
  });

  it('un 403 genérico de Nest se dice en tú', () => {
    expect(paymentLinkOutcomeOf(403, { statusCode: 403, message: 'Forbidden' })).toEqual({
      ok: false,
      message: PAYMENT_MESSAGES.forbidden,
    });
    expect(payOutcomeOf(403, {})).toEqual({ ok: false, message: PAYMENT_MESSAGES.forbidden });
  });

  it('pago aceptado, con el estado nuevo si vino', () => {
    expect(payOutcomeOf(200, { success: true, status: 'ticketed' })).toEqual({
      ok: true,
      warnings: [],
      status: 'ticketed',
    });
    expect(payOutcomeOf(200, { success: true })).toEqual({ ok: true, warnings: [] });
  });

  it('pago rechazado: el error del proxy de /pay', () => {
    expect(payOutcomeOf(403, { error: 'Cash no está habilitada.' })).toEqual({
      ok: false,
      message: 'Cash no está habilitada.',
    });
    expect(payOutcomeOf(502, 'x')).toEqual({ ok: false, message: PAYMENT_MESSAGES.payFailed });
  });

  it('los mensajes de validación en lista se juntan', () => {
    expect(errorMessageOf({ message: ['email must be an email', ' '] })).toBe(
      'email must be an email',
    );
    expect(errorMessageOf('texto')).toBeNull();
  });
});
