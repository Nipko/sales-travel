import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DepositReport, NetworkHold, Wallet, WalletMovement } from '../../lib/wallets';
import {
  CurrencyFilter,
  DepositReportList,
  MovementList,
  NetworkHoldList,
  NetworkHoldTotals,
  WalletCard,
} from './wallet-ui';

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
  network: null,
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

// ───────────────────────────── Reservas de la red (0060) ─────────────────────────────

const ORIGIN = '10000000-0000-4000-8000-00000000000a';

const NETWORK_MOVEMENT: WalletMovement = {
  id: '50000000-0000-4000-8000-000000000009',
  portfolioId: USD.id,
  currency: 'USD',
  exponent: 2,
  amountMinor: -113_400,
  transactionType: 'NETWORK_HOLD',
  referenceId: null,
  notes: 'Retención por una reserva de tu red',
  // Aunque llegara (el parser ya lo descarta), la fila de la red no muestra al vendedor.
  createdByName: 'Vendedor de otra agencia',
  network: {
    originTenantId: ORIGIN,
    originTenantName: 'Agencia Sur',
    orderNumber: 1042,
    status: 'captured',
  },
  createdAt: '2026-09-29T12:00:00.000Z',
};

const HOLD: NetworkHold = {
  levelId: '60000000-0000-4000-8000-000000000001',
  currency: 'USD',
  exponent: 2,
  amountMinor: 113_400,
  status: 'held',
  originTenantId: ORIGIN,
  originTenantName: 'Agencia Sur',
  orderNumber: 1042,
  createdAt: '2026-09-29T12:00:00.000Z',
  updatedAt: '2026-09-29T12:00:00.000Z',
};

describe('MovementList — asientos de la red', () => {
  it('la fila dice de qué agencia y qué reserva viene, y en qué quedó; nunca quién la vendió', () => {
    const html = render(
      createElement(MovementList, {
        movements: [NETWORK_MOVEMENT],
        showCurrency: false,
        emptyTitle: 'x',
      }),
    );
    expect(html).toContain('Retención de tu red');
    expect(html).toContain('Agencia Sur · Reserva #1042');
    expect(html).toContain('Estado de la reserva de tu red: </span>Cobrada');
    expect(html).not.toContain('Vendedor de otra agencia');
    expect(html).toMatch(/−US\$\s?1\.134/);
  });

  it('la liberación no repite el estado; sin la reserva (personal que no administra), sólo la nota', () => {
    const html = render(
      createElement(MovementList, {
        movements: [
          {
            ...NETWORK_MOVEMENT,
            id: '50000000-0000-4000-8000-00000000000a',
            transactionType: 'NETWORK_RELEASED',
            amountMinor: 113_400,
            network: { ...NETWORK_MOVEMENT.network!, status: 'released' },
          },
          { ...NETWORK_MOVEMENT, network: null },
        ],
        showCurrency: false,
        emptyTitle: 'x',
      }),
    );
    expect(html).toContain('Retención de tu red liberada');
    expect(html).not.toContain('Estado de la reserva de tu red');
    expect([...html.matchAll(/Agencia Sur/g)]).toHaveLength(1);
    expect(html).not.toContain('Vendedor de otra agencia');
  });
});

describe('NetworkHoldList — las reservas de la red en las carteras del nodo', () => {
  it('una lista semántica: la agencia como título, la reserva, el costo y el estado escrito', () => {
    const html = render(
      createElement(NetworkHoldList, { holds: [HOLD], showCurrency: true, emptyTitle: 'x' }),
    );
    expect(html).toMatch(/^<ul[^>]*>\s*<li/);
    expect(html).toMatch(/<h3[^>]*>Agencia Sur<\/h3>/);
    expect(html).toContain('Reserva #1042');
    expect(html).toMatch(/US\$\s?1\.134/);
    expect(html).toContain('Retenida');
    expect(html).toContain('USD');
  });

  it('cada estado con su texto, no sólo con color', () => {
    const html = render(
      createElement(NetworkHoldList, {
        holds: (['held', 'captured', 'released', 'conflict'] as const).map((status, i) => ({
          ...HOLD,
          levelId: `60000000-0000-4000-8000-00000000000${i}`,
          status,
        })),
        showCurrency: false,
        emptyTitle: 'x',
      }),
    );
    for (const label of ['Retenida', 'Cobrada', 'Liberada', 'En revisión']) {
      expect(html).toContain(label);
    }
    expect([...html.matchAll(/<li/g)]).toHaveLength(4);
  });

  it('sin nombre de la agencia, uno genérico; sin la moneda si hay una sola', () => {
    const html = render(
      createElement(NetworkHoldList, {
        holds: [{ ...HOLD, originTenantName: null, orderNumber: null }],
        showCurrency: false,
        emptyTitle: 'x',
        headingLevel: 4,
      }),
    );
    expect(html).toMatch(/<h4[^>]*>Una agencia de tu red<\/h4>/);
    expect(html).not.toContain('Reserva #');
  });

  it('vacía, el estado vacío', () => {
    const html = render(
      createElement(NetworkHoldList, {
        holds: [],
        showCurrency: false,
        emptyTitle: 'Todavía no hay reservas de tu red en tus carteras.',
      }),
    );
    expect(html).toContain('Todavía no hay reservas de tu red en tus carteras.');
  });
});

describe('NetworkHoldTotals — lo retenido y lo cobrado por moneda', () => {
  it('una tarjeta por moneda con lo retenido arriba y lo cobrado debajo', () => {
    const html = render(
      createElement(NetworkHoldTotals, {
        totals: [
          { currency: 'COP', exponent: 2, heldMinor: 0, chargedMinor: 5_000_000 },
          { currency: 'USD', exponent: 2, heldMinor: 113_400, chargedMinor: 105_000 },
        ],
      }),
    );
    expect(html).toContain('aria-label="Totales por moneda"');
    expect([...html.matchAll(/<li/g)]).toHaveLength(2);
    expect(html).toMatch(/<dt[^>]*>Retenido o en revisión<\/dt>/);
    expect(html).toMatch(/<dt[^>]*>Cobrado<\/dt>/);
    expect(html).toMatch(/US\$\s?1\.134/);
    expect(html).toMatch(/US\$\s?1\.050/);
  });

  it('sin totales no pinta nada: nunca un total en cero inventado', () => {
    expect(render(createElement(NetworkHoldTotals, { totals: [] }))).toBe('');
  });
});
