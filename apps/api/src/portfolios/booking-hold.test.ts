import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  BookingHoldRejectedError,
  PortfolioHoldAccountChangedError,
  PortfolioHoldBusyError,
  PortfolioReleaseBusyError,
  WalletHoldStateConflictError,
  bookingHoldMessage,
  isNetworkRejection,
  type BookingHoldRejection,
} from './booking-hold.js';

/**
 * Lo que ve el vendedor cuando no se retiene (docs/tbo/08 RF-23; 0060). La decisión vive en la base
 * (`wallet_hold_decide`, `wallet_hold_retain`): acá, los motivos, los textos y los errores HTTP. Los
 * de la red hablan de "tu red" y de "quien te financia", nunca de montos, ids ni del nivel que falló.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Ningún importe: los únicos dígitos admitidos son los de un nombre, como Cartera B2B. */
const AMOUNT = /(?<![A-Z])\d/;

const ALL: readonly BookingHoldRejection[] = [
  'PORTFOLIO_CURRENCY_NOT_ENABLED',
  'PORTFOLIO_INACTIVE',
  'PORTFOLIO_FUNDS_INSUFFICIENT',
  'PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED',
  'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE',
  'PORTFOLIO_NETWORK_COST_UNAVAILABLE',
];

describe('BookingHoldRejectedError: la cartera propia', () => {
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
    expect(err.message).not.toMatch(AMOUNT);
  });
});

describe('BookingHoldRejectedError: la red que financia (0060)', () => {
  it.each([
    [
      'PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED',
      'Tu red todavía no opera en USD, así que no se puede retener saldo para esta reserva. Pedile a quien te financia que lo habilite.',
    ],
    [
      'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE',
      'Tu red no tiene cupo disponible en USD para esta reserva. Pedile a quien te financia que lo revise.',
    ],
    [
      'PORTFOLIO_NETWORK_COST_UNAVAILABLE',
      'No se pudo calcular el costo de esta reserva para tu red, así que no se retuvo saldo. Avisale a quien te financia.',
    ],
  ] as const)('%s: el texto exacto, sin montos, ids ni nombres', (reason, texto) => {
    const err = new BookingHoldRejectedError(reason, { amountCurrency: 'USD' });

    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.reason).toBe(reason);
    expect(err.message).toBe(texto);
    expect(err.message).not.toMatch(AMOUNT);
    expect(err.message).not.toMatch(UUID);
    // No dice qué nivel falló ni lo manda a su propia cartera: lo resuelve quien lo financia.
    expect(err.message).not.toMatch(/consolidador|agencia|Cartera B2B/i);
  });

  it('sólo los motivos de la red son de la red', () => {
    expect(ALL.filter(isNetworkRejection)).toEqual([
      'PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED',
      'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE',
      'PORTFOLIO_NETWORK_COST_UNAVAILABLE',
    ]);
  });

  it('el aviso previo y la reserva dicen lo mismo', () => {
    for (const reason of ALL) {
      expect(new BookingHoldRejectedError(reason, { amountCurrency: 'COP' }).message).toBe(
        bookingHoldMessage(reason, 'COP'),
      );
    }
  });
});

describe('los 409 de la retención que no son de saldo', () => {
  it.each([
    [
      'busy',
      new PortfolioHoldBusyError(),
      'PORTFOLIO_HOLD_BUSY',
      'Probá de nuevo en unos segundos.',
    ],
    [
      'release busy',
      new PortfolioReleaseBusyError(),
      'PORTFOLIO_RELEASE_BUSY',
      'todavía no se liberó el saldo retenido de esta reserva',
    ],
    [
      'account',
      new PortfolioHoldAccountChangedError(),
      'PORTFOLIO_HOLD_ACCOUNT_CHANGED',
      'Volvé a buscar la tarifa.',
    ],
    [
      'conflict',
      new WalletHoldStateConflictError(),
      'PORTFOLIO_HOLD_STATE_CONFLICT',
      'requiere conciliación manual.',
    ],
  ] as const)('%s → %s', (_caso, err, reason, texto) => {
    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.reason).toBe(reason);
    expect(err.message).toContain(texto);
    expect(err.message).not.toMatch(AMOUNT);
    expect(err.message).not.toMatch(UUID);
  });
});
