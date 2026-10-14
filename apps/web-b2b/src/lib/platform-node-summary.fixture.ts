/**
 * Respuestas de `GET /admin/tenants/:id/summary` para los tests de la pestaña Resumen de un nodo: un
 * consolidador con red y movimiento, y un nodo recién creado. JSON como lo manda el API.
 */

export const NODE_NORTE = '20000000-0000-4000-8000-000000000001';
export const NODE_HIJA = '20000000-0000-4000-8000-000000000002';
export const NODE_PLANETOUR = '20000000-0000-4000-8000-000000000009';

function attention(byReason: Record<string, number>): Record<string, unknown> {
  const all = {
    review: 0,
    'verifying-long': 0,
    'create-stuck': 0,
    'cancel-failed': 0,
    'hold-conflict': 0,
    'hold-orphan': 0,
    'hcn-missing': 0,
    reconciliation: 0,
    ...byReason,
  };
  return { total: Object.values(byReason).reduce((a, b) => a + b, 0), byReason: all };
}

/** Un consolidador que vende en COP y USD, con dos nodos debajo y cosas por revisar. */
export function busySummaryPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: '2026-10-13T14:58:00.000Z',
    tenant: {
      id: NODE_NORTE,
      name: 'Consolidador Norte',
      slug: 'norte',
      tenantType: 'consolidator',
      isBranch: false,
      status: 'active',
      parent: { id: NODE_PLANETOUR, name: 'Planetour' },
      countryCode: 'CO',
      defaultCurrency: 'COP',
      createdAt: '2026-01-05T17:00:00.000Z',
    },
    own: {
      tenantId: NODE_NORTE,
      seatLimit: 5,
      seatsUsed: 5,
      liveSessions: 3,
      activeUsers: 4,
      orders30d: 6,
      sales30d: 4,
      lastOrderAt: '2026-10-12T15:00:00.000Z',
      openOrders: 2,
      pendingDepositReports: 1,
      pendingInvitations: 2,
      held: [{ currency: 'COP', exponent: 2, amountMinor: 80_000_00 }],
    },
    subtree: {
      descendants: 2,
      activeUsers: 9,
      liveSessions: 5,
      openOrders: 7,
      held: [
        { currency: 'COP', exponent: 2, amountMinor: 180_000_00 },
        { currency: 'USD', exponent: 2, amountMinor: 250_00 },
      ],
      pendingDepositReports: 3,
      pendingInvitations: 2,
    },
    sales: {
      days: 30,
      own: [
        {
          currency: 'COP',
          exponent: 2,
          ordersCount: 6,
          confirmedCount: 4,
          confirmedAmountMinor: 1_500_000_00,
          cancelledCount: 1,
          failedCount: 0,
          byVertical: [
            { vertical: 'flights', confirmedCount: 3, confirmedAmountMinor: 1_200_000_00 },
            { vertical: 'hotels', confirmedCount: 1, confirmedAmountMinor: 300_000_00 },
          ],
        },
      ],
      subtree: [
        {
          currency: 'COP',
          exponent: 2,
          ordersCount: 10,
          confirmedCount: 7,
          confirmedAmountMinor: 2_600_000_00,
          cancelledCount: 2,
          failedCount: 1,
          byVertical: [
            { vertical: 'flights', confirmedCount: 5, confirmedAmountMinor: 2_000_000_00 },
            { vertical: 'hotels', confirmedCount: 2, confirmedAmountMinor: 600_000_00 },
          ],
        },
        {
          currency: 'USD',
          exponent: 2,
          ordersCount: 1,
          confirmedCount: 1,
          confirmedAmountMinor: 450_00,
          cancelledCount: 0,
          failedCount: 0,
          byVertical: [{ vertical: 'flights', confirmedCount: 1, confirmedAmountMinor: 450_00 }],
        },
      ],
    },
    attention: attention({ 'cancel-failed': 1, review: 2 }),
    ...extra,
  };
}

/** Una agencia recién creada: sin ventas, sin reservas, sin red y sin cupo propio. */
export function quietSummaryPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: '2026-10-13T14:58:00.000Z',
    tenant: {
      id: NODE_HIJA,
      name: 'Agencia Nueva',
      slug: 'nueva',
      tenantType: 'agency',
      isBranch: false,
      status: 'active',
      parent: { id: NODE_NORTE, name: 'Consolidador Norte' },
      countryCode: 'CO',
      defaultCurrency: 'COP',
      createdAt: '2026-10-12T17:00:00.000Z',
    },
    own: {
      tenantId: NODE_HIJA,
      seatLimit: null,
      seatsUsed: null,
      liveSessions: 0,
      activeUsers: 1,
      orders30d: 0,
      sales30d: 0,
      lastOrderAt: null,
      openOrders: 0,
      pendingDepositReports: 0,
      pendingInvitations: 0,
      held: [],
    },
    subtree: {
      descendants: 0,
      activeUsers: 1,
      liveSessions: 0,
      openOrders: 0,
      held: [],
      pendingDepositReports: 0,
      pendingInvitations: 0,
    },
    sales: { days: 30, own: [], subtree: [] },
    attention: attention({}),
    ...extra,
  };
}
