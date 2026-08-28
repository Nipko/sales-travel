import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { PortfoliosService } from './portfolios.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const KEY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-08-28T12:00:00.000Z');

interface LedgerState {
  portfolio: {
    id: string;
    tenant_id: string;
    credit_limit_minor: number;
    balance_minor: number;
    currency: string;
    status: string;
    created_at: Date;
    updated_at: Date;
  } | null;
  transactions: Array<{
    id: string;
    portfolio_id: string;
    amount_minor: number;
    transaction_type: string;
    reference_id: string | null;
    idempotency_key: string | null;
    notes: string | null;
    created_by: string;
    created_at: Date;
  }>;
}

function copy(state: LedgerState): LedgerState {
  return {
    portfolio: state.portfolio ? { ...state.portfolio } : null,
    transactions: state.transactions.map((transaction) => ({ ...transaction })),
  };
}

function bank(options?: { balance?: number; credit?: number; portfolio?: boolean }) {
  const state: LedgerState = {
    portfolio:
      options?.portfolio === false
        ? null
        : {
            id: '44444444-4444-4444-8444-444444444444',
            tenant_id: TENANT,
            credit_limit_minor: options?.credit ?? 0,
            balance_minor: options?.balance ?? 100_000,
            currency: 'COP',
            status: 'active',
            created_at: NOW,
            updated_at: NOW,
          },
    transactions: [],
  };
  let mutex = Promise.resolve();
  let portfolioInserts = 0;
  let withTenantCalls = 0;

  const db = {
    withTenant: async <T>(tenantId: string, callback: (trx: unknown) => Promise<T>): Promise<T> => {
      withTenantCalls += 1;
      let release!: () => void;
      const unlocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const previous = mutex;
      mutex = previous.then(() => unlocked);
      await previous;

      const local = copy(state);
      let mutationAmount: number | null = null;

      const selectFrom = (table: string) => {
        const filters = new Map<string, unknown>();
        const query = {
          selectAll: () => query,
          where: (column: unknown, _operator?: unknown, value?: unknown) => {
            if (typeof column === 'string') filters.set(column, value);
            return query;
          },
          executeTakeFirst: () => {
            if (table === 'agency_portfolios') {
              return Promise.resolve(
                local.portfolio?.tenant_id === tenantId ? local.portfolio : undefined,
              );
            }
            if (table === 'portfolio_transactions') {
              return Promise.resolve(
                local.transactions.find(
                  (transaction) =>
                    transaction.portfolio_id === filters.get('portfolio_id') &&
                    transaction.idempotency_key === filters.get('idempotency_key'),
                ),
              );
            }
            throw new Error(`Unexpected select from ${table}`);
          },
          executeTakeFirstOrThrow: async () => {
            const row = await query.executeTakeFirst();
            if (!row) throw new Error(`Missing ${table}`);
            return row;
          },
        };
        return query;
      };

      const insertInto = (table: string) => {
        let values: Record<string, unknown> | undefined;
        const query = {
          values: (next: Record<string, unknown>) => {
            values = next;
            return query;
          },
          onConflict: (
            callback: (builder: { column: () => { doNothing: () => unknown } }) => unknown,
          ) => {
            callback({ column: () => ({ doNothing: () => query }) });
            return query;
          },
          returningAll: () => query,
          executeTakeFirst: () => {
            if (!values) throw new Error('insert without values');
            if (table !== 'agency_portfolios')
              throw new Error(`Unexpected optional insert ${table}`);
            if (local.portfolio) return Promise.resolve(undefined);
            portfolioInserts += 1;
            local.portfolio = {
              id: '44444444-4444-4444-8444-444444444444',
              tenant_id: String(values['tenant_id']),
              credit_limit_minor: Number(values['credit_limit_minor']),
              balance_minor: Number(values['balance_minor']),
              currency: String(values['currency']),
              status: String(values['status']),
              created_at: NOW,
              updated_at: NOW,
            };
            return Promise.resolve(local.portfolio);
          },
          executeTakeFirstOrThrow: () => {
            if (!values || table !== 'portfolio_transactions' || !local.portfolio) {
              throw new Error(`Unexpected required insert ${table}`);
            }
            const key = String(values['idempotency_key']);
            if (local.transactions.some((transaction) => transaction.idempotency_key === key)) {
              throw Object.assign(new Error('duplicate idempotency key'), { code: '23505' });
            }
            mutationAmount = Number(values['amount_minor']);
            const row = {
              id: `tx-${local.transactions.length + 1}`,
              portfolio_id: String(values['portfolio_id']),
              amount_minor: mutationAmount,
              transaction_type: String(values['transaction_type']),
              reference_id: null,
              idempotency_key: key,
              notes: String(values['notes']),
              created_by: String(values['created_by']),
              created_at: NOW,
            };
            local.transactions.push(row);
            return Promise.resolve(row);
          },
        };
        return query;
      };

      const updateTable = (table: string) => {
        const query = {
          set: () => query,
          where: () => query,
          returningAll: () => query,
          executeTakeFirst: () => {
            if (table !== 'agency_portfolios' || !local.portfolio || mutationAmount === null) {
              return Promise.resolve(undefined);
            }
            if (
              mutationAmount < 0 &&
              (local.portfolio.status !== 'active' ||
                local.portfolio.balance_minor + local.portfolio.credit_limit_minor <
                  -mutationAmount)
            ) {
              return Promise.resolve(undefined);
            }
            local.portfolio.balance_minor += mutationAmount;
            return Promise.resolve(local.portfolio);
          },
        };
        return query;
      };

      try {
        const result = await callback({ selectFrom, insertInto, updateTable });
        state.portfolio = local.portfolio;
        state.transactions = local.transactions;
        return result;
      } finally {
        release();
      }
    },
  } as unknown as DatabaseService;

  return {
    service: new PortfoliosService(db, {} as FlightProviderRegistry, {} as OrdersService),
    state,
    portfolioInserts: () => portfolioInserts,
    withTenantCalls: () => withTenantCalls,
  };
}

describe('depósitos y retiros idempotentes', () => {
  it('dos requests con la misma clave acreditan una sola vez y devuelven el mismo asiento', async () => {
    const h = bank();

    const [first, retry] = await Promise.all([
      h.service.deposit(TENANT, 50_000, USER, KEY_A, 'transferencia 1'),
      h.service.deposit(TENANT, 50_000, USER, KEY_A, 'transferencia 1'),
    ]);

    expect(first.transaction.id).toBe(retry.transaction.id);
    expect(h.state.portfolio?.balance_minor).toBe(150_000);
    expect(h.state.transactions).toHaveLength(1);
  });

  it('no permite reciclar una clave para otro monto, tipo o contenido', async () => {
    const h = bank();
    await h.service.deposit(TENANT, 50_000, USER, KEY_A, 'transferencia 1');

    await expect(h.service.deposit(TENANT, 60_000, USER, KEY_A, 'transferencia 1')).rejects.toEqual(
      expect.any(ConflictException),
    );
    await expect(
      h.service.withdraw(TENANT, 50_000, USER, KEY_A, 'transferencia 1'),
    ).rejects.toEqual(expect.any(ConflictException));

    expect(h.state.portfolio?.balance_minor).toBe(150_000);
    expect(h.state.transactions).toHaveLength(1);
  });

  it('dos retiros concurrentes distintos no pueden gastar el mismo saldo', async () => {
    const h = bank({ balance: 100_000 });

    const results = await Promise.allSettled([
      h.service.withdraw(TENANT, 80_000, USER, KEY_A),
      h.service.withdraw(TENANT, 80_000, USER, KEY_B),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(h.state.portfolio?.balance_minor).toBe(20_000);
    expect(h.state.transactions).toHaveLength(1);
  });

  it('crea una sola cartera ante primer acceso concurrente usando ON CONFLICT/relectura', async () => {
    const h = bank({ portfolio: false });

    const [first, second] = await Promise.all([
      h.service.getPortfolio(TENANT),
      h.service.getPortfolio(TENANT),
    ]);

    expect(first.id).toBe(second.id);
    expect(h.portfolioInserts()).toBe(1);
    expect(h.withTenantCalls()).toBe(2);
  });

  it.each([0, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rechaza un monto no positivo/no-safe (%s) antes de abrir la transacción',
    async (amount) => {
      const h = bank();
      await expect(h.service.deposit(TENANT, amount, USER, KEY_A)).rejects.toThrow(/safe integer/i);
      expect(h.withTenantCalls()).toBe(0);
    },
  );
});
