import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import { PortfoliosService } from './portfolios.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER = '22222222-2222-4222-8222-2222222222aa';
const USER = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-28T12:00:00.000Z');

interface FakeState {
  order: {
    id: string;
    tenant_id: string;
    status: string;
    total_amount: number;
    currency: string;
  } | null;
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

function copyState(state: FakeState): FakeState {
  return {
    order: state.order ? { ...state.order } : null,
    portfolio: state.portfolio ? { ...state.portfolio } : null,
    transactions: state.transactions.map((transaction) => ({ ...transaction })),
  };
}

/**
 * Banco transaccional mínimo para estas pruebas. Serializa commits como Postgres sobre el índice
 * único y sólo publica el estado local cuando el callback termina: un error revierte claim y saldo.
 */
function fakeDatabase(initial: Partial<FakeState> = {}): {
  db: DatabaseService;
  state: FakeState;
} {
  const state: FakeState = {
    order: {
      id: ORDER,
      tenant_id: TENANT,
      status: 'confirmed',
      total_amount: 125_000,
      currency: 'COP',
    },
    portfolio: {
      id: '44444444-4444-4444-8444-444444444444',
      tenant_id: TENANT,
      credit_limit_minor: 0,
      balance_minor: 500_000,
      currency: 'COP',
      status: 'active',
      created_at: NOW,
      updated_at: NOW,
    },
    transactions: [],
    ...initial,
  };

  let mutex = Promise.resolve();
  const db = {
    withTenant: async <T>(tenantId: string, callback: (trx: unknown) => Promise<T>): Promise<T> => {
      let release!: () => void;
      const unlocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const previous = mutex;
      mutex = previous.then(() => unlocked);
      await previous;

      const local = copyState(state);
      let insertedHoldAmount: number | null = null;

      const selectFrom = (table: string) => {
        const filters: Array<[string, unknown]> = [];
        const query = {
          select: () => query,
          selectAll: () => query,
          forUpdate: () => query,
          where: (column: unknown, _operator?: unknown, value?: unknown) => {
            if (typeof column === 'string') filters.push([column, value]);
            return query;
          },
          executeTakeFirst: () => {
            const row = table === 'orders' ? local.order : local.portfolio;
            if (!row) return Promise.resolve(undefined);
            const matchesTenantContext = row.tenant_id === tenantId;
            const matchesFilters = filters.every(([column, value]) =>
              column in row
                ? column === 'id'
                  ? String((row as unknown as Record<string, unknown>)[column]).toLowerCase() ===
                    String(value).toLowerCase()
                  : (row as unknown as Record<string, unknown>)[column] === value
                : true,
            );
            return Promise.resolve(matchesTenantContext && matchesFilters ? row : undefined);
          },
        };
        return query;
      };

      const insertInto = (table: string) => {
        let values: Record<string, unknown> | null = null;
        const query = {
          values: (next: Record<string, unknown>) => {
            values = next;
            return query;
          },
          returningAll: () => query,
          executeTakeFirstOrThrow: () => {
            if (table !== 'portfolio_transactions' || !values) {
              throw new Error(`Unexpected insert into ${table}`);
            }
            if (
              values['transaction_type'] === 'BOOKING_HOLD' &&
              local.transactions.some(
                (transaction) =>
                  transaction.transaction_type === 'BOOKING_HOLD' &&
                  transaction.reference_id?.toLowerCase() ===
                    String(values?.['reference_id']).toLowerCase(),
              )
            ) {
              throw Object.assign(new Error('duplicate active BOOKING_HOLD'), { code: '23505' });
            }
            insertedHoldAmount = Math.abs(Number(values['amount_minor']));
            const referenceId = values['reference_id'];
            const notes = values['notes'];
            if (referenceId !== null && typeof referenceId !== 'string') {
              throw new Error('reference_id must be a string or null');
            }
            if (notes !== null && typeof notes !== 'string') {
              throw new Error('notes must be a string or null');
            }
            const row = {
              id: `hold-${local.transactions.length + 1}`,
              portfolio_id: String(values['portfolio_id']),
              amount_minor: Number(values['amount_minor']),
              transaction_type: String(values['transaction_type']),
              reference_id: referenceId,
              idempotency_key: null,
              notes,
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
        const filters: Array<[string, unknown]> = [];
        const query = {
          set: () => query,
          where: (column: unknown, _operator?: unknown, value?: unknown) => {
            if (typeof column === 'string') filters.push([column, value]);
            return query;
          },
          returningAll: () => query,
          executeTakeFirst: () => {
            if (table !== 'agency_portfolios' || !local.portfolio) {
              return Promise.resolve(undefined);
            }
            const matchesFilters = filters.every(
              ([column, value]) =>
                (local.portfolio as unknown as Record<string, unknown>)[column] === value,
            );
            const amount = insertedHoldAmount ?? 0;
            const available = local.portfolio.balance_minor + local.portfolio.credit_limit_minor;
            if (!matchesFilters || available < amount) return Promise.resolve(undefined);
            local.portfolio.balance_minor -= amount;
            return Promise.resolve(local.portfolio);
          },
        };
        return query;
      };

      try {
        const result = await callback({ selectFrom, insertInto, updateTable });
        state.order = local.order;
        state.portfolio = local.portfolio;
        state.transactions = local.transactions;
        return result;
      } finally {
        release();
      }
    },
  } as unknown as DatabaseService;

  return { db, state };
}

function harness(initial: Partial<FakeState> = {}) {
  const bank = fakeDatabase(initial);
  const service = new PortfoliosService(bank.db, {} as FlightProviderRegistry, {} as OrdersService);
  return { service, state: bank.state };
}

describe('PortfoliosService.holdBooking', () => {
  it('deriva monto y moneda de la orden; los valores del cliente son sólo expectativas', async () => {
    const h = harness();

    const result = await h.service.holdBooking(TENANT, ORDER, USER, {
      amountMinor: 125_000,
      currency: ' cop ',
    });

    expect(result.transaction.amount_minor).toBe(-125_000);
    expect(result.portfolio.balance_minor).toBe(375_000);
    expect(h.state.transactions).toHaveLength(1);
  });

  it('persiste el UUID canónico devuelto por orders, no el casing recibido', async () => {
    const h = harness();

    await h.service.holdBooking(TENANT, ORDER.toUpperCase(), USER);

    expect(h.state.transactions[0]?.reference_id).toBe(ORDER);
  });

  it('rechaza un monto esperado manipulado sin crear el hold ni tocar el balance', async () => {
    const h = harness();

    await expect(h.service.holdBooking(TENANT, ORDER, USER, { amountMinor: 1 })).rejects.toThrow(
      /total de la reserva cambió/i,
    );

    expect(h.state.portfolio?.balance_minor).toBe(500_000);
    expect(h.state.transactions).toHaveLength(0);
  });

  it('exige que la orden pertenezca al tenant y esté confirmada, no pendiente o emitida', async () => {
    const foreign = harness();
    await expect(foreign.service.holdBooking(OTHER_TENANT, ORDER, USER)).rejects.toThrow(
      /no se encontró la reserva/i,
    );

    for (const status of ['pending', 'ticketed', 'cancelled', 'failed']) {
      const h = harness({
        order: {
          id: ORDER,
          tenant_id: TENANT,
          status,
          total_amount: 125_000,
          currency: 'COP',
        },
      });
      await expect(h.service.holdBooking(TENANT, ORDER, USER)).rejects.toThrow(
        /sólo una reserva confirmada/i,
      );
      expect(h.state.transactions).toHaveLength(0);
    }
  });

  it('no convierte USD en COP: una cartera en otra moneda falla antes del débito', async () => {
    const h = harness({
      order: {
        id: ORDER,
        tenant_id: TENANT,
        status: 'confirmed',
        total_amount: 125_000,
        currency: 'USD',
      },
    });

    await expect(h.service.holdBooking(TENANT, ORDER, USER)).rejects.toThrow(
      /cartera está en COP y la reserva en USD/i,
    );
    expect(h.state.portfolio?.balance_minor).toBe(500_000);
    expect(h.state.transactions).toHaveLength(0);
  });

  it('revierte el claim cuando el saldo más el cupo no alcanza', async () => {
    const h = harness({
      portfolio: {
        id: '44444444-4444-4444-8444-444444444444',
        tenant_id: TENANT,
        credit_limit_minor: 10_000,
        balance_minor: 100_000,
        currency: 'COP',
        status: 'active',
        created_at: NOW,
        updated_at: NOW,
      },
    });

    await expect(h.service.holdBooking(TENANT, ORDER, USER)).rejects.toThrow(/saldo insuficiente/i);
    expect(h.state.portfolio?.balance_minor).toBe(100_000);
    expect(h.state.transactions).toHaveLength(0);
  });

  it('ante dos requests concurrentes crea un solo hold y debita exactamente una vez', async () => {
    const h = harness();

    const results = await Promise.allSettled([
      h.service.holdBooking(TENANT, ORDER, USER),
      h.service.holdBooking(TENANT, ORDER, USER),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status !== 'rejected') throw new Error('Expected one rejected hold');
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(h.state.transactions).toHaveLength(1);
    expect(h.state.portfolio?.balance_minor).toBe(375_000);
  });
});
