/**
 * Una respuesta de `GET /admin/overview` con la forma que arma el API (admin-overview.service.ts),
 * para las pruebas de la lectura y de la pantalla. Por omisión no hay nada que requiera atención.
 */

export const NODE_SUR = '10000000-0000-4000-8000-000000000001';
export const NODE_ANDES = '10000000-0000-4000-8000-000000000002';

const MONTHS = [
  '2025-11',
  '2025-12',
  '2026-01',
  '2026-02',
  '2026-03',
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
  '2026-09',
  '2026-10',
];

type Payload = Record<string, unknown>;

export function quietAttention(): Payload {
  return {
    depositReports: { total: 0, platform: 0, network: 0 },
    postSale: { failed: 0, stuck: 0, byType: [] },
    hotelOrdersUnverified: 0,
    walletHoldConflicts: 0,
    reconciliation: { critical: 0, warning: 0, sinceDays: 30 },
    invitations: { pending: 0, expired: 0, expiredSinceDays: 30 },
  };
}

export function quietProviders(): Payload {
  return { killSwitched: [], openCircuits: [], disabledGlobally: [], tenantOverridesDisabled: 0 };
}

export function overviewPayload(overrides: Payload = {}): Payload {
  return {
    generatedAt: '2026-10-11T14:00:00.000Z',
    timeZone: 'America/Bogota',
    period: { from: '2026-09-12', to: '2026-10-11' },
    scope: null,
    sales: {
      byCurrency: [
        {
          currency: 'COP',
          exponent: 2,
          confirmedCount: 12,
          confirmedAmountMinor: 1_850_000_000,
          cancelledCount: 2,
          cancelledAmountMinor: 90_000_000,
          failedCount: 1,
          pendingCount: 0,
          averageTicketMinor: 154_166_667,
        },
        {
          currency: 'USD',
          exponent: 2,
          confirmedCount: 3,
          confirmedAmountMinor: 245_000,
          cancelledCount: 0,
          cancelledAmountMinor: 0,
          failedCount: 0,
          pendingCount: 1,
          averageTicketMinor: 81_667,
        },
      ],
      byVertical: [
        { vertical: 'flights', currency: 'COP', exponent: 2, count: 8, amountMinor: 1_200_000_000 },
        { vertical: 'hotels', currency: 'COP', exponent: 2, count: 4, amountMinor: 650_000_000 },
        { vertical: 'hotels', currency: 'USD', exponent: 2, count: 3, amountMinor: 245_000 },
      ],
      byProvider: [
        {
          provider: 'latam-ndc',
          currency: 'COP',
          exponent: 2,
          confirmedCount: 8,
          confirmedAmountMinor: 1_200_000_000,
          cancelledCount: 2,
          failedCount: 1,
          pendingCount: 0,
        },
        {
          provider: 'tbo-hotels',
          currency: 'USD',
          exponent: 2,
          confirmedCount: 3,
          confirmedAmountMinor: 245_000,
          cancelledCount: 0,
          failedCount: 0,
          pendingCount: 1,
        },
      ],
      quotations: {
        created: 40,
        accepted: 9,
        byStatus: { draft: 10, sent: 15, accepted: 9, expired: 4, cancelled: 2 },
      },
    },
    trend: {
      months: MONTHS,
      series: [
        {
          currency: 'COP',
          exponent: 2,
          points: MONTHS.map((month, i) => ({
            month,
            count: i,
            amountMinor: i * 100_000_000,
          })),
        },
      ],
    },
    topNodes: [
      {
        tenantId: NODE_SUR,
        name: 'Agencia Sur',
        slug: 'agencia-sur',
        tenantType: 'agency',
        isBranch: true,
        status: 'active',
        confirmedCount: 9,
        amounts: [
          { currency: 'COP', exponent: 2, amountMinor: 1_500_000_000 },
          { currency: 'USD', exponent: 2, amountMinor: 120_000 },
        ],
      },
      {
        tenantId: NODE_ANDES,
        name: 'Andes Travel',
        slug: 'andes',
        tenantType: 'consolidator',
        isBranch: false,
        status: 'suspended',
        confirmedCount: 3,
        amounts: [{ currency: 'COP', exponent: 2, amountMinor: 350_000_000 }],
      },
    ],
    network: {
      nodes: {
        total: 24,
        active: 22,
        suspended: 2,
        archived: 0,
        consolidators: 2,
        agencies: 14,
        branches: 3,
        subagencies: 5,
        created: 4,
      },
      users: {
        active: 87,
        suspended: 3,
        locked: 0,
        adminsWithoutMfa: 0,
        loggedInPeriod: 61,
      },
      liveSessions: 17,
    },
    wallets: [
      {
        currency: 'COP',
        exponent: 2,
        wallets: 15,
        creditLimitMinor: 9_000_000_000,
        debtMinor: 2_400_000_000,
        fundsMinor: 300_000_000,
        overlimit: 0,
        suspended: 1,
        platformCreditLimitMinor: 6_000_000_000,
        platformDebtMinor: 1_900_000_000,
      },
    ],
    attention: quietAttention(),
    providers: quietProviders(),
    ...overrides,
  };
}
