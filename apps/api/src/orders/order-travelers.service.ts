import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PaxTypeSchema } from '@sales-travel/canonical';
import {
  OrderModifyRejectedError,
  TRAVELER_MODIFICATIONS,
  type OrderModifyPort,
  type OrderModifyRef,
  type OrderModifyResult,
  type TravelerChange,
  type TravelerFieldRef,
} from '@sales-travel/domain';
import { AuditService } from '../audit/audit.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import {
  supportsOrderModify,
  type FlightProviderAdapter,
  type OrderProviderRef,
  type ResolvedProvider,
} from '../providers/provider.types.js';
import type { ModifyTravelersInput } from './dto.js';
import { isTestContentOrder } from './order-confirmation-mail.js';
import { uniqueViolationConstraint } from './order-create-intent.store.js';
import { ORDER_EVENTS, type TravelersEscalationReason } from './order-events.js';
import {
  TRAVELERS_MESSAGES,
  TRAVELERS_MODIFIABLE_STATUSES,
  TRAVELERS_REJECTION_MESSAGES,
  auditableTravelerIssueTypes,
  fieldNames,
  passengersAfterChange,
  publicTravelersView,
  requestedFields,
  travelerCount,
  travelersMessageOf,
  type PublicTravelersView,
  type TravelersOperationResult,
  type TravelersReply,
} from './order-travelers.plan.js';
import {
  OrderTravelersStore,
  TravelersClaimRefusedError,
  type TravelersOperationRecord,
} from './order-travelers.store.js';
import type { OrderRow } from './orders.service.js';
import { PENDING_PROVIDER_WRITE_CONSTRAINT } from './ticket-issue.store.js';

/** Un cambio pendiente más viejo que esto ya no tiene quién lo cierre: pasa a revisión. */
export const TRAVELERS_STALE_AFTER_MS = 10 * 60_000;

/** Lo que dejó el barrido de UN tenant. */
export interface TravelersSweepReport {
  examined: number;
  escalated: number;
  skipped: number;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 64) : 'UnknownError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function accountRef(order: OrderRow): OrderProviderRef {
  return {
    orderId: order.id,
    provider: order.provider,
    providerAccountId: order.provider_account_id ?? null,
  };
}

/**
 * La reserva como la entiende el puerto: el localizador, el carril con que se reservó (lo guarda la
 * oferta) y los pasajeros por posición, tipo, apellido y género, para que el proveedor los cruce con
 * los de su reserva. Un pasajero sin tipo legible no se adivina.
 */
export function modifyRefOf(order: OrderRow): OrderModifyRef {
  if (!order.provider_order_id) throw new NotFoundException(TRAVELERS_MESSAGES.notFound);
  const offer = isRecord(order.selected_offer) ? order.selected_offer : undefined;
  const provider = isRecord(offer?.['provider']) ? offer['provider'] : undefined;
  const source = provider?.['source'];
  const raw = Array.isArray(order.passengers) ? (order.passengers as unknown[]) : [];
  const passengers = raw.map((passenger) => {
    const record = isRecord(passenger) ? passenger : {};
    const paxType = PaxTypeSchema.safeParse(record['paxType']);
    if (!paxType.success) throw new BadRequestException(TRAVELERS_MESSAGES.unavailable);
    const surname = record['surname'];
    const givenName = record['givenName'];
    const gender = record['gender'];
    const passengerRef: OrderModifyRef['passengers'][number] = {
      paxType: paxType.data,
      ...(typeof surname === 'string' && surname.trim().length > 0 ? { surname } : {}),
      ...(typeof givenName === 'string' && givenName.trim().length > 0 ? { givenName } : {}),
      ...(gender === 'M' || gender === 'F' ? { gender } : {}),
    };
    return passengerRef;
  });
  if (passengers.length === 0) throw new BadRequestException(TRAVELERS_MESSAGES.unavailable);
  return {
    orderId: order.provider_order_id,
    ...(typeof source === 'string' && source.length > 0 ? { contentSource: source } : {}),
    passengers,
  };
}

/** El cuerpo validado (Zod, en el borde) en el vocabulario del puerto. */
function changesOf(body: ModifyTravelersInput): TravelerChange[] {
  return body.travelers.map((change) => ({
    index: change.index,
    ...(change.identityDocument === undefined
      ? {}
      : {
          identityDocument: {
            type: change.identityDocument.type,
            number: change.identityDocument.number,
            issuingCountry: change.identityDocument.issuingCountry,
            nationality: change.identityDocument.nationality,
            expiryDate: change.identityDocument.expiryDate,
            ...(change.identityDocument.birthDate === undefined
              ? {}
              : { birthDate: change.identityDocument.birthDate }),
          },
        }),
    ...(change.loyalty === undefined ? {} : { loyalty: { ...change.loyalty } }),
    ...(change.specialServices === undefined
      ? {}
      : { specialServices: [...change.specialServices] }),
  }));
}

/** Un rechazo del puerto antes de salir, en HTTP y en palabras del vendedor. */
function rejectionException(error: OrderModifyRejectedError): HttpException {
  const message = TRAVELERS_REJECTION_MESSAGES[error.code];
  return error.code === 'INVALID_CHANGE' || error.code === 'NOT_SUPPORTED_FOR_CONTENT'
    ? new BadRequestException(message)
    : new ConflictException(message);
}

/**
 * Corregir o completar los datos de los pasajeros de una reserva confirmada o emitida (SAB-25): el
 * documento de viaje, el viajero frecuente y los servicios especiales, sin cancelarla.
 *
 *   view           → la reserva enmascarada, para la pantalla (lectura del proveedor).
 *   requestModify  → claim `modify` (0083, el lock de la reserva) + UNA llamada al puerto, que lee,
 *                    escribe y verifica, + el desenlace en la operación, en la orden (enmascarado)
 *                    y en el rastro.
 *   sweepTenant    → las `modify` que quedaron pendientes: a revisión, nunca reenviadas.
 *
 * Corre en el request, como los servicios (SAB-20): el vendedor necesita saber en la misma pantalla
 * si la aerolínea lo guardó. No mueve dinero.
 *
 * Emitida también: los datos de un pasajero (APIS, viajero frecuente, SSR) no son la tarifa, y la
 * aerolínea los acepta después de emitir —el contrato de `modifyBooking` no restringe su cambio a
 * reservas sin tiquete (docs/sabre/05 §5.3)—. Lo que NO cambia es el nombre del pasajero: no está en
 * este pedido.
 *
 * En duda (`UNVERIFIED`) no se da por hecho: la operación queda `failed` con `reconciliationRequired`
 * y se escala. A diferencia de los servicios, volver a pedirlo es seguro y no se bloquea: cada intento
 * parte de una lectura nueva de la reserva y sólo manda lo que falta.
 *
 * PII: lo pedido viaja sólo al puerto. Ni la operación, ni el rastro, ni el log llevan un número o
 * un código de servicio especial; la orden guarda lo cambiado enmascarado (`passengersAfterChange`).
 *
 * Neutral de proveedor: decide por la capacidad `modify` y por el `OrderModifyPort` del adapter.
 */
@Injectable()
export class FlightTravelersService {
  private readonly logger = new Logger('FlightTravelers');

  constructor(
    private readonly store: OrderTravelersStore,
    private readonly registry: FlightProviderRegistry,
    private readonly audit: AuditService,
  ) {}

  /** ¿Las reservas de este proveedor cambian datos de pasajeros por el puerto? */
  handles(order: Pick<OrderRow, 'provider'>): boolean {
    return this.registry.capabilitiesOf(order.provider)?.modify === true;
  }

  /**
   * La reserva enmascarada y si se puede guardar ahora. Es una lectura: sale con la cuenta de la
   * reserva aunque la plataforma haya apagado el proveedor para ventas nuevas.
   */
  async view(tenantId: string, order: OrderRow): Promise<PublicTravelersView> {
    const ref = modifyRefOf(order);
    const { port } = await this.portFor(tenantId, order);
    const read = await port.readTravelers(ref, { tenantId });
    const blocked = !TRAVELERS_MODIFIABLE_STATUSES.includes(order.status)
      ? TRAVELERS_MESSAGES.notModifiable
      : (await this.store.pendingWrite(tenantId, order.id))
        ? TRAVELERS_MESSAGES.alreadyPending
        : null;
    return publicTravelersView(order.passengers, read, {
      testContent: isTestContentOrder(order),
      blocked,
    });
  }

  /**
   * Aplica los cambios en bloque. `order` es la fila que el controlador leyó con el tenant fijado y
   * validó (localizador, estado, capacidad).
   *
   * @throws ConflictException (409) si hay otra escritura en curso, la orden ya no admite cambios o
   *   los pasajeros no casan con la reserva. No se cambió nada.
   * @throws BadRequestException (400) si el cambio no se puede pedir para esta reserva.
   */
  async requestModify(
    tenantId: string,
    order: OrderRow,
    actorUserId: string,
    body: ModifyTravelersInput,
  ): Promise<TravelersReply> {
    if (!TRAVELERS_MODIFIABLE_STATUSES.includes(order.status)) {
      throw new ConflictException(TRAVELERS_MESSAGES.notModifiable);
    }
    const ref = modifyRefOf(order);
    const changes = changesOf(body);
    this.assertChanges(changes, ref);
    // Corregir datos no es vender: sale con la cuenta de la reserva aunque la plataforma haya
    // apagado el proveedor para ventas nuevas.
    const { provider, port } = await this.portFor(tenantId, order);
    const supported = new Set(port.supportedModifications());
    const fields = requestedFields(changes);
    if (fields.some((ref) => !supported.has(ref.field))) {
      throw new BadRequestException(TRAVELERS_MESSAGES.unavailable);
    }

    const testContent = isTestContentOrder(order);
    const requested: TravelersOperationResult = {
      kind: 'travelers',
      stage: 'sent',
      requestedAt: new Date().toISOString(),
      testContent,
      fields,
      // Mientras está pendiente, lo guardado dice «en duda»: si el proceso muere con la llamada en
      // vuelo, el barrido lo pasa a revisión.
      reconciliationRequired: true,
      retryForbidden: false,
    };

    let operationId: string;
    try {
      ({ operationId } = await this.store.claim(tenantId, order.id, actorUserId, requested));
    } catch (error) {
      throw this.claimFailure(error);
    }
    await this.emit(tenantId, order, actorUserId, ORDER_EVENTS.travelersModifyRequested, {
      operationId,
      fields: fieldNames(fields),
      travelers: travelerCount(fields),
      testContent,
    });

    let result: OrderModifyResult;
    try {
      result = await port.modifyTravelers(ref, changes, { tenantId, requestId: operationId });
    } catch (error) {
      // El contrato del puerto: si lanza, no se escribió nada en la reserva.
      await this.closeNotSent(tenantId, order, operationId, requested, actorUserId, error);
      if (error instanceof OrderModifyRejectedError) throw rejectionException(error);
      throw error;
    }
    return this.settle(tenantId, order, provider.code, operationId, requested, changes, result, {
      actorUserId,
    });
  }

  /**
   * Las `modify` de este tenant pendientes desde hace más de {@link TRAVELERS_STALE_AFTER_MS}.
   * Pudieron salir: pasan a revisión (`failed` en duda) y se escalan. Nada se reenvía; los valores
   * pedidos no se guardaron nunca, así que lo que queda es mirar la reserva —o pedirlo de nuevo, que
   * es seguro—.
   */
  async sweepTenant(tenantId: string, now: number = Date.now()): Promise<TravelersSweepReport> {
    const report: TravelersSweepReport = { examined: 0, escalated: 0, skipped: 0 };
    const stale = await this.store.listStale(tenantId, new Date(now - TRAVELERS_STALE_AFTER_MS));
    for (const op of stale) {
      report.examined += 1;
      if (await this.escalateStale(tenantId, op)) report.escalated += 1;
      else report.skipped += 1;
    }
    if (report.examined > 0) {
      this.logger.warn(
        `flights.travelers.sweep tenant=${tenantId} examined=${report.examined} escalated=${report.escalated} skipped=${report.skipped}`,
      );
    }
    return report;
  }

  // -------------------------------------------------------------------------------------------
  // Desenlaces
  // -------------------------------------------------------------------------------------------

  private async settle(
    tenantId: string,
    order: OrderRow,
    providerCode: string,
    operationId: string,
    requested: TravelersOperationResult,
    changes: readonly TravelerChange[],
    result: OrderModifyResult,
    context: { readonly actorUserId: string },
  ): Promise<TravelersReply> {
    const message = travelersMessageOf(result, requested.fields);
    const issueTypes = auditableTravelerIssueTypes(result.issues);
    const settled: TravelersOperationResult = {
      ...requested,
      stage: 'settled',
      settledAt: new Date().toISOString(),
      outcome: result.outcome,
      unchanged: result.unchanged,
      applied: result.applied,
      pending: result.pending,
      attempts: result.attempts,
      ...(result.failureReason === undefined ? {} : { failureReason: result.failureReason }),
      issueTypes,
      reconciliationRequired: result.outcome === 'UNVERIFIED',
    };
    const status = result.outcome === 'MODIFIED' ? 'success' : 'failed';
    this.logger.log(
      `flights.travelers.modify provider=${providerCode} order=${order.id} op=${operationId} outcome=${result.outcome} attempts=${result.attempts} applied=${result.applied.length} pending=${result.pending.length}`,
    );

    const passengers = passengersAfterChange(order.passengers, changes, result.applied);
    try {
      const closed = await this.store.settle(
        tenantId,
        order.id,
        operationId,
        status,
        settled,
        status === 'failed' ? message : null,
        passengers,
      );
      if (!closed) {
        // El barrido ya la pasó a revisión (y la escaló): lo que pasó en la aerolínea ya pasó y se
        // le dice al vendedor igual.
        this.logger.warn(
          `flights.travelers.settle_taken order=${order.id} op=${operationId} outcome=${result.outcome}`,
        );
      }
    } catch (error) {
      // La aerolínea contestó y no se pudo guardar: la operación queda pendiente para el barrido, y
      // se escala ya.
      this.logger.warn(
        `flights.travelers.settle_failed order=${order.id} op=${operationId} error=${errorName(error)}`,
      );
      await this.escalate(
        tenantId,
        order,
        context.actorUserId,
        operationId,
        'travelers-settle-failed',
        { errorName: errorName(error), fields: fieldNames(requested.fields) },
      );
    }

    if (result.outcome === 'MODIFIED') {
      await this.emit(tenantId, order, context.actorUserId, ORDER_EVENTS.travelersModified, {
        operationId,
        fields: fieldNames(result.applied),
        travelers: travelerCount(result.applied),
        unchanged: result.unchanged,
        attempts: result.attempts,
        testContent: requested.testContent,
      });
    } else {
      await this.emitFailed(tenantId, order, context.actorUserId, {
        operationId,
        outcome: result.outcome,
        ...(result.failureReason === undefined ? {} : { reason: result.failureReason }),
        retryable: true,
        reconciliationRequired: result.outcome === 'UNVERIFIED',
        fields: fieldNames(requested.fields),
        appliedFields: fieldNames(result.applied),
        pendingFields: fieldNames(result.pending),
        attempts: result.attempts,
        issueTypes,
        testContent: requested.testContent,
      });
    }
    if (result.outcome === 'UNVERIFIED') {
      await this.escalate(
        tenantId,
        order,
        context.actorUserId,
        operationId,
        'travelers-unverified',
        {
          appliedFields: fieldNames(result.applied),
          pendingFields: fieldNames(result.pending),
        },
      );
    }

    return {
      outcome: result.outcome,
      message,
      operationId,
      unchanged: result.unchanged,
      applied: result.applied,
      pending: result.pending,
    };
  }

  /** Un cambio que no salió: la operación se cierra y la reserva sigue como estaba. */
  private async closeNotSent(
    tenantId: string,
    order: OrderRow,
    operationId: string,
    requested: TravelersOperationResult,
    actorUserId: string,
    error: unknown,
  ): Promise<void> {
    const notSent: TravelersOperationResult = {
      ...requested,
      stage: 'settled',
      settledAt: new Date().toISOString(),
      outcome: 'NOT_SENT',
      attempts: 0,
      reconciliationRequired: false,
    };
    try {
      await this.store.settle(
        tenantId,
        order.id,
        operationId,
        'failed',
        notSent,
        this.reasonOf(order.provider, error),
      );
    } catch (closeError) {
      // Nada salió, pero no se pudo cerrar: queda pendiente y el barrido la pasa a revisión.
      this.logger.warn(
        `flights.travelers.not_sent_unsaved order=${order.id} op=${operationId} error=${errorName(closeError)}`,
      );
      return;
    }
    await this.emitFailed(tenantId, order, actorUserId, {
      operationId,
      outcome: 'NOT_SENT',
      retryable: true,
      reconciliationRequired: false,
      fields: fieldNames(requested.fields),
      errorName: errorName(error),
      ...(error instanceof OrderModifyRejectedError ? { rejection: error.code } : {}),
      testContent: requested.testContent,
    });
  }

  /** Una `modify` que se quedó pendiente: a revisión, con los campos pedidos a la vista. */
  private async escalateStale(tenantId: string, op: TravelersOperationRecord): Promise<boolean> {
    const record = isRecord(op.result) ? op.result : {};
    const fields: TravelerFieldRef[] = Array.isArray(record['fields'])
      ? (record['fields'] as unknown[]).flatMap((ref): TravelerFieldRef[] => {
          if (!isRecord(ref) || typeof ref['index'] !== 'number') return [];
          const field = TRAVELER_MODIFICATIONS.find((known) => known === ref['field']);
          return field === undefined ? [] : [{ index: ref['index'], field }];
        })
      : [];
    const result: TravelersOperationResult = {
      kind: 'travelers',
      stage: 'settled',
      requestedAt: typeof record['requestedAt'] === 'string' ? record['requestedAt'] : '',
      testContent: record['testContent'] === true,
      fields,
      settledAt: new Date().toISOString(),
      outcome: 'UNVERIFIED',
      applied: [],
      pending: fields,
      reconciliationRequired: true,
      retryForbidden: false,
      escalated: true,
    };
    let order: OrderRow | undefined;
    try {
      order = await this.store.findOrder(tenantId, op.orderId);
      const closed = await this.store.settle(
        tenantId,
        op.orderId,
        op.id,
        'failed',
        result,
        TRAVELERS_MESSAGES.unverified,
      );
      if (!closed) return false;
    } catch (error) {
      this.logger.warn(
        `flights.travelers.sweep_failed order=${op.orderId} op=${op.id} error=${errorName(error)}`,
      );
      return false;
    }
    const target = order ?? ({ id: op.orderId, provider: null } as const);
    await this.emitFailed(tenantId, target, op.actorUserId, {
      operationId: op.id,
      outcome: 'UNVERIFIED',
      source: 'stale',
      retryable: true,
      reconciliationRequired: true,
      fields: fieldNames(fields),
    });
    await this.escalate(tenantId, target, op.actorUserId, op.id, 'travelers-stale', {
      fields: fieldNames(fields),
    });
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Puertas, errores y rastro
  // -------------------------------------------------------------------------------------------

  /** Cada pasajero del cambio está en la orden, y un infante no lleva viajero frecuente ni SSR. */
  private assertChanges(changes: readonly TravelerChange[], ref: OrderModifyRef): void {
    for (const change of changes) {
      const passenger = ref.passengers[change.index];
      if (passenger === undefined) {
        throw new BadRequestException(TRAVELERS_MESSAGES.unknownPassenger);
      }
      if (
        passenger.paxType === 'INF' &&
        (change.loyalty !== undefined || change.specialServices !== undefined)
      ) {
        throw new BadRequestException(TRAVELERS_MESSAGES.infant);
      }
    }
  }

  /** El adapter de la reserva con su puerto de modificación. Sin la capacidad o sin el puerto, 400. */
  private async portFor(
    tenantId: string,
    order: OrderRow,
  ): Promise<{ provider: ResolvedProvider<FlightProviderAdapter>; port: OrderModifyPort }> {
    const provider = await this.registry.forOrder(tenantId, accountRef(order));
    const adapter = provider.adapter;
    if (provider.capabilities.modify !== true || !supportsOrderModify(adapter)) {
      throw new BadRequestException(TRAVELERS_MESSAGES.unavailable);
    }
    return { provider, port: adapter };
  }

  private claimFailure(error: unknown): unknown {
    if (error instanceof TravelersClaimRefusedError) {
      if (error.refusal === 'not-found') return new NotFoundException(TRAVELERS_MESSAGES.notFound);
      return new ConflictException(
        error.refusal === 'not-modifiable'
          ? TRAVELERS_MESSAGES.notModifiable
          : TRAVELERS_MESSAGES.alreadyPending,
      );
    }
    if (uniqueViolationConstraint(error) === PENDING_PROVIDER_WRITE_CONSTRAINT) {
      return new ConflictException(TRAVELERS_MESSAGES.alreadyPending);
    }
    return error;
  }

  /** El motivo de un fallo antes de salir, para el historial: el nuestro o el del traductor. */
  private reasonOf(provider: string, error: unknown): string {
    if (error instanceof OrderModifyRejectedError) return TRAVELERS_REJECTION_MESSAGES[error.code];
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

  private async emitFailed(
    tenantId: string,
    order: { readonly id: string; readonly provider: string | null },
    actorUserId: string | null,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.audit.emit({
      eventType: ORDER_EVENTS.travelersModifyFailed,
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
    reason: TravelersEscalationReason,
    detail: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.logger.warn(
      `flights.travelers.escalated provider=${order.provider ?? 'unknown'} order=${order.id} op=${operationId} reason=${reason}`,
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
        reconciliationRequired: true,
        ...detail,
      },
    });
  }
}
