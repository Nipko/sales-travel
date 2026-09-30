import { BadRequestException, ConflictException, HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { BookingHoldRejectedError, PortfolioHoldAccountChangedError } from './booking-hold.js';
import {
  PORTFOLIO_RULE_SQLSTATE,
  PortfolioConflictError,
  PortfolioForbiddenError,
  WALLET_HOLD_REJECTED_SQLSTATE,
  holdRejectionOfRule,
  portfolioHttpError,
  walletHoldHttpError,
  walletHoldStateRule,
  walletNotEnabled,
} from './portfolio-errors.js';

/** La forma de un error de `pg`: lo que llega de la base. */
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error('mensaje crudo de la base, con la cartera 7970ade5'), {
    code,
    ...(constraint === undefined ? {} : { constraint }),
  });
}

describe('portfolioHttpError: las reglas de 0052 salen con motivo, no como 500', () => {
  it.each([
    ['portfolio_identity_immutable', 'PORTFOLIO_IDENTITY_IMMUTABLE'],
    ['deposit_report_not_pending', 'DEPOSIT_REPORT_NOT_PENDING'],
    ['deposit_report_born_pending', 'DEPOSIT_REPORT_BORN_PENDING'],
    ['deposit_report_transition', 'DEPOSIT_REPORT_TRANSITION'],
    ['deposit_report_immutable', 'DEPOSIT_REPORT_IMMUTABLE'],
    ['deposit_report_ledger_entry', 'DEPOSIT_REPORT_LEDGER_ENTRY'],
    ['una_regla_nueva', 'PORTFOLIO_RULE_VIOLATION'],
  ])('STW01 con la regla %s → 409 %s', (constraint, reason) => {
    const mapped = portfolioHttpError(pgError(PORTFOLIO_RULE_SQLSTATE, constraint));

    expect(mapped).toBeInstanceOf(PortfolioConflictError);
    expect(mapped?.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(mapped?.reason).toBe(reason);
    expect(mapped?.message).not.toContain('7970ade5');
  });

  it.each([
    ['portfolio_financier_required', 'PORTFOLIO_FINANCIER_REQUIRED'],
    ['deposit_report_resolver', 'DEPOSIT_REPORT_RESOLVER'],
    ['portfolio_entry_author', 'PORTFOLIO_ENTRY_AUTHOR'],
  ])('42501 con la regla %s → 403 %s', (constraint, reason) => {
    const mapped = portfolioHttpError(pgError('42501', constraint));

    expect(mapped).toBeInstanceOf(PortfolioForbiddenError);
    expect(mapped?.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(mapped?.reason).toBe(reason);
  });

  it('la cartera repetida por moneda (UNIQUE de 0052) es 409 PORTFOLIO_ALREADY_ENABLED', () => {
    expect(
      portfolioHttpError(pgError('23505', 'agency_portfolios_tenant_currency_key'))?.reason,
    ).toBe('PORTFOLIO_ALREADY_ENABLED');
  });

  it('lo que no es de las carteras sigue su camino', () => {
    for (const err of [
      pgError('42501'),
      pgError('42501', 'tenant_move_forbidden'),
      pgError('23505', 'uq_portfolio_transactions_idempotency_key'),
      pgError('STH01', 'tenant_depth_limit'),
      new Error('cualquier cosa'),
      'texto',
      null,
    ]) {
      expect(portfolioHttpError(err)).toBeUndefined();
    }
  });
});

describe('walletNotEnabled', () => {
  it('dice qué moneda falta y a quién pedírsela', () => {
    const err = walletNotEnabled('USD');

    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.reason).toBe('PORTFOLIO_CURRENCY_NOT_ENABLED');
    expect(err.message).toBe(
      'La agencia no tiene cartera en USD: pedile a quien te financia que la habilite.',
    );
  });
});

describe('walletHoldHttpError: las retenciones de 0060', () => {
  it.each([
    ['hold_currency_not_enabled', 'PORTFOLIO_CURRENCY_NOT_ENABLED'],
    ['hold_inactive', 'PORTFOLIO_INACTIVE'],
    ['hold_funds_insufficient', 'PORTFOLIO_FUNDS_INSUFFICIENT'],
    ['network_currency_not_enabled', 'PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED'],
    ['network_funds_unavailable', 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE'],
    ['network_cost_unavailable', 'PORTFOLIO_NETWORK_COST_UNAVAILABLE'],
  ])('STW02 con la regla %s → 409 %s en la moneda de la reserva', (constraint, reason) => {
    const mapped = walletHoldHttpError(pgError(WALLET_HOLD_REJECTED_SQLSTATE, constraint), {
      currency: 'USD',
    });

    expect(mapped).toBeInstanceOf(BookingHoldRejectedError);
    expect(mapped?.getStatus()).toBe(HttpStatus.CONFLICT);
    expect((mapped as BookingHoldRejectedError).reason).toBe(reason);
    expect(mapped?.message).not.toContain('7970ade5');
    expect(holdRejectionOfRule(constraint)).toBe(reason);
  });

  it('una regla STW02 que la API no conoce sale con el motivo genérico', () => {
    const mapped = walletHoldHttpError(pgError('STW02', 'network_algo_nuevo'));

    expect(mapped).toBeInstanceOf(PortfolioConflictError);
    expect((mapped as PortfolioConflictError).reason).toBe('PORTFOLIO_RULE_VIOLATION');
  });

  it('sin la moneda (el filtro global) el texto sigue siendo de negocio', () => {
    expect(walletHoldHttpError(pgError('STW02', 'network_funds_unavailable'))?.message).toBe(
      'Tu red no tiene cupo disponible en la moneda de la tarifa para esta reserva. Pedile a quien te financia que lo revise.',
    );
  });

  it.each([
    [
      'hold_order_not_found',
      BadRequestException,
      'No se encontró la reserva. No se modificó el saldo de la cartera.',
    ],
    [
      'hold_order_not_holdable',
      BadRequestException,
      'La reserva no está en un estado que pueda retener saldo de cartera.',
    ],
    [
      'hold_already_exists',
      ConflictException,
      'Esta reserva ya tiene una retención activa. No se realizó un segundo débito.',
    ],
    [
      'hold_amount_invalid',
      BadRequestException,
      'La reserva no tiene un total y una moneda válidos para crear la retención.',
    ],
    [
      'hold_release_order_open',
      ConflictException,
      'La reserva no está en el estado que la liberación exige: su retención de saldo se mantiene.',
    ],
  ])('STW01 %s → la excepción de siempre', (constraint, type, message) => {
    const mapped = walletHoldHttpError(pgError(PORTFOLIO_RULE_SQLSTATE, constraint));

    expect(mapped).toBeInstanceOf(type);
    expect(mapped?.message).toBe(message);
    expect(walletHoldStateRule(pgError(PORTFOLIO_RULE_SQLSTATE, constraint))).toBe(constraint);
    // `portfolioHttpError` las deja pasar: no son un PORTFOLIO_RULE_VIOLATION.
    expect(portfolioHttpError(pgError(PORTFOLIO_RULE_SQLSTATE, constraint))).toBeUndefined();
  });

  it('cada vía dice por qué su orden no retiene', () => {
    expect(
      walletHoldHttpError(pgError('STW01', 'hold_order_not_holdable'), {
        notHoldableMessage:
          'Sólo una reserva confirmada y no emitida puede retener saldo de cartera.',
      })?.message,
    ).toBe('Sólo una reserva confirmada y no emitida puede retener saldo de cartera.');
  });

  it('la cuenta del proveedor que ya no se resuelve es 409 PORTFOLIO_HOLD_ACCOUNT_CHANGED', () => {
    const mapped = walletHoldHttpError(pgError('STW01', 'hold_owner_unresolvable'));

    expect(mapped).toBeInstanceOf(PortfolioHoldAccountChangedError);
    expect((mapped as PortfolioHoldAccountChangedError).reason).toBe(
      'PORTFOLIO_HOLD_ACCOUNT_CHANGED',
    );
  });

  it('la liberación fuera de rango es PORTFOLIO_BALANCE_OUT_OF_RANGE', () => {
    expect(
      (walletHoldHttpError(pgError('STW01', 'hold_release_out_of_range')) as PortfolioConflictError)
        .reason,
    ).toBe('PORTFOLIO_BALANCE_OUT_OF_RANGE');
  });

  it('los 42501 de 0060 son errores de programación: no se traducen (500 y log)', () => {
    for (const rule of [
      'wallet_hold_no_tenant',
      'wallet_hold_actor_invalid',
      'hold_entry_reserved',
      'portfolio_balance_reserved',
    ]) {
      expect(walletHoldHttpError(pgError('42501', rule))).toBeUndefined();
      expect(portfolioHttpError(pgError('42501', rule))).toBeUndefined();
    }
  });

  it('lo que no es de las retenciones sigue su camino', () => {
    for (const err of [
      pgError('STW01', 'portfolio_identity_immutable'),
      pgError('23505', 'uq_portfolio_transactions_booking_hold'),
      new Error('cualquier cosa'),
      null,
    ]) {
      expect(walletHoldHttpError(err)).toBeUndefined();
    }
  });
});
