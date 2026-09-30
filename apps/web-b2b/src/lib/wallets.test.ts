import { describe, expect, it } from 'vitest';
import {
  NETWORK_HOLDS_PAGE,
  combineNetworkHolds,
  currencyName,
  financesNetwork,
  formatDay,
  formatMinor,
  formatSignedMinor,
  hasNetworkHolds,
  movementLabel,
  movementTone,
  movementsIn,
  networkHoldCurrencies,
  networkHoldStatus,
  networkHoldsEmpty,
  networkHoldsIn,
  networkOriginLabel,
  nodeFinancesNetwork,
  openNetworkHolds,
  parseAgencyWallets,
  parseDepositReports,
  parseFinancedWallets,
  parseMovements,
  parseNetworkHolds,
  parseWallet,
  pendingReportsLabel,
  reportStatus,
  sortDepositReports,
  walletCurrencies,
  walletNotice,
  walletOperates,
  walletStatus,
  type DepositReport,
  type Wallet,
} from './wallets';

const TENANT = '10000000-0000-4000-8000-000000000001';
const FINANCIER = '10000000-0000-4000-8000-000000000002';
const COP_ID = '20000000-0000-4000-8000-000000000001';
const USD_ID = '20000000-0000-4000-8000-000000000002';

function apiWallet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: USD_ID,
    tenantId: TENANT,
    currency: 'USD',
    exponent: 2,
    creditLimitMinor: 100_000,
    balanceMinor: 25_050,
    availableMinor: 125_050,
    status: 'active',
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T11:00:00.000Z',
    ...overrides,
  };
}

function wallet(overrides: Partial<Wallet> = {}): Wallet {
  const base = parseWallet(apiWallet())!;
  const merged = { ...base, ...overrides };
  return { ...merged, availableMinor: merged.balanceMinor + merged.creditLimitMinor };
}

function apiReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '30000000-0000-4000-8000-000000000001',
    portfolioId: USD_ID,
    currency: 'USD',
    exponent: 2,
    amountMinor: 50_000,
    reference: 'TRX-54223',
    depositedOn: '2026-09-28',
    notes: null,
    status: 'pending',
    reportedBy: TENANT,
    reportedByName: 'Ana Pérez',
    reportedAt: '2026-09-29T12:00:00.000Z',
    resolvedBy: null,
    resolvedByName: null,
    resolvedAt: null,
    resolutionReason: null,
    portfolioTransactionId: null,
    ...overrides,
  };
}

describe('parseWallet — una cartera del API', () => {
  it('lee la cartera y recalcula el disponible con la regla del API (saldo más cupo)', () => {
    expect(parseWallet(apiWallet({ availableMinor: 999 }))).toEqual({
      id: USD_ID,
      tenantId: TENANT,
      currency: 'USD',
      exponent: 2,
      creditLimitMinor: 100_000,
      balanceMinor: 25_050,
      availableMinor: 125_050,
      status: 'active',
      updatedAt: '2026-09-29T11:00:00.000Z',
    });
  });

  it('una moneda retirada llega con exponente null y se conserva', () => {
    expect(parseWallet(apiWallet({ exponent: null }))?.exponent).toBeNull();
  });

  it('con montos que no son enteros exactos o ids rotos, no hay cartera', () => {
    for (const bad of [
      { balanceMinor: 1.5 },
      { creditLimitMinor: '100' },
      { balanceMinor: 2 ** 60 },
      { id: 'x' },
      { currency: 'usd' },
      { exponent: 7 },
    ]) {
      expect(parseWallet(apiWallet(bad))).toBeUndefined();
    }
  });
});

describe('parseAgencyWallets — lo que ve la agencia', () => {
  it('las carteras por moneda y a quién pedirle', () => {
    const view = parseAgencyWallets({
      portfolios: [apiWallet(), apiWallet({ id: COP_ID, currency: 'COP' })],
      financier: { tenantId: FINANCIER, name: 'Consolidador Andino' },
    });
    expect(view?.portfolios.map((w) => w.currency)).toEqual(['COP', 'USD']);
    expect(view?.financier).toEqual({ tenantId: FINANCIER, name: 'Consolidador Andino' });
  });

  it('sin financiador (la raíz o un nodo suelto): null, lo gestiona Planetour', () => {
    expect(parseAgencyWallets({ portfolios: [], financier: null })?.financier).toBeNull();
  });

  it('una cartera rota se descarta sin tirar las demás; sin listado no hay vista', () => {
    const view = parseAgencyWallets({ portfolios: [apiWallet(), { id: 'x' }], financier: null });
    expect(view?.portfolios).toHaveLength(1);
    expect(parseAgencyWallets({ portfolio: apiWallet() })).toBeUndefined();
  });
});

describe('parseFinancedWallets — lo que ve quien financia', () => {
  it('el nodo, sus carteras, los pendientes y las monedas que le faltan', () => {
    const view = parseFinancedWallets({
      tenant: {
        id: TENANT,
        name: 'Agencia Sur',
        tenantType: 'agency',
        isBranch: false,
        status: 'active',
        defaultCurrency: 'COP',
      },
      portfolios: [apiWallet()],
      pendingDepositReports: 2,
      availableCurrencies: ['COP', 'EUR', 'nope'],
    });
    expect(view?.tenant.name).toBe('Agencia Sur');
    expect(view?.pendingDepositReports).toBe(2);
    expect(view?.availableCurrencies).toEqual(['COP', 'EUR']);
  });

  it('sin el nodo no hay vista', () => {
    expect(parseFinancedWallets({ portfolios: [] })).toBeUndefined();
  });
});

describe('movimientos y depósitos informados', () => {
  it('lee los movimientos con su firma y descarta los rotos', () => {
    const list = parseMovements({
      transactions: [
        {
          id: '40000000-0000-4000-8000-000000000001',
          portfolioId: USD_ID,
          currency: 'USD',
          exponent: 2,
          amountMinor: -12_000,
          transactionType: 'BOOKING_HOLD',
          referenceId: null,
          notes: 'Retención de saldo antes de reservar con el proveedor',
          createdBy: TENANT,
          createdByName: 'Ana',
          createdAt: '2026-09-29T12:00:00.000Z',
        },
        { id: 'roto' },
      ],
    });
    expect(list).toHaveLength(1);
    expect(list?.[0]?.createdByName).toBe('Ana');
  });

  it('lee los informes; una fecha con otra forma se descarta, no el informe', () => {
    const [report] = parseDepositReports({ reports: [apiReport({ depositedOn: '28/09' })] }) ?? [];
    expect(report?.depositedOn).toBeNull();
    expect(report?.reportedByName).toBe('Ana Pérez');
    expect(parseDepositReports({ reports: [apiReport({ status: 'maybe' })] })).toEqual([]);
  });

  it('los pendientes primero, y del más nuevo al más viejo', () => {
    const [a, b, c] = parseDepositReports({
      reports: [
        apiReport({
          id: '30000000-0000-4000-8000-00000000000a',
          status: 'approved',
          reportedAt: '2026-09-29T13:00:00.000Z',
        }),
        apiReport({
          id: '30000000-0000-4000-8000-00000000000b',
          reportedAt: '2026-09-27T10:00:00.000Z',
        }),
        apiReport({
          id: '30000000-0000-4000-8000-00000000000c',
          reportedAt: '2026-09-28T10:00:00.000Z',
        }),
      ],
    }) as DepositReport[];
    expect(sortDepositReports([a!, b!, c!]).map((r) => r.id.slice(-1))).toEqual(['c', 'b', 'a']);
  });
});

describe('montos', () => {
  it('con los centavos sólo si los hay, en la moneda de la cartera', () => {
    expect(formatMinor(150_000_000, 'COP', 2)).toMatch(/1\.500\.000$/);
    expect(formatMinor(150_000_050, 'COP', 2)).toMatch(/1\.500\.000,50$/);
    expect(formatMinor(50_000, 'USD', 2)).toMatch(/US\$\s?500$/);
  });

  it('con signo escrito: + acredita, − debita', () => {
    expect(formatSignedMinor(1_000, 'USD', 2)).toMatch(/^\+US\$\s?10$/);
    expect(formatSignedMinor(-1_000, 'USD', 2)).toMatch(/^−US\$\s?10$/);
  });

  it('un código que Intl no conoce no rompe la pantalla', () => {
    expect(formatMinor(1_050, 'ZZZ', 2)).toContain('10,50');
  });

  it('el nombre de la moneda en castellano, o el código', () => {
    expect(currencyName('USD')).toMatch(/^Dólar/);
    expect(currencyName('ZZZ')).toBe('ZZZ');
  });

  it('el día del depósito no se corre con la zona horaria', () => {
    expect(formatDay('2026-09-01')).toMatch(/1 .*sept.*2026|1\/09\/2026/);
  });
});

describe('estados y avisos', () => {
  it('cada estado dicho con palabras', () => {
    expect(walletStatus('active')).toEqual({ label: 'Activa', tone: 'success' });
    expect(walletStatus('suspended').label).toBe('Suspendida');
    expect(walletStatus('otro').label).toBe('otro');
    expect(reportStatus('pending').label).toBe('Pendiente');
    expect(reportStatus('rejected').tone).toBe('danger');
  });

  it('sólo una cartera activa reserva', () => {
    expect(walletOperates({ status: 'active' })).toBe(true);
    expect(walletOperates({ status: 'suspended' })).toBe(false);
    expect(walletOperates({ status: 'overlimit' })).toBe(false);
  });

  it('suspendida antes que sin fondos; excedida; sin saldo ni cupo; y sin aviso si reserva', () => {
    expect(
      walletNotice(wallet({ status: 'suspended', balanceMinor: -1, creditLimitMinor: 0 }))?.text,
    ).toMatch(/Suspendida: no se puede reservar en USD/);
    expect(walletNotice(wallet({ balanceMinor: -200, creditLimitMinor: 100 }))?.text).toMatch(
      /Se pasó del cupo/,
    );
    expect(walletNotice(wallet({ balanceMinor: 0, creditLimitMinor: 0 }))?.text).toMatch(
      /Sin saldo ni cupo/,
    );
    expect(walletNotice(wallet())).toBeUndefined();
  });

  it('los movimientos con su nombre; la retención en su propio tono', () => {
    expect(movementLabel('DEPOSIT_PAYMENT')).toBe('Depósito');
    expect(movementLabel('BOOKING_RELEASED')).toBe('Retención liberada');
    expect(movementLabel('ALGO_NUEVO')).toBe('Movimiento');
    expect(movementTone({ amountMinor: -5, transactionType: 'BOOKING_HOLD' })).toBe('warning');
    expect(movementTone({ amountMinor: -5, transactionType: 'MANUAL_ADJUSTMENT' })).toBe('danger');
    expect(movementTone({ amountMinor: 5, transactionType: 'DEPOSIT_PAYMENT' })).toBe('success');
  });

  it('el título de los pendientes, en singular y plural', () => {
    expect(pendingReportsLabel(0)).toMatch(/Ningún/);
    expect(pendingReportsLabel(1)).toBe('1 depósito informado espera revisión.');
    expect(pendingReportsLabel(3)).toBe('3 depósitos informados esperan revisión.');
  });

  it('filtra los movimientos por moneda', () => {
    const list = parseMovements({
      transactions: ['USD', 'COP'].map((currency, i) => ({
        id: `40000000-0000-4000-8000-00000000000${i}`,
        portfolioId: USD_ID,
        currency,
        exponent: 2,
        amountMinor: 1,
        transactionType: 'DEPOSIT_PAYMENT',
        createdAt: '2026-09-29T12:00:00.000Z',
      })),
    })!;
    expect(movementsIn(list, 'COP').map((m) => m.currency)).toEqual(['COP']);
    expect(movementsIn(list, 'all')).toHaveLength(2);
    expect(
      walletCurrencies([{ currency: 'USD' }, { currency: 'COP' }, { currency: 'USD' }]),
    ).toEqual(['COP', 'USD']);
  });
});

// ───────────────────────────── Reservas de la red (0060) ─────────────────────────────

const ORIGIN = '10000000-0000-4000-8000-00000000000A';
const LEVEL_ID = '60000000-0000-4000-8000-000000000001';

function apiNetworkMovement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '40000000-0000-4000-8000-000000000009',
    portfolioId: USD_ID,
    currency: 'USD',
    exponent: 2,
    amountMinor: -113_400,
    transactionType: 'NETWORK_HOLD',
    referenceId: null,
    notes: 'Retención por una reserva de tu red',
    createdBy: null,
    createdByName: null,
    network: {
      originTenantId: ORIGIN,
      originTenantName: 'Agencia Sur',
      orderNumber: 1042,
      status: 'held',
    },
    createdAt: '2026-09-29T12:00:00.000Z',
    ...overrides,
  };
}

function apiNetworkHold(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    levelId: LEVEL_ID,
    currency: 'USD',
    exponent: 2,
    amountMinor: 113_400,
    status: 'held',
    originTenantId: ORIGIN,
    originTenantName: 'Agencia Sur',
    orderNumber: 1042,
    createdAt: '2026-09-29T12:00:00.000Z',
    updatedAt: '2026-09-29T12:05:00.000Z',
    ...overrides,
  };
}

describe('asientos de la red en los movimientos', () => {
  it('lee de qué agencia y qué reserva viene, sin quién la vendió', () => {
    const [m] = parseMovements({ transactions: [apiNetworkMovement()] }) ?? [];
    expect(m?.network).toEqual({
      originTenantId: ORIGIN.toLowerCase(),
      originTenantName: 'Agencia Sur',
      orderNumber: 1042,
      status: 'held',
    });
    expect(m?.createdByName).toBeNull();
  });

  it('aunque el API mandara la firma o la orden ajena, un asiento de la red no las muestra', () => {
    const [m] =
      parseMovements({
        transactions: [
          apiNetworkMovement({
            createdByName: 'Vendedor de otra agencia',
            referenceId: '70000000-0000-4000-8000-000000000001',
          }),
        ],
      }) ?? [];
    expect(m?.createdByName).toBeNull();
    expect(m?.referenceId).toBeNull();
  });

  it('para el personal que no administra, el API no manda la reserva: el asiento igual se lee', () => {
    const [m] = parseMovements({ transactions: [apiNetworkMovement({ network: null })] }) ?? [];
    expect(m?.transactionType).toBe('NETWORK_HOLD');
    expect(m?.network).toBeNull();
  });

  it('una reserva de la red rota se descarta sin tirar el asiento', () => {
    for (const network of [
      { originTenantId: 'x', status: 'held' },
      { originTenantId: ORIGIN, status: 'maybe' },
      'Agencia Sur',
    ]) {
      const [m] = parseMovements({ transactions: [apiNetworkMovement({ network })] }) ?? [];
      expect(m?.network).toBeNull();
    }
    const [m] =
      parseMovements({
        transactions: [
          apiNetworkMovement({
            network: {
              originTenantId: ORIGIN,
              originTenantName: ' ',
              orderNumber: -3,
              status: 'captured',
            },
          }),
        ],
      }) ?? [];
    expect(m?.network).toMatchObject({ originTenantName: null, orderNumber: null });
  });

  it('la reserva de la red sólo va en los asientos NETWORK_*', () => {
    const [m] =
      parseMovements({
        transactions: [
          apiNetworkMovement({ transactionType: 'BOOKING_HOLD', createdByName: 'Ana' }),
        ],
      }) ?? [];
    expect(m?.network).toBeNull();
    expect(m?.createdByName).toBe('Ana');
  });

  it('su nombre y su tono: la retención de la red se ve como retención, la liberación suma', () => {
    expect(movementLabel('NETWORK_HOLD')).toBe('Retención de tu red');
    expect(movementLabel('NETWORK_RELEASED')).toBe('Retención de tu red liberada');
    expect(movementTone({ amountMinor: -5, transactionType: 'NETWORK_HOLD' })).toBe('warning');
    expect(movementTone({ amountMinor: 5, transactionType: 'NETWORK_RELEASED' })).toBe('success');
  });
});

describe('parseNetworkHolds — las reservas de la red en las carteras del nodo', () => {
  it('lee cada reserva y los totales por moneda, en orden alfabético', () => {
    const view = parseNetworkHolds({
      items: [apiNetworkHold()],
      totals: [
        { currency: 'USD', exponent: 2, heldMinor: 113_400, chargedMinor: 0 },
        { currency: 'COP', exponent: 2, heldMinor: 0, chargedMinor: 5_000_000 },
      ],
    });
    expect(view?.items).toEqual([
      {
        levelId: LEVEL_ID,
        currency: 'USD',
        exponent: 2,
        amountMinor: 113_400,
        status: 'held',
        originTenantId: ORIGIN.toLowerCase(),
        originTenantName: 'Agencia Sur',
        orderNumber: 1042,
        createdAt: '2026-09-29T12:00:00.000Z',
        updatedAt: '2026-09-29T12:05:00.000Z',
      },
    ]);
    expect(view?.totals.map((t) => t.currency)).toEqual(['COP', 'USD']);
  });

  it('descarta las reservas rotas: monto no positivo o no entero, estado o ids desconocidos', () => {
    const view = parseNetworkHolds({
      items: [
        apiNetworkHold(),
        apiNetworkHold({ amountMinor: 0 }),
        apiNetworkHold({ amountMinor: -10 }),
        apiNetworkHold({ amountMinor: 1.5 }),
        apiNetworkHold({ status: 'pending' }),
        apiNetworkHold({ levelId: 'x' }),
        apiNetworkHold({ originTenantId: null }),
        apiNetworkHold({ currency: 'usd' }),
      ],
      totals: [{ currency: 'USD', exponent: 2, heldMinor: -1, chargedMinor: 0 }],
    });
    expect(view?.items).toHaveLength(1);
    expect(view?.totals).toEqual([]);
  });

  it('sin listado no hay vista; sin totales, la lista sale igual y sin totales inventados', () => {
    expect(parseNetworkHolds({ totals: [] })).toBeUndefined();
    expect(parseNetworkHolds(null)).toBeUndefined();
    expect(parseNetworkHolds({ items: [apiNetworkHold()] })?.totals).toEqual([]);
  });

  it('nunca deja pasar lo que no es de este nivel: ni el vendedor ni el precio de venta', () => {
    const view = parseNetworkHolds({
      items: [apiNetworkHold({ sellerName: 'Ana Vendedora', saleAmountMinor: 139_709 })],
      totals: [],
    });
    expect(JSON.stringify(view)).not.toMatch(/Ana Vendedora|139709|sellerName|sale/);
  });

  it('un nombre o un número de reserva que no se pueden leer se dicen genéricos', () => {
    const [h] =
      parseNetworkHolds({ items: [apiNetworkHold({ originTenantName: '', orderNumber: '12' })] })
        ?.items ?? [];
    expect(h).toMatchObject({ originTenantName: null, orderNumber: null });
    expect(networkOriginLabel(h!)).toBe('Una agencia de tu red');
  });
});

describe('las reservas de la red en pantalla', () => {
  it('cada estado con palabras y su tono: nunca sólo el color', () => {
    expect(networkHoldStatus('held')).toEqual({ label: 'Retenida', tone: 'warning' });
    expect(networkHoldStatus('captured')).toEqual({ label: 'Cobrada', tone: 'neutral' });
    expect(networkHoldStatus('released')).toEqual({ label: 'Liberada', tone: 'success' });
    expect(networkHoldStatus('conflict')).toEqual({ label: 'En revisión', tone: 'danger' });
  });

  it('de dónde viene: la agencia y el número de reserva', () => {
    expect(networkOriginLabel({ originTenantName: 'Agencia Sur', orderNumber: 1042 })).toBe(
      'Agencia Sur · Reserva #1042',
    );
    expect(networkOriginLabel({ originTenantName: 'Agencia Sur', orderNumber: null })).toBe(
      'Agencia Sur',
    );
    expect(networkOriginLabel({ originTenantName: null, orderNumber: 7 })).toBe(
      'Una agencia de tu red · Reserva #7',
    );
  });

  it('abiertas son las retenidas y las que están en revisión', () => {
    expect(
      openNetworkHolds([
        { status: 'held' },
        { status: 'conflict' },
        { status: 'captured' },
        { status: 'released' },
      ]),
    ).toBe(2);
  });

  it('se filtran por moneda con sus totales; las monedas salen de ambas listas', () => {
    const holds = parseNetworkHolds({
      items: [
        apiNetworkHold(),
        apiNetworkHold({ levelId: '60000000-0000-4000-8000-000000000002', currency: 'COP' }),
      ],
      totals: [{ currency: 'EUR', exponent: 2, heldMinor: 1, chargedMinor: 0 }],
    })!;
    expect(networkHoldCurrencies(holds)).toEqual(['COP', 'EUR', 'USD']);
    const usd = networkHoldsIn(holds, 'USD');
    expect(usd.items.map((h) => h.currency)).toEqual(['USD']);
    expect(usd.totals).toEqual([]);
    expect(networkHoldsIn(holds, 'all')).toBe(holds);
  });

  it('financian a una red los consolidadores y las agencias (sucursales incluidas)', () => {
    expect(financesNetwork({ tenantType: 'consolidator' })).toBe(true);
    expect(financesNetwork({ tenantType: 'agency' })).toBe(true);
    expect(financesNetwork({ tenantType: 'subagency' })).toBe(false);
    expect(financesNetwork({ tenantType: 'platform' })).toBe(false);
  });

  it('financia a una red el nodo de un tipo que financia y con nodos colgando de él', () => {
    const network = {
      tenants: [
        { id: FINANCIER, tenantType: 'consolidator', parentTenantId: null },
        { id: ORIGIN, tenantType: 'subagency', parentTenantId: FINANCIER.toUpperCase() },
      ],
    };
    expect(nodeFinancesNetwork(network, FINANCIER.toUpperCase())).toBe(true);
    expect(nodeFinancesNetwork(network, ORIGIN)).toBe(false);
    expect(nodeFinancesNetwork(network, TENANT)).toBe(false);
    expect(nodeFinancesNetwork({ tenants: 'x' }, FINANCIER)).toBe(false);
    expect(nodeFinancesNetwork(null, FINANCIER)).toBe(false);
  });

  it('una agencia sin sub-agencias no tiene red, aunque su tipo financie', () => {
    const alone = { tenants: [{ id: TENANT, tenantType: 'agency', parentTenantId: FINANCIER }] };
    expect(nodeFinancesNetwork(alone, TENANT)).toBe(false);
  });

  it('hay algo de la red si hay filas o totales', () => {
    expect(hasNetworkHolds(null)).toBe(false);
    expect(hasNetworkHolds({ items: [], totals: [] })).toBe(false);
    expect(
      hasNetworkHolds({
        items: [],
        totals: [{ currency: 'USD', exponent: 2, heldMinor: 0, chargedMinor: 1 }],
      }),
    ).toBe(true);
  });
});

describe('la lista de la red cuando el API la corta (NETWORK_HOLDS_LIMIT)', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  // Los 200 más nuevos, todos cobrados o liberados: una red que vende llena la página así.
  const recent = parseNetworkHolds({
    items: Array.from({ length: NETWORK_HOLDS_PAGE }, (_, i) =>
      apiNetworkHold({
        levelId: uuid(i + 1),
        status: i % 2 === 0 ? 'captured' : 'released',
        orderNumber: 2000 - i,
        createdAt: '2026-09-29T10:00:00.000Z',
      }),
    ),
    // El API suma los totales sobre todos los niveles, también los de fuera de la página.
    totals: [
      { currency: 'EUR', exponent: 2, heldMinor: 800_00, chargedMinor: 0 },
      { currency: 'USD', exponent: 2, heldMinor: 1_050_00, chargedMinor: 100 * 100_00 },
    ],
  })!;
  // Más viejas que la página: una en revisión en USD y una retenida en EUR.
  const conflict = parseNetworkHolds({
    items: [
      apiNetworkHold({
        levelId: uuid(900),
        status: 'conflict',
        amountMinor: 1_050_00,
        createdAt: '2026-08-01T10:00:00.000Z',
      }),
    ],
    totals: recent.totals,
  })!;
  const held = parseNetworkHolds({
    items: [
      apiNetworkHold({
        levelId: uuid(901),
        currency: 'EUR',
        status: 'held',
        amountMinor: 800_00,
        createdAt: '2026-08-02T10:00:00.000Z',
      }),
    ],
    totals: recent.totals,
  })!;

  it('sólo con la página, las abiertas no se ven aunque los totales las sumen', () => {
    expect(openNetworkHolds(recent.items)).toBe(0);
    expect(networkHoldsIn(recent, 'EUR').items).toHaveLength(0);
  });

  it('con las abiertas pedidas aparte, el contador y la lista las muestran, primero la en revisión', () => {
    const view = combineNetworkHolds(recent, [held, conflict]);
    expect(openNetworkHolds(view.items)).toBe(2);
    expect(view.items.slice(0, 2).map((h) => h.status)).toEqual(['conflict', 'held']);
    expect(view.items).toHaveLength(NETWORK_HOLDS_PAGE + 2);
    expect(view.totals).toBe(recent.totals);
    expect(view.truncated).toBe(true);
    const eur = networkHoldsIn(view, 'EUR');
    expect(eur.items.map((h) => h.status)).toEqual(['held']);
    expect(eur.truncated).toBe(true);
  });

  it('una reserva que vino en dos listas se muestra una vez, en su versión más reciente', () => {
    const sameLevel = apiNetworkHold({ updatedAt: '2026-09-29T12:05:00.000Z' });
    const stale = parseNetworkHolds({ items: [sameLevel], totals: [] })!;
    const fresh = parseNetworkHolds({
      items: [{ ...sameLevel, status: 'conflict', updatedAt: '2026-09-29T13:00:00.000Z' }],
      totals: [],
    })!;
    const view = combineNetworkHolds(stale, [fresh]);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.status).toBe('conflict');
    expect(view.truncated).toBe(false);
  });

  it('con la lista cortada, una moneda sin filas no se dice red vacía', () => {
    expect(networkHoldsEmpty({ truncated: true }, 'vacío', 'texto')).toEqual({
      emptyTitle: 'No hay reservas recientes en esta moneda.',
      emptyText: 'Lo que suman los totales es de reservas más viejas, ya cobradas.',
    });
    expect(networkHoldsEmpty({}, 'vacío', 'texto')).toEqual({
      emptyTitle: 'vacío',
      emptyText: 'texto',
    });
  });
});
