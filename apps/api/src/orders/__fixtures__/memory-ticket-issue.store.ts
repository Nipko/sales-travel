import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { DB, OrderOperationStatus } from '../../database/database.types.js';
import type { OrderRow } from '../orders.service.js';
import { issueOperationPolicy, type IssueOperationResult } from '../ticket-issue.plan.js';
import type {
  FinalizeOutcome,
  IssueClaimOutcome,
  IssueOperationRecord,
  IssueTransition,
  TicketIssueStore,
} from '../ticket-issue.store.js';

/**
 * `TicketIssueStore` en memoria, con las mismas CAS que el de Postgres: el claim exige la orden
 * `confirmed` y ninguna escritura pendiente (el índice de 0083), el write-ahead sólo gana desde
 * `requested`, y el cierre en `ticketed` es todo o nada —si `inTransaction` lanza, no queda nada
 * escrito—. La CAS contra Postgres de verdad la prueba `ticket-issue.integration.test.ts`.
 *
 * `failNext` hace fallar la próxima llamada a un método, como una base caída.
 */
export class MemoryTicketIssueStore {
  readonly orders = new Map<string, OrderRow>();
  readonly operations = new Map<string, IssueOperationRecord & { tenantId: string }>();
  /** Cada llamada, en orden: para afirmar QUÉ se escribió y cuándo. */
  readonly calls: string[] = [];
  private failures = new Map<string, Error>();
  private sequence = 0;
  private clock = Date.parse('2026-10-13T12:00:00Z');

  failNext(method: keyof TicketIssueStore, error = new Error('base caída')): void {
    this.failures.set(method, error);
  }

  addOrder(order: OrderRow): void {
    this.orders.set(order.id, order);
  }

  /** Mete una operación ya hecha (de un intento anterior o de otro proceso). */
  addOperation(
    tenantId: string,
    op: Pick<IssueOperationRecord, 'orderId' | 'status' | 'result'> &
      Partial<Pick<IssueOperationRecord, 'id' | 'lastError' | 'actorUserId' | 'updatedAt'>>,
  ): IssueOperationRecord {
    this.sequence += 1;
    const at = new Date(this.tick());
    const record = {
      id: op.id ?? randomUUID(),
      orderId: op.orderId,
      status: op.status,
      result: op.result,
      lastError: op.lastError ?? null,
      actorUserId: op.actorUserId ?? null,
      createdAt: at,
      updatedAt: op.updatedAt ?? at,
      tenantId,
    };
    this.operations.set(record.id, record);
    return record;
  }

  operation(id: string): IssueOperationRecord | undefined {
    return this.operations.get(id);
  }

  order(id: string): OrderRow | undefined {
    return this.orders.get(id);
  }

  findOrder(tenantId: string, orderId: string): Promise<OrderRow | undefined> {
    return this.run('findOrder', () => {
      const order = this.orders.get(orderId);
      return order?.tenant_id === tenantId ? { ...order } : undefined;
    });
  }

  claim(
    tenantId: string,
    orderId: string,
    actorUserId: string | null,
    result: IssueOperationResult,
  ): Promise<IssueClaimOutcome> {
    return this.run('claim', (): IssueClaimOutcome => {
      const order = this.orders.get(orderId);
      if (order?.tenant_id !== tenantId) return { claimed: false, refusal: 'not-found' };
      if (order.status !== 'confirmed') return { claimed: false, refusal: 'not-confirmed' };
      const ops = this.ofOrder(tenantId, orderId);
      const latest = ops[ops.length - 1];
      if (latest?.status === 'pending') return { claimed: false, refusal: 'already-pending' };
      if (latest?.status === 'success') return { claimed: false, refusal: 'already-issued' };
      if (
        latest?.status === 'failed' &&
        issueOperationPolicy('failed', latest.result).reconciliationRequired
      ) {
        return { claimed: false, refusal: 'previous-unverified' };
      }
      const op = this.addOperation(tenantId, {
        orderId,
        status: 'pending',
        result,
        actorUserId,
      });
      return { claimed: true, operationId: op.id };
    });
  }

  getOperation(
    tenantId: string,
    orderId: string,
    operationId: string,
  ): Promise<IssueOperationRecord | undefined> {
    return this.run('getOperation', () => {
      const op = this.operations.get(operationId);
      if (op?.tenantId !== tenantId || op.orderId !== orderId) return undefined;
      return structuredClone(op);
    });
  }

  markSent(tenantId: string, operationId: string, result: IssueOperationResult): Promise<boolean> {
    return this.run('markSent', () => {
      const op = this.operations.get(operationId);
      if (op?.tenantId !== tenantId || op.status !== 'pending') return false;
      if (op.result.stage !== 'requested') return false;
      this.write(op, { result });
      return true;
    });
  }

  settle(
    tenantId: string,
    operationId: string,
    transition: IssueTransition,
    status: Exclude<OrderOperationStatus, 'pending'>,
    result: IssueOperationResult,
    lastError: string | null,
  ): Promise<boolean> {
    return this.run('settle', () => {
      const op = this.operations.get(operationId);
      if (op?.tenantId !== tenantId || !transition.from.includes(op.status)) return false;
      if (transition.stage !== undefined && op.result.stage !== transition.stage) return false;
      this.write(op, { status, result, lastError });
      return true;
    });
  }

  updateResult(
    tenantId: string,
    operationId: string,
    expected: OrderOperationStatus,
    result: IssueOperationResult,
  ): Promise<boolean> {
    return this.run('updateResult', () => {
      const op = this.operations.get(operationId);
      if (op?.tenantId !== tenantId || op.status !== expected) return false;
      this.write(op, { result });
      return true;
    });
  }

  async finalizeTicketed(
    tenantId: string,
    orderId: string,
    operationId: string,
    result: IssueOperationResult,
    inTransaction: (trx: Transaction<DB>, order: OrderRow) => Promise<void>,
  ): Promise<FinalizeOutcome> {
    this.calls.push('finalizeTicketed');
    const failure = this.failures.get('finalizeTicketed');
    if (failure !== undefined) {
      this.failures.delete('finalizeTicketed');
      throw failure;
    }
    const op = this.operations.get(operationId);
    if (op?.tenantId !== tenantId || op.orderId !== orderId || op.status === 'success') {
      return { kind: 'already' };
    }
    const order = this.orders.get(orderId);
    if (order?.tenant_id !== tenantId) return { kind: 'order-changed' };
    if (order.status !== 'confirmed' && order.status !== 'ticketed') {
      return { kind: 'order-changed' };
    }
    const savedOp = structuredClone(op);
    const savedOrder = { ...order };
    this.write(op, { status: 'success', result, lastError: null });
    const updated: OrderRow = { ...order, status: 'ticketed' };
    this.orders.set(orderId, updated);
    try {
      await inTransaction({} as Transaction<DB>, { ...updated });
    } catch (error) {
      this.operations.set(operationId, savedOp);
      this.orders.set(orderId, savedOrder);
      throw error;
    }
    return { kind: 'finalized', order: { ...updated } };
  }

  listStale(tenantId: string, cutoff: Date): Promise<IssueOperationRecord[]> {
    return this.run('listStale', () =>
      [...this.operations.values()]
        .filter(
          (op) =>
            op.tenantId === tenantId &&
            op.status === 'pending' &&
            op.updatedAt.getTime() < cutoff.getTime(),
        )
        .map((op) => structuredClone(op)),
    );
  }

  asStore(): TicketIssueStore {
    return this as unknown as TicketIssueStore;
  }

  private ofOrder(tenantId: string, orderId: string): IssueOperationRecord[] {
    return [...this.operations.values()].filter(
      (op) => op.tenantId === tenantId && op.orderId === orderId,
    );
  }

  private write(
    op: IssueOperationRecord & { tenantId: string },
    patch: Partial<Pick<IssueOperationRecord, 'status' | 'result' | 'lastError'>>,
  ): void {
    this.operations.set(op.id, {
      ...op,
      ...patch,
      result: structuredClone(patch.result ?? op.result),
      updatedAt: new Date(this.tick()),
    });
  }

  private tick(): number {
    this.clock += 1_000;
    return this.clock;
  }

  private run<T>(method: string, fn: () => T): Promise<T> {
    this.calls.push(method);
    const failure = this.failures.get(method);
    if (failure !== undefined) {
      this.failures.delete(method);
      return Promise.reject(failure);
    }
    return Promise.resolve(fn());
  }
}
