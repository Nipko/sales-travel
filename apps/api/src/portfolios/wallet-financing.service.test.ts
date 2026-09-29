import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import { PortfolioConflictError, PortfolioForbiddenError } from './portfolio-errors.js';
import { WALLET_EVENTS, WalletFinancingService } from './wallet-financing.service.js';

/**
 * Lo que decide `WalletFinancingService` sin Postgres: que pregunta si quien actúa financia al nodo
 * antes de escribir, que un depósito o un ajuste reclaman su Idempotency-Key antes de tocar el saldo
 * (y un reenvío no acredita dos veces), y que cada cambio deja su `domain_event` en la misma
 * transacción. La SQL real, la RLS y las guardas de 0052 como `app_user` las prueba
 * `wallet-financing.integration.test.ts`.
 */

const AGENCIA = '11111111-1111-4111-8111-111111111111';
const CONSOLIDADOR_ADMIN = '33333333-3333-4333-8333-333333333333';
const OTRO_ADMIN = '44444444-4444-4444-8444-444444444444';
const CARTERA = '55555555-5555-4555-8555-555555555555';
const KEY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-09-29T12:00:00.000Z');

interface Wallet {
  id: string;
  tenant_id: string;
  credit_limit_minor: number;
  balance_minor: number;
  currency: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface Entry {
  id: string;
  portfolio_id: string;
  amount_minor: number;
  transaction_type: string;
  reference_id: string | null;
  idempotency_key: string | null;
  notes: string | null;
  created_by: string;
  created_at: Date;
}

interface State {
  wallet: Wallet;
  entries: Entry[];
}

/**
 * Banco transaccional mínimo: serializa las transacciones (como el FOR UPDATE de la cartera) y sólo
 * publica el estado si el callback termina, así un error revierte asiento y saldo. `financiers` son
 * los usuarios para los que `can_finance_tenant` da true.
 */
function banco(opts: { financiers?: string[]; balance?: number; credit?: number } = {}) {
  const financiers = new Set(opts.financiers ?? [CONSOLIDADOR_ADMIN]);
  const state: State = {
    wallet: {
      id: CARTERA,
      tenant_id: AGENCIA,
      credit_limit_minor: opts.credit ?? 0,
      balance_minor: opts.balance ?? 100_000,
      currency: 'COP',
      status: 'active',
      created_at: NOW,
      updated_at: NOW,
    },
    entries: [],
  };
  const contexts: { userId?: string; tenantId?: string }[] = [];
  let mutex = Promise.resolve();

  const db = {
    withRequestContext: async <T>(
      ctx: { userId?: string; tenantId?: string },
      fn: (trx: unknown) => Promise<T>,
    ): Promise<T> => {
      contexts.push(ctx);
      let release!: () => void;
      const unlocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const previous = mutex;
      mutex = previous.then(() => unlocked);
      await previous;

      const local: State = {
        wallet: { ...state.wallet },
        entries: state.entries.map((e) => ({ ...e })),
      };
      let pendingDelta: number | null = null;
      let pendingSet: Record<string, unknown> | null = null;

      const selectFrom = (table: string) => {
        const filters = new Map<string, unknown>();
        const q = {
          select: () => q,
          selectAll: () => q,
          innerJoin: () => q,
          forUpdate: () => q,
          orderBy: () => q,
          where: (column: unknown, _op?: unknown, value?: unknown) => {
            if (typeof column === 'string') filters.set(column, value);
            return q;
          },
          executeTakeFirst: () => {
            if (table === 'tenants') {
              return Promise.resolve(
                filters.get('id') === AGENCIA
                  ? {
                      id: AGENCIA,
                      name: 'Agencia',
                      tenant_type: 'agency',
                      is_branch: false,
                      status: 'active',
                      default_currency: 'COP',
                      allowed: ctx.userId !== undefined && financiers.has(ctx.userId),
                    }
                  : undefined,
              );
            }
            if (table === 'agency_portfolios') {
              const w = local.wallet;
              const mine =
                w.tenant_id === ctx.tenantId &&
                filters.get('tenant_id') === w.tenant_id &&
                filters.get('id') === w.id;
              // Una copia, como una fila de la base: el UPDATE no cambia lo que ya se leyó.
              return Promise.resolve(mine ? { ...w } : undefined);
            }
            if (table === 'portfolio_transactions as t') {
              // La clave se busca en las carteras del nodo (join con agency_portfolios).
              return Promise.resolve(
                filters.get('p.tenant_id') === local.wallet.tenant_id
                  ? local.entries.find(
                      (e) => e.idempotency_key === filters.get('t.idempotency_key'),
                    )
                  : undefined,
              );
            }
            if (table === 'users') return Promise.resolve({ name: 'Admin del consolidador' });
            throw new Error(`select inesperado de ${table}`);
          },
        };
        return q;
      };

      const insertInto = (table: string) => {
        let values: Record<string, unknown> = {};
        const q = {
          values: (v: Record<string, unknown>) => {
            values = v;
            return q;
          },
          returningAll: () => q,
          executeTakeFirstOrThrow: () => {
            if (table !== 'portfolio_transactions') throw new Error(`insert en ${table}`);
            // La guarda de 0052: sólo quien financia, y firmado por quien actúa.
            if (!ctx.userId || !financiers.has(ctx.userId)) {
              return Promise.reject(
                Object.assign(new Error('guard'), {
                  code: '42501',
                  constraint: 'portfolio_financier_required',
                }),
              );
            }
            const key = values['idempotency_key'];
            if (key !== null && local.entries.some((e) => e.idempotency_key === key)) {
              return Promise.reject(Object.assign(new Error('duplicate'), { code: '23505' }));
            }
            pendingDelta = Number(values['amount_minor']);
            const row: Entry = {
              id: `tx-${local.entries.length + 1}`,
              portfolio_id: String(values['portfolio_id']),
              amount_minor: Number(values['amount_minor']),
              transaction_type: String(values['transaction_type']),
              reference_id: (values['reference_id'] as string | null) ?? null,
              idempotency_key: (key as string | null) ?? null,
              notes: (values['notes'] as string | null) ?? null,
              created_by: String(values['created_by']),
              created_at: NOW,
            };
            local.entries.push(row);
            return Promise.resolve(row);
          },
        };
        return q;
      };

      const updateTable = (table: string) => {
        const q = {
          set: (v: Record<string, unknown>) => {
            pendingSet = v;
            return q;
          },
          where: () => q,
          returningAll: () => q,
          executeTakeFirst: () => q.executeTakeFirstOrThrow(),
          executeTakeFirstOrThrow: () => {
            if (table !== 'agency_portfolios') throw new Error(`update de ${table}`);
            const set = pendingSet ?? {};
            if ('balance_minor' in set) {
              local.wallet.balance_minor += pendingDelta ?? 0;
            } else {
              if (!ctx.userId || !financiers.has(ctx.userId)) {
                return Promise.reject(
                  Object.assign(new Error('guard'), {
                    code: '42501',
                    constraint: 'portfolio_financier_required',
                  }),
                );
              }
              Object.assign(local.wallet, set);
            }
            return Promise.resolve({ ...local.wallet });
          },
        };
        return q;
      };

      try {
        const out = await fn({ selectFrom, insertInto, updateTable });
        state.wallet = local.wallet;
        state.entries = local.entries;
        return out;
      } finally {
        release();
      }
    },
  } as unknown as DatabaseService;

  const audit = new RecordingAuditService();
  const service = new WalletFinancingService(db, audit.asService());
  return { service, state, audit, contexts };
}

async function rechazo(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('se esperaba un rechazo');
}

const DEPOSITO = { amountMinor: 50_000, reason: 'Transferencia Bancolombia 991' };

describe('WalletFinancingService: sólo quien financia al nodo', () => {
  it('corre como quien actúa sobre el nodo DUEÑO de la cartera (contrato de 0052)', async () => {
    const b = banco();

    await b.service.recordDeposit(CONSOLIDADOR_ADMIN, AGENCIA, CARTERA, DEPOSITO, KEY_A);

    expect(b.contexts).toEqual([{ userId: CONSOLIDADOR_ADMIN, tenantId: AGENCIA }]);
  });

  it('quien no la financia recibe 403 con motivo antes de escribir, y no queda rastro', async () => {
    const b = banco();

    const err = await rechazo(
      b.service.recordDeposit(OTRO_ADMIN, AGENCIA, CARTERA, DEPOSITO, KEY_A),
    );

    expect(err).toBeInstanceOf(PortfolioForbiddenError);
    expect((err as PortfolioForbiddenError).getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect((err as PortfolioForbiddenError).reason).toBe('PORTFOLIO_FINANCIER_REQUIRED');
    expect(b.state.entries).toHaveLength(0);
    expect(b.state.wallet.balance_minor).toBe(100_000);
    expect(b.audit.events).toHaveLength(0);
  });

  it('un nodo que no existe responde igual que uno ajeno: 403, sin confirmar el id', async () => {
    const b = banco();

    const err = await rechazo(
      b.service.overview(CONSOLIDADOR_ADMIN, '99999999-9999-4999-8999-999999999999'),
    );

    expect(err).toMatchObject({ reason: 'PORTFOLIO_FINANCIER_REQUIRED' });
  });
});

describe('WalletFinancingService: depósitos y ajustes idempotentes', () => {
  it('acredita, firma el asiento por quien actúa y deja el evento con el motivo', async () => {
    const b = banco();

    const { portfolio, transaction } = await b.service.recordDeposit(
      CONSOLIDADOR_ADMIN,
      AGENCIA,
      CARTERA,
      DEPOSITO,
      KEY_A,
    );

    expect(portfolio).toMatchObject({ balanceMinor: 150_000, currency: 'COP', exponent: 2 });
    expect(transaction).toMatchObject({
      amountMinor: 50_000,
      transactionType: 'DEPOSIT_PAYMENT',
      createdBy: CONSOLIDADOR_ADMIN,
      createdByName: 'Admin del consolidador',
      notes: DEPOSITO.reason,
    });
    expect(b.audit.types()).toEqual([WALLET_EVENTS.depositRecorded]);
    expect(b.audit.first(WALLET_EVENTS.depositRecorded)).toMatchObject({
      tenantId: AGENCIA,
      actorUserId: CONSOLIDADOR_ADMIN,
      aggregateType: 'agency_portfolio',
      aggregateId: CARTERA,
      payload: {
        currency: 'COP',
        amountMinor: 50_000,
        transactionId: transaction.id,
        reason: DEPOSITO.reason,
      },
    });
  });

  it('dos envíos con la misma clave acreditan una sola vez y devuelven el mismo asiento', async () => {
    const b = banco();

    const [first, retry] = await Promise.all([
      b.service.recordDeposit(CONSOLIDADOR_ADMIN, AGENCIA, CARTERA, DEPOSITO, KEY_A),
      b.service.recordDeposit(CONSOLIDADOR_ADMIN, AGENCIA, CARTERA, DEPOSITO, KEY_A),
    ]);

    expect(first.transaction.id).toBe(retry.transaction.id);
    expect(b.state.wallet.balance_minor).toBe(150_000);
    expect(b.state.entries).toHaveLength(1);
    expect(b.audit.events).toHaveLength(1);
  });

  it('no deja reciclar una clave para otro monto, otro tipo u otro motivo', async () => {
    const b = banco();
    await b.service.recordDeposit(CONSOLIDADOR_ADMIN, AGENCIA, CARTERA, DEPOSITO, KEY_A);

    for (const intento of [
      b.service.recordDeposit(
        CONSOLIDADOR_ADMIN,
        AGENCIA,
        CARTERA,
        { ...DEPOSITO, amountMinor: 1 },
        KEY_A,
      ),
      b.service.recordAdjustment(CONSOLIDADOR_ADMIN, AGENCIA, CARTERA, DEPOSITO, KEY_A),
      b.service.recordDeposit(
        CONSOLIDADOR_ADMIN,
        AGENCIA,
        CARTERA,
        { ...DEPOSITO, reason: 'Otro' },
        KEY_A,
      ),
    ]) {
      const err = await rechazo(intento);
      expect(err).toBeInstanceOf(PortfolioConflictError);
      expect(err).toMatchObject({ reason: 'PORTFOLIO_IDEMPOTENCY_KEY_REUSED' });
    }
    expect(b.state.wallet.balance_minor).toBe(150_000);
    expect(b.state.entries).toHaveLength(1);
  });

  it('un ajuste negativo registra la deuda aunque deje la cartera por debajo del cupo', async () => {
    const b = banco({ balance: 10_000, credit: 5_000 });

    const { portfolio, transaction } = await b.service.recordAdjustment(
      CONSOLIDADOR_ADMIN,
      AGENCIA,
      CARTERA,
      { amountMinor: -40_000, reason: 'Reverso de un depósito aprobado por error' },
      KEY_B,
    );

    expect(transaction).toMatchObject({
      amountMinor: -40_000,
      transactionType: 'MANUAL_ADJUSTMENT',
    });
    expect(portfolio).toMatchObject({ balanceMinor: -30_000, availableMinor: -25_000 });
    expect(b.audit.types()).toEqual([WALLET_EVENTS.adjustmentRecorded]);
  });
});

describe('WalletFinancingService.updateWallet', () => {
  it('fija el cupo y deja el evento con el antes, el después y el motivo', async () => {
    const b = banco({ credit: 0 });

    const view = await b.service.updateWallet(CONSOLIDADOR_ADMIN, AGENCIA, CARTERA, {
      creditLimitMinor: 3_000_000,
      reason: 'Cupo aprobado en comité',
    });

    expect(view).toMatchObject({ creditLimitMinor: 3_000_000, availableMinor: 3_100_000 });
    expect(b.audit.types()).toEqual([WALLET_EVENTS.creditLimitChanged]);
    expect(b.audit.first(WALLET_EVENTS.creditLimitChanged)?.payload).toEqual({
      currency: 'COP',
      fromMinor: 0,
      toMinor: 3_000_000,
      reason: 'Cupo aprobado en comité',
      source: 'api',
    });
  });

  it('suspender deja su propio evento; reenviar lo mismo no escribe ni audita', async () => {
    const b = banco();

    await b.service.updateWallet(CONSOLIDADOR_ADMIN, AGENCIA, CARTERA, {
      status: 'suspended',
      reason: 'Mora de 60 días',
    });
    await b.service.updateWallet(CONSOLIDADOR_ADMIN, AGENCIA, CARTERA, {
      status: 'suspended',
      creditLimitMinor: 0,
      reason: 'Mora de 60 días',
    });

    expect(b.state.wallet.status).toBe('suspended');
    expect(b.audit.types()).toEqual([WALLET_EVENTS.statusChanged]);
    expect(b.audit.first(WALLET_EVENTS.statusChanged)?.payload).toMatchObject({
      from: 'active',
      to: 'suspended',
    });
  });

  it('la agencia no se sube su propio cupo', async () => {
    const b = banco({ financiers: [CONSOLIDADOR_ADMIN] });

    const err = await rechazo(
      b.service.updateWallet(OTRO_ADMIN, AGENCIA, CARTERA, {
        creditLimitMinor: 9_000_000,
        reason: 'Me lo subo',
      }),
    );

    expect(err).toMatchObject({ reason: 'PORTFOLIO_FINANCIER_REQUIRED' });
    expect(b.state.wallet.credit_limit_minor).toBe(0);
  });
});
