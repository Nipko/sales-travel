import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import type { HotelOrderSnapshot } from '../hotels/hotel-order-state.js';
import { HotelOrderCancellationStore } from './hotel-order-cancellation.store.js';

/**
 * El SQL de la cancelación de hoteles con el compilador REAL de Postgres de Kysely (como
 * `hotels/hotel-booking-verification.store.test.ts`): tenant fijado, filtros del barrido, CAS del
 * paso y la transacción del cierre. Contra Postgres de verdad, con RLS, corre
 * `hotel-order-cancellation.integration.test.ts`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDEN = '22222222-2222-4222-8222-222222222222';
const T = Date.parse('2026-09-26T15:00:00Z');

type Respuesta = { rows?: unknown[]; numAffectedRows?: bigint };

class DriverQueGraba extends DummyDriver {
  constructor(private readonly responder: (q: CompiledQuery) => Respuesta) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const base = await super.acquireConnection();
    return {
      executeQuery: <R>(q: CompiledQuery): Promise<QueryResult<R>> =>
        new Promise((resolve) => {
          const r = this.responder(q);
          resolve({
            rows: (r.rows ?? []) as R[],
            ...(r.numAffectedRows === undefined ? {} : { numAffectedRows: r.numAffectedRows }),
          });
        }),
      streamQuery: (q, chunkSize) => base.streamQuery(q, chunkSize),
    };
  }
}

function banco(responder: (q: CompiledQuery) => Respuesta = () => ({})) {
  const consultas: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new DriverQueGraba((q) => {
          consultas.push(q);
          return q.sql.includes('set_config') ? {} : responder(q);
        }),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const database = new DatabaseService();
  database.db = db;
  const store = new HotelOrderCancellationStore(database);
  const negocio = () =>
    consultas.filter(
      (q) => !q.sql.includes('set_config') && !/^(begin|commit|rollback)/i.test(q.sql),
    );
  return { store, db, consultas, negocio };
}

function fila(parcial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORDEN,
    provider: 'tbo-hotels',
    user_id: 'u-1',
    status: 'pending',
    provider_order_id: 'FL1IMA',
    provider_account_id: 'cuenta-1',
    provider_booking_ref: 'STT7K2M9QX4D8R1VZ6AB',
    provider_status: 'CancelPending',
    provider_voucher_status: 'true',
    sub_status: null,
    refund_awaited: null,
    hcn: null,
    hcn_state: null,
    cancel_verify_anchor_at: new Date(T),
    cancel_verify_step: '1',
    cancel_verify_next_at: new Date(T + 15 * 60_000),
    ...parcial,
  };
}

describe('HotelOrderCancellationStore — lecturas', () => {
  it('findTarget: la orden del tenant con su seguimiento y calendario, sin columnas de PII', async () => {
    const b = banco(() => ({ rows: [fila()] }));

    const target = await b.store.findTarget(TENANT, ORDEN);

    expect(target).toEqual({
      orderId: ORDEN,
      provider: 'tbo-hotels',
      userId: 'u-1',
      status: 'pending',
      providerOrderId: 'FL1IMA',
      providerAccountId: 'cuenta-1',
      bookingReference: 'STT7K2M9QX4D8R1VZ6AB',
      snapshot: {
        status: 'pending',
        subStatus: null,
        providerStatus: 'CancelPending',
        voucherStatus: 'true',
        refundAwaited: false,
        hcn: null,
        hcnState: null,
      },
      calendar: { anchorAt: T, step: 1, nextAt: T + 15 * 60_000 },
    });
    const [tenant] = b.consultas;
    expect(tenant?.sql).toContain('set_config');
    expect(tenant?.parameters).toEqual([TENANT]);
    const [q] = b.negocio();
    expect(q?.sql).toContain('"t"."tenant_id" = "o"."tenant_id"');
    expect(q?.sql).not.toMatch(/passengers|contact_info/);
    expect(q?.parameters).toEqual([ORDEN, TENANT]);
  });

  it('findTarget sin fila, y fechas y pasos como texto (otro driver)', async () => {
    expect(await banco(() => ({ rows: [] })).store.findTarget(TENANT, ORDEN)).toBeUndefined();
    const b = banco(() => ({
      rows: [
        fila({
          cancel_verify_anchor_at: new Date(T).toISOString(),
          cancel_verify_step: null,
          cancel_verify_next_at: null,
        }),
      ],
    }));
    expect((await b.store.findTarget(TENANT, ORDEN))?.calendar).toEqual({
      anchorAt: T,
      step: null,
      nextAt: null,
    });
  });

  it('listDue: sólo lo vencido del tenant, el más atrasado primero y con tope', async () => {
    const b = banco(() => ({ rows: [fila()] }));

    const due = await b.store.listDue(TENANT, { dueBefore: T, limit: 25 });

    expect(due).toHaveLength(1);
    const [q] = b.negocio();
    expect(q?.sql).toContain('"t"."cancel_verify_next_at" is not null');
    expect(q?.sql).toContain('"t"."cancel_verify_next_at" <= $2');
    expect(q?.sql).toContain('order by "t"."cancel_verify_next_at"');
    expect(q?.parameters).toEqual([TENANT, new Date(T), 25]);
  });
});

describe('HotelOrderCancellationStore — escrituras dentro de la cancelación', () => {
  it('markRequested: upsert del claim que además apaga un calendario anterior', async () => {
    const b = banco();

    await b.db.transaction().execute((trx) => b.store.markRequested(trx, TENANT, ORDEN));

    const [q] = b.negocio();
    expect(q?.sql).toContain('insert into "hotel_order_tracking"');
    expect(q?.sql).toContain(
      'on conflict ("order_id") do update set "sub_status" = $4, "cancel_verify_next_at" = $5',
    );
    expect(q?.parameters).toEqual([ORDEN, TENANT, 'cancel-requested', 'cancel-requested', null]);
  });

  it('writeOutcome: la lectura, el subestado, el calendario y el corte del HCN sólo si estaba en curso', async () => {
    const b = banco();

    await b.db.transaction().execute((trx) =>
      b.store.writeOutcome(trx, TENANT, ORDEN, {
        at: T,
        source: 'cancel',
        record: { providerStatus: 'Cancelled', refundAwaited: false, voucherStatus: 'true' },
        subStatus: null,
        hcn: { hcn: 'HCN-1', markReceived: true },
        stopHcn: true,
        openCalendar: { anchorAt: T, nextAt: T + 120_000 },
      }),
    );

    const [q] = b.negocio();
    expect(q?.sql).toContain('"provider_status_source"');
    expect(q?.sql).toContain('"cancel_verify_step"');
    expect(q?.sql).toMatch(
      /CASE WHEN hotel_order_tracking\.hcn_state IN \('out-of-window', 'scheduled'\) THEN 'stopped' ELSE hotel_order_tracking\.hcn_state END/,
    );
    // En el INSERT (fila nueva) no hay seguimiento que cortar: sólo en el UPDATE.
    const [insert] = (q?.sql ?? '').split('on conflict');
    expect(insert).not.toContain('CASE WHEN');
  });

  it('writeOutcome sin nada que escribir no manda nada', async () => {
    const b = banco();
    await b.db
      .transaction()
      .execute((trx) => b.store.writeOutcome(trx, TENANT, ORDEN, { at: T, source: 'cancel' }));
    expect(b.negocio()).toEqual([]);
  });
});

describe('HotelOrderCancellationStore — la verificación', () => {
  it('advance: CAS sobre el paso de un calendario abierto', async () => {
    const b = banco(() => ({ numAffectedRows: 1n }));

    await expect(
      b.store.advance(TENANT, ORDEN, 1, {
        step: 2,
        nextAt: T,
        write: { at: T, source: 'verify', subStatus: 'unknown' },
      }),
    ).resolves.toBe(true);

    const [q] = b.negocio();
    expect(q?.sql).toContain('update "hotel_order_tracking"');
    expect(q?.sql).toContain('"cancel_verify_step" = $');
    expect(q?.sql).toContain('"cancel_verify_next_at" is not null');
    expect(q?.parameters).toContain(TENANT);
  });

  it('advance que pierde el CAS devuelve false', async () => {
    const b = banco(() => ({ numAffectedRows: 0n }));
    await expect(b.store.advance(TENANT, ORDEN, 1, { step: 2, nextAt: null })).resolves.toBe(false);
  });

  it('postpone: corre la próxima lectura sin avanzar el paso, con CAS sobre ancla y paso', async () => {
    const b = banco(() => ({ numAffectedRows: 1n }));

    await expect(
      b.store.postpone(TENANT, ORDEN, { anchorAt: T, step: 1 }, T + 15 * 60_000),
    ).resolves.toBe(true);

    const [q] = b.negocio();
    expect(q?.sql).toBe(
      'update "hotel_order_tracking" set "cancel_verify_next_at" = $1 where "order_id" = $2 and "tenant_id" = $3 and "cancel_verify_anchor_at" = $4 and "cancel_verify_step" = $5 and "cancel_verify_next_at" is not null',
    );
    expect(q?.parameters).toEqual([new Date(T + 15 * 60_000), ORDEN, TENANT, new Date(T), 1]);

    // Otro camino lo avanzó, lo cerró o abrió el calendario de una cancelación nueva.
    const perdio = banco(() => ({ numAffectedRows: 0n }));
    await expect(perdio.store.postpone(TENANT, ORDEN, { anchorAt: T, step: 1 }, T)).resolves.toBe(
      false,
    );
  });

  it('close: paso, orden y operación sin verificar en UNA transacción', async () => {
    const b = banco((q) => {
      if (q.sql.startsWith('update "hotel_order_tracking"')) return { numAffectedRows: 1n };
      if (q.sql.startsWith('update "orders"')) return { rows: [{ id: ORDEN }] };
      if (q.sql.startsWith('select "id", "status", "result" from "order_operations"')) {
        return {
          rows: [
            {
              id: 'op-1',
              status: 'failed',
              result: {
                outcome: 'UNVERIFIED',
                retryable: false,
                reconciliationRequired: true,
                reason: 'write-unverified',
                priorOrderStatus: 'confirmed',
              },
            },
          ],
        };
      }
      return {};
    });

    await expect(
      b.store.close(TENANT, ORDEN, 1, { at: T, source: 'verify', subStatus: null }),
    ).resolves.toBe(true);

    const sqls = b.negocio().map((q) => q.sql);
    expect(sqls[0]).toContain('update "hotel_order_tracking"');
    expect(sqls[1]).toContain(
      `update "orders" set "status" = $1 where "id" = $2 and "tenant_id" = $3 and "status" = $4`,
    );
    const op = b.negocio()[3];
    expect(op?.sql).toContain('update "order_operations"');
    expect(JSON.parse(String(op?.parameters[2]))).toEqual({
      status: 'success',
      outcome: 'SUCCEEDED',
      retryable: false,
      reconciliationRequired: false,
      reason: 'completed',
      priorOrderStatus: 'confirmed',
      resolvedBy: 'verify-cancellation',
    });
  });

  it('close: la última operación que no quedó sin verificar no se toca', async () => {
    for (const latest of [
      undefined,
      { id: 'op-1', status: 'success', result: '{}' },
      {
        id: 'op-1',
        status: 'failed',
        result: JSON.stringify({
          outcome: 'FAILED',
          retryable: false,
          reconciliationRequired: false,
          reason: 'provider-rejected',
        }),
      },
    ]) {
      const b = banco((q) => {
        if (q.sql.startsWith('update "hotel_order_tracking"')) return { numAffectedRows: 1n };
        if (q.sql.startsWith('update "orders"')) return { rows: [{ id: ORDEN }] };
        if (q.sql.startsWith('select')) return { rows: latest === undefined ? [] : [latest] };
        return {};
      });
      await expect(b.store.close(TENANT, ORDEN, 1, { at: T, source: 'verify' })).resolves.toBe(
        true,
      );
      expect(b.negocio().some((q) => q.sql.startsWith('update "order_operations"'))).toBe(false);
    }
  });

  it('close: una fila vieja cuya política no se puede leer cuenta como sin verificar, y se resuelve', async () => {
    const b = banco((q) => {
      if (q.sql.startsWith('update "hotel_order_tracking"')) return { numAffectedRows: 1n };
      if (q.sql.startsWith('update "orders"')) return { rows: [{ id: ORDEN }] };
      if (q.sql.startsWith('select')) {
        return { rows: [{ id: 'op-1', status: 'failed', result: 'no-es-json' }] };
      }
      return {};
    });
    await b.store.close(TENANT, ORDEN, 1, { at: T, source: 'verify' });
    expect(b.negocio().some((q) => q.sql.startsWith('update "order_operations"'))).toBe(true);
  });

  it('close: sin el prior en el resultado, la operación se resuelve igual', async () => {
    const b = banco((q) => {
      if (q.sql.startsWith('update "hotel_order_tracking"')) return { numAffectedRows: 1n };
      if (q.sql.startsWith('update "orders"')) return { rows: [{ id: ORDEN }] };
      if (q.sql.startsWith('select')) {
        return {
          rows: [
            {
              id: 'op-1',
              status: 'failed',
              result: JSON.stringify({
                outcome: 'UNVERIFIED',
                retryable: false,
                reconciliationRequired: true,
                reason: 'write-unverified',
              }),
            },
          ],
        };
      }
      return {};
    });
    await b.store.close(TENANT, ORDEN, 1, { at: T, source: 'verify' });
    const op = b.negocio().find((q) => q.sql.startsWith('update "order_operations"'));
    expect(JSON.parse(String(op?.parameters[2]))).not.toHaveProperty('priorOrderStatus');
  });

  it('close: si pierde el CAS del paso, o la orden ya no está pendiente, deshace y devuelve false', async () => {
    const sinPaso = banco(() => ({ numAffectedRows: 0n }));
    await expect(sinPaso.store.close(TENANT, ORDEN, 1, { at: T, source: 'verify' })).resolves.toBe(
      false,
    );
    expect(sinPaso.negocio().some((q) => q.sql.startsWith('update "orders"'))).toBe(false);

    const noPendiente = banco((q) =>
      q.sql.startsWith('update "hotel_order_tracking"') ? { numAffectedRows: 1n } : {},
    );
    await expect(
      noPendiente.store.close(TENANT, ORDEN, 1, { at: T, source: 'verify' }),
    ).resolves.toBe(false);
    // La transacción se deshace antes de tocar la operación.
    expect(noPendiente.negocio().some((q) => q.sql.includes('order_operations'))).toBe(false);
  });

  it('close: un error de la base se propaga', async () => {
    const b = banco((q) => {
      if (q.sql.startsWith('update "hotel_order_tracking"')) throw new Error('base caída');
      return {};
    });
    await expect(b.store.close(TENANT, ORDEN, 1, { at: T, source: 'verify' })).rejects.toThrow(
      'base caída',
    );
  });
});

describe('HotelOrderCancellationStore — la conciliación que confirmó una cancelación (PR-5.5)', () => {
  const ESPERADO: Pick<HotelOrderSnapshot, 'subStatus' | 'providerStatus' | 'hcn' | 'hcnState'> = {
    subStatus: 'cancel-unverified',
    providerStatus: null,
    hcn: null,
    hcnState: null,
  };

  function conFilas(tracking: boolean) {
    return banco((q) => {
      if (q.sql.startsWith('update "orders"')) return { rows: [{ id: ORDEN }] };
      if (q.sql.startsWith('insert into "hotel_order_tracking"')) {
        return { rows: tracking ? [{ order_id: ORDEN }] : [] };
      }
      if (q.sql.startsWith('select')) return { rows: [] };
      return {};
    });
  }

  it('transitionByReading a cancelled: CAS de la orden y de la foto, y el calendario queda cerrado', async () => {
    const b = conFilas(true);

    await expect(
      b.store.transitionByReading(TENANT, ORDEN, {
        from: 'pending',
        to: 'cancelled',
        expected: ESPERADO,
        write: { at: T, source: 'reconciliation', subStatus: null, stopHcn: true },
      }),
    ).resolves.toBe(true);

    const [orden, seguimiento] = b.negocio();
    expect(orden?.sql).toBe(
      'update "orders" set "status" = $1 where "id" = $2 and "tenant_id" = $3 and "status" = $4 returning "id"',
    );
    expect(orden?.parameters).toEqual(['cancelled', ORDEN, TENANT, 'pending']);
    const [, update] = (seguimiento?.sql ?? '').split('on conflict');
    const cierre = /"cancel_verify_next_at" = \$(\d+)/.exec(update ?? '');
    expect(cierre).not.toBeNull();
    expect(seguimiento?.parameters[Number(cierre?.[1]) - 1]).toBeNull();
    expect(update).toContain('"hotel_order_tracking"."sub_status" is not distinct from $');
    expect(update).toContain('"hotel_order_tracking"."hcn_state" is not distinct from $');
  });

  it('transitionByReading a "Cancelación en curso" abre el calendario y no lo cierra', async () => {
    const b = conFilas(true);

    await b.store.transitionByReading(TENANT, ORDEN, {
      from: 'confirmed',
      to: 'pending',
      expected: { ...ESPERADO, subStatus: null },
      write: {
        at: T,
        source: 'reconciliation',
        subStatus: null,
        openCalendar: { anchorAt: T, nextAt: T + 120_000 },
      },
    });

    const seguimiento = b.negocio()[1];
    const [, update] = (seguimiento?.sql ?? '').split('on conflict');
    // Una sola vez: la del calendario que se abre, no la del cierre.
    expect(update?.match(/"cancel_verify_next_at" = \$/g)).toHaveLength(1);
    expect(seguimiento?.parameters).toContainEqual(new Date(T + 120_000));
    expect(b.negocio().some((q) => q.sql.includes('order_operations'))).toBe(false);
  });

  it('transitionByReading que pierde el CAS de la foto deshace la orden y devuelve false', async () => {
    const b = conFilas(false);

    await expect(
      b.store.transitionByReading(TENANT, ORDEN, {
        from: 'pending',
        to: 'cancelled',
        expected: ESPERADO,
        write: { at: T, source: 'reconciliation' },
      }),
    ).resolves.toBe(false);
    // La transacción se deshace antes de tocar la operación sin verificar.
    expect(b.negocio().some((q) => q.sql.includes('order_operations'))).toBe(false);
  });
});
