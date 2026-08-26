import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import {
  type BookingContactInfo,
  type OrderCancelResult,
  type OrderCreateResult,
  type OrderPayResult,
  type OrderReshopRequest,
  type OrderReshopResult,
  type OrderView,
  type Passenger,
  type PaymentInfo,
  type ProviderIssue,
  type ServiceListResult,
} from '@sales-travel/domain';
import type { Offer } from '@sales-travel/canonical';
import { DatabaseService } from '../database/database.service.js';
import type {
  OrderOperationStatus,
  OrderOperationType,
  OrderStatus,
} from '../database/database.types.js';
import { AuditService } from '../audit/audit.service.js';
import { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import {
  supportsAuditedCancel,
  supportsAuditedCreate,
  type FlightProviderAdapter,
  type ResolvedProvider,
} from '../providers/provider.types.js';
import { PostSaleQueueService } from '../queue/post-sale-queue.service.js';
import {
  ORDER_STATUS_BY_OUTCOME,
  compensationTargets,
  decideAfterCreateThrew,
  decideAfterVerify,
  fallbackProviderRaw,
  planVerification,
  verificationSummary,
  type SagaDecision,
} from './order-create.saga.js';
import { ORDER_EVENTS, createdSummary } from './order-events.js';

/**
 * Resumen legible de las incidencias del proveedor para `orders.error_message`.
 *
 * Deja fuera `fieldValue` a propósito: es el valor que NOSOTROS mandamos, devuelto tal cual, y
 * puede llevar un número de documento —o un PAN, si algún día se activara el flag de tarjeta—.
 * `error_message` se persiste y se enseña; `fieldValue` no puede acabar ahí.
 */
export function summarizeIssues(issues: ProviderIssue[]): string | null {
  const relevantes = issues.filter((i) => i.severity === 'ERROR');
  if (relevantes.length === 0) return null;
  return relevantes
    .map((i) => [i.category, i.type, i.message].filter(Boolean).join(': '))
    .join(' | ');
}

export interface OrderOperationRow {
  id: string;
  type: OrderOperationType;
  status: OrderOperationStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
}

export interface CreateOrderDto {
  offer: Offer;
  searchCriteria: unknown;
  passengers: Passenger[];
  contactInfo: BookingContactInfo;
  quotationId?: string;
}

/**
 * Persiste una orden cuya reserva YA ocurrió contra el proveedor (no se llama a ningún
 * proveedor en `recordExternalOrder`). Usado por verticales que confirman fuera de OrdersService
 * (p.ej. autos vía CarsService.book). Montos en unidades menores; el discriminador es `provider`.
 */
export interface RecordExternalOrderInput {
  provider: string;
  providerOrderId: string | null;
  status: OrderStatus;
  searchCriteria: unknown;
  selectedOffer: unknown;
  passengers: unknown;
  contactInfo: unknown;
  totalAmountMinor: number;
  currency: string;
  errorMessage?: string | null;
}

export interface OrderRow {
  id: string;
  tenant_id: string;
  user_id: string;
  quotation_id: string | null;
  provider: string;
  provider_order_id: string | null;
  status: OrderStatus;
  search_criteria: unknown;
  selected_offer: unknown;
  passengers: unknown;
  contact_info: unknown;
  total_amount: number;
  currency: string;
  order_number: number;
  provider_raw: unknown;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly registry: FlightProviderRegistry,
    private readonly queue: PostSaleQueueService,
    private readonly agentCars: AgentCarsProviderFactory,
    private readonly audit: AuditService,
  ) {}

  /**
   * Proveedor QUE HIZO la reserva, con sus capacidades. Antes se inyectaba el factory de un
   * proveedor concreto y toda la post-venta salía por ahí sin mirar de quién era la orden: con
   * dos proveedores eso es cancelar el billete de otro, o no encontrarlo.
   */
  private async flightProvider(
    tenantId: string,
    providerCode: string | undefined,
  ): Promise<ResolvedProvider<FlightProviderAdapter>> {
    if (!providerCode) {
      throw new NotFoundException('La reserva no existe o no tiene proveedor asociado.');
    }
    return this.registry.byCode(tenantId, providerCode);
  }

  private async flightAdapter(
    tenantId: string,
    providerCode: string | undefined,
  ): Promise<FlightProviderAdapter> {
    return (await this.flightProvider(tenantId, providerCode)).adapter;
  }

  /**
   * Inserta una fila `orders` para una reserva que YA fue confirmada por el proveedor (no se llama
   * a ningún proveedor aquí). Reusa la asignación de `order_number` por tenant. Devuelve la fila.
   */
  async recordExternalOrder(
    tenantId: string,
    userId: string,
    input: RecordExternalOrderInput,
  ): Promise<OrderRow> {
    return this.db.withTenant(tenantId, async (trx) => {
      const nextNumber = await trx
        .selectFrom('orders')
        .select(sql<number>`COALESCE(MAX(order_number), 0) + 1`.as('next'))
        .where('tenant_id', '=', tenantId)
        .executeTakeFirstOrThrow();

      const row = await trx
        .insertInto('orders')
        .values({
          tenant_id: tenantId,
          user_id: userId,
          quotation_id: null,
          provider: input.provider,
          provider_order_id: input.providerOrderId,
          status: input.status,
          search_criteria: JSON.stringify(input.searchCriteria),
          selected_offer: JSON.stringify(input.selectedOffer),
          passengers: JSON.stringify(input.passengers),
          contact_info: JSON.stringify(input.contactInfo),
          total_amount: input.totalAmountMinor,
          currency: input.currency,
          order_number: nextNumber.next,
          provider_raw: null,
          error_message: input.errorMessage ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return row as unknown as OrderRow;
    });
  }

  /**
   * SAGA DE CREACIÓN (D9, sobre el BullMQ que ya existe).
   *
   * Tres pasos, y el segundo NO es opcional:
   *
   *  1. **crear** contra el proveedor de LA OFERTA (nunca una constante: reservar una oferta de
   *     un proveedor contra el adapter de otro devuelve "no existe ese vuelo" en el mejor caso).
   *  2. **verificar** con una lectura de cierre. Es el criterio de salida de la fase y no es
   *     telemetría: con Sabre, `createBooking` no devuelve `bookingSignature`, así que sin esta
   *     lectura no hay forma de modificar ni de compensar nada después.
   *  3. **compensar** lo que quedó a medias, cancelando por `itemId` y nunca en bloque.
   *
   * Las DECISIONES viven en `order-create.saga.ts`, sin I/O: este método sólo las ejecuta. Es lo
   * que hace que migrar a Temporal sea cambiar el ejecutor y no reescribir la lógica que decide
   * si se cancela una reserva.
   *
   * Ninguna rama termina en silencio: lo que no se pudo comprobar sale como `escalate` y deja su
   * `domain_event`, en vez de persistirse como confirmado.
   */
  async createOrder(
    tenantId: string,
    userId: string,
    dto: CreateOrderDto,
  ): Promise<{ order: OrderRow; providerResult: OrderCreateResult; saga: SagaDecision }> {
    const providerCode = dto.offer.provider.name;
    const provider = await this.flightProvider(tenantId, providerCode);

    // Antes de llamar, no después: si el proveedor no contesta, este evento es lo único que
    // demuestra que hubo un intento contra el que buscar una reserva fantasma en el PCC.
    await this.audit.emit({
      eventType: ORDER_EVENTS.createRequested,
      tenantId,
      actorUserId: userId,
      aggregateType: 'order',
      payload: {
        provider: providerCode,
        offerRef: dto.offer.provider.offerRef ?? null,
        amountMinor: dto.offer.pricing?.finalMinor ?? dto.offer.total.amountMinor,
        currency: dto.offer.total.currency,
        passengers: dto.passengers.length,
        quotationId: dto.quotationId ?? null,
      },
    });

    const created = await this.callCreate(tenantId, userId, provider, dto);

    const order = await this.persistOrder(tenantId, userId, dto, providerCode, created);

    await this.audit.emit({
      eventType: ORDER_EVENTS.created,
      tenantId,
      actorUserId: userId,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: {
        provider: providerCode,
        ...createdSummary(created.result),
        // La política con la que se pidió la reserva. Es lo que convierte un `PARTIAL` en algo
        // explicable tres semanas después: el éxito parcial es un modo que se ELIGE.
        ...created.audit,
      },
    });

    const saga = await this.closeCreation(tenantId, userId, provider, order, created);
    const finalOrder = await this.applyDecision(tenantId, userId, order, created, saga);

    return { order: finalOrder, providerResult: created.result, saga };
  }

  /**
   * Paso 1. Usa la vista auditada si el proveedor la ofrece; si no, la del puerto del dominio y
   * lo DICE (`audited: false`), en vez de fingir una política vacía.
   */
  private async callCreate(
    tenantId: string,
    userId: string,
    provider: ResolvedProvider<FlightProviderAdapter>,
    dto: CreateOrderDto,
  ): Promise<{
    result: OrderCreateResult;
    audit: Record<string, unknown>;
    providerRaw: Record<string, unknown>;
  }> {
    const request = {
      offer: dto.offer,
      criteria: dto.offer as never,
      passengers: dto.passengers,
      contactInfo: dto.contactInfo,
    };

    try {
      if (supportsAuditedCreate(provider.adapter)) {
        const audited = await provider.adapter.createOrderAudited(request, { tenantId });
        return {
          result: audited.result,
          audit: { ...audited.audit, hasVersionStamp: audited.hasVersionStamp },
          providerRaw: { ...audited.providerRaw },
        };
      }
      const result = await provider.adapter.createOrder(request, { tenantId });
      return {
        result,
        audit: { audited: false, hasVersionStamp: result.revision !== undefined },
        providerRaw: fallbackProviderRaw(provider.code, result),
      };
    } catch (err) {
      // Una excepción NO es un `FAILED`. Un `FAILED` es el proveedor diciendo "no reservé nada";
      // un timeout es el proveedor no diciendo nada, y la reserva puede existir.
      const decision = decideAfterCreateThrew();
      await this.audit.emit({
        eventType: ORDER_EVENTS.createFailed,
        tenantId,
        actorUserId: userId,
        aggregateType: 'order',
        payload: {
          provider: provider.code,
          reason: decision.kind === 'escalate' ? decision.reason : 'unknown',
          // El NOMBRE de la clase de error, nunca su mensaje: el mensaje puede arrastrar el eco
          // de lo que mandamos, y `domain_events` es append-only.
          errorName: err instanceof Error ? err.name : 'UnknownError',
          uncertain: true,
        },
      });
      throw err;
    }
  }

  /** Inserta la fila `orders` con el estado que dicta el desenlace y el `provider_raw` sin PAN. */
  private async persistOrder(
    tenantId: string,
    userId: string,
    dto: CreateOrderDto,
    providerCode: string,
    created: { result: OrderCreateResult; providerRaw: Record<string, unknown> },
  ): Promise<OrderRow> {
    return this.db.withTenant(tenantId, async (trx) => {
      const nextNumber = await trx
        .selectFrom('orders')
        .select(sql<number>`COALESCE(MAX(order_number), 0) + 1`.as('next'))
        .where('tenant_id', '=', tenantId)
        .executeTakeFirstOrThrow();

      const row = await trx
        .insertInto('orders')
        .values({
          tenant_id: tenantId,
          user_id: userId,
          quotation_id: dto.quotationId ?? null,
          provider: providerCode,
          provider_order_id: created.result.pnr ?? null,
          status: ORDER_STATUS_BY_OUTCOME[created.result.outcome],
          search_criteria: JSON.stringify(dto.searchCriteria),
          selected_offer: JSON.stringify(dto.offer),
          passengers: JSON.stringify(dto.passengers),
          contact_info: JSON.stringify(dto.contactInfo),
          // El cliente paga el precio final (con la cascada de markup); el proveedor
          // recibe el neto (dto.offer.total). Si no hay pricing, final = neto.
          total_amount: dto.offer.pricing?.finalMinor ?? dto.offer.total.amountMinor,
          currency: dto.offer.total.currency,
          order_number: nextNumber.next,
          // Lista BLANCA del adapter (o la nuestra si no la ofrece). Nunca un volcado: la
          // respuesta cruda de una creación arrastra el eco de lo que mandamos, con la PII de
          // los viajeros, y `orders.provider_raw` se persiste para siempre.
          provider_raw: JSON.stringify(created.providerRaw),
          error_message: summarizeIssues(created.result.issues),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return row as unknown as OrderRow;
    });
  }

  /**
   * Paso 2: la lectura de cierre. Best-effort en el sentido de que NO tumba la reserva —ya existe
   * del otro lado— pero jamás en el sentido de "si falla, da igual": si falla, el saga escala.
   */
  private async closeCreation(
    tenantId: string,
    userId: string,
    provider: ResolvedProvider<FlightProviderAdapter>,
    order: OrderRow,
    created: { result: OrderCreateResult },
  ): Promise<SagaDecision> {
    const plan = planVerification(created.result, provider.capabilities);

    if (plan.kind === 'skip') return { kind: 'settled', status: plan.status };
    if (plan.kind === 'escalate') return plan;

    let view: OrderView | null = null;
    try {
      view = await provider.adapter.retrieveForDisplay(plan.locator, { tenantId });
    } catch {
      // El motivo no se copia al evento: `verificationSummary(null)` ya dice `read-failed`, y el
      // mensaje del proveedor no entra en `domain_events`.
      view = null;
    }

    await this.logOperation(
      tenantId,
      order.id,
      'retrieve',
      view === null ? 'failed' : 'success',
      view === null ? 'la lectura de cierre de la creación falló' : null,
      userId,
    );

    await this.audit.emit({
      eventType: ORDER_EVENTS.verified,
      tenantId,
      actorUserId: userId,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { provider: provider.code, ...verificationSummary(view) },
    });

    return decideAfterVerify({ created: created.result, view });
  }

  /**
   * Paso 3: ejecuta la decisión. Encolar y actualizar el estado son lo único que ocurre aquí; el
   * QUÉ hacer ya lo decidió el saga puro.
   */
  private async applyDecision(
    tenantId: string,
    userId: string,
    order: OrderRow,
    created: { result: OrderCreateResult },
    decision: SagaDecision,
  ): Promise<OrderRow> {
    if (decision.kind === 'compensate') {
      const queued = await this.queue.enqueueCompensation({
        tenantId,
        orderId: order.id,
        cancellableItemIds: [...decision.cancellableItemIds],
        reason: decision.reason,
        // El actor viaja en el job para que el `domain_event` de la compensación —que ocurre
        // minutos después y en otro proceso— siga sabiendo quién originó la reserva (RNF-08).
        actorUserId: userId,
      });
      await this.audit.emit({
        eventType: ORDER_EVENTS.compensationScheduled,
        tenantId,
        actorUserId: userId,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: {
          provider: order.provider,
          reason: decision.reason,
          cancellableItemIds: [...decision.cancellableItemIds],
          // Sin Redis no hay reintento automático. Decirlo es la diferencia entre una
          // degradación elegante y creer que hay una compensación en marcha que no existe.
          queued,
        },
      });
    }

    if (decision.kind === 'escalate') {
      // `verification-unavailable` es lo único reintentable de forma automática: la reserva está
      // creada y sólo falta releerla. El resto necesita a una persona.
      const queued =
        decision.reason === 'verification-unavailable'
          ? await this.queue.enqueueVerifyCreation({
              tenantId,
              orderId: order.id,
              actorUserId: userId,
            })
          : false;

      await this.audit.emit({
        eventType: ORDER_EVENTS.escalated,
        tenantId,
        actorUserId: userId,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: {
          provider: order.provider,
          reason: decision.reason,
          outcome: created.result.outcome,
          compensationTargets: [...compensationTargets(created.result)],
          queued,
        },
      });
    }

    // Sólo se escribe si el estado CAMBIA. Un UPDATE que no cambia nada mueve `updated_at` y
    // hace creer que alguien tocó la reserva.
    if (decision.status === order.status) return order;

    const updated = await this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .updateTable('orders')
        .set({ status: decision.status })
        .where('id', '=', order.id)
        .returningAll()
        .executeTakeFirst();
      return row as unknown as OrderRow | undefined;
    });

    return updated ?? order;
  }

  async findAll(tenantId: string): Promise<OrderRow[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('orders')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute();
      return rows as unknown as OrderRow[];
    });
  }

  async findById(tenantId: string, id: string): Promise<OrderRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row as unknown as OrderRow | undefined;
    });
  }

  /**
   * Lectura de SÓLO VISUALIZACIÓN. No sirve —ni puede servir— como paso previo de una
   * modificación: su tipo de retorno no lleva firma de concurrencia. Ver RF-09.
   */
  async retrieveFromProvider(
    tenantId: string,
    pnr: string,
    providerCode: string,
  ): Promise<OrderView> {
    const adapter = await this.flightAdapter(tenantId, providerCode);
    return adapter.retrieveForDisplay(pnr, { tenantId });
  }

  /**
   * Ejecuta la cancelación (void) contra el proveedor y registra la operación. LANZA sólo en fallo
   * TRANSITORIO (el proveedor lanzó: red/timeout/5xx) — un rechazo de negocio devuelve `success:false`
   * sin lanzar. No encola reintentos (lo decide el caller). Usado por la API y por el worker.
   */
  private async runCancel(
    tenantId: string,
    id: string,
    pnr: string,
    actorUserId?: string,
    /** Compensación selectiva: sólo estos `itemId`. Sin ellos, la cancelación es de la reserva. */
    cancellableItemIds?: readonly string[],
  ): Promise<{ result: OrderCancelResult; order?: OrderRow }> {
    const existing = await this.findById(tenantId, id);
    let result: OrderCancelResult;
    /** Lo que el proveedor cuenta de la cancelación además del booleano. */
    let audit: Record<string, unknown> = { audited: false };
    /** `false` ⇒ el proveedor no dijo qué pasó: PROHIBIDO reintentar. */
    let verified = true;

    try {
      if (existing?.provider === 'agent-cars') {
        result = await this.cancelAgentCarsOrder(tenantId, existing, pnr);
      } else {
        const adapter = await this.flightAdapter(tenantId, existing?.provider);
        if (supportsAuditedCancel(adapter)) {
          const outcome = await adapter.cancelOrderAudited(
            pnr,
            { tenantId },
            cancellableItemIds === undefined ? undefined : { itemIds: cancellableItemIds },
          );
          result = outcome.result;
          audit = {
            ...outcome.audit,
            verified: outcome.verified,
            ...(outcome.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: outcome.idempotencyKey }),
          };
          verified = outcome.verified;
        } else {
          result = await adapter.cancelOrder(pnr, { tenantId });
        }
      }
    } catch (err) {
      await this.logOperation(
        tenantId,
        id,
        'cancel',
        'failed',
        (err as Error).message,
        actorUserId,
      );
      await this.audit.emit({
        eventType: ORDER_EVENTS.cancelled,
        tenantId,
        actorUserId,
        aggregateType: 'order',
        aggregateId: id,
        payload: {
          provider: existing?.provider ?? null,
          success: false,
          threw: true,
          errorName: err instanceof Error ? err.name : 'UnknownError',
          ...(cancellableItemIds === undefined
            ? {}
            : { cancellableItemIds: [...cancellableItemIds] }),
        },
      });
      throw err;
    }

    await this.audit.emit({
      eventType: ORDER_EVENTS.cancelled,
      tenantId,
      actorUserId,
      aggregateType: 'order',
      aggregateId: id,
      payload: {
        provider: existing?.provider ?? null,
        success: result.success,
        ...(cancellableItemIds === undefined
          ? {}
          : { cancellableItemIds: [...cancellableItemIds] }),
        ...audit,
      },
    });

    // `UNVERIFIED` no es un fallo reintentable: el proveedor no dijo si la cancelación se
    // ejecutó. Reintentar a ciegas puede cancelar lo que sobrevivió, así que esto necesita a una
    // persona que relea la reserva y compare.
    if (!verified) {
      await this.audit.emit({
        eventType: ORDER_EVENTS.escalated,
        tenantId,
        actorUserId,
        aggregateType: 'order',
        aggregateId: id,
        payload: {
          provider: existing?.provider ?? null,
          reason: 'cancellation-unverified',
          retryForbidden: true,
        },
      });
    }

    await this.logOperation(
      tenantId,
      id,
      'cancel',
      result.success ? 'success' : 'failed',
      result.success ? null : (result.error ?? 'cancelación rechazada'),
      actorUserId,
    );

    if (result.success) {
      const order = await this.db.withTenant(tenantId, async (trx) => {
        const row = await trx
          .updateTable('orders')
          .set({ status: 'cancelled' as OrderStatus })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst();
        return row as unknown as OrderRow | undefined;
      });
      return { result, order };
    }

    return { result };
  }

  /**
   * Cancela una reserva de auto contra AgentCars (no LATAM). `confirmationCode` = provider_order_id;
   * `lastName` sale del primer pasajero (DRIVER). Mapea el CancelResult del proveedor al
   * OrderCancelResult del dominio.
   */
  private async cancelAgentCarsOrder(
    tenantId: string,
    order: OrderRow,
    confirmationCode: string,
  ): Promise<OrderCancelResult> {
    const passengers = (order.passengers as { surname?: unknown }[] | null) ?? [];
    const surname = passengers[0]?.surname;
    const lastName = typeof surname === 'string' ? surname : '';
    const adapter = await this.agentCars.forTenant(tenantId);
    const res = await adapter.cancel({ lastName, confirmationCode });
    return {
      success: res.success,
      warnings: [],
      ...(res.success ? {} : { error: res.message ?? 'cancelación rechazada' }),
    };
  }

  /**
   * Cancelación desde la API: intenta una vez; si falla por causa transitoria (excepción), encola un
   * reintento automático (BullMQ) y re-lanza el error al usuario. Los rechazos de negocio no reintentan.
   */
  async cancelOrder(
    tenantId: string,
    id: string,
    pnr: string,
    actorUserId?: string,
  ): Promise<{ result: OrderCancelResult; order?: OrderRow }> {
    try {
      return await this.runCancel(tenantId, id, pnr, actorUserId);
    } catch (err) {
      await this.queue.enqueueCancelRetry({ tenantId, orderId: id, type: 'cancel' });
      throw err;
    }
  }

  /** Reintento desde el worker: re-ejecuta la cancelación con el PNR de la orden. Propaga el error
   *  transitorio para que BullMQ reintente; un rechazo de negocio termina el job sin reintentar. */
  async runCancelById(tenantId: string, orderId: string): Promise<void> {
    const order = await this.findById(tenantId, orderId);
    if (!order?.provider_order_id) return;
    if (order.status === 'cancelled') return;
    await this.runCancel(tenantId, orderId, order.provider_order_id);
  }

  /**
   * Paso 2 del saga, reintentado desde el worker: la lectura de cierre que no se pudo hacer en
   * línea. Propaga el error transitorio para que BullMQ reintente.
   *
   * No es una consulta de cortesía: mientras esta lectura no ocurra, la creación **no está
   * cerrada** y no hay forma de modificar ni compensar la reserva.
   */
  async verifyCreationById(tenantId: string, orderId: string, actorUserId?: string): Promise<void> {
    const order = await this.findById(tenantId, orderId);
    if (!order?.provider_order_id) return;
    if (order.status === 'cancelled') return;

    const provider = await this.flightProvider(tenantId, order.provider);
    const view = await provider.adapter.retrieveForDisplay(order.provider_order_id, { tenantId });

    await this.logOperation(tenantId, orderId, 'retrieve', 'success', null, actorUserId);
    await this.audit.emit({
      eventType: ORDER_EVENTS.verified,
      tenantId,
      actorUserId,
      aggregateType: 'order',
      aggregateId: orderId,
      payload: { provider: order.provider, deferred: true, ...verificationSummary(view) },
    });

    // La reserva del proveedor manda sobre lo que creíamos: si la relectura dice que no existe,
    // dejarla en `confirmed` es sostener una reserva que no está.
    if (!view.found && order.status === 'confirmed') {
      await this.audit.emit({
        eventType: ORDER_EVENTS.escalated,
        tenantId,
        actorUserId,
        aggregateType: 'order',
        aggregateId: orderId,
        payload: { provider: order.provider, reason: 'verified-not-found' },
      });
      await this.db.withTenant(tenantId, async (trx) => {
        await trx
          .updateTable('orders')
          .set({ status: 'pending' as OrderStatus })
          .where('id', '=', orderId)
          .execute();
      });
    }
  }

  /**
   * Paso 3 del saga desde el worker: compensación SELECTIVA por `itemId`.
   *
   * Los ids vienen en el job y no se recalculan aquí a propósito: son los que el proveedor
   * declaró cancelables en el momento de la creación, y volver a derivarlos horas después contra
   * un estado que ya cambió es como se cancela lo que sí estaba bien. Una lista vacía no
   * degrada a "cancelar todo": no hace nada, porque un `cancelAll` ciego en un éxito parcial
   * cancela también lo que quedó confirmado.
   */
  async runCompensation(
    tenantId: string,
    orderId: string,
    cancellableItemIds: readonly string[],
    actorUserId?: string,
  ): Promise<void> {
    if (cancellableItemIds.length === 0) return;
    const order = await this.findById(tenantId, orderId);
    if (!order?.provider_order_id) return;
    if (order.status === 'cancelled') return;

    await this.runCancel(
      tenantId,
      orderId,
      order.provider_order_id,
      actorUserId,
      cancellableItemIds,
    );
  }

  async listServices(tenantId: string, row: OrderRow): Promise<ServiceListResult> {
    const passengers = (row.passengers as { paxId: string; paxType: string }[]) ?? [];
    const adapter = await this.flightAdapter(tenantId, row.provider);
    return adapter.listServices(
      { orderId: row.provider_order_id!, passengers, itemType: 'BAGGAGE' },
      { tenantId },
    );
  }

  async reshopOrder(
    tenantId: string,
    row: OrderRow,
    body: OrderReshopRequest,
    actorUserId?: string,
  ): Promise<OrderReshopResult> {
    const orderId = row.id;
    const adapter = await this.flightAdapter(tenantId, row.provider);
    let result: OrderReshopResult;
    try {
      result = await adapter.reshopWithTickets(body, { tenantId });
    } catch (err) {
      await this.logOperation(
        tenantId,
        orderId,
        'reshop',
        'failed',
        (err as Error).message,
        actorUserId,
      );
      throw err;
    }
    await this.logOperation(
      tenantId,
      orderId,
      'reshop',
      result.success ? 'success' : 'failed',
      result.success ? null : (result.error ?? 'reshop rechazado'),
      actorUserId,
    );
    return result;
  }

  /** Inserta un registro durable de una operación de post-venta (trazabilidad + reintento). */
  private async logOperation(
    tenantId: string,
    orderId: string,
    type: OrderOperationType,
    status: OrderOperationStatus,
    lastError: string | null,
    actorUserId?: string,
  ): Promise<void> {
    try {
      await this.db.withTenant(tenantId, async (trx) => {
        await trx
          .insertInto('order_operations')
          .values({
            tenant_id: tenantId,
            order_id: orderId,
            type,
            status,
            last_error: lastError,
            result: JSON.stringify({ status }),
            actor_user_id: actorUserId ?? null,
          })
          .execute();
      });
    } catch {
      // El registro de la operación es best-effort: nunca debe tumbar la operación principal.
    }
  }

  /** Historial de operaciones de post-venta de una orden (más reciente primero). */
  async listOperations(tenantId: string, orderId: string): Promise<OrderOperationRow[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('order_operations')
        .select(['id', 'type', 'status', 'attempts', 'last_error', 'created_at'])
        .where('order_id', '=', orderId)
        .orderBy('created_at', 'desc')
        .execute();
      return rows as unknown as OrderOperationRow[];
    });
  }

  /**
   * Reintenta una operación fallida. Hoy soporta 'cancel' (re-ejecuta el void con el PNR de la
   * orden). Para 'pay' no aplica (no guardamos datos de tarjeta por PCI).
   */
  async retryOperation(
    tenantId: string,
    orderId: string,
    opId: string,
    actorUserId?: string,
  ): Promise<{ result: OrderCancelResult }> {
    const op = await this.db.withTenant(tenantId, async (trx) =>
      trx
        .selectFrom('order_operations')
        .select(['type'])
        .where('id', '=', opId)
        .where('order_id', '=', orderId)
        .executeTakeFirst(),
    );
    if (!op) throw new Error('operation not found');
    if (op.type !== 'cancel') {
      throw new Error('Sólo las cancelaciones se pueden reintentar automáticamente.');
    }
    const order = await this.findById(tenantId, orderId);
    if (!order?.provider_order_id) throw new Error('order has no PNR');
    const { result } = await this.cancelOrder(
      tenantId,
      orderId,
      order.provider_order_id,
      actorUserId,
    );
    return { result };
  }

  async payOrder(
    tenantId: string,
    id: string,
    row: OrderRow,
    payment: PaymentInfo,
    actorUserId?: string,
  ): Promise<OrderPayResult> {
    const contactInfo = (row.contact_info as BookingContactInfo) ?? {
      email: '',
      phone: '',
    };
    const passengers = (row.passengers as { paxId: string; paxType: string }[]) ?? [];

    const adapter = await this.flightAdapter(tenantId, row.provider);
    let result: OrderPayResult;
    try {
      result = await adapter.payOrder(
        { orderId: row.provider_order_id!, payment, contactInfo, passengers },
        { tenantId },
      );
    } catch (err) {
      await this.logOperation(tenantId, id, 'pay', 'failed', (err as Error).message, actorUserId);
      throw err;
    }
    await this.logOperation(
      tenantId,
      id,
      'pay',
      result.success ? 'success' : 'failed',
      result.success ? null : (result.error ?? 'pago rechazado'),
      actorUserId,
    );

    if (result.success) {
      await this.db.withTenant(tenantId, async (trx) => {
        await trx
          .updateTable('orders')
          .set({ status: (result.status ?? 'confirmed') as OrderStatus })
          .where('id', '=', id)
          .execute();
      });
    }

    return result;
  }
}
