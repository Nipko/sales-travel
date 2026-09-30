import type { Money } from '@sales-travel/canonical';
import type {
  HcnState,
  HotelOrderSubStatus,
  OrderStatus,
  WalletHoldStatus,
} from '../../database/database.types.js';
import type { HcnTrackingService } from '../../hotels/hcn-tracking.service.js';
import type {
  ExternalCreateOutcome,
  ExternalOrderIntentService,
} from '../../orders/external-order-intent.service.js';
import type {
  HotelCancelTrackingWrite,
  HotelOrderCancellationStore,
} from '../../orders/hotel-order-cancellation.store.js';
import type {
  HotelOrderReadTarget,
  HotelOrderReadWrite,
  HotelOrderTrackingStore,
} from '../../orders/hotel-order-tracking.store.js';
import type { BookingHoldLedger } from '../../portfolios/booking-hold.ledger.js';
import type { WalletHoldSettleOutcome } from '../../portfolios/wallet-hold.store.js';
import type { ProviderCredentialsService } from '../../provider-credentials/provider-credentials.service.js';
import type { ReconciliationOrder } from '../reconciliation.plan.js';
import type {
  FinishRunInput,
  ReconciliationItemInput,
  ReconciliationItemRow,
  ReconciliationRunRow,
  ReconciliationStore,
  StartRunInput,
} from '../reconciliation.store.js';

/**
 * Lo que la conciliación toca en Postgres, en memoria y con la RLS de verdad por tenant: cada
 * método ve sólo las filas del tenant con que se lo llama, como `withTenant`. Existe para probar el
 * servicio por su puerta pública sin montar la base; el SQL real lo prueba
 * `reconciliation.integration.test.ts`.
 */

export interface MemoryTenant {
  readonly id: string;
  readonly parent: string | null;
}

export interface MemoryOrder {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: string;
  status: OrderStatus;
  providerOrderId: string | null;
  readonly bookingReference: string | null;
  readonly accountId: string | null;
  providerRawNull: boolean;
  readonly createdAt: number;
  readonly checkout: string | null;
  readonly net: Money | null;
  createRequestKey: string | null;
  /** Huéspedes: nada de la conciliación puede copiarlos. */
  readonly guests: readonly string[];
}

export interface MemoryTracking {
  subStatus: HotelOrderSubStatus | null;
  providerStatus: string | null;
  providerStatusSource: string | null;
  refundAwaited: boolean;
  voucherStatus: string | null;
  hcn: string | null;
  hcnState: HcnState | null;
  verifyNextAt: number | null;
  cancelAnchorAt: number | null;
  cancelNextAt: number | null;
}

export function emptyTracking(extra: Partial<MemoryTracking> = {}): MemoryTracking {
  return {
    subStatus: null,
    providerStatus: null,
    providerStatusSource: null,
    refundAwaited: false,
    voucherStatus: null,
    hcn: null,
    hcnState: null,
    verifyNextAt: null,
    cancelAnchorAt: null,
    cancelNextAt: null,
    ...extra,
  };
}

interface MemoryRun extends ReconciliationRunRow {
  readonly tenantId: string;
  readonly accountId: string;
}

interface MemoryItem extends ReconciliationItemRow {
  readonly tenantId: string;
  readonly accountId: string;
  readonly dedupeKey: string;
}

export interface MemoryAccount {
  readonly id: string;
  readonly tenantId: string;
  readonly providerCode: string;
  readonly active: boolean;
}

/**
 * Una retención de cartera de 0060, como la ve el nodo que vende: el grupo, con la cuenta de la
 * orden. `holds.settle` la cierra con la tabla de `wallet_hold_settle`.
 */
export interface MemoryHoldGroup {
  readonly orderId: string;
  status: WalletHoldStatus;
  readonly createdBy: string;
}

export class MemoryReconciliationBank {
  readonly runs: MemoryRun[] = [];
  readonly items: MemoryItem[] = [];
  readonly tracking = new Map<string, MemoryTracking>();
  readonly holdsReleased: { tenantId: string; orderId: string; as: 'cancelled' | 'failed' }[] = [];
  /** Las retenciones registradas (0060), por orden. Vacío salvo que el test las siembre. */
  readonly holdGroups: MemoryHoldGroup[] = [];
  /** Cada `holds.settle` sin precondición, con el tenant, el actor y lo que devolvió. */
  readonly holdSettles: {
    tenantId: string;
    orderId: string;
    actor: string;
    outcome: WalletHoldSettleOutcome;
  }[] = [];
  readonly hcnScheduled: { tenantId: string; orderId: string }[] = [];
  readonly settles: { tenantId: string; orderId: string; outcome: ExternalCreateOutcome }[] = [];
  /** Cada consulta de órdenes, con el tenant con el que corrió. */
  readonly orderQueries: string[] = [];
  private sequence = 0;
  /** Si se define, `startRun` devuelve `undefined`: otra corrida en curso. */
  busy = false;
  /** Si se define, `holds.release*` y `holds.settle` lanzan. */
  holdFailure: Error | undefined;
  /** Si se define, `listMisalignedHolds` lanza (la base no respondió). */
  holdListFailure: Error | undefined;
  /** Si se define, `inactiveOwnAccountIds` lanza (la base no respondió). */
  inactiveAccountsFailure: Error | undefined;
  /** Si se define, `recordItem` lanza (la base no respondió). */
  itemFailure: Error | undefined;

  constructor(
    readonly tenants: readonly MemoryTenant[],
    readonly orders: MemoryOrder[],
    readonly accounts: readonly MemoryAccount[] = [],
  ) {}

  trackingOf(orderId: string): MemoryTracking {
    return this.tracking.get(orderId) ?? emptyTracking();
  }

  order(orderId: string): MemoryOrder {
    const found = this.orders.find((o) => o.id === orderId);
    if (found === undefined) throw new Error(`orden desconocida ${orderId}`);
    return found;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private ancestorsOf(tenantId: string): string[] {
    const chain: string[] = [];
    let current: string | null = tenantId;
    while (current !== null) {
      chain.push(current);
      current = this.tenants.find((t) => t.id === current)?.parent ?? null;
    }
    return chain;
  }

  private view(o: MemoryOrder): ReconciliationOrder {
    const t = this.trackingOf(o.id);
    return {
      tenantId: o.tenantId,
      orderId: o.id,
      userId: o.userId,
      status: o.status,
      subStatus: t.subStatus,
      providerStatus: t.providerStatus,
      refundAwaited: t.refundAwaited,
      providerOrderId: o.providerOrderId,
      bookingReference: o.bookingReference,
      createdAt: o.createdAt,
      openIntent:
        o.status === 'pending' &&
        o.providerRawNull &&
        o.providerOrderId === null &&
        o.bookingReference !== null,
      verificationScheduled: t.verifyNextAt !== null,
      cancelSince: t.cancelAnchorAt,
      net: o.net,
    };
  }

  private target(o: MemoryOrder): HotelOrderReadTarget {
    const t = this.trackingOf(o.id);
    return {
      orderId: o.id,
      provider: o.provider,
      userId: o.userId,
      status: o.status,
      providerOrderId: o.providerOrderId,
      providerAccountId: o.accountId,
      bookingReference: o.bookingReference,
      snapshot: {
        status: o.status,
        subStatus: t.subStatus,
        providerStatus: t.providerStatus,
        voucherStatus: t.voucherStatus,
        refundAwaited: t.refundAwaited,
        hcn: t.hcn,
        hcnState: t.hcnState,
      },
    };
  }

  private matches(
    tenantId: string,
    orderId: string,
    expected: HotelOrderReadWrite['expected'],
  ): boolean {
    const t = this.trackingOf(orderId);
    void tenantId;
    return (
      t.subStatus === expected.subStatus &&
      t.providerStatus === expected.providerStatus &&
      t.hcn === expected.hcn &&
      t.hcnState === expected.hcnState
    );
  }

  private apply(
    orderId: string,
    write: Omit<HotelCancelTrackingWrite, 'source'> & { source: string },
  ) {
    const t = { ...this.trackingOf(orderId) };
    if (write.record !== undefined) {
      t.providerStatus = write.record.providerStatus;
      t.providerStatusSource = write.source;
      t.refundAwaited = write.record.refundAwaited;
      if (write.record.voucherStatus !== undefined) t.voucherStatus = write.record.voucherStatus;
    }
    if (write.subStatus !== undefined) t.subStatus = write.subStatus;
    if (write.hcn !== undefined) {
      t.hcn = write.hcn.hcn;
      if (write.hcn.markReceived) t.hcnState = 'received';
    }
    if (write.stopHcn === true && (t.hcnState === 'scheduled' || t.hcnState === 'out-of-window')) {
      t.hcnState = 'stopped';
    }
    if (write.openCalendar !== undefined) {
      t.cancelAnchorAt = write.openCalendar.anchorAt;
      t.cancelNextAt = write.openCalendar.nextAt;
    }
    this.tracking.set(orderId, t);
  }

  asStore(): ReconciliationStore {
    const store = {
      allTenants: () => Promise.resolve(this.tenants.map((t) => t.id).sort()),
      networkOf: (owner: string) =>
        Promise.resolve(
          this.tenants
            .filter((t) => this.ancestorsOf(t.id).includes(owner))
            .map((t) => t.id)
            .sort(),
        ),
      listAnchors: (
        tenantId: string,
        q: { provider: string; accountId: string; checkoutFrom: string },
      ) => {
        this.orderQueries.push(tenantId);
        return Promise.resolve(
          this.orders
            .filter(
              (o) =>
                o.tenantId === tenantId && o.provider === q.provider && o.accountId === q.accountId,
            )
            .filter(
              (o) =>
                this.view(o).openIntent ||
                (['pending', 'confirmed', 'ticketed'].includes(o.status) &&
                  (o.checkout === null || o.checkout >= q.checkoutFrom)),
            )
            .map((o) => this.view(o)),
        );
      },
      listByKeys: (
        tenantId: string,
        q: { provider: string; accountId: string; locators: string[]; references: string[] },
      ) => {
        this.orderQueries.push(tenantId);
        const locators = new Set(q.locators.map((k) => k.toUpperCase()));
        const refs = new Set(q.references.map((k) => k.toUpperCase()));
        return Promise.resolve(
          this.orders
            .filter(
              (o) =>
                o.tenantId === tenantId && o.provider === q.provider && o.accountId === q.accountId,
            )
            .filter(
              (o) =>
                (o.providerOrderId !== null && locators.has(o.providerOrderId.toUpperCase())) ||
                (o.bookingReference !== null && refs.has(o.bookingReference.toUpperCase())),
            )
            .map((o) => this.view(o)),
        );
      },
      startRun: (tenantId: string, input: StartRunInput) => {
        if (this.busy) return Promise.resolve(undefined);
        const id = this.nextId('run');
        this.runs.push({
          id,
          tenantId,
          accountId: input.accountId,
          trigger: input.trigger,
          status: 'running',
          windows: [],
          rowsRead: 0,
          rowsMatched: 0,
          discrepancies: 0,
          summary: {},
          errorClass: null,
          startedAt: new Date(),
          finishedAt: null,
        });
        return Promise.resolve(id);
      },
      finishRun: (tenantId: string, runId: string, input: FinishRunInput) => {
        const i = this.runs.findIndex((r) => r.id === runId && r.tenantId === tenantId);
        const run = this.runs[i];
        if (run === undefined) throw new Error('corrida de otro tenant');
        this.runs[i] = {
          ...run,
          status: input.status,
          windows: input.windows,
          rowsRead: input.rowsRead,
          rowsMatched: input.rowsMatched,
          discrepancies: input.discrepancies,
          summary: input.summary,
          errorClass: input.errorClass ?? null,
          finishedAt: new Date(),
        };
        return Promise.resolve();
      },
      listRuns: (tenantId: string, accountId: string, q: { since?: number; limit: number }) =>
        Promise.resolve(
          this.runs
            .filter((r) => r.tenantId === tenantId && r.accountId === accountId)
            .filter((r) => q.since === undefined || r.startedAt.getTime() >= q.since)
            .reverse()
            .slice(0, q.limit),
        ),
      recordItem: (tenantId: string, item: ReconciliationItemInput) => {
        if (this.itemFailure !== undefined) return Promise.reject(this.itemFailure);
        if (item.orderId !== undefined && this.order(item.orderId).tenantId !== tenantId) {
          // La FK compuesta de 0047: un ítem de una orden vive en el tenant de la orden.
          throw new Error('ítem de una orden en otro tenant');
        }
        if (
          this.items.some((i) => i.accountId === item.accountId && i.dedupeKey === item.dedupeKey)
        ) {
          return Promise.resolve(false);
        }
        this.items.push({
          id: this.nextId('item'),
          tenantId,
          accountId: item.accountId,
          dedupeKey: item.dedupeKey,
          runId: item.runId,
          kind: item.kind,
          severity: item.severity,
          action: item.action,
          orderId: item.orderId ?? null,
          providerBookingId: item.providerBookingId ?? null,
          details: item.details,
          createdAt: new Date(),
        });
        return Promise.resolve(true);
      },
      listItems: (tenantId: string, runIds: readonly string[]) =>
        Promise.resolve(
          this.items.filter((i) => i.tenantId === tenantId && runIds.includes(i.runId)),
        ),
      inactiveOwnAccountIds: (owner: string, provider: string) =>
        this.inactiveAccountsFailure !== undefined
          ? Promise.reject(this.inactiveAccountsFailure)
          : Promise.resolve(
              this.accounts
                .filter((a) => a.tenantId === owner && a.providerCode === provider && !a.active)
                .map((a) => a.id)
                .sort(),
            ),
      listMisalignedHolds: (
        tenantId: string,
        q: { provider: string; accountIds: readonly string[]; limit: number },
      ) =>
        this.holdListFailure !== undefined
          ? Promise.reject(this.holdListFailure)
          : Promise.resolve(
              this.holdGroups
                .map((g) => ({ g, o: this.order(g.orderId) }))
                .filter(
                  ({ o }) =>
                    o.tenantId === tenantId &&
                    o.provider === q.provider &&
                    o.accountId !== null &&
                    q.accountIds.includes(o.accountId),
                )
                .filter(
                  ({ g, o }) =>
                    (['held', 'captured'].includes(g.status) &&
                      ['failed', 'cancelled'].includes(o.status)) ||
                    (g.status === 'held' && ['confirmed', 'ticketed'].includes(o.status)),
                )
                .slice(0, q.limit)
                .map(({ g, o }) => ({
                  orderId: g.orderId,
                  holdStatus: g.status,
                  orderStatus: o.status,
                  createdBy: g.createdBy,
                })),
            ),
    };
    return store as unknown as ReconciliationStore;
  }

  asTracking(): HotelOrderTrackingStore {
    const tracking = {
      findReadTarget: (tenantId: string, orderId: string) => {
        const o = this.orders.find((x) => x.id === orderId && x.tenantId === tenantId);
        return Promise.resolve(o === undefined ? undefined : this.target(o));
      },
      recordRead: (tenantId: string, orderId: string, write: HotelOrderReadWrite) => {
        const o = this.orders.find((x) => x.id === orderId && x.tenantId === tenantId);
        if (o === undefined || !this.matches(tenantId, orderId, write.expected)) {
          return Promise.resolve(false);
        }
        this.apply(orderId, write);
        return Promise.resolve(true);
      },
    };
    return tracking as unknown as HotelOrderTrackingStore;
  }

  asCancellations(): HotelOrderCancellationStore {
    const store = {
      transitionByReading: (
        tenantId: string,
        orderId: string,
        change: {
          from: OrderStatus;
          to: OrderStatus;
          expected: HotelOrderReadWrite['expected'];
          write: HotelCancelTrackingWrite;
        },
      ) => {
        const o = this.orders.find((x) => x.id === orderId && x.tenantId === tenantId);
        if (o === undefined || o.status !== change.from) return Promise.resolve(false);
        if (!this.matches(tenantId, orderId, change.expected)) return Promise.resolve(false);
        o.status = change.to;
        // Como el store: pasar a `cancelled` corta el HCN aunque la escritura no lo pida.
        this.apply(
          orderId,
          change.to === 'cancelled' ? { ...change.write, stopHcn: true } : change.write,
        );
        if (change.to === 'cancelled') {
          this.tracking.set(orderId, { ...this.trackingOf(orderId), cancelNextAt: null });
        }
        return Promise.resolve(true);
      },
    };
    return store as unknown as HotelOrderCancellationStore;
  }

  asIntents(): ExternalOrderIntentService {
    const intents = {
      settleExternalCreateIntent: (
        tenantId: string,
        intent: { id: string },
        outcome: ExternalCreateOutcome,
      ) => {
        const o = this.orders.find((x) => x.id === intent.id && x.tenantId === tenantId);
        if (o === undefined || o.status !== 'pending' || !o.providerRawNull) {
          return Promise.resolve(undefined);
        }
        o.status = outcome.status;
        o.providerRawNull = false;
        o.providerOrderId = outcome.providerOrderId ?? null;
        if (outcome.status === 'failed') o.createRequestKey = null;
        this.settles.push({ tenantId, orderId: o.id, outcome });
        return Promise.resolve({ id: o.id });
      },
    };
    return intents as unknown as ExternalOrderIntentService;
  }

  asHolds(): BookingHoldLedger {
    const release = (as: 'cancelled' | 'failed') => (tenantId: string, orderId: string) => {
      if (this.holdFailure !== undefined) return Promise.reject(this.holdFailure);
      const o = this.orders.find((x) => x.id === orderId && x.tenantId === tenantId);
      if (o === undefined || o.status !== as) {
        return Promise.reject(new Error('la retención sólo se libera con la orden cerrada'));
      }
      this.holdsReleased.push({ tenantId, orderId, as });
      const group = this.holdGroups.find((g) => g.orderId === orderId);
      if (group !== undefined && (group.status === 'held' || group.status === 'captured')) {
        group.status = 'released';
      }
      return Promise.resolve('released');
    };
    // La tabla de `wallet_hold_settle` sin precondición (db/migrations/0060).
    const settle = (tenantId: string, orderId: string, actor: string) => {
      if (this.holdFailure !== undefined) return Promise.reject(this.holdFailure);
      const o = this.orders.find((x) => x.id === orderId && x.tenantId === tenantId);
      if (o === undefined) return Promise.reject(new Error('la reserva no existe en este nodo'));
      const group = this.holdGroups.find((g) => g.orderId === orderId);
      let outcome: WalletHoldSettleOutcome;
      if (group === undefined) outcome = 'no-hold';
      else if (o.status === 'confirmed' || o.status === 'ticketed') {
        outcome =
          group.status === 'held'
            ? 'captured'
            : group.status === 'captured'
              ? 'already-captured'
              : group.status === 'released'
                ? 'already-released'
                : 'conflict';
        if (group.status === 'held') group.status = 'captured';
      } else if (o.status === 'failed' || o.status === 'cancelled') {
        if (group.status === 'released') outcome = 'already-released';
        else if (group.status === 'conflict') outcome = 'conflict';
        else if (o.status === 'failed' && group.status === 'captured') {
          group.status = 'conflict';
          outcome = 'conflict';
        } else {
          group.status = 'released';
          outcome = 'released';
        }
      } else outcome = 'open';
      this.holdSettles.push({ tenantId, orderId, actor, outcome });
      return Promise.resolve(outcome);
    };
    return {
      releaseCancelled: release('cancelled'),
      releaseFailed: release('failed'),
      settle,
    } as unknown as BookingHoldLedger;
  }

  asHcn(): HcnTrackingService {
    return {
      schedule: (input: { tenantId: string; orderId: string }) => {
        this.hcnScheduled.push(input);
        return Promise.resolve({ opened: true, queued: true });
      },
    } as unknown as HcnTrackingService;
  }

  asCredentials(): ProviderCredentialsService {
    return {
      listActiveOwnAccounts: (tenantId: string, providers: readonly string[]) =>
        Promise.resolve(
          this.accounts
            .filter(
              (a) => a.tenantId === tenantId && a.active && providers.includes(a.providerCode),
            )
            .map((a) => ({ id: a.id, providerCode: a.providerCode })),
        ),
    } as unknown as ProviderCredentialsService;
  }
}
