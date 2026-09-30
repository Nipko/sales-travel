import { describe, expect, it } from 'vitest';
import {
  FUNDING_GATE_REASON,
  NETWORK_FUNDING_GATE_REASON,
  fundingGateReason,
  fundingNotice,
  isNetworkFundingReason,
  parseFunding,
} from './funding-view';

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

  it('un motivo de la red sin texto lleva a quien financia, no a Cartera B2B', () => {
    expect(
      parseFunding({ status: 'blocked', reason: 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE' }),
    ).toEqual({
      status: 'blocked',
      reason: 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE',
      message: 'Hablá con quien te financia antes de volver a intentarlo.',
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
  ])('%s → "%s", con el texto del API debajo y el camino a Cartera B2B', (reason, title) => {
    expect(fundingNotice({ status: 'blocked', reason, message: 'Texto del API.' })).toEqual({
      title,
      detail: 'Texto del API.',
      action: 'portfolios',
    });
  });

  it.each([
    ['PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED', 'La red que te financia no opera en esta moneda.'],
    ['PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE', 'La red que te financia no cubre esta reserva.'],
    ['PORTFOLIO_NETWORK_COST_UNAVAILABLE', 'No se pudo calcular el costo para quien te financia.'],
  ])('%s → "%s", sin enlace a Cartera B2B: lo resuelve quien financia', (reason, title) => {
    const message =
      'Tu red no tiene cupo disponible en USD para esta reserva. Pedile a quien te financia que lo revise.';
    const view = fundingNotice({ status: 'blocked', reason, message });
    expect(view).toEqual({ title, detail: message, action: 'financier' });
    // Ni montos, ni ids, ni qué nivel falló: sólo "tu red" y "quien te financia".
    expect(`${view?.title} ${view?.detail}`).not.toMatch(/\d{2,}|[0-9a-f]{8}-[0-9a-f]{4}/i);
    // El título nombra lo que financia al vendedor (hacia arriba) y no repite el texto del API:
    // "tu red" en Cartera B2B es la red que el nodo financia (hacia abajo).
    expect(view?.title).not.toMatch(/tu red/i);
  });

  it('sin aviso o con la cartera que cubre, no hay nada que mostrar', () => {
    expect(fundingNotice(undefined)).toBeUndefined();
    expect(fundingNotice({ status: 'ok' })).toBeUndefined();
  });
});

describe('fundingGateReason — por qué no se sigue a los huéspedes', () => {
  it('la cartera de la agencia o la de su red, cada una con su camino', () => {
    const blocked = (reason?: string) =>
      ({ status: 'blocked', message: 'x', ...(reason ? { reason } : {}) }) as const;
    expect(fundingGateReason(blocked('PORTFOLIO_FUNDS_INSUFFICIENT'))).toBe(FUNDING_GATE_REASON);
    expect(fundingGateReason(blocked())).toBe(FUNDING_GATE_REASON);
    expect(fundingGateReason(blocked('PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED'))).toBe(
      NETWORK_FUNDING_GATE_REASON,
    );
    expect(NETWORK_FUNDING_GATE_REASON).toBe(
      'Hablá con quien te financia antes de cargar los huéspedes: esta reserva se rechazaría.',
    );
  });

  it('sólo los tres motivos de la red son de la red', () => {
    expect(isNetworkFundingReason('PORTFOLIO_NETWORK_COST_UNAVAILABLE')).toBe(true);
    expect(isNetworkFundingReason('PORTFOLIO_INACTIVE')).toBe(false);
    expect(isNetworkFundingReason('PORTFOLIO_HOLD_BUSY')).toBe(false);
    expect(isNetworkFundingReason(undefined)).toBe(false);
  });
});
