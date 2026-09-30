import { describe, expect, it } from 'vitest';
import type { CarRateDetail, CarSelection } from '../actions';
import {
  SESSION_TTL_MS,
  bookingStatusView,
  canHold,
  checkDriver,
  countdownLabel,
  holdDeadlineLabel,
  priceBreakdown,
  sessionRemainingMs,
  sessionTone,
  youngDriver,
} from './car-checkout-model';

const usd = (major: number) => ({ amountMinor: Math.round(major * 100), currency: 'USD' });

describe('la sesión de la tarifa (15 min)', () => {
  it('cuenta hacia atrás y avisa en los últimos dos minutos', () => {
    const t0 = 1_000_000;
    expect(sessionRemainingMs(t0, t0)).toBe(SESSION_TTL_MS);
    expect(sessionTone(sessionRemainingMs(t0, t0 + 60_000))).toBe('ok');
    expect(sessionTone(sessionRemainingMs(t0, t0 + 13.5 * 60_000))).toBe('warning');
    expect(sessionTone(sessionRemainingMs(t0, t0 + 16 * 60_000))).toBe('expired');
    expect(sessionRemainingMs(t0, t0 + 20 * 60_000)).toBe(0);
  });

  it('"m:ss", redondeando hacia arriba', () => {
    expect(countdownLabel(SESSION_TTL_MS)).toBe('15:00');
    expect(countdownLabel(61_500)).toBe('1:02');
    expect(countdownLabel(400)).toBe('0:01');
    expect(countdownLabel(0)).toBe('0:00');
  });
});

describe('checkDriver', () => {
  const ok = { firstName: 'Ana', lastName: 'García', email: 'ana@example.com', age: '30' };

  it('completo, sin observaciones', () => {
    expect(checkDriver(ok)).toEqual({});
  });

  it('cada campo con su motivo, en "tú"', () => {
    const issues = checkDriver({ firstName: ' ', lastName: '', email: 'ana@', age: '17' });
    expect(Object.keys(issues).sort()).toEqual(['age', 'email', 'firstName', 'lastName']);
    expect(issues.lastName).toContain('se consulta y se cancela');
    for (const msg of Object.values(issues)) expect(msg).not.toMatch(/Escribí|Ingresá/);
  });

  it('edad fuera de rango o no numérica', () => {
    expect(checkDriver({ ...ok, age: '100' }).age).toBeDefined();
    expect(checkDriver({ ...ok, age: '3a' }).age).toBeDefined();
    expect(checkDriver({ ...ok, age: '18' }).age).toBeUndefined();
  });

  it('conductor joven: aviso de recargo', () => {
    expect(youngDriver('22')).toBe(true);
    expect(youngDriver('25')).toBe(false);
    expect(youngDriver('')).toBe(false);
  });
});

describe('priceBreakdown', () => {
  const selection: Pick<CarSelection, 'pricing' | 'rateAmount' | 'tax'> = {
    rateAmount: usd(131.92),
    tax: usd(11.92),
    pricing: {
      costMinor: usd(131.92).amountMinor,
      finalMinor: usd(151.92).amountMinor,
      ownMarkupMinor: usd(20).amountMinor,
      currency: 'USD',
    },
  };
  const detail: CarRateDetail = {
    base: usd(120),
    tax: usd(11.92),
    charges: [
      { code: '1', name: 'CRF - CONCESSION RECOUP FEE', amount: usd(2.3) },
      { code: '2', name: ' ', amount: usd(1) },
    ],
  };

  it('prepago: el mostrador pasa tal cual y el markup va en lo que se cobra al reservar', () => {
    const b = priceBreakdown(selection, detail, 'ppd');
    expect(b.sale).toEqual(usd(151.92));
    expect(b.atCounter).toEqual(usd(11.92));
    expect(b.payNow).toEqual(usd(140));
    expect(b.ownMargin).toEqual(usd(20));
    expect(b.cost).toEqual(usd(131.92));
    expect(b.counterCharges).toEqual([{ name: 'CRF - CONCESSION RECOUP FEE', amount: usd(2.3) }]);
  });

  it('nunca muestra el neto del proveedor', () => {
    const b = priceBreakdown(selection, detail, 'ppd');
    expect(Object.values(b)).not.toContainEqual(usd(120));
  });

  it('pago en destino: todo en el mostrador, sin reparto', () => {
    const b = priceBreakdown(selection, detail, 'pod');
    expect(b.payNow).toBeUndefined();
    expect(b.atCounter).toBeUndefined();
    expect(b.sale).toEqual(usd(151.92));
  });

  it('sin reglas de precio: venta = neto, sin costo ni margen', () => {
    const b = priceBreakdown({ rateAmount: usd(100), tax: usd(0) }, null, 'ppd');
    expect(b).toEqual({ sale: usd(100), counterCharges: [] });
  });
});

describe('reserva en espera', () => {
  const now = new Date(Date.UTC(2026, 8, 30, 13, 0, 0)); // 08:00 en Bogotá

  it('sólo con más de 48 h al retiro', () => {
    expect(canHold({ pickUpDate: '2026-10-02', pickUpHour: '09:00' }, now, 'America/Bogota')).toBe(
      true,
    );
    expect(canHold({ pickUpDate: '2026-10-02', pickUpHour: '07:30' }, now, 'America/Bogota')).toBe(
      false,
    );
  });

  it('el plazo para activarla es 48 h antes del retiro', () => {
    expect(holdDeadlineLabel({ pickUpDate: '2026-10-22', pickUpHour: '1000' })).toBe(
      'mar 20 oct · 10:00',
    );
  });
});

describe('bookingStatusView', () => {
  it('confirmada: el voucher en prepago, el mostrador en destino', () => {
    expect(bookingStatusView('confirmed', 'ppd', 'x').note).toContain('voucher');
    expect(bookingStatusView('confirmed', 'pod', 'x').note).toContain('mostrador');
    expect(bookingStatusView('confirmed', 'ppd', 'x').tone).toBe('success');
  });

  it('en espera: con el plazo para activarla', () => {
    const view = bookingStatusView('on_hold', 'ppd', 'mar 20 oct · 10:00');
    expect(view.tone).toBe('warning');
    expect(view.note).toContain('mar 20 oct · 10:00');
  });

  it('a confirmar: que no se le avise al cliente todavía', () => {
    expect(bookingStatusView('on_request', 'ppd', 'x').note).toContain('antes de avisarle');
  });
});
