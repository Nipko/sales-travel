import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NETWORK_DETAIL } from '../../hoteles/checkout/_components/funding-view';
import { createOrderFundingView } from './create-order-funding';
import { shouldShowBookingForm } from './create-order-reconciliation';

/*
 * La reserva de un vuelo que liquida la red (SAB-10) cuando la cartera no la cubre: el API responde
 * 409 con el motivo y sin llamar a la aerolínea. El checkout lo muestra con el título de hoteles,
 * lleva a Cartera B2B si es la cartera propia y a quien te financia si es la red, y deja volver a
 * reservar una vez resuelto.
 */

const SIN_SALDO =
  'La cartera en USD de la agencia no tiene saldo ni cupo suficiente para esta reserva. Informa un depósito en Cartera B2B o pídele más cupo a quien te financia.';

describe('createOrderFundingView', () => {
  it('la cartera propia: título, el texto del API y Cartera B2B', () => {
    expect(
      createOrderFundingView(409, {
        statusCode: 409,
        error: 'Conflict',
        message: SIN_SALDO,
        reason: 'PORTFOLIO_FUNDS_INSUFFICIENT',
      }),
    ).toEqual({ title: 'Falta saldo para esta reserva.', detail: SIN_SALDO, action: 'portfolios' });
    expect(createOrderFundingView(409, { reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED' })?.action).toBe(
      'portfolios',
    );
    expect(createOrderFundingView(409, { reason: 'PORTFOLIO_INACTIVE' })?.action).toBe(
      'portfolios',
    );
  });

  it('un nivel de la red: hablar con quien te financia, sin Cartera B2B', () => {
    const view = createOrderFundingView(409, { reason: 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE' });
    expect(view).toEqual({
      title: 'La red que te financia no cubre esta reserva.',
      detail: NETWORK_DETAIL,
      action: 'financier',
    });
  });

  it('la red ocupada se reintenta; la cuenta cambiada se vuelve a buscar', () => {
    expect(createOrderFundingView(409, { reason: 'PORTFOLIO_HOLD_BUSY' })?.action).toBe('retry');
    expect(createOrderFundingView(409, { reason: 'PORTFOLIO_HOLD_ACCOUNT_CHANGED' })?.action).toBe(
      'research',
    );
  });

  it('otra cosa no es un aviso de cartera', () => {
    expect(createOrderFundingView(400, { reason: 'PORTFOLIO_FUNDS_INSUFFICIENT' })).toBeUndefined();
    expect(createOrderFundingView(409, { reason: 'OTRA_COSA' })).toBeUndefined();
    expect(createOrderFundingView(409, { message: 'sin motivo' })).toBeUndefined();
    expect(createOrderFundingView(409, null)).toBeUndefined();
  });

  it('un texto del API demasiado largo no se pinta: queda el fijo', () => {
    const view = createOrderFundingView(409, {
      reason: 'PORTFOLIO_FUNDS_INSUFFICIENT',
      message: 'x'.repeat(501),
    });
    expect(view?.detail).toBe('Revisa la cartera de la agencia en Cartera B2B.');
  });

  it('nada salió hacia la aerolínea: el formulario vuelve para reservar otra vez', () => {
    const funding = createOrderFundingView(409, { reason: 'PORTFOLIO_FUNDS_INSUFFICIENT' });
    expect(funding).toBeDefined();
    expect(shouldShowBookingForm({ outcome: 'FAILED', ...(funding ? { funding } : {}) })).toBe(
      true,
    );
  });
});

/*
 * La página pide datos al montar y no se pinta sin DOM: se verifica en el código que un rechazo de
 * la reserva pasa por el aviso de cartera y que el aviso lleva a Cartera B2B.
 */
describe('el checkout de cotizaciones muestra el aviso de cartera', () => {
  const page = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');

  it('un rechazo pasa por el aviso, con su enlace a Cartera B2B', () => {
    expect(page).toContain('createOrderFundingView(res.status, data)');
    expect(page).toContain('bookingResult.funding.title');
    expect(page).toContain("bookingResult.funding.action === 'portfolios'");
    expect(page).toContain('href={PORTFOLIOS_HREF}');
  });
});
