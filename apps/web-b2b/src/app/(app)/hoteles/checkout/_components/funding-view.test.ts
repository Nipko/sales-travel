import { describe, expect, it } from 'vitest';
import { fundingNotice, parseFunding } from './funding-view';

const NOT_ENABLED = {
  status: 'blocked',
  currency: 'USD',
  reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED',
  message: 'La agencia no tiene cartera en USD: pedile a quien te financia que la habilite.',
};

describe('parseFunding — el aviso de cartera del PreBook', () => {
  it('lee "cubre" y "no cubre" con su motivo y el texto del API', () => {
    expect(parseFunding({ status: 'ok', currency: 'USD' })).toEqual({ status: 'ok' });
    expect(parseFunding(NOT_ENABLED)).toEqual({
      status: 'blocked',
      reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED',
      message: NOT_ENABLED.message,
    });
  });

  it('sin aviso, o con una forma que no se entiende, no se sabe: decide el Book', () => {
    for (const value of [undefined, null, 'blocked', [], { status: 'maybe' }, {}]) {
      expect(parseFunding(value)).toBeUndefined();
    }
  });

  it('un bloqueo sin motivo o sin texto válido sigue siendo un bloqueo, con el texto genérico', () => {
    expect(parseFunding({ status: 'blocked', reason: '<b>x</b>', message: '' })).toEqual({
      status: 'blocked',
      message: 'Revisá la cartera de la agencia en Cartera B2B.',
    });
    expect(parseFunding({ status: 'blocked', message: 'x'.repeat(501) })).toMatchObject({
      message: 'Revisá la cartera de la agencia en Cartera B2B.',
    });
  });

  it('no deja pasar nada más que el motivo y el texto, aunque el API sumara saldo o cupo', () => {
    const parsed = parseFunding({ ...NOT_ENABLED, balanceMinor: 123, creditLimitMinor: 456 });
    expect(JSON.stringify(parsed)).not.toMatch(/123|456|currency/);
  });
});

describe('fundingNotice — lo que ve el vendedor antes de cargar huéspedes', () => {
  it.each([
    ['PORTFOLIO_CURRENCY_NOT_ENABLED', 'No se puede reservar en esta moneda.'],
    ['PORTFOLIO_INACTIVE', 'La cartera de la agencia está suspendida.'],
    ['PORTFOLIO_FUNDS_INSUFFICIENT', 'Falta saldo para esta reserva.'],
    ['OTRO_MOTIVO', 'La cartera de la agencia no cubre esta reserva.'],
  ])('%s → "%s", con el texto del API debajo', (reason, title) => {
    expect(fundingNotice({ status: 'blocked', reason, message: 'Texto del API.' })).toEqual({
      title,
      detail: 'Texto del API.',
    });
  });

  it('sin aviso o con la cartera que cubre, no hay nada que mostrar', () => {
    expect(fundingNotice(undefined)).toBeUndefined();
    expect(fundingNotice({ status: 'ok' })).toBeUndefined();
  });
});
