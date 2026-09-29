import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  BookingHoldRejectedError,
  decideBookingHold,
  type BookingHoldFacts,
} from './booking-hold.js';

/**
 * Las reglas de la retención antes del Book (docs/tbo/08 RF-23; D-TBO-21 A), sin base de datos. El
 * tope es uno: el saldo más el cupo de la cartera en la moneda de la tarifa, que fija quien financia
 * a la agencia (db/migrations/0052). El crédito interno de 0007 ya no participa (0053).
 */

const USD = (amountMinor: number) => ({ amountMinor, currency: 'USD' });

type Cartera = NonNullable<BookingHoldFacts['portfolio']>;

function facts(overrides: Partial<BookingHoldFacts> = {}): BookingHoldFacts {
  return {
    amount: USD(34_012),
    portfolio: { balanceMinor: 0, creditLimitMinor: 0, currency: 'USD', status: 'active' },
    ...overrides,
  };
}

function cartera(balanceMinor: number, creditLimitMinor: number, extra: Partial<Cartera> = {}) {
  return { balanceMinor, creditLimitMinor, currency: 'USD', status: 'active', ...extra };
}

describe('decideBookingHold: el saldo más el cupo de la cartera de esa moneda', () => {
  it.each([
    ['el saldo solo', 34_012, 0],
    ['el saldo más el cupo', 10_000, 24_012],
    ['el cupo solo, con saldo negativo', -5_000, 39_012],
  ])('alcanza con %s', (_caso, balance, cupo) => {
    expect(decideBookingHold(facts({ portfolio: cartera(balance, cupo) }))).toEqual({
      ok: true,
      creditMinor: cupo,
    });
  });

  it('un centavo menos no alcanza', () => {
    expect(decideBookingHold(facts({ portfolio: cartera(10_000, 24_011) }))).toEqual({
      ok: false,
      reason: 'PORTFOLIO_FUNDS_INSUFFICIENT',
    });
  });

  it('un cupo negativo o corrupto no da crédito: falla cerrado', () => {
    for (const cupo of [-50_000, Number.NaN, 1.5]) {
      expect(decideBookingHold(facts({ portfolio: cartera(34_011, cupo) }))).toMatchObject({
        ok: false,
      });
    }
  });

  it('una cartera suspendida no retiene, aunque le sobre saldo', () => {
    expect(
      decideBookingHold(facts({ portfolio: cartera(1_000_000, 0, { status: 'suspended' }) })),
    ).toEqual({ ok: false, reason: 'PORTFOLIO_INACTIVE' });
  });

  it('sin cartera en la moneda de la tarifa no se reserva, y eso se dice antes que el saldo', () => {
    expect(decideBookingHold(facts({ portfolio: null }))).toEqual({
      ok: false,
      reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED',
    });
  });

  it('no convierte monedas: una cartera en COP cuenta como ninguna para una reserva en USD', () => {
    expect(
      decideBookingHold(facts({ portfolio: cartera(1_000_000_000, 0, { currency: 'COP' }) })),
    ).toEqual({ ok: false, reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED' });
  });
});

describe('BookingHoldRejectedError', () => {
  it.each([
    [
      'PORTFOLIO_CURRENCY_NOT_ENABLED',
      'La agencia no tiene cartera en USD: pedile a quien te financia que la habilite.',
    ],
    ['PORTFOLIO_FUNDS_INSUFFICIENT', 'Informá un depósito en Cartera B2B'],
    ['PORTFOLIO_INACTIVE', 'está suspendida'],
  ] as const)('%s: 409 con motivo y mensaje de negocio, sin importes', (reason, texto) => {
    const err = new BookingHoldRejectedError(reason, { amountCurrency: 'USD' });

    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.reason).toBe(reason);
    expect(err.message).toContain(texto);
    // Ningún importe: los únicos dígitos admitidos son los de un nombre, como Cartera B2B.
    expect(err.message).not.toMatch(/(?<![A-Z])\d/);
  });
});
