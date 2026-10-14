import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PaxTypeSchema } from '@sales-travel/canonical';
import type {
  AncillaryAddResult,
  AncillaryOrderRef,
  AncillaryPort,
  AncillaryRemoveResult,
} from '@sales-travel/domain';
import { z } from '@sales-travel/validation';
import { AuditService } from '../audit/audit.service.js';
import { BookingHoldPolicyService } from '../portfolios/booking-hold-policy.service.js';
import type { WalletHoldAdjusted } from '../portfolios/wallet-hold.store.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import {
  supportsAncillaries,
  type FlightProviderAdapter,
  type OrderProviderRef,
  type ResolvedProvider,
} from '../providers/provider.types.js';
import type { AddServicesInput, RemoveServicesInput } from './dto.js';
import { uniqueViolationConstraint } from './order-create-intent.store.js';
import { isTestContentOrder } from './order-confirmation-mail.js';
import { ORDER_EVENTS, type ServicesEscalationReason } from './order-events.js';
import {
  SERVICES_MESSAGES,
  addMessageOf,
  addOutcomeOf,
  auditableServiceIssueTypes,
  isRemovable,
  planRemoval,
  priceSelections,
  publicServiceOffer,
  removalGroupOf,
  removeMessageOf,
  removedLinesOf,
  settleAddedLines,
  type PricedServiceLine,
  type PublicServiceLine,
  type PublicServicesCatalog,
  type ServicesAddOutcome,
  type ServicesOperationResult,
  type ServicesRemoveOutcome,
  type SettledServiceLine,
} from './order-services.plan.js';
import {
  OrderServicesStore,
  ServicesClaimRefusedError,
  minorOf,
  type ServiceLineRecord,
  type ServicesClaimRefusal,
  type ServicesOperationRecord,
} from './order-services.store.js';
import type { OrderRow } from './orders.service.js';
import { PENDING_PROVIDER_WRITE_CONSTRAINT } from './ticket-issue.store.js';

/** Un cambio pendiente más viejo que esto ya no tiene quién lo cierre: pasa a conciliación. */
export const SERVICES_STALE_AFTER_MS = 10 * 60_000;

/** Lo que vuelve al vendedor de un alta. */
export interface ServicesAddReply {
  readonly outcome: ServicesAddOutcome;
  readonly message: string;
  readonly operationId: string;
  /** Lo que quedó agregado (o en duda), en unidades menores de la moneda de la orden. */
  readonly addedMinor: number;
  readonly failed: number;
  readonly unverified: number;
}

/** Lo que vuelve al vendedor de una baja. */
export interface ServicesRemoveReply {
  readonly outcome: ServicesRemoveOutcome;
  readonly message: string;
  readonly operationId: string;
  readonly removedMinor: number;
}

/** Lo que dejó el barrido de UN tenant. */
export interface ServicesSweepReport {
  examined: number;
  reconciling: number;
  skipped: number;
}

const CLAIM_MESSAGES: Readonly<Record<ServicesClaimRefusal, string>> = {
  'not-found': SERVICES_MESSAGES.notFound,
  'not-confirmed': SERVICES_MESSAGES.notConfirmed,
  'currency-changed': SERVICES_MESSAGES.currencyChanged,
  'already-pending': SERVICES_MESSAGES.alreadyPending,
  'previous-unverified': SERVICES_MESSAGES.previousUnverified,
};

/** Lo pedido en un alta, como quedó guardado en la operación (viene de la base: se valida). */
const PersistedLinesSchema = z.array(
  z.object({
    serviceOfferItemId: z.string().min(1).max(255),
    passengerIndex: z.number().int().min(0).max(8),
    amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
    name: z.string().min(1).max(160),
    category: z.enum(['BAGGAGE', 'MEAL', 'LOUNGE', 'PET', 'FEE', 'OTHER']),
    serviceCode: z.string().regex(/^[0-9A-Z]{3}$/),
    airlineCode: z.string().regex(/^[A-Z0-9]{2}$/),
    segments: z.array(
      z.object({
        origin: z.string(),
        destination: z.string(),
        departureAt: z.string(),
        carrier: z.string(),
        flightNumber: z.string(),
      }),
    ),
  }),
);

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 64) : 'UnknownError';
}

function currencyOf(order: Pick<OrderRow, 'currency'>): string {
  return order.currency.trim().toUpperCase();
}

function accountRef(order: OrderRow): OrderProviderRef {
  return {
    orderId: order.id,
    provider: order.provider,
    providerAccountId: order.provider_account_id ?? null,
  };
}

/**
 * La reserva tal como la entiende el puerto: el localizador, el carril con que se reservó (lo
 * guarda la oferta) y los pasajeros por posición y tipo. Un pasajero sin tipo legible no se adivina.
 */
export function ancillaryOrderRefOf(order: OrderRow): AncillaryOrderRef {
  if (!order.provider_order_id) throw new NotFoundException(SERVICES_MESSAGES.notFound);
  const offer = order.selected_offer as { provider?: { source?: unknown } } | null | undefined;
  const source = offer?.provider?.source;
  const raw = Array.isArray(order.passengers) ? (order.passengers as unknown[]) : [];
  const passengers = raw.map((passenger) => {
    const paxType = PaxTypeSchema.safeParse(
      typeof passenger === 'object' && passenger !== null
        ? (passenger as { paxType?: unknown }).paxType
        : undefined,
    );
    if (!paxType.success) throw new BadRequestException(SERVICES_MESSAGES.unavailable);
    return { paxType: paxType.data };
  });
  return {
    orderId: order.provider_order_id,
    ...(typeof source === 'string' && source.length > 0 ? { contentSource: source } : {}),
    passengers,
  };
}

function publicLine(line: ServiceLineRecord): PublicServiceLine {
  return {
    id: line.id,
    passengerIndex: line.passengerIndex,
    name: line.name,
    category: line.category,
    serviceCode: line.serviceCode,
    segments: line.segments,
    amountMinor: line.amountMinor,
    currency: line.currency,
    status: line.status,
    removable: isRemovable(line),
    removalGroup: removalGroupOf(line),
  };
}

function sum(lines: readonly { readonly amountMinor: number }[]): number {
  return lines.reduce((total, line) => total + line.amountMinor, 0);
}

/**
 * Maletas y servicios adicionales sobre una reserva de vuelo confirmada, antes de emitir (SAB-20).
 *
 *   catalog        → lo que se puede agregar hoy y lo ya agregado (lectura del proveedor + base).
 *   requestAdd     → claim (0083) + total y retención de la red ajustados, UNA llamada al puerto y
 *                    el desenlace por línea.
 *   requestRemove  → claim, UNA llamada al puerto y, con lo que la aerolínea confirmó quitado, el
 *                    total y la retención liberados.
 *   sweepTenant    → los cambios que quedaron pendientes (el proceso murió con la llamada en vuelo):
 *                    a conciliación, nunca reenviados.
 *
 * Corre en el request, como la anulación (SAB-09): el vendedor necesita el total nuevo en la misma
 * pantalla. La garantía contra el doble cobro es el claim durable de 0083 —una escritura pendiente
 * por orden— y no reenviar nunca lo que quedó en duda: se escala y lo concilia una persona.
 *
 * El dinero: lo agregado se cobra con el tiquete, como EMD, con la forma de pago de la cuenta (D1).
 * Si la reserva retiene la cartera de la red (SAB-10), la retención sube con lo agregado ANTES de
 * llamar al proveedor (`wallet_hold_adjust`, todo o nada en cada nivel) y baja con lo que no quedó
 * o se quitó. Una reserva de pruebas o con la cuenta propia del nodo no retiene, y el ajuste no hace
 * nada. El precio es el de la aerolínea, sin markup (P-16).
 *
 * Neutral de proveedor: decide por la capacidad `addServices` y por el `AncillaryPort` del adapter.
 */
@Injectable()
export class FlightServicesService {
  private readonly logger = new Logger('FlightServices');

  constructor(
    private readonly store: OrderServicesStore,
    private readonly registry: FlightProviderRegistry,
    private readonly holds: BookingHoldPolicyService,
    private readonly audit: AuditService,
  ) {}

  /** ¿Las reservas de este proveedor venden servicios por el puerto de ancillares? */
  handles(order: Pick<OrderRow, 'provider'>): boolean {
    return this.registry.capabilitiesOf(order.provider)?.addServices === true;
  }

  /**
   * El catálogo de la reserva y lo ya agregado. Es una lectura: sale con la cuenta de la reserva aunque
   * la plataforma haya apagado el proveedor para ventas nuevas (no se puede agregar, pero sí ver).
   */
  async catalog(tenantId: string, order: OrderRow): Promise<PublicServicesCatalog> {
    const { port } = await this.portFor(tenantId, order, 'read');
    const currency = currencyOf(order);
    const catalog = await port.listAncillaries(ancillaryOrderRefOf(order), { tenantId });
    const lines = await this.store.listLines(tenantId, order.id);
    const blocking = await this.store.blocking(tenantId, order.id);
    return {
      kind: 'ancillaries',
      currency,
      orderTotalMinor: minorOf(order.total_amount),
      testContent: isTestContentOrder(order),
      segments: catalog.segments.map((segment, index) => ({ ...segment, index })),
      offers: catalog.offers.map((offer) => publicServiceOffer(offer, currency)),
      added: lines.map(publicLine),
      warnings: [...catalog.warnings],
      blocked:
        order.status !== 'confirmed'
          ? SERVICES_MESSAGES.notConfirmed
          : blocking === 'pending'
            ? SERVICES_MESSAGES.alreadyPending
            : blocking === 'unverified'
              ? SERVICES_MESSAGES.previousUnverified
              : null,
    };
  }

  /**
   * Agrega lo elegido. `order` es la fila que el controlador leyó con el tenant fijado y validó
   * (localizador, `confirmed`, capacidad).
   *
   * @throws ConflictException (409) si el precio cambió, otra escritura está en curso, la anterior
   *   quedó en duda, o la orden ya no está confirmada. No se cambió nada.
   * @throws BookingHoldRejectedError (409) si la cartera propia o un nivel de la red no cubre lo
   *   agregado. No se llamó al proveedor.
   */
  async requestAdd(
    tenantId: string,
    order: OrderRow,
    actorUserId: string,
    body: AddServicesInput,
  ): Promise<ServicesAddReply> {
    const currency = this.assertChangeable(order, body.currency);
    // Agregar es VENTA: si la plataforma apagó el proveedor, no se agrega.
    const { provider, port } = await this.portFor(tenantId, order, 'sale');
    const ref = ancillaryOrderRefOf(order);

    // El precio lo pone el catálogo de ahora, nunca el navegador. El puerto lo vuelve a comprobar al
    // agregar y rechaza por línea lo que cambió en el medio.
    const catalog = await port.listAncillaries(ref, { tenantId });
    const priced = priceSelections(catalog, body.selections, currency);
    if (!priced.ok) throw new ConflictException(priced.message);
    if (priced.totalMinor !== body.expectedTotalMinor) {
      throw new ConflictException(SERVICES_MESSAGES.priceChanged);
    }

    const testContent = isTestContentOrder(order);
    // Mientras está pendiente, lo guardado dice «en duda»: si el proceso muere con la llamada en
    // vuelo, el barrido la concilia y nadie la repite.
    const requested: ServicesOperationResult = {
      kind: 'add',
      stage: 'sent',
      requestedAt: new Date().toISOString(),
      testContent,
      currency,
      totalMinor: priced.totalMinor,
      lines: priced.lines.length,
      requested: priced.lines,
      reconciliationRequired: true,
      retryForbidden: true,
    };

    let claim: { readonly operationId: string; readonly hold: WalletHoldAdjusted };
    try {
      claim = await this.holds.adjustOrderHold(
        tenantId,
        { id: order.id, currency },
        'retain',
        async (trx, adjust) => {
          const { operationId } = await this.store.claimWithin(
            trx,
            tenantId,
            order.id,
            'add-services',
            actorUserId,
            currency,
            requested,
          );
          if (priced.totalMinor > 0) {
            await this.store.addToTotalWithin(trx, order.id, priced.totalMinor);
          }
          const hold = await adjust(actorUserId, operationId, priced.totalMinor);
          return { operationId, hold };
        },
      );
    } catch (error) {
      throw this.claimFailure(error);
    }
    const operationId = claim.operationId;
    await this.emit(tenantId, order, actorUserId, ORDER_EVENTS.servicesRequested, {
      operationId,
      kind: 'add',
      lines: priced.lines.length,
      totalMinor: priced.totalMinor,
      currency,
      hold: claim.hold.outcome,
      testContent,
    });

    let result: AncillaryAddResult;
    try {
      result = await port.addAncillaries(ref, body.selections, {
        tenantId,
        requestId: operationId,
      });
    } catch (error) {
      // El contrato del puerto: si lanza, no se escribió nada en la reserva. Se devuelve el total y
      // la retención, y el error sigue su camino (lo traduce el filtro del proveedor).
      await this.closeAddNotSent(tenantId, order, operationId, requested, actorUserId, error);
      throw error;
    }
    return this.settleAdd(
      tenantId,
      order,
      provider.code,
      operationId,
      requested,
      priced.lines,
      result,
      {
        actorUserId,
        hold: claim.hold,
      },
    );
  }

  /**
   * Quita servicios agregados. Quitar deshace lo vendido, como cancelar: sale con la cuenta de la
   * reserva aunque la plataforma haya apagado el proveedor para ventas nuevas.
   */
  async requestRemove(
    tenantId: string,
    order: OrderRow,
    actorUserId: string,
    body: RemoveServicesInput,
  ): Promise<ServicesRemoveReply> {
    const currency = this.assertChangeable(order, body.currency);
    const { port } = await this.portFor(tenantId, order, 'post-sale');
    const ref = ancillaryOrderRefOf(order);

    const stored = await this.store.listLines(tenantId, order.id);
    const plan = planRemoval(stored, body.lineIds);
    if (!plan.ok) throw new ConflictException(plan.message);
    if (plan.totalMinor !== body.expectedTotalMinor) {
      throw new ConflictException(SERVICES_MESSAGES.totalChanged);
    }
    const testContent = isTestContentOrder(order);
    const requested: ServicesOperationResult = {
      kind: 'remove',
      stage: 'sent',
      requestedAt: new Date().toISOString(),
      testContent,
      currency,
      totalMinor: plan.totalMinor,
      lines: plan.lines.length,
      lineIds: plan.lines.map((line) => line.id),
      reconciliationRequired: true,
      retryForbidden: true,
    };

    let operationId: string;
    try {
      ({ operationId } = await this.store.run(tenantId, (trx) =>
        this.store.claimWithin(
          trx,
          tenantId,
          order.id,
          'remove-services',
          actorUserId,
          currency,
          requested,
        ),
      ));
    } catch (error) {
      throw this.claimFailure(error);
    }
    await this.emit(tenantId, order, actorUserId, ORDER_EVENTS.servicesRequested, {
      operationId,
      kind: 'remove',
      lines: plan.lines.length,
      totalMinor: plan.totalMinor,
      currency,
      testContent,
    });

    let result: AncillaryRemoveResult;
    try {
      result = await port.removeAncillaries(ref, plan.providerItemIds, {
        tenantId,
        requestId: operationId,
      });
    } catch (error) {
      // No se escribió nada en la reserva: la operación se cierra como no enviada.
      await this.closeNotSent(tenantId, order, operationId, requested, actorUserId, error);
      throw error;
    }
    return this.settleRemove(tenantId, order, operationId, requested, plan.lines, result, {
      actorUserId,
    });
  }

  /**
   * Lo que el proceso no cerró en este tenant: cambios pendientes desde hace más de
   * {@link SERVICES_STALE_AFTER_MS}. Pudieron salir: pasan a conciliación con lo pedido a la vista
   * (las líneas de un alta en duda; las de una baja, como «quitar sin confirmar») y se escalan.
   * Nada se reenvía, y el total y la retención quedan como estaban (del lado seguro).
   */
  async sweepTenant(tenantId: string, now: number = Date.now()): Promise<ServicesSweepReport> {
    const report: ServicesSweepReport = { examined: 0, reconciling: 0, skipped: 0 };
    const stale = await this.store.listStale(tenantId, new Date(now - SERVICES_STALE_AFTER_MS));
    for (const op of stale) {
      report.examined += 1;
      if (await this.reconcileStale(tenantId, op)) report.reconciling += 1;
      else report.skipped += 1;
    }
    if (report.examined > 0) {
      this.logger.warn(
        `flights.services.sweep tenant=${tenantId} examined=${report.examined} reconciling=${report.reconciling} skipped=${report.skipped}`,
      );
    }
    return report;
  }

  // -------------------------------------------------------------------------------------------
  // Desenlaces
  // -------------------------------------------------------------------------------------------

  private async settleAdd(
    tenantId: string,
    order: OrderRow,
    providerCode: string,
    operationId: string,
    requested: ServicesOperationResult,
    pricedLines: readonly PricedServiceLine[],
    result: AncillaryAddResult,
    context: { readonly actorUserId: string; readonly hold: WalletHoldAdjusted },
  ): Promise<ServicesAddReply> {
    const lines = settleAddedLines(pricedLines, result);
    const outcome = addOutcomeOf(lines);
    const failed = lines.filter((line) => line.status === 'failed');
    const kept = lines.filter((line) => line.status !== 'failed');
    const failedMinor = sum(failed);
    const unverified = lines.filter((line) => line.status === 'unverified').length;
    const settled: ServicesOperationResult = {
      ...requested,
      stage: 'settled',
      settledAt: new Date().toISOString(),
      outcome,
      done: lines.filter((line) => line.status === 'active').length,
      failed: failed.length,
      unverified,
      hold: context.hold.outcome,
      issueTypes: auditableServiceIssueTypes(result.issues),
      reconciliationRequired: outcome === 'UNVERIFIED',
      retryForbidden: outcome === 'UNVERIFIED',
    };
    const status = outcome === 'ADDED' || outcome === 'PARTIAL' ? 'success' : 'failed';
    this.logger.log(
      `flights.services.add provider=${providerCode} order=${order.id} op=${operationId} outcome=${result.outcome} lines=${lines.length} failed=${failed.length} unverified=${unverified}`,
    );

    try {
      await this.holds.adjustOrderHold(
        tenantId,
        { id: order.id, currency: requested.currency },
        'release',
        async (trx, adjust) => {
          await this.store.insertLinesWithin(trx, tenantId, order.id, operationId, lines);
          // Lo que no quedó no se cobra: sale del total y de la retención en la misma transacción.
          if (failedMinor > 0) {
            await this.store.addToTotalWithin(trx, order.id, -failedMinor);
            await adjust(context.actorUserId, operationId, -failedMinor);
          }
          const closed = await this.store.settleWithin(
            trx,
            operationId,
            status,
            settled,
            status === 'failed' ? addMessageOf(outcome) : null,
          );
          if (!closed) throw new ServicesOperationTakenError();
        },
      );
    } catch (error) {
      return this.settleFailed(tenantId, order, operationId, context.actorUserId, error, {
        kind: 'add',
        outcome: 'UNVERIFIED',
        addedMinor: sum(kept),
        failed: failed.length,
        unverified: lines.length - failed.length,
      });
    }

    if (outcome === 'ADDED' || outcome === 'PARTIAL') {
      await this.emit(tenantId, order, context.actorUserId, ORDER_EVENTS.servicesAdded, {
        operationId,
        count: settled.done,
        totalMinor: sum(kept),
        currency: requested.currency,
        failed: failed.length,
        hold: context.hold.outcome,
        testContent: requested.testContent,
      });
    } else {
      await this.emitChangeFailed(tenantId, order, context.actorUserId, {
        operationId,
        kind: 'add',
        outcome,
        retryable: outcome === 'FAILED',
        reconciliationRequired: outcome === 'UNVERIFIED',
        issueTypes: settled.issueTypes ?? [],
      });
    }
    if (outcome === 'UNVERIFIED') {
      await this.escalate(
        tenantId,
        order,
        context.actorUserId,
        operationId,
        'services-unverified',
        {
          kind: 'add',
          unverified,
        },
      );
    }
    return {
      outcome,
      message: addMessageOf(outcome),
      operationId,
      addedMinor: sum(kept),
      failed: failed.length,
      unverified,
    };
  }

  private async settleRemove(
    tenantId: string,
    order: OrderRow,
    operationId: string,
    requested: ServicesOperationResult,
    lines: readonly ServiceLineRecord[],
    result: AncillaryRemoveResult,
    context: { readonly actorUserId: string },
  ): Promise<ServicesRemoveReply> {
    const issueTypes = auditableServiceIssueTypes(result.issues);
    if (result.outcome === 'FAILED') {
      // El proveedor lo rechazó antes de ejecutarlo: los servicios siguen y se puede volver a pedir.
      await this.store.run(tenantId, (trx) =>
        this.store.settleWithin(
          trx,
          operationId,
          'failed',
          {
            ...requested,
            stage: 'settled',
            settledAt: new Date().toISOString(),
            outcome: 'FAILED',
            done: 0,
            issueTypes,
            reconciliationRequired: false,
            retryForbidden: false,
          },
          SERVICES_MESSAGES.removeFailed,
        ),
      );
      await this.emitChangeFailed(tenantId, order, context.actorUserId, {
        operationId,
        kind: 'remove',
        outcome: 'FAILED',
        retryable: true,
        reconciliationRequired: false,
        issueTypes,
      });
      return {
        outcome: 'FAILED',
        message: SERVICES_MESSAGES.removeFailed,
        operationId,
        removedMinor: 0,
      };
    }

    const { removed, pending } = removedLinesOf(lines, result);
    const removedMinor = sum(removed);
    const outcome: ServicesRemoveOutcome = pending.length > 0 ? 'UNVERIFIED' : 'REMOVED';
    const settled: ServicesOperationResult = {
      ...requested,
      stage: 'settled',
      settledAt: new Date().toISOString(),
      outcome,
      done: removed.length,
      unverified: pending.length,
      issueTypes,
      reconciliationRequired: outcome === 'UNVERIFIED',
      retryForbidden: outcome === 'UNVERIFIED',
    };
    let hold: WalletHoldAdjusted | undefined;
    try {
      await this.holds.adjustOrderHold(
        tenantId,
        { id: order.id, currency: requested.currency },
        'release',
        async (trx, adjust) => {
          await this.store.markLinesWithin(
            trx,
            order.id,
            removed.map((line) => line.id),
            'removed',
            operationId,
          );
          // Lo que no se sabe si salió sigue contando en el total y en la retención.
          await this.store.markLinesWithin(
            trx,
            order.id,
            pending.map((line) => line.id),
            'remove-unverified',
            operationId,
          );
          if (removedMinor > 0) {
            await this.store.addToTotalWithin(trx, order.id, -removedMinor);
            hold = await adjust(context.actorUserId, operationId, -removedMinor);
          }
          const closed = await this.store.settleWithin(
            trx,
            operationId,
            outcome === 'REMOVED' ? 'success' : 'failed',
            { ...settled, ...(hold === undefined ? {} : { hold: hold.outcome }) },
            outcome === 'REMOVED' ? null : SERVICES_MESSAGES.removeUnverified,
          );
          if (!closed) throw new ServicesOperationTakenError();
        },
      );
    } catch (error) {
      const reply = await this.settleFailed(
        tenantId,
        order,
        operationId,
        context.actorUserId,
        error,
        {
          kind: 'remove',
          outcome: 'UNVERIFIED',
          addedMinor: 0,
          failed: 0,
          unverified: lines.length,
        },
      );
      return {
        outcome: 'UNVERIFIED',
        message: reply.message,
        operationId,
        removedMinor: 0,
      };
    }

    if (removed.length > 0) {
      await this.emit(tenantId, order, context.actorUserId, ORDER_EVENTS.servicesRemoved, {
        operationId,
        count: removed.length,
        totalMinor: removedMinor,
        currency: requested.currency,
        hold: hold?.outcome ?? 'unchanged',
        testContent: requested.testContent,
      });
    }
    if (outcome === 'UNVERIFIED') {
      await this.emitChangeFailed(tenantId, order, context.actorUserId, {
        operationId,
        kind: 'remove',
        outcome,
        retryable: false,
        reconciliationRequired: true,
        issueTypes,
      });
      await this.escalate(
        tenantId,
        order,
        context.actorUserId,
        operationId,
        'services-unverified',
        {
          kind: 'remove',
          unverified: pending.length,
        },
      );
    }
    return { outcome, message: removeMessageOf(outcome), operationId, removedMinor };
  }

  /**
   * El proveedor contestó y el desenlace no se pudo guardar (la base, o el barrido ya la cerró). Lo
   * que pasó en la aerolínea ya pasó: la operación queda pendiente para el barrido, que la pasa a
   * conciliación, y se escala ya. Al vendedor se le dice que no repita.
   */
  private async settleFailed(
    tenantId: string,
    order: OrderRow,
    operationId: string,
    actorUserId: string,
    error: unknown,
    reply: Omit<ServicesAddReply, 'message' | 'operationId'> & { readonly kind: 'add' | 'remove' },
  ): Promise<ServicesAddReply> {
    this.logger.warn(
      `flights.services.settle_failed order=${order.id} op=${operationId} kind=${reply.kind} error=${errorName(error)}`,
    );
    if (!(error instanceof ServicesOperationTakenError)) {
      await this.escalate(tenantId, order, actorUserId, operationId, 'services-settle-failed', {
        kind: reply.kind,
        errorName: errorName(error),
      });
    }
    const { kind, ...rest } = reply;
    return {
      ...rest,
      message: kind === 'add' ? SERVICES_MESSAGES.unverified : SERVICES_MESSAGES.removeUnverified,
      operationId,
    };
  }

  /** Un alta que no salió: el total y la retención vuelven a lo de antes, en una transacción. */
  private async closeAddNotSent(
    tenantId: string,
    order: OrderRow,
    operationId: string,
    requested: ServicesOperationResult,
    actorUserId: string,
    error: unknown,
  ): Promise<void> {
    try {
      await this.holds.adjustOrderHold(
        tenantId,
        { id: order.id, currency: requested.currency },
        'release',
        async (trx, adjust) => {
          if (requested.totalMinor > 0) {
            await this.store.addToTotalWithin(trx, order.id, -requested.totalMinor);
            await adjust(actorUserId, operationId, -requested.totalMinor);
          }
          const closed = await this.store.settleWithin(
            trx,
            operationId,
            'failed',
            this.notSent(requested),
            this.reasonOf(order.provider, error),
          );
          // El barrido la cerró antes (en duda, con sus líneas contando): devolver acá dejaría el
          // total y la retención sin lo que esas líneas dicen. Se deshace todo.
          if (!closed) throw new ServicesOperationTakenError();
        },
      );
    } catch (closeError) {
      // Nada salió, pero no se pudo devolver: la operación queda pendiente y el barrido la concilia
      // (o ya la concilió).
      this.logger.warn(
        `flights.services.not_sent_unsaved order=${order.id} op=${operationId} error=${errorName(closeError)}`,
      );
      return;
    }
    await this.emitChangeFailed(tenantId, order, actorUserId, {
      operationId,
      kind: 'add',
      outcome: 'NOT_SENT',
      retryable: true,
      reconciliationRequired: false,
      errorName: errorName(error),
    });
  }

  /** Una baja que no salió: la operación se cierra y los servicios siguen. */
  private async closeNotSent(
    tenantId: string,
    order: OrderRow,
    operationId: string,
    requested: ServicesOperationResult,
    actorUserId: string,
    error: unknown,
  ): Promise<void> {
    try {
      await this.store.run(tenantId, (trx) =>
        this.store.settleWithin(
          trx,
          operationId,
          'failed',
          this.notSent(requested),
          this.reasonOf(order.provider, error),
        ),
      );
    } catch (closeError) {
      this.logger.warn(
        `flights.services.not_sent_unsaved order=${order.id} op=${operationId} error=${errorName(closeError)}`,
      );
      return;
    }
    await this.emitChangeFailed(tenantId, order, actorUserId, {
      operationId,
      kind: requested.kind,
      outcome: 'NOT_SENT',
      retryable: true,
      reconciliationRequired: false,
      errorName: errorName(error),
    });
  }

  private notSent(requested: ServicesOperationResult): ServicesOperationResult {
    return {
      ...requested,
      stage: 'settled',
      settledAt: new Date().toISOString(),
      outcome: 'NOT_SENT',
      done: 0,
      reconciliationRequired: false,
      retryForbidden: false,
    };
  }

  /** Un cambio que se quedó pendiente: a conciliación, con lo pedido a la vista. */
  private async reconcileStale(tenantId: string, op: ServicesOperationRecord): Promise<boolean> {
    const record =
      typeof op.result === 'object' && op.result !== null
        ? (op.result as Partial<ServicesOperationResult>)
        : {};
    const requestedLines = PersistedLinesSchema.safeParse(record.requested ?? []);
    const lineIds = Array.isArray(record.lineIds)
      ? record.lineIds.filter((id): id is string => typeof id === 'string')
      : [];
    const result: ServicesOperationResult = {
      kind: op.type === 'add-services' ? 'add' : 'remove',
      stage: 'settled',
      requestedAt: typeof record.requestedAt === 'string' ? record.requestedAt : '',
      testContent: record.testContent === true,
      currency: typeof record.currency === 'string' ? record.currency : '',
      totalMinor: typeof record.totalMinor === 'number' ? record.totalMinor : 0,
      lines: typeof record.lines === 'number' ? record.lines : 0,
      ...(op.type === 'add-services' && requestedLines.success
        ? { requested: requestedLines.data }
        : {}),
      ...(lineIds.length > 0 ? { lineIds } : {}),
      settledAt: new Date().toISOString(),
      outcome: 'UNVERIFIED',
      reconciliationRequired: true,
      retryForbidden: true,
      escalated: true,
    };
    let order: OrderRow | undefined;
    try {
      order = await this.store.findOrder(tenantId, op.orderId);
      const moved = await this.store.run(tenantId, async (trx) => {
        const closed = await this.store.settleWithin(
          trx,
          op.id,
          'failed',
          result,
          op.type === 'add-services'
            ? SERVICES_MESSAGES.unverified
            : SERVICES_MESSAGES.removeUnverified,
        );
        if (!closed) return false;
        if (op.type === 'add-services' && requestedLines.success) {
          const unverified: SettledServiceLine[] = requestedLines.data.map((line) => ({
            ...line,
            status: 'unverified',
            providerItemIds: [],
            providerItemIdsShared: false,
          }));
          await this.store.insertLinesWithin(trx, tenantId, op.orderId, op.id, unverified);
        }
        if (op.type === 'remove-services') {
          await this.store.markLinesWithin(trx, op.orderId, lineIds, 'remove-unverified', op.id);
        }
        return true;
      });
      if (!moved) return false;
    } catch (error) {
      this.logger.warn(
        `flights.services.sweep_failed order=${op.orderId} op=${op.id} error=${errorName(error)}`,
      );
      return false;
    }
    const target = order ?? ({ id: op.orderId, provider: null } as const);
    await this.emitChangeFailed(tenantId, target, op.actorUserId, {
      operationId: op.id,
      kind: result.kind,
      outcome: 'UNVERIFIED',
      source: 'stale',
      retryable: false,
      reconciliationRequired: true,
    });
    await this.escalate(tenantId, target, op.actorUserId, op.id, 'services-stale', {
      kind: result.kind,
    });
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Puertas, errores y rastro
  // -------------------------------------------------------------------------------------------

  /** La reserva admite un cambio: confirmada, con localizador y en la moneda que vio el vendedor. */
  private assertChangeable(order: OrderRow, currency: string): string {
    if (!order.provider_order_id) throw new NotFoundException(SERVICES_MESSAGES.notFound);
    if (order.status !== 'confirmed') throw new ConflictException(SERVICES_MESSAGES.notConfirmed);
    const own = currencyOf(order);
    if (own !== currency) throw new ConflictException(SERVICES_MESSAGES.currencyChanged);
    return own;
  }

  /**
   * El adapter de la reserva con su puerto de servicios. `sale` corta si la plataforma apagó el
   * proveedor (agregar es vender); `read` y `post-sale`, no. Sin la capacidad o sin el puerto, 400.
   */
  private async portFor(
    tenantId: string,
    order: OrderRow,
    mode: 'sale' | 'read' | 'post-sale',
  ): Promise<{ provider: ResolvedProvider<FlightProviderAdapter>; port: AncillaryPort }> {
    const ref = accountRef(order);
    const provider =
      mode === 'sale'
        ? await this.registry.forOrderSale(tenantId, ref)
        : await this.registry.forOrder(tenantId, ref);
    const adapter = provider.adapter;
    if (provider.capabilities.addServices !== true || !supportsAncillaries(adapter)) {
      throw new BadRequestException(SERVICES_MESSAGES.unavailable);
    }
    return { provider, port: adapter };
  }

  private claimFailure(error: unknown): unknown {
    if (error instanceof ServicesClaimRefusedError) {
      const message = CLAIM_MESSAGES[error.refusal];
      return error.refusal === 'not-found'
        ? new NotFoundException(message)
        : new ConflictException(message);
    }
    if (uniqueViolationConstraint(error) === PENDING_PROVIDER_WRITE_CONSTRAINT) {
      return new ConflictException(SERVICES_MESSAGES.alreadyPending);
    }
    return error;
  }

  /** El motivo de un fallo antes de salir, para el historial: el nuestro o el del traductor. */
  private reasonOf(provider: string, error: unknown): string {
    if (error instanceof HttpException) return error.message;
    return this.registry.humanizeError(provider, error);
  }

  private async emit(
    tenantId: string,
    order: Pick<OrderRow, 'id' | 'provider'>,
    actorUserId: string,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.audit.emit({
      eventType,
      tenantId,
      actorUserId,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { provider: order.provider, ...payload },
    });
  }

  private async emitChangeFailed(
    tenantId: string,
    order: { readonly id: string; readonly provider: string | null },
    actorUserId: string | null,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.audit.emit({
      eventType: ORDER_EVENTS.servicesChangeFailed,
      tenantId,
      actorUserId,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { provider: order.provider, ...payload },
    });
  }

  private async escalate(
    tenantId: string,
    order: { readonly id: string; readonly provider: string | null },
    actorUserId: string | null,
    operationId: string,
    reason: ServicesEscalationReason,
    detail: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.logger.warn(
      `flights.services.escalated provider=${order.provider ?? 'unknown'} order=${order.id} op=${operationId} reason=${reason}`,
    );
    await this.audit.emit({
      eventType: ORDER_EVENTS.escalated,
      tenantId,
      actorUserId,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: {
        provider: order.provider,
        reason,
        operationId,
        retryForbidden: true,
        reconciliationRequired: true,
        ...detail,
      },
    });
  }
}

/** El desenlace no se escribió porque otra ejecución (el barrido) ya cerró la operación. */
class ServicesOperationTakenError extends Error {
  constructor() {
    super('la operación de servicios ya no estaba pendiente al cerrarla');
    this.name = 'ServicesOperationTakenError';
  }
}
