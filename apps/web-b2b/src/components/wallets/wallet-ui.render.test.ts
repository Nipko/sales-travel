import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DepositReport, Wallet, WalletMovement } from '../../lib/wallets';
import { CurrencyFilter, DepositReportList, MovementList, WalletCard } from './wallet-ui';

const USD: Wallet = {
  id: '20000000-0000-4000-8000-000000000002',
  tenantId: '10000000-0000-4000-8000-000000000001',
  currency: 'USD',
  exponent: 2,
  creditLimitMinor: 100_000,
  balanceMinor: 20_000,
  availableMinor: 120_000,
  status: 'active',
  updatedAt: '',
};

const MOVEMENT: WalletMovement = {
  id: '50000000-0000-4000-8000-000000000001',
  portfolioId: USD.id,
  currency: 'USD',
  exponent: 2,
  amountMinor: -12_000,
  transactionType: 'BOOKING_HOLD',
  referenceId: null,
  notes: 'Retención de saldo antes de reservar con el proveedor',
  createdByName: 'Ana',
  createdAt: '2026-09-29T12:00:00.000Z',
};

const REPORT: DepositReport = {
  id: '30000000-0000-4000-8000-000000000001',
  portfolioId: USD.id,
  currency: 'USD',
  exponent: 2,
  amountMinor: 50_000,
  reference: '54223',
  depositedOn: '2026-09-28',
  notes: 'Bancolombia',
  status: 'rejected',
  reportedByName: 'Ana',
  reportedAt: '2026-09-29T12:00:00.000Z',
  resolvedByName: 'Luis',
  resolvedAt: '2026-09-29T13:00:00.000Z',
  resolutionReason: 'No aparece en el extracto',
};

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe('WalletCard', () => {
  it('el disponible arriba, saldo y cupo como lista de definición, y el estado escrito', () => {
    const html = render(createElement(WalletCard, { wallet: USD }));
    expect(html).toContain('aria-label="Cartera USD"');
    expect(html).toContain('Disponible para reservar');
    expect(html).toMatch(/<dt[^>]*>Saldo<\/dt>/);
    expect(html).toMatch(/<dt[^>]*>Cupo<\/dt>/);
    expect(html).toContain('Activa');
  });

  it('suspendida lo dice con palabras, no sólo con color', () => {
    const html = render(createElement(WalletCard, { wallet: { ...USD, status: 'suspended' } }));
    expect(html).toContain('Suspendida: no se puede reservar en USD.');
  });

  it('sin acciones no hay barra de acciones (la agencia sólo mira)', () => {
    expect(render(createElement(WalletCard, { wallet: USD }))).not.toContain('<button');
  });
});

describe('MovementList', () => {
  it('cada movimiento con su tipo, su nota, quién y el monto con signo', () => {
    const html = render(
      createElement(MovementList, { movements: [MOVEMENT], showCurrency: true, emptyTitle: 'x' }),
    );
    expect(html).toContain('Retención por reserva');
    expect(html).toContain('Retención de saldo antes de reservar con el proveedor');
    expect(html).toContain('Ana');
    expect(html).toMatch(/−US\$\s?120/);
  });

  it('vacía, el estado vacío', () => {
    const html = render(
      createElement(MovementList, {
        movements: [],
        showCurrency: false,
        emptyTitle: 'Sin movimientos.',
      }),
    );
    expect(html).toContain('Sin movimientos.');
  });
});

describe('DepositReportList', () => {
  it('un rechazo muestra el motivo, quién y cuándo; sin acciones', () => {
    const html = render(
      createElement(DepositReportList, {
        reports: [REPORT],
        emptyTitle: 'x',
        actions: () => createElement('button', null, 'Aprobar'),
      }),
    );
    expect(html).toContain('Rechazado');
    expect(html).toContain('Motivo del rechazo: </span>No aparece en el extracto');
    expect(html).toContain('Rechazado por Luis');
    expect(html).toContain('Ref. 54223');
    expect(html).not.toContain('Aprobar');
  });

  it('un pendiente muestra las acciones de quien financia', () => {
    const html = render(
      createElement(DepositReportList, {
        reports: [
          {
            ...REPORT,
            status: 'pending',
            resolutionReason: null,
            resolvedByName: null,
            resolvedAt: null,
          },
        ],
        emptyTitle: 'x',
        actions: () => createElement('button', null, 'Aprobar'),
      }),
    );
    expect(html).toContain('Pendiente');
    expect(html).toContain('<button>Aprobar</button>');
  });
});

describe('CurrencyFilter', () => {
  it('con varias monedas, un grupo de radios con leyenda', () => {
    const html = render(
      createElement(CurrencyFilter, {
        currencies: ['COP', 'USD'],
        value: 'all',
        onChange: () => undefined,
        legend: 'Moneda',
      }),
    );
    expect(html).toContain('<legend class="sr-only">Moneda</legend>');
    expect([...html.matchAll(/type="radio"/g)]).toHaveLength(3);
  });

  it('con una sola moneda no hay nada que filtrar', () => {
    const html = render(
      createElement(CurrencyFilter, {
        currencies: ['COP'],
        value: 'all',
        onChange: () => undefined,
        legend: 'Moneda',
      }),
    );
    expect(html).toBe('');
  });
});
