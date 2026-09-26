import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  BookingHoldRejectedError,
  decideBookingHold,
  internalCreditMinor,
  type BookingHoldFacts,
} from './booking-hold.js';

/**
 * Las reglas de la retención antes del Book (docs/tbo/08 RF-23; D-TBO-21 A), sin base de datos.
 */

const USD = (amountMinor: number) => ({ amountMinor, currency: 'USD' });

function facts(overrides: Partial<BookingHoldFacts> = {}): BookingHoldFacts {
  return {
    amount: USD(34_012),
    portfolio: { balanceMinor: 0, creditLimitMinor: 0, currency: 'USD', status: 'active' },
    ...overrides,
  };
}

function cartera(
  balanceMinor: number,
  creditLimitMinor: number,
  extra: Partial<BookingHoldFacts['portfolio']> = {},
): BookingHoldFacts['portfolio'] {
  return { balanceMinor, creditLimitMinor, currency: 'USD', status: 'active', ...extra };
}

describe('decideBookingHold con la cuenta propia: sólo la cartera', () => {
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

  it('una cartera inactiva no retiene, aunque le sobre saldo', () => {
    expect(
      decideBookingHold(facts({ portfolio: cartera(1_000_000, 0, { status: 'suspended' }) })),
    ).toEqual({ ok: false, reason: 'PORTFOLIO_INACTIVE' });
  });

  it('no convierte monedas: una cartera en COP no retiene una reserva en USD', () => {
    for (const currency of ['COP', null]) {
      expect(
        decideBookingHold(facts({ portfolio: cartera(1_000_000_000, 0, { currency }) })),
      ).toEqual({ ok: false, reason: 'PORTFOLIO_CURRENCY_MISMATCH' });
    }
  });
});

describe('decideBookingHold con la cuenta heredada: además, el crédito interno (RF-23 CA-1)', () => {
  it('CA-1: sin crédito interno, la sub-agencia sólo reserva con saldo, aunque su cartera declare cupo', () => {
    const sinCredito = facts({
      portfolio: cartera(0, 10_000_000),
      internalCredit: { limitMinor: 0, currency: 'USD' },
    });

    expect(decideBookingHold(sinCredito)).toEqual({
      ok: false,
      reason: 'INTERNAL_CREDIT_INSUFFICIENT',
    });
    expect(decideBookingHold({ ...sinCredito, portfolio: cartera(34_012, 10_000_000) })).toEqual({
      ok: true,
      creditMinor: 0,
    });
  });

  it('el cupo efectivo es el MENOR: la agencia no se amplía el crédito de su red editando la cartera', () => {
    const f = facts({
      portfolio: cartera(-20_000, 10_000_000),
      internalCredit: { limitMinor: 50_000, currency: 'USD' },
    });

    expect(decideBookingHold(f)).toEqual({ ok: false, reason: 'INTERNAL_CREDIT_INSUFFICIENT' });
    expect(decideBookingHold({ ...f, portfolio: cartera(-15_988, 10_000_000) })).toEqual({
      ok: true,
      creditMinor: 50_000,
    });
  });

  it('si el tope que no alcanza es el de la cartera, lo dice la cartera', () => {
    expect(
      decideBookingHold(
        facts({
          portfolio: cartera(0, 20_000),
          internalCredit: { limitMinor: 1_000_000, currency: 'USD' },
        }),
      ),
    ).toEqual({ ok: false, reason: 'PORTFOLIO_FUNDS_INSUFFICIENT' });
  });

  it('un crédito interno en otra moneda no se convierte: vale cero', () => {
    const f = facts({
      portfolio: cartera(0, 1_000_000),
      internalCredit: { limitMinor: 1_000_000_000, currency: 'COP' },
    });

    expect(decideBookingHold(f)).toEqual({ ok: false, reason: 'INTERNAL_CREDIT_INSUFFICIENT' });
    expect(
      decideBookingHold({ ...f, internalCredit: { limitMinor: 1_000_000_000, currency: null } }),
    ).toEqual({ ok: false, reason: 'INTERNAL_CREDIT_INSUFFICIENT' });
  });

  it('la cartera inactiva o en otra moneda se dice antes que el crédito', () => {
    const interno = { limitMinor: 0, currency: 'USD' };
    expect(
      decideBookingHold(
        facts({ portfolio: cartera(0, 0, { status: 'suspended' }), internalCredit: interno }),
      ),
    ).toEqual({ ok: false, reason: 'PORTFOLIO_INACTIVE' });
    expect(
      decideBookingHold(
        facts({ portfolio: cartera(0, 0, { currency: 'COP' }), internalCredit: interno }),
      ),
    ).toEqual({ ok: false, reason: 'PORTFOLIO_CURRENCY_MISMATCH' });
  });
});

describe('internalCreditMinor: `tenants.credit_limit` NUMERIC(14,2) en unidades menores', () => {
  it.each([
    ['1500.00', 150_000],
    ['1500.5', 150_050],
    ['1500', 150_000],
    ['0.01', 1],
    [' 250.75 ', 25_075],
    ['999999999999.99', 99_999_999_999_999],
    [1500.25, 150_025],
  ])('%j → %i', (valor, minor) => {
    expect(internalCreditMinor(valor)).toBe(minor);
  });

  it.each([['-10.00'], ['1e6'], ['abc'], [''], ['1.234'], [null], [undefined], [Number.NaN]])(
    '%j no da crédito',
    (valor) => {
      expect(internalCreditMinor(valor)).toBe(0);
    },
  );
});

describe('BookingHoldRejectedError', () => {
  it.each([
    ['INTERNAL_CREDIT_INSUFFICIENT', 'crédito interno'],
    ['PORTFOLIO_FUNDS_INSUFFICIENT', 'Cargá saldo'],
    ['PORTFOLIO_INACTIVE', 'no está activa'],
    ['PORTFOLIO_CURRENCY_MISMATCH', 'se cobra en USD y la cartera de la agencia está en COP'],
  ] as const)('%s: 409 con motivo y mensaje de negocio, sin importes', (reason, texto) => {
    const err = new BookingHoldRejectedError(reason, {
      amountCurrency: 'USD',
      portfolioCurrency: 'COP',
    });

    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.reason).toBe(reason);
    expect(err.message).toContain(texto);
    expect(err.message).not.toMatch(/\d/);
  });
});
