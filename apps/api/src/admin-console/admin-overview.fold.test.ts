import { describe, expect, it } from 'vitest';
import {
  CATALOG_STALE_HOURS,
  foldAttention,
  foldCatalogs,
  foldNetwork,
  foldOrderAttention,
  foldQuotations,
  foldReconciliationRuns,
  foldSales,
  foldSaturatedSeats,
  foldTopNodes,
  foldTrend,
  foldWallets,
  orderStatusBucket,
  type AttentionExtras,
  type OverviewOrderAttentionRow,
  type OverviewOrdersRow,
} from './admin-overview.fold.js';
import { ORDER_ATTENTION_REASONS } from './attention.js';

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

const NO_EXTRAS: AttentionExtras = {
  orders: foldOrderAttention([]),
  seats: { saturated: [] },
  reconciliationRuns: foldReconciliationRuns([], 7),
  jobs: { postSaleSweepStale: false, lastOkAt: '2026-10-13T12:00:00.000Z' },
};

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
      NO_EXTRAS,
    );
    expect(attention).toEqual({
      depositReports: { total: 3, platform: 2, network: 1 },
      orders: NO_EXTRAS.orders,
      seats: { saturated: [] },
      reconciliationRuns: { sinceDays: 7, failedRuns: 0, byProvider: [] },
      jobs: { postSaleSweepStale: false, lastOkAt: '2026-10-13T12:00:00.000Z' },
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
    expect(foldAttention(undefined, [], 30, NO_EXTRAS).depositReports).toEqual({
      total: 0,
      platform: 0,
      network: 0,
    });
  });
});

const attentionRow = (
  orderId: string,
  reason: string,
  since: string,
  extra: Partial<OverviewOrderAttentionRow> = {},
): OverviewOrderAttentionRow => ({
  order_id: orderId,
  tenant_id: 'nodo-1',
  tenant_name: 'Agencia Uno',
  order_number: '1042',
  provider: 'tbo-hotels',
  provider_order_id: 'LOC-1',
  order_status: 'pending',
  reason,
  since,
  ...extra,
});

describe('foldOrderAttention', () => {
  it('cuenta reservas distintas y, por motivo, cada fila', () => {
    const view = foldOrderAttention([
      attentionRow('o1', 'hcn-missing', '2026-10-01T10:00:00Z'),
      attentionRow('o1', 'cancel-failed', '2026-10-02T10:00:00Z'),
      attentionRow('o2', 'create-stuck', '2026-10-03T10:00:00Z'),
    ]);
    expect(view.total).toBe(2);
    expect(view.byReason).toEqual({
      ...Object.fromEntries(ORDER_ATTENTION_REASONS.map((r) => [r, 0])),
      'hcn-missing': 1,
      'cancel-failed': 1,
      'create-stuck': 1,
    });
  });

  it('la muestra lleva una fila por reserva con su motivo más grave, de la que más espera a la que menos', () => {
    const view = foldOrderAttention([
      attentionRow('o2', 'create-stuck', '2026-10-03T10:00:00Z'),
      // o1: hcn-missing es menos grave que cancel-failed (ATTENTION_PRIORITY), aunque sea anterior.
      attentionRow('o1', 'hcn-missing', '2026-10-01T10:00:00Z'),
      attentionRow('o1', 'cancel-failed', '2026-10-04T10:00:00Z', { order_number: 7 }),
      attentionRow('o3', 'hold-orphan', '2026-09-30T10:00:00Z', {
        since: new Date('2026-09-30T10:00:00Z'),
      }),
    ]);
    expect(view.sample.map((s) => [s.orderId, s.reason, s.since])).toEqual([
      ['o3', 'hold-orphan', '2026-09-30T10:00:00.000Z'],
      ['o2', 'create-stuck', '2026-10-03T10:00:00.000Z'],
      ['o1', 'cancel-failed', '2026-10-04T10:00:00.000Z'],
    ]);
    expect(view.sample[2]).toMatchObject({
      orderNumber: 7,
      tenantName: 'Agencia Uno',
      providerOrderId: 'LOC-1',
    });
  });

  it('corta la muestra y descarta motivos desconocidos o fechas rotas', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      attentionRow(
        `o${String(i).padStart(2, '0')}`,
        'review',
        `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      ),
    );
    const view = foldOrderAttention([
      ...rows,
      attentionRow('x', 'otra-cosa', '2026-10-01T00:00:00Z'),
      attentionRow('y', 'review', 'no-es-fecha'),
    ]);
    expect(view.total).toBe(12);
    expect(view.byReason.review).toBe(12);
    expect(view.sample).toHaveLength(10);
    expect(view.sample[0]?.orderId).toBe('o00');
    expect(foldOrderAttention(rows, 3).sample).toHaveLength(3);
  });
});

describe('foldSaturatedSeats', () => {
  const seats = (name: string, used: number | string, limit: number | string) => ({
    tenant_id: `id-${name}`,
    tenant_name: name,
    seats_used: used,
    seat_limit: limit,
  });

  it('desde el 90 % de los puestos (redondeado hacia arriba), del más lleno al menos', () => {
    expect(
      foldSaturatedSeats([
        seats('Diez', 9, 10),
        seats('Ocho de diez', 8, 10),
        seats('Tres', '3', '3'),
        seats('Dos de tres', 2, 3),
        seats('Sin cupo', 5, 0),
      ]),
    ).toEqual([
      { tenantId: 'id-Tres', tenantName: 'Tres', used: 3, limit: 3 },
      { tenantId: 'id-Diez', tenantName: 'Diez', used: 9, limit: 10 },
    ]);
  });

  it('con un cupo de 1, el único puesto en uso lo satura', () => {
    expect(foldSaturatedSeats([seats('Uno', 1, 1), seats('Libre', 0, 1)])).toHaveLength(1);
  });
});

describe('foldReconciliationRuns', () => {
  it('suma las corridas fallidas de todos los proveedores', () => {
    const view = foldReconciliationRuns(
      [
        {
          provider_code: 'tbo-hotels',
          runs: '7',
          failed_runs: '2',
          last_finished_at: '2026-10-12T06:00:00Z',
          last_status: 'failed',
          critical_items: '1',
          warning_items: '0',
        },
        {
          provider_code: 'agent-cars',
          runs: 0,
          failed_runs: 0,
          last_finished_at: null,
          last_status: null,
          critical_items: 0,
          warning_items: 3,
        },
      ],
      7,
    );
    expect(view.failedRuns).toBe(2);
    expect(view.sinceDays).toBe(7);
    expect(view.byProvider.map((p) => [p.providerCode, p.lastFinishedAt])).toEqual([
      ['agent-cars', null],
      ['tbo-hotels', '2026-10-12T06:00:00.000Z'],
    ]);
  });
});

describe('foldCatalogs', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const catalog = (code: string, lastSyncedAt: string | null) => ({
    provider_code: code,
    cities: '120',
    synced_last_48h: '100',
    failed_cities: '3',
    last_synced_at: lastSyncedAt,
  });

  it(`queda atrás pasadas ${CATALOG_STALE_HOURS} horas, o si nunca se sincronizó`, () => {
    const view = foldCatalogs(
      [
        catalog('tbo-hotels', hoursAgo(35)),
        catalog('hoteldo', hoursAgo(37)),
        catalog('nuevo', null),
      ],
      now,
    );
    expect(view.map((c) => [c.providerCode, c.stale])).toEqual([
      ['hoteldo', true],
      ['nuevo', true],
      ['tbo-hotels', false],
    ]);
    expect(view.find((c) => c.providerCode === 'tbo-hotels')).toMatchObject({
      cities: 120,
      syncedLast48h: 100,
      failedCities: 3,
    });
  });
});
