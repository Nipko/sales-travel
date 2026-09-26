import type {
  HcnPriority,
  HcnState,
  HotelOrderSubStatus,
  OrderStatus,
} from '../../database/database.types.js';
import type {
  HcnDueQuery,
  HcnExpectation,
  HcnOpeningWrite,
  HcnTarget,
  HcnTrackingStore,
  HcnUnplannedQuery,
  HcnWrite,
} from '../hcn-tracking.store.js';

/**
 * Doble de Postgres del seguimiento del HCN (docs/tbo/09 PR-5.4) con lo que decide estos casos: RLS
 * por tenant, el CAS del plan, la tarea de operaciones en la misma "transacción" y los filtros del
 * barrido. El SQL real lo prueban `hcn-tracking.store.test.ts` (compilado) y
 * `hcn-tracking.integration.test.ts` (contra Postgres).
 */

export interface MemoryHcnOrder {
  id: string;
  tenant_id: string;
  user_id: string;
  provider: string;
  status: OrderStatus;
  provider_order_id: string | null;
  provider_account_id: string | null;
  provider_booking_ref: string | null;
  created_at: number;
  search_criteria: Record<string, unknown>;
  /** Lo que el seguimiento nunca debe copiar a una tarea ni a un evento. */
  passengers?: unknown;
  contact_info?: unknown;
}

export interface MemoryHcnRow {
  sub_status: HotelOrderSubStatus | null;
  provider_status: string | null;
  provider_status_source: string | null;
  provider_status_at: number | null;
  provider_voucher_status: string | null;
  refund_awaited: boolean;
  hcn: string | null;
  hcn_received_at: number | null;
  hcn_state: HcnState | null;
  hcn_priority: HcnPriority | null;
  hcn_next_check_at: number | null;
  hcn_attempts: number;
}

export interface MemoryHcnOperation {
  tenant_id: string;
  order_id: string;
  type: string;
  status: string;
  result: string;
  actor_user_id: string | null;
}

export function emptyHcnRow(): MemoryHcnRow {
  return {
    sub_status: null,
    provider_status: null,
    provider_status_source: null,
    provider_status_at: null,
    provider_voucher_status: null,
    refund_awaited: false,
    hcn: null,
    hcn_received_at: null,
    hcn_state: null,
    hcn_priority: null,
    hcn_next_check_at: null,
    hcn_attempts: 0,
  };
}

export class MemoryHcnTracking {
  readonly orders: MemoryHcnOrder[] = [];
  readonly tracking = new Map<string, MemoryHcnRow>();
  readonly operations: MemoryHcnOperation[] = [];
  /** Para simular la base caída en una operación. */
  readonly fallas: Partial<Record<keyof HcnTrackingStore, Error>> = {};
  /** Antes de escribir: para simular otro camino que escribe en medio de una lectura. */
  antesDeEscribir: (() => void) | undefined;

  constructor(orders: MemoryHcnOrder[] = [], tracking: [string, MemoryHcnRow][] = []) {
    this.orders.push(...orders);
    for (const [id, row] of tracking) this.tracking.set(id, row);
  }

  asStore(): HcnTrackingStore {
    return this as unknown as HcnTrackingStore;
  }

  row(orderId: string): MemoryHcnRow | undefined {
    return this.tracking.get(orderId);
  }

  findTarget(tenantId: string, orderId: string): Promise<HcnTarget | undefined> {
    return this.run('findTarget', () => {
      const order = this.visible(tenantId).find((o) => o.id === orderId);
      return order === undefined ? undefined : this.targetOf(order);
    });
  }

  listDue(tenantId: string, query: HcnDueQuery): Promise<HcnTarget[]> {
    return this.run('listDue', () =>
      this.visible(tenantId)
        .flatMap((order) => {
          const t = this.tracking.get(order.id);
          const next = t?.hcn_next_check_at ?? null;
          if (t === undefined || next === null) return [];
          const due =
            (t.hcn_state === 'scheduled' && next <= query.scheduledBefore) ||
            (t.hcn_state === 'out-of-window' && next <= query.windowBefore);
          return due ? [{ order, next }] : [];
        })
        .sort((a, b) => a.next - b.next)
        .slice(0, query.limit)
        .map(({ order }) => this.targetOf(order)),
    );
  }

  listUnplanned(tenantId: string, query: HcnUnplannedQuery): Promise<HcnTarget[]> {
    return this.run('listUnplanned', () =>
      this.visible(tenantId)
        .filter((o) => {
          const checkin = o.search_criteria['checkinDate'];
          return (
            o.status === 'confirmed' &&
            o.provider_order_id !== null &&
            query.providers.includes(o.provider) &&
            o.search_criteria['vertical'] === 'hotels' &&
            (this.tracking.get(o.id)?.hcn_state ?? null) === null &&
            typeof checkin === 'string' &&
            /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(checkin) &&
            checkin >= query.checkinFrom
          );
        })
        .sort((a, b) => a.created_at - b.created_at)
        .slice(0, query.limit)
        .map((o) => this.targetOf(o)),
    );
  }

  open(tenantId: string, orderId: string, opening: HcnOpeningWrite): Promise<boolean> {
    return this.run('open', () => {
      const order = this.visible(tenantId).find((o) => o.id === orderId);
      if (order === undefined) throw new Error('la FK (order_id, tenant_id) no encuentra la orden');
      const row = this.tracking.get(orderId) ?? emptyHcnRow();
      if (row.hcn_state !== null) return false;
      this.tracking.set(orderId, {
        ...row,
        hcn_state: opening.state,
        hcn_priority: opening.priority,
        hcn_next_check_at: opening.nextAt,
        hcn_attempts: 0,
      });
      return true;
    });
  }

  advance(
    tenantId: string,
    orderId: string,
    from: HcnExpectation,
    write: HcnWrite,
  ): Promise<boolean> {
    return this.run('advance', () => {
      this.antesDeEscribir?.();
      const order = this.visible(tenantId).find((o) => o.id === orderId);
      const row = this.tracking.get(orderId);
      if (order === undefined || row === undefined) return false;
      if (row.hcn_state !== from.state || row.hcn_attempts !== from.attempts) return false;
      const s = from.snapshot;
      if (
        s !== undefined &&
        (row.sub_status !== s.subStatus ||
          row.provider_status !== s.providerStatus ||
          row.hcn !== s.hcn)
      ) {
        return false;
      }
      const read = write.read;
      if (read?.record !== undefined) {
        row.provider_status = read.record.providerStatus;
        row.provider_status_at = read.at;
        row.provider_status_source = 'hcn';
        row.refund_awaited = read.record.refundAwaited;
        if (read.record.voucherStatus !== undefined) {
          row.provider_voucher_status = read.record.voucherStatus;
        }
      }
      if (read?.subStatus !== undefined) row.sub_status = read.subStatus;
      if (read?.hcn !== undefined) {
        row.hcn = read.hcn;
        row.hcn_received_at = read.at;
      }
      row.hcn_state = write.state;
      row.hcn_attempts = write.attempts;
      row.hcn_next_check_at = write.nextAt;
      if (write.priority !== undefined) row.hcn_priority = write.priority;
      assertChecks(row);
      if (write.ticket !== undefined) {
        this.operations.push({
          tenant_id: tenantId,
          order_id: orderId,
          type: 'hcn-ticket',
          status: 'pending',
          result: JSON.stringify(write.ticket),
          actor_user_id: null,
        });
      }
      return true;
    });
  }

  private visible(tenantId: string): MemoryHcnOrder[] {
    return this.orders.filter((o) => o.tenant_id === tenantId);
  }

  private targetOf(o: MemoryHcnOrder): HcnTarget {
    const t = this.tracking.get(o.id);
    const text = (key: string): string | null => {
      const value = o.search_criteria[key];
      return typeof value === 'string' ? value : null;
    };
    return {
      orderId: o.id,
      provider: o.provider,
      userId: o.user_id,
      status: o.status,
      providerOrderId: o.provider_order_id,
      providerAccountId: o.provider_account_id,
      bookingReference: o.provider_booking_ref,
      createdAt: o.created_at,
      checkinDate: text('checkinDate'),
      checkoutDate: text('checkoutDate'),
      hotelId: text('hotelId'),
      snapshot: {
        status: o.status,
        subStatus: t?.sub_status ?? null,
        providerStatus: t?.provider_status ?? null,
        voucherStatus: t?.provider_voucher_status ?? null,
        refundAwaited: t?.refund_awaited === true,
        hcn: t?.hcn ?? null,
        hcnState: t?.hcn_state ?? null,
      },
      tracking: {
        state: t?.hcn_state ?? null,
        priority: t?.hcn_priority ?? null,
        nextAt: t?.hcn_next_check_at ?? null,
        attempts: t?.hcn_attempts ?? 0,
      },
    };
  }

  private run<T>(op: keyof HcnTrackingStore, fn: () => T): Promise<T> {
    const falla = this.fallas[op];
    if (falla !== undefined) return Promise.reject(falla);
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/** Los CHECK de 0042 sobre el HCN: el doble falla donde fallaría Postgres. */
function assertChecks(row: MemoryHcnRow): void {
  if (row.hcn_state === 'received' && (row.hcn === null || row.hcn_received_at === null)) {
    throw new Error('hotel_order_tracking_hcn_received');
  }
  if (
    row.hcn_next_check_at !== null &&
    row.hcn_state !== 'out-of-window' &&
    row.hcn_state !== 'scheduled'
  ) {
    throw new Error('hotel_order_tracking_hcn_wakeup');
  }
}
