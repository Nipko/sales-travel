import { describe, expect, it } from 'vitest';
import {
  foldAttention,
  foldNetwork,
  foldQuotations,
  foldSales,
  foldTopNodes,
  foldTrend,
  foldWallets,
  killSwitchedCodes,
  orderStatusBucket,
  type OverviewOrdersRow,
} from './admin-overview.fold.js';

/**
 * Plataforma → Resumen: de las filas de 0075 a la vista. Lo que no puede pasar nunca es sumar monedas
 * distintas, ni contar como venta lo cancelado o lo fallido.
 */

const row = (
  currency: string,
  provider: string,
  status: string,
  orders: number,
  amount: number,
  vertical: string | null = null,
): OverviewOrdersRow => ({
  currency,
  provider,
  declared_vertical: vertical,
  status,
  orders: String(orders),
  amount_minor: String(amount),
});

describe('orderStatusBucket', () => {
  it.each([
    ['confirmed', 'confirmed'],
    ['ticketed', 'confirmed'],
    ['cancelled', 'cancelled'],
    ['failed', 'failed'],
    ['pending', 'pending'],
    ['algo-nuevo', 'pending'],
  ])('%s → %s', (status, bucket) => {
    expect(orderStatusBucket(status)).toBe(bucket);
  });
});

describe('foldSales', () => {
  const orders = [
    row('COP', 'latam-ndc', 'confirmed', 2, 300_000),
    row('COP', 'latam-ndc', 'ticketed', 1, 150_000),
    row('COP', 'tbo-hotels', 'confirmed', 1, 90_000, 'hotels'),
    row('COP', 'tbo-hotels', 'cancelled', 1, 40_000, 'hotels'),
    row('USD', 'tbo-hotels', 'confirmed', 2, 50_000, 'hotels'),
    row('USD', 'agent-cars', 'failed', 3, 10_000, 'cars'),
    row('USD', 'agent-cars', 'pending', 1, 5_000, 'cars'),
  ];
  const sales = foldSales(orders, []);

  it('por moneda, sin sumar monedas y con el ticket promedio de lo confirmado', () => {
    expect(sales.byCurrency).toEqual([
      {
        currency: 'COP',
        exponent: 2,
        confirmedCount: 4,
        confirmedAmountMinor: 540_000,
        cancelledCount: 1,
        cancelledAmountMinor: 40_000,
        failedCount: 0,
        pendingCount: 0,
        averageTicketMinor: 135_000,
      },
      {
        currency: 'USD',
        exponent: 2,
        confirmedCount: 2,
        confirmedAmountMinor: 50_000,
        cancelledCount: 0,
        cancelledAmountMinor: 0,
        failedCount: 3,
        pendingCount: 1,
        averageTicketMinor: 25_000,
      },
    ]);
  });

  it('por vertical, sólo lo confirmado, en el orden de las verticales y por moneda', () => {
    expect(sales.byVertical).toEqual([
      { vertical: 'flights', currency: 'COP', exponent: 2, count: 3, amountMinor: 450_000 },
      { vertical: 'hotels', currency: 'COP', exponent: 2, count: 1, amountMinor: 90_000 },
      { vertical: 'hotels', currency: 'USD', exponent: 2, count: 2, amountMinor: 50_000 },
    ]);
  });

  it('por proveedor y moneda, con lo cancelado, lo fallido y lo pendiente', () => {
    expect(sales.byProvider).toEqual([
      {
        provider: 'agent-cars',
        currency: 'USD',
        exponent: 2,
        confirmedCount: 0,
        confirmedAmountMinor: 0,
        cancelledCount: 0,
        failedCount: 3,
        pendingCount: 1,
      },
      {
        provider: 'latam-ndc',
        currency: 'COP',
        exponent: 2,
        confirmedCount: 3,
        confirmedAmountMinor: 450_000,
        cancelledCount: 0,
        failedCount: 0,
        pendingCount: 0,
      },
      {
        provider: 'tbo-hotels',
        currency: 'COP',
        exponent: 2,
        confirmedCount: 1,
        confirmedAmountMinor: 90_000,
        cancelledCount: 1,
        failedCount: 0,
        pendingCount: 0,
      },
      {
        provider: 'tbo-hotels',
        currency: 'USD',
        exponent: 2,
        confirmedCount: 2,
        confirmedAmountMinor: 50_000,
        cancelledCount: 0,
        failedCount: 0,
        pendingCount: 0,
      },
    ]);
  });

  it('sin confirmadas, el ticket promedio es null; una moneda retirada, exponente null', () => {
    const only = foldSales([row('XYZ', 'latam-ndc', 'failed', 1, 100)], []);
    expect(only.byCurrency[0]).toMatchObject({ currency: 'XYZ', exponent: null });
    expect(only.byCurrency[0]?.averageTicketMinor).toBeNull();
    expect(only.byVertical).toEqual([]);
  });

  it('sin órdenes, todo vacío', () => {
    expect(foldSales([], [])).toEqual({
      byCurrency: [],
      byVertical: [],
      byProvider: [],
      quotations: {
        created: 0,
        accepted: 0,
        byStatus: { draft: 0, sent: 0, accepted: 0, expired: 0, cancelled: 0 },
      },
    });
  });
});

describe('foldQuotations', () => {
  it('cuenta por estado; un estado desconocido suma al total y a ningún estado', () => {
    expect(
      foldQuotations([
        { status: 'sent', quotations: '4' },
        { status: 'accepted', quotations: 2 },
        { status: 'otro', quotations: '1' },
      ]),
    ).toEqual({
      created: 7,
      accepted: 2,
      byStatus: { draft: 0, sent: 4, accepted: 2, expired: 0, cancelled: 0 },
    });
  });
});

describe('foldTrend', () => {
  it('una serie por moneda con todos los meses, en cero los que no vendieron', () => {
    const trend = foldTrend(
      [
        { month: '2026-09', currency: 'USD', orders: '1', amount_minor: '500' },
        { month: '2026-08', currency: 'COP', orders: '2', amount_minor: '1000' },
        { month: '2026-10', currency: 'COP', orders: '1', amount_minor: '700' },
        // Fuera de los meses pedidos: no entra.
        { month: '2025-01', currency: 'COP', orders: '9', amount_minor: '9' },
      ],
      ['2026-08', '2026-09', '2026-10'],
    );
    expect(trend).toEqual({
      months: ['2026-08', '2026-09', '2026-10'],
      series: [
        {
          currency: 'COP',
          exponent: 2,
          points: [
            { month: '2026-08', count: 2, amountMinor: 1000 },
            { month: '2026-09', count: 0, amountMinor: 0 },
            { month: '2026-10', count: 1, amountMinor: 700 },
          ],
        },
        {
          currency: 'USD',
          exponent: 2,
          points: [
            { month: '2026-08', count: 0, amountMinor: 0 },
            { month: '2026-09', count: 1, amountMinor: 500 },
            { month: '2026-10', count: 0, amountMinor: 0 },
          ],
        },
      ],
    });
  });
});

describe('foldTopNodes', () => {
  it('un nodo por entrada en el orden del ranking, con lo vendido en cada moneda', () => {
    const base = { slug: 's', tenant_type: 'agency', is_branch: false, status: 'active' };
    expect(
      foldTopNodes([
        {
          ...base,
          tenant_id: 'b',
          name: 'B',
          orders_total: '5',
          currency: 'USD',
          orders: '1',
          amount_minor: '10',
        },
        {
          ...base,
          tenant_id: 'b',
          name: 'B',
          orders_total: '5',
          currency: 'COP',
          orders: '4',
          amount_minor: '400',
        },
        {
          ...base,
          tenant_id: 'a',
          name: 'A',
          orders_total: 2,
          currency: 'COP',
          orders: 2,
          amount_minor: 90,
        },
      ]),
    ).toEqual([
      {
        tenantId: 'b',
        name: 'B',
        slug: 's',
        tenantType: 'agency',
        isBranch: false,
        status: 'active',
        confirmedCount: 5,
        amounts: [
          { currency: 'COP', exponent: 2, amountMinor: 400 },
          { currency: 'USD', exponent: 2, amountMinor: 10 },
        ],
      },
      {
        tenantId: 'a',
        name: 'A',
        slug: 's',
        tenantType: 'agency',
        isBranch: false,
        status: 'active',
        confirmedCount: 2,
        amounts: [{ currency: 'COP', exponent: 2, amountMinor: 90 }],
      },
    ]);
  });
});

describe('foldNetwork', () => {
  it('pasa los conteos a números', () => {
    const network = foldNetwork({
      nodes_total: '9',
      nodes_active: '8',
      nodes_suspended: '1',
      nodes_archived: '0',
      consolidators: '1',
      agencies: '5',
      branches: '2',
      subagencies: '1',
      nodes_created: '3',
      users_active: '20',
      users_suspended: '1',
      users_locked: '2',
      admins_without_mfa: '4',
      users_logged_in: '12',
      live_sessions: '7',
    });
    expect(network).toEqual({
      nodes: {
        total: 9,
        active: 8,
        suspended: 1,
        archived: 0,
        consolidators: 1,
        agencies: 5,
        branches: 2,
        subagencies: 1,
        created: 3,
      },
      users: { active: 20, suspended: 1, locked: 2, adminsWithoutMfa: 4, loggedInPeriod: 12 },
      liveSessions: 7,
    });
  });

  it('sin fila, ceros', () => {
    expect(foldNetwork(undefined).nodes.total).toBe(0);
    expect(foldNetwork(undefined).liveSessions).toBe(0);
  });
});

describe('foldWallets', () => {
  it('por moneda, ordenado, con la exposición de Planetour aparte', () => {
    expect(
      foldWallets([
        {
          currency: 'USD',
          wallets: '1',
          credit_limit_minor: '1000',
          debt_minor: '0',
          funds_minor: '50',
          overlimit: '0',
          suspended: '0',
          platform_credit_limit_minor: '1000',
          platform_debt_minor: '0',
        },
        {
          currency: 'COP',
          wallets: '3',
          credit_limit_minor: '900000',
          debt_minor: '120000',
          funds_minor: '0',
          overlimit: '1',
          suspended: '1',
          platform_credit_limit_minor: '500000',
          platform_debt_minor: '20000',
        },
      ]).map((w) => [w.currency, w.debtMinor, w.platformDebtMinor, w.exponent]),
    ).toEqual([
      ['COP', 120000, 20000, 2],
      ['USD', 0, 0, 2],
    ]);
  });
});

describe('foldAttention', () => {
  it('suma lo de Planetour y lo de la red, y deja sólo los tipos con algo pendiente', () => {
    const attention = foldAttention(
      {
        deposit_reports_platform: '2',
        deposit_reports_network: '1',
        hotel_orders_unverified: '3',
        wallet_hold_conflicts: '1',
        reconciliation_critical: '1',
        reconciliation_warning: '4',
        invitations_pending: '6',
        invitations_expired: '2',
      },
      [
        { op_type: 'retrieve', failed: '0', stuck: '0' },
        { op_type: 'cancel', failed: '2', stuck: '1' },
        { op_type: 'pay', failed: 1, stuck: 0 },
      ],
      30,
    );
    expect(attention).toEqual({
      depositReports: { total: 3, platform: 2, network: 1 },
      postSale: {
        failed: 3,
        stuck: 1,
        byType: [
          { type: 'cancel', failed: 2, stuck: 1 },
          { type: 'pay', failed: 1, stuck: 0 },
        ],
      },
      hotelOrdersUnverified: 3,
      walletHoldConflicts: 1,
      reconciliation: { critical: 1, warning: 4, sinceDays: 30 },
      invitations: { pending: 6, expired: 2, expiredSinceDays: 30 },
    });
  });

  it('sin fila, ceros', () => {
    expect(foldAttention(undefined, [], 30).depositReports).toEqual({
      total: 0,
      platform: 0,
      network: 0,
    });
  });
});

describe('killSwitchedCodes', () => {
  it('los códigos de PROVIDERS_DISABLED, sin nivel, sin repetir y ordenados', () => {
    expect(killSwitchedCodes(' tbo-hotels:ventas , latam-ndc,, latam-ndc:otra ')).toEqual([
      'latam-ndc',
      'tbo-hotels',
    ]);
    expect(killSwitchedCodes(undefined)).toEqual([]);
    expect(killSwitchedCodes('')).toEqual([]);
  });
});
