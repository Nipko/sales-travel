import type { DatabaseService } from '../../database/database.service.js';
import type { HcnState, HotelOrderSubStatus } from '../../database/database.types.js';
import type {
  HotelCancelTarget,
  HotelCancelTrackingWrite,
  HotelCancelVerifyAdvance,
  HotelOrderCancellationStore,
} from '../hotel-order-cancellation.store.js';

/**
 * Dobles de Postgres para la cancelación de una orden de hotel (docs/tbo/09 PR-5.3), compartidos por
 * los tests de `OrdersService` y de `HotelOrderCancellationService`.
 *
 * Un solo estado para `orders`, `order_operations` y `hotel_order_tracking`, con lo que decide estos
 * casos: RLS por tenant, transacciones que se deshacen ENTERAS si fallan (el seguimiento incluido,
 * porque se escribe dentro de la transacción de la operación), el índice de la cancelación
 * pendiente (0037) y los CAS del calendario de verificación (0046). El SQL real lo prueba
 * `hotel-order-cancellation.integration.test.ts` contra Postgres.
 */

export type Row = Record<string, unknown>;

export interface TrackingRow {
  sub_status: HotelOrderSubStatus | null;
  provider_status: string | null;
  provider_status_source: string | null;
  provider_voucher_status: string | null;
  refund_awaited: boolean;
  hcn: string | null;
  hcn_state: HcnState | null;
  cancel_verify_anchor_at: number | null;
  cancel_verify_step: number | null;
  cancel_verify_next_at: number | null;
}

export interface HotelCancelState {
  orders: Row[];
  operations: Row[];
  tracking: Map<string, TrackingRow>;
}

function emptyTracking(): TrackingRow {
  return {
    sub_status: null,
    provider_status: null,
    provider_status_source: null,
    provider_voucher_status: null,
    refund_awaited: false,
    hcn: null,
    hcn_state: null,
    cancel_verify_anchor_at: null,
    cancel_verify_step: null,
    cancel_verify_next_at: null,
  };
}

function clone(state: HotelCancelState): HotelCancelState {
  return {
    orders: state.orders.map((r) => ({ ...r })),
    operations: state.operations.map((r) => ({ ...r })),
    tracking: new Map([...state.tracking].map(([k, v]) => [k, { ...v }])),
  };
}

function restore(state: HotelCancelState, from: HotelCancelState): void {
  state.orders.splice(0, state.orders.length, ...from.orders);
  state.operations.splice(0, state.operations.length, ...from.operations);
  state.tracking.clear();
  for (const [k, v] of from.tracking) state.tracking.set(k, v);
}

function parse(value: unknown): Row {
  if (typeof value === 'string') return JSON.parse(value) as Row;
  return (value ?? {}) as Row;
}

/** Lo que una escritura de la cancelación deja en la fila (la misma regla que `columnsOf`). */
export function applyTrackingWrite(
  row: TrackingRow,
  write: Omit<HotelCancelTrackingWrite, never>,
): void {
  if (write.record !== undefined) {
    row.provider_status = write.record.providerStatus;
    row.provider_status_source = write.source;
    row.refund_awaited = write.record.refundAwaited;
    if (write.record.voucherStatus !== undefined) {
      row.provider_voucher_status = write.record.voucherStatus;
    }
  }
  if (write.subStatus !== undefined) row.sub_status = write.subStatus;
  if (write.hcn !== undefined) {
    row.hcn = write.hcn.hcn;
    if (write.hcn.markReceived) row.hcn_state = 'received';
  }
  if (
    write.stopHcn === true &&
    (row.hcn_state === 'out-of-window' || row.hcn_state === 'scheduled')
  ) {
    row.hcn_state = 'stopped';
  }
  if (write.openCalendar !== undefined) {
    row.cancel_verify_anchor_at = write.openCalendar.anchorAt;
    row.cancel_verify_step = 0;
    row.cancel_verify_next_at = write.openCalendar.nextAt;
  }
}

export function memoryHotelCancellation(initial: Partial<HotelCancelState> = {}) {
  const state: HotelCancelState = {
    orders: initial.orders ?? [],
    operations: initial.operations ?? [],
    tracking: initial.tracking ?? new Map<string, TrackingRow>(),
  };
  let sequence = 0;
  let clock = 1_700_000_000_000;

  const transaction = (tenant: string) => {
    const visible = (table: string): Row[] => {
      const rows =
        table === 'orders' ? state.orders : table === 'order_operations' ? state.operations : [];
      return rows.filter((r) => r['tenant_id'] === tenant);
    };

    const selectFrom = (table: string) => {
      const filters: [string, unknown][] = [];
      let desc = false;
      let limit: number | undefined;
      const rows = (): Row[] => {
        const found = visible(table).filter((r) => filters.every(([f, v]) => r[f] === v));
        const ordered = desc
          ? [...found].sort((a, b) => Number(b['created_at']) - Number(a['created_at']))
          : found;
        return (limit === undefined ? ordered : ordered.slice(0, limit)).map((r) => ({ ...r }));
      };
      const q = {
        select: () => q,
        selectAll: () => q,
        where: (field: string, _op: string, value: unknown) => {
          filters.push([field, value]);
          return q;
        },
        orderBy: (_field: string, direction?: string) => {
          desc = direction === 'desc';
          return q;
        },
        limit: (n: number) => {
          limit = n;
          return q;
        },
        execute: () => Promise.resolve(rows()),
        executeTakeFirst: () => Promise.resolve(rows()[0]),
      };
      return q;
    };

    const insertInto = (table: string) => {
      let values: Row = {};
      const insert = (): Row => {
        if (table !== 'order_operations') throw new Error(`insert inesperado en ${table}`);
        if (values['tenant_id'] !== tenant) throw new Error('RLS: tenant_id ajeno');
        if (
          values['type'] === 'cancel' &&
          values['status'] === 'pending' &&
          state.operations.some(
            (op) =>
              op['order_id'] === values['order_id'] &&
              op['type'] === 'cancel' &&
              op['status'] === 'pending',
          )
        ) {
          throw Object.assign(new Error('duplicate pending cancel'), {
            code: '23505',
            constraint: 'uq_order_operations_pending_cancel',
          });
        }
        sequence += 1;
        clock += 1;
        const row = { id: `op-${sequence}`, attempts: 1, created_at: clock, ...values };
        state.operations.push(row);
        return { ...row };
      };
      const q = {
        values: (v: Row) => {
          values = v;
          return q;
        },
        returning: () => q,
        executeTakeFirst: () => Promise.resolve().then(insert),
      };
      return q;
    };

    const updateTable = (table: string) => {
      const filters: [string, unknown][] = [];
      let values: Row = {};
      const apply = (): Row | undefined => {
        const target = visible(table).find((r) => filters.every(([f, v]) => r[f] === v));
        if (target === undefined) return undefined;
        Object.assign(target, values);
        return { ...target };
      };
      const q = {
        set: (v: Row) => {
          values = v;
          return q;
        },
        where: (field: string, _op: string, value: unknown) => {
          filters.push([field, value]);
          return q;
        },
        returning: () => q,
        returningAll: () => q,
        execute: () => Promise.resolve().then(() => [{ numUpdatedRows: apply() ? 1n : 0n }]),
        executeTakeFirst: () => Promise.resolve().then(apply),
      };
      return q;
    };

    return { selectFrom, insertInto, updateTable };
  };

  /** Serializa las transacciones y las deshace enteras si fallan, como Postgres. */
  let tail = Promise.resolve();
  const withTenant = <T>(tenant: string, fn: (trx: unknown) => Promise<T>): Promise<T> => {
    const run = tail.then(async () => {
      const before = clone(state);
      try {
        return await fn(transaction(tenant));
      } catch (err) {
        restore(state, before);
        throw err;
      }
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const db = { withTenant } as unknown as DatabaseService;

  const trackingOf = (orderId: string): TrackingRow => {
    let row = state.tracking.get(orderId);
    if (row === undefined) {
      row = emptyTracking();
      state.tracking.set(orderId, row);
    }
    return row;
  };

  const targetOf = (order: Row): HotelCancelTarget => {
    const t = state.tracking.get(String(order['id'])) ?? emptyTracking();
    return {
      orderId: String(order['id']),
      provider: String(order['provider']),
      userId: String(order['user_id']),
      status: order['status'] as HotelCancelTarget['status'],
      providerOrderId: (order['provider_order_id'] as string | null) ?? null,
      providerAccountId: (order['provider_account_id'] as string | null) ?? null,
      bookingReference: (order['provider_booking_ref'] as string | null) ?? null,
      snapshot: {
        status: order['status'] as HotelCancelTarget['status'],
        subStatus: t.sub_status,
        providerStatus: t.provider_status,
        voucherStatus: t.provider_voucher_status,
        refundAwaited: t.refund_awaited,
        hcn: t.hcn,
        hcnState: t.hcn_state,
      },
      calendar: {
        anchorAt: t.cancel_verify_anchor_at,
        step: t.cancel_verify_step,
        nextAt: t.cancel_verify_next_at,
      },
    };
  };

  const orderOf = (tenantId: string, orderId: string): Row | undefined =>
    state.orders.find((o) => o['id'] === orderId && o['tenant_id'] === tenantId);

  /** Las llamadas que recibió, en orden: para afirmar QUÉ se escribió dentro del claim. */
  const calls: { method: string; orderId: string; write?: unknown }[] = [];

  const advanceIn = (
    orderId: string,
    fromStep: number,
    next: HotelCancelVerifyAdvance,
  ): boolean => {
    const row = state.tracking.get(orderId);
    if (
      row === undefined ||
      row.cancel_verify_step !== fromStep ||
      row.cancel_verify_next_at === null
    ) {
      return false;
    }
    if (next.write !== undefined) applyTrackingWrite(row, next.write);
    row.cancel_verify_step = next.step;
    row.cancel_verify_next_at = next.nextAt;
    return true;
  };

  const store = {
    findTarget: (tenantId: string, orderId: string) => {
      const order = orderOf(tenantId, orderId);
      return Promise.resolve(order === undefined ? undefined : targetOf(order));
    },
    listDue: (tenantId: string, query: { dueBefore: number; limit: number }) =>
      Promise.resolve(
        state.orders
          .filter((o) => o['tenant_id'] === tenantId)
          .filter((o) => {
            const next = state.tracking.get(String(o['id']))?.cancel_verify_next_at ?? null;
            return next !== null && next <= query.dueBefore;
          })
          .slice(0, query.limit)
          .map(targetOf),
      ),
    markRequested: (_trx: unknown, _tenantId: string, orderId: string) => {
      calls.push({ method: 'markRequested', orderId });
      const row = trackingOf(orderId);
      row.sub_status = 'cancel-requested';
      row.cancel_verify_next_at = null;
      return Promise.resolve();
    },
    writeOutcome: (
      _trx: unknown,
      _tenantId: string,
      orderId: string,
      write: HotelCancelTrackingWrite,
    ) => {
      calls.push({ method: 'writeOutcome', orderId, write });
      applyTrackingWrite(trackingOf(orderId), write);
      return Promise.resolve();
    },
    advance: (
      tenantId: string,
      orderId: string,
      fromStep: number,
      next: HotelCancelVerifyAdvance,
    ) =>
      withTenant(tenantId, () => {
        calls.push({ method: 'advance', orderId, write: next });
        return Promise.resolve(advanceIn(orderId, fromStep, next));
      }),
    close: (
      tenantId: string,
      orderId: string,
      fromStep: number,
      write: Omit<HotelCancelTrackingWrite, 'openCalendar'>,
    ) =>
      withTenant(tenantId, () => {
        calls.push({ method: 'close', orderId, write });
        const order = orderOf(tenantId, orderId);
        if (order?.['status'] !== 'pending') return Promise.resolve(false);
        if (!advanceIn(orderId, fromStep, { step: fromStep + 1, nextAt: null, write })) {
          return Promise.resolve(false);
        }
        order['status'] = 'cancelled';
        const latest = state.operations
          .filter((op) => op['order_id'] === orderId && op['type'] === 'cancel')
          .sort((a, b) => Number(b['created_at']) - Number(a['created_at']))[0];
        if (
          latest?.['status'] === 'failed' &&
          parse(latest['result'])['outcome'] === 'UNVERIFIED'
        ) {
          latest['status'] = 'success';
          latest['result'] = JSON.stringify({
            ...parse(latest['result']),
            status: 'success',
            outcome: 'SUCCEEDED',
            retryable: false,
            reconciliationRequired: false,
            reason: 'completed',
            resolvedBy: 'verify-cancellation',
          });
        }
        return Promise.resolve(true);
      }),
  };

  return {
    state,
    db,
    store: store as unknown as HotelOrderCancellationStore,
    calls,
    tracking: (orderId: string) => state.tracking.get(orderId),
    order: (orderId: string) => state.orders.find((o) => o['id'] === orderId),
    operations: (orderId: string) => state.operations.filter((o) => o['order_id'] === orderId),
    result: (op: Row | undefined) => parse(op?.['result']),
  };
}
