import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  PORTFOLIO_RULE_SQLSTATE,
  PortfolioConflictError,
  PortfolioForbiddenError,
  portfolioHttpError,
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
