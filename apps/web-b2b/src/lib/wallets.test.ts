import { describe, expect, it } from 'vitest';
import {
  currencyName,
  formatDay,
  formatMinor,
  formatSignedMinor,
  movementLabel,
  movementTone,
  movementsIn,
  parseAgencyWallets,
  parseDepositReports,
  parseFinancedWallets,
  parseMovements,
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
