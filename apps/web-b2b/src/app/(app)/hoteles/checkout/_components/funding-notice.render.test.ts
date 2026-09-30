import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FundingNotice } from './funding-notice';
import { fundingNotice } from './funding-view';

function html(reason: string): string {
  return renderToStaticMarkup(
    createElement(FundingNotice, {
      view: fundingNotice({ status: 'blocked', reason, message: 'Texto del API.' }),
    }),
  );
}

describe('FundingNotice — el aviso de cartera del PreBook', () => {
  it('un motivo de la cartera de la agencia lleva a Cartera B2B', () => {
    const out = html('PORTFOLIO_FUNDS_INSUFFICIENT');
    expect(out).toContain('role="alert"');
    expect(out).toContain('href="/carteras"');
    expect(out).toContain('Ir a Cartera B2B');
  });

  it('un motivo de la red no: el vendedor no lo resuelve en su cartera sino con quien lo financia', () => {
    const out = html('PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE');
    expect(out).toContain('role="alert"');
    expect(out).toContain('La red que te financia no cubre esta reserva.');
    expect(out).toContain('Texto del API.');
    expect(out).not.toContain('href="/carteras"');
  });

  it('sin aviso no pinta nada', () => {
    expect(renderToStaticMarkup(createElement(FundingNotice, { view: undefined }))).toBe('');
  });
});
