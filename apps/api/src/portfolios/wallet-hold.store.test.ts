import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import {
  BookingHoldRejectedError,
  PortfolioHoldBusyError,
  PortfolioReleaseBusyError,
} from './booking-hold.js';
import {
  WALLET_HOLD_RETRIES,
  WalletHoldContractError,
  WalletHoldStore,
  runHoldTransaction,
  translateWalletHoldError,
  type WalletHoldTiming,
} from './wallet-hold.store.js';

/**
 * La puerta de la API a las funciones de 0060, sin base: el `lock_timeout` antes que nada, el
 * reintento ante un bloqueo y sólo ante un bloqueo, y que lo que devuelve la base se valida antes de
 * usarlo. Las funciones de verdad las prueban los tests de integración.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-2222222222aa';
const USER = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';
const WALLET = '55555555-5555-4555-8555-555555555555';
const ENTRY = '66666666-6666-4666-8666-666666666666';
const ACCOUNT = '77777777-7777-4777-8777-777777777777';

interface Call {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error(`crudo con ${ORDER}`), {
    code,
    ...(constraint === undefined ? {} : { constraint }),
  });
}

/** Una base que responde con `answer` a cada consulta y anota lo que se le pidió. */
function fakeDb(answer: (call: Call, attempt: number) => unknown[] | Error) {
  const calls: Call[] = [];
  let attempts = 0;
  const db = {
    withTenant: async <T>(tenantId: string, fn: (trx: unknown) => Promise<T>): Promise<T> => {
      attempts += 1;
      const attempt = attempts;
      calls.push({ sql: `withTenant ${tenantId}`, parameters: [] });
      return fn({
        executeQuery: (q: Call) => {
          calls.push({ sql: q.sql, parameters: q.parameters });
          const out = answer(q, attempt);
          return out instanceof Error ? Promise.reject(out) : Promise.resolve({ rows: out });
        },
      });
    },
  } as unknown as DatabaseService;
  return { db, calls, attempts: () => attempts };
}

function instantTiming() {
  const waits: number[] = [];
  const timing: WalletHoldTiming = {
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
  };
  return { timing, waits };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runHoldTransaction: el lock_timeout y el reintento acotado', () => {
  it('pone SET LOCAL lock_timeout antes de cualquier otra cosa de la transacción', async () => {
    const f = fakeDb(() => []);

    await runHoldTransaction(f.db, TENANT, async (trx) => {
      await trx.executeQuery({ sql: 'SELECT 1', parameters: [] } as never);
      return 'ok';
    });

    expect(f.calls.map((c) => c.sql)).toEqual([
      `withTenant ${TENANT}`,
      "SET LOCAL lock_timeout = '2s'",
      'SELECT 1',
    ]);
  });

  it.each(['40P01', '55P03', '40001'])(
    'ante %s repite la transacción entera hasta 2 veces, con espera entre 50 y 250 ms, y después BUSY',
    async (code) => {
      const f = fakeDb(() => []);
      const { timing, waits } = instantTiming();
      const fn = vi.fn(() => Promise.reject(pgError(code)));

      const err = await runHoldTransaction(f.db, TENANT, fn, timing).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PortfolioHoldBusyError);
      expect((err as PortfolioHoldBusyError).reason).toBe('PORTFOLIO_HOLD_BUSY');
      expect(fn).toHaveBeenCalledTimes(1 + WALLET_HOLD_RETRIES);
      expect(f.attempts()).toBe(3);
      expect(waits).toHaveLength(2);
      for (const w of waits) {
        expect(w).toBeGreaterThanOrEqual(50);
        expect(w).toBeLessThanOrEqual(250);
      }
    },
  );

  it('al liberar, agotado el reintento, el 409 dice que falta devolver el saldo y no que no se retuvo', async () => {
    const f = fakeDb(() => []);
    const { timing } = instantTiming();

    const err = await runHoldTransaction(
      f.db,
      TENANT,
      () => Promise.reject(pgError('55P03')),
      timing,
      'release',
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PortfolioReleaseBusyError);
    expect((err as PortfolioReleaseBusyError).reason).toBe('PORTFOLIO_RELEASE_BUSY');
    expect((err as Error).message).not.toContain('no se retuvo');
    expect(f.attempts()).toBe(1 + WALLET_HOLD_RETRIES);
  });

  it('si el reintento sale bien, devuelve ese resultado', async () => {
    const f = fakeDb(() => []);
    const { timing } = instantTiming();
    let n = 0;

    const out = await runHoldTransaction(
      f.db,
      TENANT,
      () => {
        n += 1;
        return n === 1 ? Promise.reject(pgError('40P01')) : Promise.resolve('segunda');
      },
      timing,
    );

    expect(out).toBe('segunda');
    expect(f.attempts()).toBe(2);
  });

  it('las esperas cubren los extremos 50 y 250 ms', async () => {
    const f = fakeDb(() => []);
    const waits: number[] = [];
    const randoms = [0, 0.999999];
    const timing: WalletHoldTiming = {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      random: () => randoms.shift() ?? 0,
    };

    await runHoldTransaction(f.db, TENANT, () => Promise.reject(pgError('55P03')), timing).catch(
      () => undefined,
    );

    expect(waits).toEqual([50, 250]);
  });

  it.each([
    ['un rechazo de la red (STW02)', pgError('STW02', 'network_funds_unavailable')],
    ['una regla de estado (STW01)', pgError('STW01', 'hold_already_exists')],
    ['un error de programación (42501)', pgError('42501', 'wallet_hold_no_tenant')],
    ['cualquier otra cosa', new Error('boom')],
  ])('no reintenta %s: lo lanza tal cual', async (_caso, error) => {
    const f = fakeDb(() => []);
    const { timing, waits } = instantTiming();

    await expect(
      runHoldTransaction(f.db, TENANT, () => Promise.reject(error), timing),
    ).rejects.toBe(error);
    expect(f.attempts()).toBe(1);
    expect(waits).toEqual([]);
  });

  it('sin tiempos inyectados espera de verdad, y termina en BUSY', async () => {
    const f = fakeDb(() => []);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    await expect(
      runHoldTransaction(f.db, TENANT, () => Promise.reject(pgError('40P01'))),
    ).rejects.toBeInstanceOf(PortfolioHoldBusyError);
  });
});

describe('WalletHoldStore.retain: la fila de wallet_hold_retain, validada', () => {
  const row = {
    group_id: GROUP,
    hold_status: 'held',
    own_portfolio_id: WALLET,
    own_transaction_id: ENTRY,
    network_levels: 2,
    mode: 'enforce',
  };
  /** La venta con la cuenta propia del nodo (O = T): el grupo, sin cartera ni asiento propio. */
  const exempt = {
    group_id: GROUP,
    hold_status: 'exempt',
    own_portfolio_id: null,
    own_transaction_id: null,
    network_levels: 0,
    mode: 'enforce',
  };

  it('llama sólo con la orden y el actor: ni montos ni moneda ni cadena', async () => {
    const f = fakeDb(() => [row]);
    const store = new WalletHoldStore(f.db);

    const out = await store.run(TENANT, (trx) => store.retain(trx, ORDER, USER));

    expect(out).toEqual({
      status: 'held',
      groupId: GROUP,
      ownPortfolioId: WALLET,
      ownTransactionId: ENTRY,
      networkLevels: 2,
      mode: 'enforce',
    });
    const call = f.calls.find((c) => c.sql.includes('wallet_hold_retain'));
    expect(call?.parameters).toEqual([ORDER, USER]);
  });

  it('una retención manual de una orden confirmada nace capturada', async () => {
    const f = fakeDb(() => [{ ...row, hold_status: 'captured' }]);
    const store = new WalletHoldStore(f.db);

    await expect(store.run(TENANT, (trx) => store.retain(trx, ORDER, USER))).resolves.toMatchObject(
      { status: 'captured', ownPortfolioId: WALLET },
    );
  });

  it('con la cuenta propia del nodo devuelve exempt, sin cartera ni asiento', async () => {
    const f = fakeDb(() => [exempt]);
    const store = new WalletHoldStore(f.db);

    await expect(store.run(TENANT, (trx) => store.retain(trx, ORDER, USER))).resolves.toEqual({
      status: 'exempt',
      groupId: GROUP,
      mode: 'enforce',
    });
  });

  it.each([
    ['sin filas', []],
    ['dos filas', [row, row]],
    ['un id que no es UUID', [{ ...row, group_id: 'no' }]],
    ['más niveles que los que admite la red', [{ ...row, network_levels: 4 }]],
    ['un modo desconocido', [{ ...row, mode: 'legacy' }]],
    ['un estado desconocido', [{ ...row, hold_status: 'released' }]],
    ['retenida sin cartera propia', [{ ...row, own_portfolio_id: null }]],
    ['exenta con una cartera propia', [{ ...exempt, own_portfolio_id: WALLET }]],
    ['exenta con un asiento propio', [{ ...exempt, own_transaction_id: ENTRY }]],
    ['exenta con niveles de la red', [{ ...exempt, network_levels: 1 }]],
  ])('%s → WalletHoldContractError, nunca un dato a medias', async (_caso, rows) => {
    const f = fakeDb(() => rows);
    const store = new WalletHoldStore(f.db);

    await expect(store.run(TENANT, (trx) => store.retain(trx, ORDER, USER))).rejects.toBeInstanceOf(
      WalletHoldContractError,
    );
  });
});

describe('WalletHoldStore.settle', () => {
  it.each([
    'released',
    'already-released',
    'captured',
    'already-captured',
    'open',
    'no-hold',
    'conflict',
  ])('devuelve %s tal cual', async (outcome) => {
    const f = fakeDb(() => [{ outcome }]);
    const store = new WalletHoldStore(f.db);

    await expect(store.run(TENANT, (trx) => store.settle(trx, ORDER, USER))).resolves.toBe(outcome);
  });

  it('pasa la precondición, y NULL si no hay', async () => {
    const f = fakeDb(() => [{ outcome: 'released' }]);
    const store = new WalletHoldStore(f.db);

    await store.run(TENANT, (trx) => store.settle(trx, ORDER, USER, 'failed'));
    await store.run(TENANT, (trx) => store.settle(trx, ORDER, USER));

    const params = f.calls
      .filter((c) => c.sql.includes('wallet_hold_settle'))
      .map((c) => c.parameters);
    expect(params).toEqual([
      [ORDER, USER, 'failed'],
      [ORDER, USER, null],
    ]);
  });

  it('un resultado que 0060 no promete es un error de contrato', async () => {
    const f = fakeDb(() => [{ outcome: 'liberado' }]);
    const store = new WalletHoldStore(f.db);

    await expect(store.run(TENANT, (trx) => store.settle(trx, ORDER, USER))).rejects.toBeInstanceOf(
      WalletHoldContractError,
    );
  });
});

describe('WalletHoldStore.preview: sólo ok, exempt, blocked con su motivo, o no se sabe', () => {
  const quote = {
    amount: { amountMinor: 139_709, currency: 'USD' },
    netMinor: 100_000,
    vertical: 'hotels' as const,
    providerCode: 'tbo-hotels',
    providerAccountId: ACCOUNT,
  };

  it('manda proveedor, cuenta, vertical, moneda, venta y neto, en ese orden', async () => {
    const f = fakeDb(() => [{ status: 'ok', reason: null }]);
    const store = new WalletHoldStore(f.db);

    const out = await f.db.withTenant(TENANT, (trx) => store.preview(trx as never, quote));

    expect(out).toEqual({ status: 'ok' });
    expect(f.calls.find((c) => c.sql.includes('wallet_hold_preview'))?.parameters).toEqual([
      'tbo-hotels',
      ACCOUNT,
      'hotels',
      'USD',
      139_709,
      100_000,
    ]);
  });

  it('exempt: la cuenta propia del nodo, que no retiene nada', async () => {
    const f = fakeDb(() => [{ status: 'exempt', reason: null }]);
    const store = new WalletHoldStore(f.db);

    await expect(
      f.db.withTenant(TENANT, (trx) => store.preview(trx as never, quote)),
    ).resolves.toEqual({ status: 'exempt' });
  });

  it.each([
    ['hold_funds_insufficient', 'PORTFOLIO_FUNDS_INSUFFICIENT'],
    ['network_currency_not_enabled', 'PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED'],
    ['network_funds_unavailable', 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE'],
    ['network_cost_unavailable', 'PORTFOLIO_NETWORK_COST_UNAVAILABLE'],
  ])('blocked por %s → %s', async (rule, reason) => {
    const f = fakeDb(() => [{ status: 'blocked', reason: rule }]);
    const store = new WalletHoldStore(f.db);

    await expect(
      f.db.withTenant(TENANT, (trx) => store.preview(trx as never, quote)),
    ).resolves.toEqual({ status: 'blocked', reason });
  });

  it.each([
    ['unknown', [{ status: 'unknown', reason: null }]],
    ['una regla que la API no conoce', [{ status: 'blocked', reason: 'network_nueva' }]],
  ])('%s → undefined', async (_caso, rows) => {
    const f = fakeDb(() => rows);
    const store = new WalletHoldStore(f.db);

    await expect(
      f.db.withTenant(TENANT, (trx) => store.preview(trx as never, quote)),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['una cuenta que no es de la bóveda', { providerAccountId: 'env' }],
    ['un neto con decimales', { netMinor: 1.5 }],
    ['un neto cero', { netMinor: 0 }],
    ['una venta fuera de rango', { amount: { amountMinor: 2 ** 53, currency: 'USD' } }],
  ])('%s → undefined sin preguntar a la base', async (_caso, change) => {
    const f = fakeDb(() => [{ status: 'ok', reason: null }]);
    const store = new WalletHoldStore(f.db);

    await expect(
      f.db.withTenant(TENANT, (trx) => store.preview(trx as never, { ...quote, ...change })),
    ).resolves.toBeUndefined();
    expect(f.calls.some((c) => c.sql.includes('wallet_hold_preview'))).toBe(false);
  });

  it('sin cuenta (credenciales de entorno) y sin neto también pregunta: la base decide', async () => {
    const f = fakeDb(() => [{ status: 'blocked', reason: 'network_cost_unavailable' }]);
    const store = new WalletHoldStore(f.db);

    await f.db.withTenant(TENANT, (trx) =>
      store.preview(trx as never, { ...quote, providerAccountId: null, netMinor: null }),
    );

    const call = f.calls.find((c) => c.sql.includes('wallet_hold_preview'));
    expect(call?.parameters[1]).toBeNull();
    expect(call?.parameters[5]).toBeNull();
  });

  it('una fila fuera de contrato es un error de contrato', async () => {
    const f = fakeDb(() => [{ status: 'quizás', reason: null }]);
    const store = new WalletHoldStore(f.db);

    await expect(
      f.db.withTenant(TENANT, (trx) => store.preview(trx as never, quote)),
    ).rejects.toBeInstanceOf(WalletHoldContractError);
  });
});

describe('WalletHoldStore.reportBlock: best-effort y sin el mensaje de la base', () => {
  it('llama a wallet_hold_report_block en su propia transacción con el tenant que vende', async () => {
    const f = fakeDb(() => [{}]);
    const store = new WalletHoldStore(f.db);

    await store.reportBlock(TENANT, ORDER);

    expect(f.calls.map((c) => c.sql)).toEqual([
      `withTenant ${TENANT}`,
      'SELECT public.wallet_hold_report_block($1::uuid)',
    ]);
    expect(f.calls[1]?.parameters).toEqual([ORDER]);
  });

  it('si falla no lanza, y el log no repite lo que dijo la base', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const f = fakeDb(() => pgError('42501', 'wallet_hold_no_tenant'));
    const store = new WalletHoldStore(f.db);

    await expect(store.reportBlock(TENANT, ORDER)).resolves.toBeUndefined();

    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('portfolios.network_hold.report_failed');
    expect(logged).not.toContain('crudo');
  });

  it('un error que no es Error también queda en el log con un nombre genérico', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const db = {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- el caso es un rechazo que no es Error
      withTenant: () => Promise.reject('texto'),
    } as unknown as DatabaseService;

    await new WalletHoldStore(db).reportBlock(TENANT, ORDER);

    expect(String(warn.mock.calls[0]?.[0])).toContain('error=UnknownError');
  });
});

describe('translateWalletHoldError', () => {
  it('usa la moneda de la reserva en el texto del rechazo', () => {
    const err = translateWalletHoldError(pgError('STW02', 'network_funds_unavailable'), 'COP');

    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect(err?.message).toContain('en COP');
  });

  it('con el texto de la vía para una orden que no retiene', () => {
    expect(
      translateWalletHoldError(pgError('STW01', 'hold_order_not_holdable'), 'USD', 'Sólo así.')
        ?.message,
    ).toBe('Sólo así.');
  });

  it('lo que no es de las retenciones no se traduce', () => {
    expect(translateWalletHoldError(new Error('x'))).toBeUndefined();
  });
});
