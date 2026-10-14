import { Injectable } from '@nestjs/common';
import type { OrderCancelResult, OrderView } from '@sales-travel/domain';
import { AuditService } from '../audit/audit.service.js';
import type { HotelCancellationEstimate } from '../hotels/hotel-cancellation.js';
import { runWithTenantContext } from '../request-context/request-context.js';
import type { AdminOrderDetail } from './admin-order-view.js';
import {
  AdminOrderNotFoundError,
  AdminOrderNumberMismatchError,
  AdminOrderWithoutLocatorError,
} from './admin-orders.errors.js';
import type { AdminOrderActionDto, AdminOrderCancelDto } from './admin-orders.schemas.js';
import { AdminOrdersService } from './admin-orders.service.js';
import type { HotelOrderReadResult } from './hotel-order-reads.service.js';
import { OrderCapabilitiesService } from './order-capabilities.service.js';
import {
  OrderConfirmationService,
  type OrderConfirmationSent,
} from './order-confirmation.service.js';
import { OrdersService, type OrderRow } from './orders.service.js';

/** El evento que deja cada acción del superadmin sobre una reserva, en el nodo de la reserva. */
export const ADMIN_ORDER_ACTION_EVENT = 'platform.order.action';

/** Las acciones de post-venta de la consola. Ninguna vende. */
export type AdminOrderAction = 'send-confirmation' | 'retrieve' | 'retry-cancel' | 'cancel';

/** Cómo terminó la acción, para la auditoría. Nunca texto libre del proveedor ni datos del cliente. */
interface ActionOutcome {
  readonly outcome: 'ok' | 'error';
  readonly errorReason?: string;
  /** Lo que cuenta qué pasó, en códigos: si el correo salió, qué leyó el proveedor, si canceló. */
  readonly result?: Readonly<Record<string, unknown>>;
}

/**
 * Lo que respondió el proveedor al consultarlo, sin datos de pasajeros: si tiene la reserva, su
 * estado, los localizadores de las aerolíneas, los tiquetes y la confirmación del hotel.
 */
export interface AdminProviderReading {
  readonly found: boolean;
  readonly status: string | null;
  readonly airlineLocators: readonly { readonly carrierCode: string; readonly locator: string }[];
  readonly ticketNumbers: readonly string[];
  readonly hotelConfirmationNumber: string | null;
  /** ISO 8601: cuándo se leyó. */
  readonly readAt: string;
}

/** `POST /admin/orders/:id/retrieve`: la lectura y la ficha ya actualizada (`null` si no se pudo releer). */
export interface AdminOrderRetrieveResult {
  readonly reading: AdminProviderReading;
  readonly detail: AdminOrderDetail | null;
}

/** `GET /admin/orders/:id/cancellation-estimate`, como el de la agencia. */
export interface AdminCancellationEstimate {
  readonly orderId: string;
  readonly estimate: HotelCancellationEstimate;
}

const MACHINE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_LIST = 50;

function errorReasonOf(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const reason = (err as { reason?: unknown }).reason;
    if (typeof reason === 'string' && MACHINE_REASON.test(reason)) return reason;
  }
  return (err instanceof Error && err.name !== '' ? err.name : 'UnknownError').slice(0, 64);
}

function code(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

function isHotelRead(read: OrderView | HotelOrderReadResult): read is HotelOrderReadResult {
  return (read as { vertical?: unknown }).vertical === 'hotels';
}

/** La lectura del proveedor, de cualquier vertical, en la forma de la consola. */
export function adminProviderReading(
  read: OrderView | HotelOrderReadResult,
  readAt: Date,
): AdminProviderReading {
  if (isHotelRead(read)) {
    return {
      found: read.found,
      status: code(read.providerStatus, 60) ?? code(read.status, 60),
      airlineLocators: [],
      ticketNumbers: [],
      hotelConfirmationNumber: code(read.hotelConfirmationNumber, 60),
      readAt: readAt.toISOString(),
    };
  }
  return {
    found: read.found,
    status: code(read.status, 60),
    airlineLocators: read.airlineLocators.slice(0, MAX_LIST).flatMap((l) => {
      const carrierCode = code(l.carrierCode, 3);
      const locator = code(l.locator, 20);
      return carrierCode === null || locator === null ? [] : [{ carrierCode, locator }];
    }),
    ticketNumbers: (read.ticketNumbers ?? []).slice(0, MAX_LIST).flatMap((t) => {
      const ticket = code(t, 20);
      return ticket === null ? [] : [ticket];
    }),
    hotelConfirmationNumber: null,
    readAt: readAt.toISOString(),
  };
}

/**
 * Por qué una cancelación respondida no canceló, según el intento que quedó en el historial: el
 * proveedor la rechazó (la reserva sigue como estaba), no confirmó si se aplicó (hay que conciliar
 * antes de cualquier otro pedido) o no se pudo saber.
 */
type CancelNotDone = 'PROVIDER_REJECTED' | 'PROVIDER_UNVERIFIED' | 'PROVIDER_NOT_CANCELLED';

/** Lo que devolvió el servicio de la agencia y, si no canceló, por qué. */
interface CancelDone {
  readonly result: OrderCancelResult;
  readonly notDone?: CancelNotDone;
}

/** Una cancelación (nueva o reintentada) salió bien si el proveedor la aceptó. */
function cancelOutcome(done: CancelDone): ActionOutcome {
  const { result } = done;
  const summary = {
    success: result.success,
    ...(result.settlement === undefined ? {} : { settlement: result.settlement }),
  };
  return result.success
    ? { outcome: 'ok', result: summary }
    : {
        outcome: 'error',
        errorReason: done.notDone ?? 'PROVIDER_NOT_CANCELLED',
        result: summary,
      };
}

/**
 * Plataforma → Reservas de la red: lo que el superadmin puede hacer desde la ficha de una reserva de
 * cualquier nodo (FD-1 C, 2026-10-13). Reenviar la confirmación, consultar el estado al proveedor,
 * reintentar una cancelación que falló y cancelar en nombre de la agencia. Nada de esto vende.
 *
 * Cada acción:
 * - resuelve el nodo de la reserva con la guarda del superadmin en la base (`ownerOf`, 0076) y la
 *   lee con ese tenant fijado, como Reservas de la agencia;
 * - corre en el contexto de ESE nodo (`runWithTenantContext`): lo que cae al tenant del contexto
 *   —la auditoría sin tenant explícito, la bóveda de payloads de proveedor— va al nodo, no a la
 *   plataforma;
 * - usa los mismos servicios y las mismas reglas que la agencia (OrdersService,
 *   OrderConfirmationService, OrderCapabilitiesService), con el superadmin como actor: los eventos
 *   de la cancelación y de la retención de cartera lo nombran a él;
 * - deja `platform.order.action` en el nodo de la reserva, con el motivo y cómo terminó: lo ve el
 *   administrador de la agencia y lo ve la plataforma.
 */
@Injectable()
export class AdminOrderActionsService {
  constructor(
    private readonly adminOrders: AdminOrdersService,
    private readonly orders: OrdersService,
    private readonly confirmation: OrderConfirmationService,
    private readonly capabilities: OrderCapabilitiesService,
    private readonly audit: AuditService,
  ) {}

  /** Reenvía la confirmación al contacto, con la marca y el correo del nodo de la reserva. */
  async sendConfirmation(
    actorUserId: string,
    orderId: string,
    body: AdminOrderActionDto,
  ): Promise<OrderConfirmationSent> {
    return this.act(
      actorUserId,
      orderId,
      { action: 'send-confirmation', reason: body.reason },
      (owner, row) => this.confirmation.resend(owner, row),
      (sent) =>
        sent.sent
          ? { outcome: 'ok', result: { sent: true } }
          : { outcome: 'error', errorReason: 'MAIL_NOT_SENT', result: { sent: false } },
    );
  }

  /**
   * Consulta el estado al proveedor. En hoteles la lectura queda en el seguimiento de la orden; en
   * vuelos es sólo para ver, y vuelve en `reading`.
   */
  async retrieve(
    actorUserId: string,
    orderId: string,
    body: AdminOrderActionDto,
  ): Promise<AdminOrderRetrieveResult> {
    const reading = await this.act(
      actorUserId,
      orderId,
      { action: 'retrieve', reason: body.reason },
      async (owner, row) => {
        this.assertLocator(row);
        this.capabilities.assertSupports(row, 'retrieve');
        const read = await this.orders.retrieveOrder(owner, row, actorUserId);
        return adminProviderReading(read, new Date());
      },
      (r) => ({ outcome: 'ok', result: { found: r.found, providerStatus: r.status } }),
    );
    // La consulta ya se hizo y quedó registrada: si la ficha no se puede releer, la pantalla la
    // vuelve a pedir en vez de recibir un error de algo que salió bien.
    const detail = await this.adminOrders.snapshot(actorUserId, orderId).catch(() => null);
    return { reading, detail };
  }

  /** Reintenta una cancelación que la agencia ya pidió y falló, con el mismo claim durable. */
  async retryCancellation(
    actorUserId: string,
    orderId: string,
    operationId: string,
    body: AdminOrderActionDto,
  ): Promise<OrderCancelResult> {
    const done = await this.act(
      actorUserId,
      orderId,
      { action: 'retry-cancel', reason: body.reason, operationId: operationId.toLowerCase() },
      async (owner, row) => {
        this.assertLocator(row);
        this.capabilities.assertSupports(row, 'cancel');
        const { result } = await this.orders.retryOperation(
          owner,
          row.id,
          operationId.toLowerCase(),
          actorUserId,
        );
        return this.cancelDone(owner, row.id, result);
      },
      cancelOutcome,
    );
    return done.result;
  }

  /**
   * La penalidad estimada de cancelar una reserva de hotel, como la ve la agencia antes de
   * confirmar. Sólo lee y no llama al proveedor: no deja evento (abrir la ficha ya lo dejó).
   */
  async cancellationEstimate(
    actorUserId: string,
    orderId: string,
  ): Promise<AdminCancellationEstimate> {
    const id = orderId.toLowerCase();
    const owner = await this.adminOrders.ownerOf(actorUserId, id);
    const row = await this.orders.findById(owner, id);
    if (row === undefined) throw new AdminOrderNotFoundError();
    this.assertLocator(row);
    this.capabilities.assertSupports(row, 'cancel');
    return { orderId: row.id, estimate: this.orders.cancellationEstimate(row) };
  }

  /**
   * Cancela la reserva en nombre de la agencia (FD-1 C). El número de la orden que escribió el
   * superadmin tiene que ser el de la reserva. Las reglas son las de la agencia: una emitida no se
   * cancela, un intento anterior fallido sólo se continúa con el reintento, y en hoteles se respeta
   * el día de entrada.
   */
  async cancel(
    actorUserId: string,
    orderId: string,
    body: AdminOrderCancelDto,
  ): Promise<OrderCancelResult> {
    const done = await this.act(
      actorUserId,
      orderId,
      { action: 'cancel', reason: body.reason },
      async (owner, row) => {
        if (body.orderNumber !== row.order_number) throw new AdminOrderNumberMismatchError();
        const pnr = this.assertLocator(row);
        this.capabilities.assertSupports(row, 'cancel');
        const { result } = await this.orders.cancelOrder(owner, row.id, pnr, actorUserId);
        return this.cancelDone(owner, row.id, result);
      },
      cancelOutcome,
    );
    return done.result;
  }

  /**
   * Un `success: false` no siempre es un rechazo: también lo devuelve la cancelación que el
   * proveedor no confirmó, que deja la reserva por conciliar. La auditoría los distingue con el
   * intento que quedó en el historial; si no se puede leer, lo dice sin adivinar.
   */
  private async cancelDone(
    owner: string,
    orderId: string,
    result: OrderCancelResult,
  ): Promise<CancelDone> {
    if (result.success) return { result };
    try {
      const latest = (await this.orders.listOperations(owner, orderId)).find(
        (op) => op.type === 'cancel',
      );
      if (latest === undefined) return { result, notDone: 'PROVIDER_NOT_CANCELLED' };
      return {
        result,
        notDone: latest.reconciliationRequired ? 'PROVIDER_UNVERIFIED' : 'PROVIDER_REJECTED',
      };
    } catch {
      return { result, notDone: 'PROVIDER_NOT_CANCELLED' };
    }
  }

  private assertLocator(row: Pick<OrderRow, 'provider_order_id'>): string {
    if (!row.provider_order_id) throw new AdminOrderWithoutLocatorError();
    return row.provider_order_id;
  }

  /**
   * Lo común de cada acción. Un 404 o un 403 al resolver el nodo no dejan evento: no se tocó nada
   * de ninguna agencia. De ahí en más, todo intento queda en la auditoría del nodo, salga bien o
   * mal, con el motivo de quien lo pidió.
   */
  private async act<T>(
    actorUserId: string,
    orderId: string,
    what: { action: AdminOrderAction; reason: string; operationId?: string },
    run: (owner: string, row: OrderRow) => Promise<T>,
    outcomeOf: (result: T) => ActionOutcome,
  ): Promise<T> {
    const id = orderId.toLowerCase();
    const owner = await this.adminOrders.ownerOf(actorUserId, id);

    let result: T;
    try {
      result = await runWithTenantContext(owner, async () => {
        const row = await this.orders.findById(owner, id);
        if (row === undefined) throw new AdminOrderNotFoundError();
        return run(owner, row);
      });
    } catch (err) {
      await this.record(owner, actorUserId, id, what, {
        outcome: 'error',
        errorReason: errorReasonOf(err),
      });
      throw err;
    }
    await this.record(owner, actorUserId, id, what, outcomeOf(result));
    return result;
  }

  /** Best-effort, como toda la auditoría: la acción ya ocurrió y no se deshace si esto falla. */
  private async record(
    owner: string,
    actorUserId: string,
    orderId: string,
    what: { action: AdminOrderAction; reason: string; operationId?: string },
    outcome: ActionOutcome,
  ): Promise<void> {
    await this.audit.emit({
      eventType: ADMIN_ORDER_ACTION_EVENT,
      tenantId: owner,
      actorUserId,
      aggregateType: 'order',
      aggregateId: orderId,
      payload: {
        action: what.action,
        orderId,
        ...(what.operationId === undefined ? {} : { operationId: what.operationId }),
        reason: what.reason,
        outcome: outcome.outcome,
        ...(outcome.errorReason === undefined ? {} : { errorReason: outcome.errorReason }),
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
      },
    });
  }
}
