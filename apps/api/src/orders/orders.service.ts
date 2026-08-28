import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'kysely';
import {
  type BookingContactInfo,
  type FlightSearchCriteria,
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
import { PricingService, applyCascade, toTenantView } from '../pricing/pricing.service.js';
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
import {
  CANCEL_REJECTED_POLICY,
  CANCEL_SUCCESS_POLICY,
  CANCEL_UNVERIFIED_POLICY,
  classifyCancelThrownFailure,
  persistedCancelRetryPolicy,
  type CancelOperationOutcome,
  type CancelRetryPolicy,
} from './cancel-retry-policy.js';

/**
 * Resumen legible de las incidencias del proveedor para `orders.error_message`.
 *
 * Persiste únicamente campos estructurados. Tanto `fieldValue` como `message` son texto libre del
 * proveedor y pueden incluir datos que enviamos (documento, email o incluso un PAN si algún día se
 * habilitara tarjeta); ninguno puede terminar en una columna durable ni volver al navegador.
 */
export function summarizeIssues(issues: ProviderIssue[]): string | null {
  const relevantes = issues.filter((i) => i.severity === 'ERROR');
  if (relevantes.length === 0) return null;
  return relevantes
    .map((i) =>
      [
        i.category,
        i.type,
        i.fieldPath === undefined ? undefined : `path=${i.fieldPath}`,
        i.fieldName === undefined ? undefined : `field=${i.fieldName}`,
      ]
        .filter(Boolean)
        .join(': '),
    )
    .join(' | ');
}

/** Identidad comercial estable; no incluye precio, TTL ni ids opacos del proveedor. */
function fareSelection(offer: Offer): string | null {
  if (!offer.fareComponents || offer.fareComponents.length === 0) return null;
  const components = offer.fareComponents.map((component) => ({
    segmentRefs: [...component.segmentRefs].sort((a, b) => a - b),
    // Flight Check puede añadir `programId` o dejar de repetir `programCode` sin cambiar el
    // producto. Código de marca (o nombre como fallback) + fare basis + RBD sí lo identifican.
    brand:
      component.brand?.code?.trim().toUpperCase() ??
      component.brand?.name?.trim().toUpperCase() ??
      null,
    fareBasisCode: component.fareBasisCode?.trim().toUpperCase(),
    cabin: component.cabin?.trim().toUpperCase() ?? null,
    bookingClasses: component.bookingClasses
      ? [...component.bookingClasses].map((value) => value.trim().toUpperCase()).sort()
      : null,
  }));
  components.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(components);
}

function fareSelectionChanged(before: Offer, after: Offer): boolean {
  const selected = fareSelection(before);
  if (selected !== null) return selected !== fareSelection(after);

  // Ofertas anteriores a `fareComponents` sí tenían una selección comercial: la etiqueta
  // global. Ignorarla permite que Flight Check cambie LIGHT por FLEX al mismo precio y que el
  // servidor reserve sin una nueva aceptación. Se compara como fallback, normalizada.
  const legacySelection = (offer: Offer): string | null => {
    const family = offer.fareFamily;
    if (!family) return null;
    return JSON.stringify({
      name: family.name.trim().toUpperCase(),
      cabin: family.cabin.trim().toUpperCase(),
    });
  };
  const selectedLegacy = legacySelection(before);
  return selectedLegacy !== null && selectedLegacy !== legacySelection(after);
}

/**
 * Sentinel cerrado del intent de creación. Nunca contiene el mensaje del proveedor ni datos del
 * pasajero; además permite que el UPDATE final haga CAS usando el schema actual, sin una columna
 * nueva de versión.
 */
const CREATE_PENDING_RECONCILIATION_MARKER =
  'Creación pendiente de conciliación con el proveedor. No reenviar la reserva.';
const CREATE_NOT_SENT_MARKER = 'La creación no se envió al proveedor.';
const CREATE_REQUEST_KEY_CONSTRAINT = 'uq_orders_create_request_key';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CreatedOrderResult {
  result: OrderCreateResult;
  audit: Record<string, unknown>;
  providerRaw: Record<string, unknown>;
}

interface CancellationClaim {
  operationId: string;
  /** Estado que se restaura sólo cuando se demostró que el write no ocurrió o fue rechazado. */
  priorStatus: OrderStatus;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function isCreateRequestKeyViolation(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const constraint =
    typeof error === 'object' && error !== null && 'constraint' in error
      ? (error as { constraint?: unknown }).constraint
      : undefined;
  return constraint === CREATE_REQUEST_KEY_CONSTRAINT;
}

function createRequestKey(quotationId: string | undefined, clientRequestId: string | undefined) {
  if (quotationId !== undefined) return `q:${quotationId.toLowerCase()}`;
  const normalized = clientRequestId?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) {
    throw new BadRequestException(
      'Se requiere Idempotency-Key UUID cuando la reserva no proviene de una cotización.',
    );
  }
  if (!UUID_PATTERN.test(normalized)) {
    throw new BadRequestException('Idempotency-Key debe ser un UUID válido.');
  }
  return `c:${normalized}`;
}

export interface OrderOperationRow {
  id: string;
  type: OrderOperationType;
  status: OrderOperationStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  /** Sólo `true` si se demostró que el fallo ocurrió antes de enviar la cancelación. */
  retryable: boolean;
  outcome: CancelOperationOutcome | null;
  reconciliationRequired: boolean;
}

export interface CreateOrderDto {
  offer: Offer;
  searchCriteria: FlightSearchCriteria;
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
  create_request_key: string | null;
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
    private readonly pricing: PricingService,
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
      // Serializa MAX(order_number)+1 por tenant. El índice único de 0038 queda como defensa final.
      await trx
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', tenantId)
        .forUpdate()
        .executeTakeFirstOrThrow();
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
          create_request_key: null,
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
    clientRequestId?: string,
  ): Promise<{ order: OrderRow; providerResult: OrderCreateResult; saga: SagaDecision }> {
    if (dto.offer.tenantId !== tenantId) {
      throw new BadRequestException('La oferta no pertenece a la agencia activa.');
    }
    this.assertCreateRequestConsistency(dto);
    const requestKey = createRequestKey(dto.quotationId, clientRequestId);

    const providerCode = dto.offer.provider.name;
    const provider = await this.flightProvider(tenantId, providerCode);

    // El claim se inserta antes de priceOffer/createOrder. Una colisión termina aquí, sin tocar el
    // proveedor. La transacción también valida que la cotización pertenezca al tenant.
    const intent = await this.insertCreateIntent(tenantId, userId, dto, providerCode, requestKey);

    // La verificación de la pantalla es UX; ésta es la puerta de integridad. Un cliente puede
    // saltarse el botón, reenviar una cotización vieja o modificar el JSON. El servidor vuelve
    // a consultar al proveedor justo antes del write y reconstruye el precio de venta con las
    // reglas de la BD. Nunca se confía en `offer.pricing` recibido del navegador.
    let verifiedDto: CreateOrderDto;
    try {
      verifiedDto = await this.revalidateForCreate(tenantId, provider, dto);
    } catch (error) {
      await this.failCreateIntentBeforeProviderBestEffort(tenantId, intent);
      throw error;
    }

    // Antes de llamar, no después: si el proveedor no contesta, este evento es lo único que
    // demuestra que hubo un intento contra el que buscar una reserva fantasma en el PCC.
    try {
      await this.audit.emit({
        eventType: ORDER_EVENTS.createRequested,
        tenantId,
        actorUserId: userId,
        aggregateType: 'order',
        aggregateId: intent.id,
        payload: {
          provider: providerCode,
          offerRef: verifiedDto.offer.provider.offerRef ?? null,
          amountMinor: verifiedDto.offer.pricing?.finalMinor ?? verifiedDto.offer.total.amountMinor,
          currency: verifiedDto.offer.total.currency,
          passengers: verifiedDto.passengers.length,
          quotationId: verifiedDto.quotationId ?? null,
        },
      });
    } catch (error) {
      await this.failCreateIntentBeforeProviderBestEffort(tenantId, intent);
      throw error;
    }

    const created = await this.callCreate(tenantId, userId, provider, verifiedDto, intent.id);

    // Tras el write externo, un fallo del audit log no puede convertir la respuesta en un 500 que
    // invite a reservar otra vez. El intent durable sigue siendo la fuente de conciliación.
    try {
      await this.audit.emit({
        eventType: ORDER_EVENTS.created,
        tenantId,
        actorUserId: userId,
        aggregateType: 'order',
        aggregateId: intent.id,
        payload: {
          provider: providerCode,
          ...createdSummary(created.result),
          // La política con la que se pidió la reserva. Es lo que convierte un `PARTIAL` en algo
          // explicable tres semanas después: el éxito parcial es un modo que se ELIGE.
          ...created.audit,
        },
      });
    } catch {
      // Fail-closed: nunca se repite el write por una caída del canal de auditoría.
    }

    let order: OrderRow | undefined;
    try {
      order = await this.settleCreateIntent(tenantId, intent, verifiedDto, created);
    } catch {
      order = undefined;
    }

    if (order === undefined) {
      const saga: SagaDecision = {
        kind: 'escalate',
        reason: 'result-persistence-unavailable',
        status: 'pending',
      };
      try {
        await this.audit.emit({
          eventType: ORDER_EVENTS.escalated,
          tenantId,
          actorUserId: userId,
          aggregateType: 'order',
          aggregateId: intent.id,
          payload: {
            provider: providerCode,
            reason: saga.reason,
            ...createdSummary(created.result),
            retryForbidden: true,
            reconciliationRequired: true,
          },
        });
      } catch {
        // La fila pending ya quedó comprometida antes del proveedor. No se oculta esa referencia
        // al cliente sólo porque el canal secundario de auditoría también esté degradado.
      }
      // No se relee ni se compensa: antes hay que conciliar el resultado con ESTA fila.
      return { order: intent, providerResult: created.result, saga };
    }

    try {
      const saga = await this.closeCreation(tenantId, userId, provider, order, created);
      const finalOrder = await this.applyDecision(tenantId, userId, order, created, saga);
      return { order: finalOrder, providerResult: created.result, saga };
    } catch {
      const saga: SagaDecision = {
        kind: 'escalate',
        reason: 'post-create-finalization-unavailable',
        status: 'pending',
      };
      const marked = await this.markCreatePendingBestEffort(tenantId, order);
      try {
        await this.audit.emit({
          eventType: ORDER_EVENTS.escalated,
          tenantId,
          actorUserId: userId,
          aggregateType: 'order',
          aggregateId: order.id,
          payload: {
            provider: providerCode,
            reason: saga.reason,
            ...createdSummary(created.result),
            retryForbidden: true,
            reconciliationRequired: true,
          },
        });
      } catch {
        // El locator ya está en la fila consolidada; nunca se transforma esta caída secundaria en
        // otro 500 que permita repetir el write.
      }
      return {
        order: marked ?? { ...order, status: 'pending' },
        providerResult: created.result,
        saga,
      };
    }
  }

  /** Invariantes que deben fallar antes de resolver credenciales o llamar al proveedor. */
  private assertCreateRequestConsistency(dto: CreateOrderDto): void {
    const passengers = {
      adults: dto.passengers.filter((passenger) => passenger.paxType === 'ADT').length,
      children: dto.passengers.filter((passenger) => passenger.paxType === 'CHD').length,
      infants: dto.passengers.filter((passenger) => passenger.paxType === 'INF').length,
    };
    const requested = dto.searchCriteria.paxCount;
    if (
      passengers.adults !== requested.adults ||
      passengers.children !== requested.children ||
      passengers.infants !== requested.infants
    ) {
      throw new BadRequestException(
        'Los pasajeros no coinciden con la cantidad de adultos, niños e infantes de la búsqueda.',
      );
    }

    if (dto.searchCriteria.currency !== dto.offer.total.currency) {
      throw new BadRequestException(
        'La moneda de la búsqueda no coincide con la moneda total de la oferta.',
      );
    }

    const itineraries = dto.offer.itineraries;
    if (!itineraries || itineraries.length === 0) {
      throw new BadRequestException(
        'La oferta de vuelo no contiene un itinerario reservable que se pueda contrastar con la búsqueda.',
      );
    }

    const itineraryMatches = (
      index: number,
      origin: string,
      destination: string,
      departureDate: string,
    ): boolean => {
      const segments = itineraries[index]?.segments;
      const first = segments?.[0];
      const last = segments?.at(-1);
      return (
        first?.origin === origin &&
        last?.destination === destination &&
        first.departureAt.slice(0, 10) === departureDate
      );
    };

    const outboundMatches = itineraryMatches(
      0,
      dto.searchCriteria.origin,
      dto.searchCriteria.destination,
      dto.searchCriteria.departureDate,
    );
    const returnDate = dto.searchCriteria.returnDate;
    const expectedLegs = returnDate === undefined ? 1 : 2;
    const inboundMatches =
      returnDate === undefined ||
      itineraryMatches(1, dto.searchCriteria.destination, dto.searchCriteria.origin, returnDate);

    if (itineraries.length !== expectedLegs || !outboundMatches || !inboundMatches) {
      throw new BadRequestException(
        'La ruta, las fechas o el tipo de viaje de la oferta no coinciden con la búsqueda.',
      );
    }
  }

  /**
   * Revalida disponibilidad/precio y fija la oferta exacta que cruza a `createOrder`.
   *
   * Un cambio de precio o de identidad tarifaria requiere una aceptación nueva del vendedor.
   * Reservar automáticamente una alternativa `Same cabin` o un fare basis distinto, aunque
   * cueste lo mismo, sería cambiar el producto después de la selección.
   */
  private async revalidateForCreate(
    tenantId: string,
    provider: ResolvedProvider<FlightProviderAdapter>,
    dto: CreateOrderDto,
  ): Promise<CreateOrderDto> {
    const checked = await provider.adapter.priceOffer(dto.offer, dto.searchCriteria, { tenantId });

    if (checked.offer.provider.name !== provider.code || checked.offer.tenantId !== tenantId) {
      throw new BadRequestException(
        'El proveedor devolvió una oferta que no corresponde a la solicitud.',
      );
    }

    const revalidatedExpiry = Date.parse(checked.offer.expiresAt);
    if (!Number.isFinite(revalidatedExpiry) || revalidatedExpiry <= Date.now()) {
      throw new ConflictException(
        'La oferta revalidada ya venció o no tiene una vigencia válida. Volvé a buscar antes de reservar.',
      );
    }

    const changedMoney =
      checked.offer.total.amountMinor !== dto.offer.total.amountMinor ||
      checked.offer.total.currency !== dto.offer.total.currency;
    const changedFare = fareSelectionChanged(dto.offer, checked.offer);

    if (checked.priceChanged || changedMoney || changedFare) {
      throw new ConflictException(
        changedFare
          ? 'La familia o la base tarifaria cambió. Revalidá la oferta y aceptá la nueva opción antes de reservar.'
          : 'El precio cambió. Revalidá la oferta y aceptá el nuevo precio antes de reservar.',
      );
    }

    // El adapter puede construir su respuesta sobre la oferta de entrada y, por tanto, arrastrar
    // un `pricing` manipulado por el cliente. Se quita siempre y se vuelve a calcular desde BD.
    const { pricing: _untrustedPricing, ...providerOffer } = checked.offer;
    const rules = await this.pricing.getApplicableRules(tenantId, 'flights');
    const offer: Offer =
      rules.length === 0
        ? providerOffer
        : {
            ...providerOffer,
            pricing: toTenantView(
              applyCascade(providerOffer.total.amountMinor, rules),
              tenantId,
              providerOffer.total.currency,
            ),
          };

    return { ...dto, offer };
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
    intentId: string,
  ): Promise<CreatedOrderResult> {
    const request = {
      offer: dto.offer,
      criteria: dto.searchCriteria,
      passengers: dto.passengers,
      contactInfo: dto.contactInfo,
    };

    try {
      if (supportsAuditedCreate(provider.adapter)) {
        const audited = await provider.adapter.createOrderAudited(request, {
          tenantId,
          requestId: intentId,
        });
        return {
          result: audited.result,
          audit: { ...audited.audit, hasVersionStamp: audited.hasVersionStamp },
          providerRaw: { ...audited.providerRaw },
        };
      }
      const result = await provider.adapter.createOrder(request, {
        tenantId,
        requestId: intentId,
      });
      return {
        result,
        audit: { audited: false, hasVersionStamp: result.revision !== undefined },
        providerRaw: fallbackProviderRaw(provider.code, result),
      };
    } catch (err) {
      // Una excepción NO es un `FAILED`. Un `FAILED` es el proveedor diciendo "no reservé nada";
      // un timeout es el proveedor no diciendo nada, y la reserva puede existir.
      const decision = decideAfterCreateThrew();
      try {
        await this.audit.emit({
          eventType: ORDER_EVENTS.createFailed,
          tenantId,
          actorUserId: userId,
          aggregateType: 'order',
          aggregateId: intentId,
          payload: {
            provider: provider.code,
            reason: decision.kind === 'escalate' ? decision.reason : 'unknown',
            // El NOMBRE de la clase de error, nunca su mensaje: el mensaje puede arrastrar el eco
            // de lo que mandamos, y `domain_events` es append-only.
            errorName: err instanceof Error ? err.name : 'UnknownError',
            uncertain: true,
          },
        });
      } catch {
        // El intent durable ya existe; una segunda caída no autoriza a repetir la creación.
      }
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message:
          'La creación quedó pendiente de conciliación con el proveedor. No vuelvas a reservar.',
        orderId: intentId,
        retryForbidden: true,
        reconciliationRequired: true,
      });
    }
  }

  /** Inserta y compromete el intent `pending` antes de tocar el proveedor. */
  private async insertCreateIntent(
    tenantId: string,
    userId: string,
    dto: CreateOrderDto,
    providerCode: string,
    requestKey: string,
  ): Promise<OrderRow> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.insertCreateIntentOnce(tenantId, userId, dto, providerCode, requestKey);
      } catch (error) {
        if (!isCreateRequestKeyViolation(error)) throw error;

        const existing = await this.findByCreateRequestKey(tenantId, requestKey);
        if (existing !== undefined) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            message:
              'Esta solicitud de creación ya fue recibida. No vuelvas a reservar; usa la orden existente.',
            orderId: existing.id,
            ...(existing.provider_order_id === null ? {} : { pnr: existing.provider_order_id }),
            duplicateRequest: true,
            retryForbidden: true,
            reconciliationRequired: true,
          });
        }

        // El primer request pudo liberar la clave al cerrar FAILED entre el 23505 y esta lectura.
        // Sólo se repite el INSERT; nunca priceOffer/createOrder.
        if (attempt === 0) continue;
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: 'No se pudo adquirir de forma segura la clave de creación.',
          duplicateRequest: true,
          retryForbidden: true,
          reconciliationRequired: true,
        });
      }
    }
    throw new ConflictException('No se pudo adquirir la clave de creación.');
  }

  private async insertCreateIntentOnce(
    tenantId: string,
    userId: string,
    dto: CreateOrderDto,
    providerCode: string,
    requestKey: string,
  ): Promise<OrderRow> {
    return this.db.withTenant(tenantId, async (trx) => {
      // Lock real por tenant: dos transacciones no pueden observar el mismo MAX(order_number).
      await trx
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', tenantId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      if (dto.quotationId !== undefined) {
        const quotation = await trx
          .selectFrom('quotations')
          .select('id')
          .where('id', '=', dto.quotationId)
          .where('tenant_id', '=', tenantId)
          .executeTakeFirst();
        if (quotation === undefined) {
          throw new BadRequestException('La cotización no pertenece a la agencia activa.');
        }
      }

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
          provider_order_id: null,
          status: 'pending',
          search_criteria: JSON.stringify(dto.searchCriteria),
          selected_offer: JSON.stringify(dto.offer),
          passengers: JSON.stringify(dto.passengers),
          contact_info: JSON.stringify(dto.contactInfo),
          // El cliente paga el precio final (con la cascada de markup); el proveedor
          // recibe el neto (dto.offer.total). Si no hay pricing, final = neto.
          total_amount: dto.offer.pricing?.finalMinor ?? dto.offer.total.amountMinor,
          currency: dto.offer.total.currency,
          order_number: nextNumber.next,
          provider_raw: null,
          error_message: CREATE_PENDING_RECONCILIATION_MARKER,
          create_request_key: requestKey,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return row as unknown as OrderRow;
    });
  }

  private async findByCreateRequestKey(
    tenantId: string,
    requestKey: string,
  ): Promise<OrderRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom('orders')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('create_request_key', '=', requestKey)
        .executeTakeFirst();
      return row as unknown as OrderRow | undefined;
    });
  }

  /**
   * Consolida el resultado sobre la MISMA fila. `provider_raw IS NULL` es el CAS compatible con
   * el schema vigente: todo resultado cerrado escribe una lista blanca no nula, incluso FAILED.
   */
  private async settleCreateIntent(
    tenantId: string,
    intent: OrderRow,
    dto: CreateOrderDto,
    created: CreatedOrderResult,
  ): Promise<OrderRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .updateTable('orders')
        .set({
          provider_order_id: created.result.pnr ?? created.result.orderId ?? null,
          status: ORDER_STATUS_BY_OUTCOME[created.result.outcome],
          selected_offer: JSON.stringify(dto.offer),
          search_criteria: JSON.stringify(dto.searchCriteria),
          total_amount: dto.offer.pricing?.finalMinor ?? dto.offer.total.amountMinor,
          currency: dto.offer.total.currency,
          // Lista BLANCA del adapter (o la nuestra si no la ofrece). Nunca un volcado: la
          // respuesta cruda de una creación arrastra el eco de lo que mandamos, con la PII de
          // los viajeros, y `orders.provider_raw` se persiste para siempre.
          provider_raw: JSON.stringify(created.providerRaw),
          error_message: summarizeIssues(created.result.issues),
          ...(created.result.outcome === 'FAILED' ? { create_request_key: null } : {}),
        })
        .where('id', '=', intent.id)
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'pending')
        .where('provider_raw', 'is', null)
        .returningAll()
        .executeTakeFirst();

      return row as unknown as OrderRow | undefined;
    });
  }

  /** Un fallo anterior a createOrder es reintentable: cierra localmente y libera la clave. */
  private async failCreateIntentBeforeProviderBestEffort(
    tenantId: string,
    intent: OrderRow,
  ): Promise<void> {
    try {
      await this.db.withTenant(tenantId, async (trx) => {
        await trx
          .updateTable('orders')
          .set({
            status: 'failed',
            provider_raw: JSON.stringify({ phase: 'pre-create', outcome: 'FAILED' }),
            error_message: CREATE_NOT_SENT_MARKER,
            create_request_key: null,
          })
          .where('id', '=', intent.id)
          .where('tenant_id', '=', tenantId)
          .where('status', '=', 'pending')
          .where('provider_raw', 'is', null)
          .where('create_request_key', '=', intent.create_request_key)
          .execute();
      });
    } catch {
      // Si la base cayó, el intent pending conserva la clave y bloquea un segundo create.
    }
  }

  /** Baja el estado a pending sin pisar una transición concurrente; todos los fallos son seguros. */
  private async markCreatePendingBestEffort(
    tenantId: string,
    order: OrderRow,
  ): Promise<OrderRow | undefined> {
    try {
      return await this.db.withTenant(tenantId, async (trx) => {
        const row = await trx
          .updateTable('orders')
          .set({
            status: 'pending',
            error_message: CREATE_PENDING_RECONCILIATION_MARKER,
          })
          .where('id', '=', order.id)
          .where('tenant_id', '=', tenantId)
          .where('status', '=', order.status)
          .returningAll()
          .executeTakeFirst();
        return row as unknown as OrderRow | undefined;
      });
    } catch {
      return undefined;
    }
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
      view = await provider.adapter.retrieveForDisplay(plan.locator, {
        tenantId,
        requestId: order.id,
      });
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
   * Claim durable PRE-WRITE. El índice parcial de la migración 0037 hace que el INSERT sea el
   * CAS entre requests concurrentes; el UPDATE condicional protege además contra una transición
   * de estado ocurrida entre la lectura y el claim. Ambos viven en la misma transacción.
   *
   * `error_message` se conserva intacto: puede contener un error previo que no pertenece a esta
   * cancelación y no se debe perder para fabricar un marcador.
   */
  private async beginCancellationOperation(
    tenantId: string,
    order: OrderRow,
    actorUserId?: string,
  ): Promise<CancellationClaim> {
    this.assertGenericCancellationAllowed(order);
    try {
      return await this.db.withTenant(tenantId, async (trx) => {
        const operation = await trx
          .insertInto('order_operations')
          .values({
            tenant_id: tenantId,
            order_id: order.id,
            type: 'cancel',
            status: 'pending',
            last_error: null,
            result: JSON.stringify({
              status: 'pending',
              ...CANCEL_UNVERIFIED_POLICY,
              priorOrderStatus: order.status,
            }),
            actor_user_id: actorUserId ?? null,
          })
          .returning('id')
          .executeTakeFirst();

        const claimedOrder = await trx
          .updateTable('orders')
          .set({ status: 'pending' as OrderStatus })
          .where('id', '=', order.id)
          .where('status', '=', order.status)
          .returning('id')
          .executeTakeFirst();

        if (!operation || !claimedOrder) {
          throw new ConflictException(
            'Otra ejecución cambió la reserva antes de adquirir el claim de cancelación.',
          );
        }
        return { operationId: operation.id, priorStatus: order.status };
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Ya hay una cancelación pendiente. Hay que consultar y conciliar su estado antes de reenviar el write.',
        );
      }
      throw error;
    }
  }

  /** Completa exactamente el claim adquirido; nunca crea un segundo intento post-write. */
  private async completeCancellationOperation(
    tenantId: string,
    orderId: string,
    claim: CancellationClaim,
    status: 'success' | 'failed',
    lastError: string | null,
    policy: CancelRetryPolicy,
    actorUserId?: string,
    finalOrderStatus?: OrderStatus,
  ): Promise<OrderRow | undefined> {
    return this.db.withTenant(tenantId, async (trx) => {
      const completed = await trx
        .updateTable('order_operations')
        .set({
          status,
          last_error: lastError,
          result: JSON.stringify({
            status,
            ...policy,
            priorOrderStatus: claim.priorStatus,
          }),
          actor_user_id: actorUserId ?? null,
        })
        .where('id', '=', claim.operationId)
        .where('status', '=', 'pending')
        .returning('id')
        .executeTakeFirst();
      if (!completed) {
        throw new ConflictException(
          'Se perdió el claim durable de cancelación. No se puede reenviar el write hasta conciliar.',
        );
      }

      if (finalOrderStatus === undefined) return undefined;
      const order = await trx
        .updateTable('orders')
        .set({ status: finalOrderStatus })
        .where('id', '=', orderId)
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst();
      if (!order) {
        throw new ConflictException(
          'La reserva cambió mientras se completaba la cancelación. Se requiere conciliación.',
        );
      }
      return order as unknown as OrderRow;
    });
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
    claim: CancellationClaim,
    actorUserId?: string,
    /** Compensación selectiva: sólo estos `itemId`. Sin ellos, la cancelación es de la reserva. */
    cancellableItemIds?: readonly string[],
  ): Promise<{ result: OrderCancelResult; order?: OrderRow }> {
    const existing = await this.findById(tenantId, id);
    if (!existing?.provider_order_id) {
      throw new NotFoundException('La reserva no existe o no tiene localizador.');
    }
    if (existing.status === 'cancelled') {
      throw new ConflictException('La reserva ya está cancelada.');
    }

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
      const failure = classifyCancelThrownFailure(err);
      const durableError = failure.reconciliationRequired
        ? 'Cancelación no verificada; requiere conciliación.'
        : failure.retryable
          ? 'Cancelación fallida antes de enviar el write.'
          : 'Cancelación rechazada antes de completarse.';
      await this.completeCancellationOperation(
        tenantId,
        id,
        claim,
        'failed',
        durableError,
        failure,
        actorUserId,
        failure.reconciliationRequired ? undefined : claim.priorStatus,
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
          outcome: failure.outcome,
          retryable: failure.retryable,
          reconciliationRequired: failure.reconciliationRequired,
          ...(cancellableItemIds === undefined
            ? {}
            : { cancellableItemIds: [...cancellableItemIds] }),
        },
      });
      if (failure.reconciliationRequired) {
        await this.emitCancellationEscalation(tenantId, id, existing?.provider, actorUserId, {
          reason: failure.reason,
          threw: true,
        });
      }
      throw err;
    }

    if (!verified) {
      result = {
        ...result,
        success: false,
        error:
          'El proveedor no confirmó si la cancelación se aplicó. No la reintentes: primero hay que consultar y conciliar la reserva.',
      };
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
      await this.emitCancellationEscalation(tenantId, id, existing?.provider, actorUserId);
    }

    const operationPolicy = !verified
      ? CANCEL_UNVERIFIED_POLICY
      : result.success
        ? CANCEL_SUCCESS_POLICY
        : CANCEL_REJECTED_POLICY;

    const finalizedOrder = await this.completeCancellationOperation(
      tenantId,
      id,
      claim,
      result.success ? 'success' : 'failed',
      result.success
        ? null
        : operationPolicy.reconciliationRequired
          ? 'Cancelación no verificada; requiere conciliación.'
          : 'Cancelación rechazada por el proveedor.',
      operationPolicy,
      actorUserId,
      operationPolicy.reconciliationRequired
        ? undefined
        : result.success
          ? 'cancelled'
          : claim.priorStatus,
    );

    if (result.success) {
      return { result, order: finalizedOrder };
    }

    return { result };
  }

  /**
   * Un resultado ambiguo nunca se convierte en un retry. Queda en la cola humana con una señal
   * cerrada y sin copiar texto libre del proveedor al evento durable.
   */
  private async emitCancellationEscalation(
    tenantId: string,
    orderId: string,
    provider: string | undefined,
    actorUserId?: string,
    detail: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.audit.emit({
      eventType: ORDER_EVENTS.escalated,
      tenantId,
      actorUserId,
      aggregateType: 'order',
      aggregateId: orderId,
      payload: {
        provider: provider ?? null,
        reason: 'cancellation-unverified',
        retryForbidden: true,
        reconciliationRequired: true,
        ...detail,
      },
    });
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

  /** Último intento durable: es la compuerta tanto del endpoint como de jobs antiguos. */
  private async latestCancelOperation(
    tenantId: string,
    orderId: string,
  ): Promise<
    { id: string; status: OrderOperationStatus; result: unknown; created_at: Date } | undefined
  > {
    return this.db.withTenant(tenantId, async (trx) => {
      const row = await trx
        .selectFrom('order_operations')
        .select(['id', 'status', 'result', 'created_at'])
        .where('order_id', '=', orderId)
        .where('type', '=', 'cancel')
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row as
        | { id: string; status: OrderOperationStatus; result: unknown; created_at: Date }
        | undefined;
    });
  }

  /**
   * Consume una autorización de retry de forma condicional. Desde este UPDATE y hasta que se
   * persista el nuevo intento, la operación queda UNVERIFIED/no-retryable. Así, si el proceso cae
   * o falla el INSERT posterior, ni otro worker ni el endpoint manual pueden reutilizar el permiso
   * viejo para enviar un segundo write.
   */
  private async claimCancelRetry(
    tenantId: string,
    operationId: string,
    order: OrderRow,
  ): Promise<CancellationClaim | undefined> {
    try {
      return await this.db.withTenant(tenantId, async (trx) => {
        const claimed = await trx
          .updateTable('order_operations')
          .set({
            status: 'pending' as OrderOperationStatus,
            last_error: null,
            result: JSON.stringify({
              status: 'pending',
              ...CANCEL_UNVERIFIED_POLICY,
              priorOrderStatus: order.status,
            }),
          })
          .where('id', '=', operationId)
          .where('status', '=', 'failed')
          .returning('id')
          .executeTakeFirst();
        if (!claimed) return undefined;

        const claimedOrder = await trx
          .updateTable('orders')
          .set({ status: 'pending' as OrderStatus })
          .where('id', '=', order.id)
          .where('status', '=', order.status)
          .returning('id')
          .executeTakeFirst();
        if (!claimedOrder) {
          throw new ConflictException(
            'La reserva cambió antes de adquirir el claim de reintento de cancelación.',
          );
        }
        return { operationId, priorStatus: order.status };
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (isUniqueViolation(error)) {
        throw new ConflictException('Otra ejecución ya tomó la cancelación pendiente.');
      }
      throw error;
    }
  }

  /**
   * Sólo encola cuando la evidencia dice que el write NO empezó (p.ej. falló el get/check previo).
   * Un timeout del endpoint de cancelación se registra como UNVERIFIED y nunca llega a BullMQ.
   */
  private async attemptCancelAndMaybeQueue(
    tenantId: string,
    id: string,
    pnr: string,
    claim: CancellationClaim,
    actorUserId?: string,
  ): Promise<{ result: OrderCancelResult; order?: OrderRow }> {
    try {
      return await this.runCancel(tenantId, id, pnr, claim, actorUserId);
    } catch (err) {
      const policy = classifyCancelThrownFailure(err);
      if (policy.retryable) {
        await this.queue.enqueueCancelRetry({ tenantId, orderId: id, type: 'cancel' });
        throw err;
      }
      throw new ConflictException(
        policy.reconciliationRequired
          ? 'El proveedor no confirmó si la cancelación se aplicó. No la reintentes: primero hay que consultar y conciliar la reserva.'
          : 'La cancelación fue rechazada de forma definitiva y no se reintentará automáticamente.',
      );
    }
  }

  /**
   * Cancelación desde la API. Un intento anterior fallido se continúa por el endpoint de retry,
   * que valida su política durable; el endpoint principal nunca sirve como segundo write ciego.
   */
  async cancelOrder(
    tenantId: string,
    id: string,
    pnr: string,
    actorUserId?: string,
  ): Promise<{ result: OrderCancelResult; order?: OrderRow }> {
    const current = await this.findById(tenantId, id);
    if (!current?.provider_order_id) {
      throw new NotFoundException('La reserva no existe o no tiene localizador.');
    }
    if (current.status === 'cancelled') {
      throw new ConflictException('La reserva ya está cancelada.');
    }
    this.assertGenericCancellationAllowed(current);

    const previous = await this.latestCancelOperation(tenantId, id);
    if (previous) {
      const policy = persistedCancelRetryPolicy(previous.result);
      if (previous.status === 'success' || policy.outcome === 'SUCCEEDED') {
        throw new ConflictException('La reserva ya registra una cancelación exitosa.');
      }
      if (previous.status === 'failed') {
        throw new ConflictException(
          policy.reconciliationRequired
            ? 'La cancelación anterior quedó sin verificar. No se puede enviar otra cancelación hasta conciliar el estado con el proveedor.'
            : policy.retryable
              ? 'La cancelación anterior sólo puede continuarse desde su operación de reintento.'
              : 'La cancelación anterior no es reintentable. Revisá el motivo antes de continuar.',
        );
      }
      if (previous.status === 'pending') {
        throw new ConflictException(
          'Ya hay una cancelación pendiente. Hay que consultar y conciliar antes de reenviar el write.',
        );
      }
    }
    const claim = await this.beginCancellationOperation(tenantId, current, actorUserId);
    return this.attemptCancelAndMaybeQueue(tenantId, id, pnr, claim, actorUserId);
  }

  /**
   * Reintento desde el worker. Jobs viejos o carreras contra un UNVERIFIED terminan sin write.
   * BullMQ sólo recibe de vuelta excepciones que siguen siendo pre-write y por tanto seguras.
   */
  async runCancelById(tenantId: string, orderId: string): Promise<void> {
    const order = await this.findById(tenantId, orderId);
    if (!order?.provider_order_id) return;
    if (order.status === 'cancelled') return;
    if (order.status === 'ticketed') return;
    const previous = await this.latestCancelOperation(tenantId, orderId);
    if (
      !previous ||
      previous.status !== 'failed' ||
      !persistedCancelRetryPolicy(previous.result).retryable
    ) {
      return;
    }
    const claim = await this.claimCancelRetry(tenantId, previous.id, order);
    if (!claim) return;

    try {
      await this.runCancel(tenantId, orderId, order.provider_order_id, claim);
    } catch (err) {
      if (classifyCancelThrownFailure(err).retryable) throw err;
      // El intento alcanzó el write o dejó de ser reintentable: runCancel ya lo registró y, si
      // corresponde, lo escaló. Devolver cierra este job para que BullMQ no haga otro write.
    }
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
    if (order.status === 'ticketed') return;

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

    const previous = await this.latestCancelOperation(tenantId, orderId);
    let claim: CancellationClaim | undefined;
    if (!previous) {
      claim = await this.beginCancellationOperation(tenantId, order, actorUserId);
    } else if (
      previous.status === 'failed' &&
      persistedCancelRetryPolicy(previous.result).retryable
    ) {
      claim = await this.claimCancelRetry(tenantId, previous.id, order);
    }
    if (!claim) return;

    try {
      await this.runCancel(
        tenantId,
        orderId,
        order.provider_order_id,
        claim,
        actorUserId,
        cancellableItemIds,
      );
    } catch (error) {
      const policy = classifyCancelThrownFailure(error);
      if (policy.retryable) throw error;
      if (policy.reconciliationRequired) {
        await this.emitCancellationEscalation(tenantId, orderId, order.provider, actorUserId, {
          reason: 'compensation-unverified',
        });
      }
      // Nunca devolver un error no reintentable a BullMQ: sus `attempts: 5` convertirían un
      // resultado ambiguo en hasta cuatro writes selectivos adicionales.
    }
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
    retryPolicy?: CancelRetryPolicy,
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
            result: JSON.stringify({ status, ...retryPolicy }),
            actor_user_id: actorUserId ?? null,
          })
          .execute();
      });
    } catch (error) {
      // Cancel usa begin/completeCancellationOperation y no debe llegar a este helper. Este guard
      // conserva el fail-closed si una regresión futura intentara registrar el write por aquí.
      if (type === 'cancel') throw error;
      // El resto de operaciones conserva el comportamiento best-effort histórico.
    }
  }

  /** Historial de operaciones de post-venta de una orden (más reciente primero). */
  async listOperations(tenantId: string, orderId: string): Promise<OrderOperationRow[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('order_operations')
        .select(['id', 'type', 'status', 'attempts', 'last_error', 'result', 'created_at'])
        .where('order_id', '=', orderId)
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map((row) => {
        const base = {
          id: row.id,
          type: row.type,
          status: row.status,
          attempts: row.attempts,
          last_error: row.last_error,
          created_at: row.created_at,
        };
        if (row.type !== 'cancel') {
          return {
            ...base,
            retryable: false,
            outcome: null,
            reconciliationRequired: false,
          } as unknown as OrderOperationRow;
        }
        const policy =
          row.status === 'success' ? CANCEL_SUCCESS_POLICY : persistedCancelRetryPolicy(row.result);
        return {
          ...base,
          retryable: row.status === 'failed' && policy.retryable,
          outcome: policy.outcome,
          reconciliationRequired: policy.reconciliationRequired,
        } as unknown as OrderOperationRow;
      });
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
        .select(['type', 'status', 'result'])
        .where('id', '=', opId)
        .where('order_id', '=', orderId)
        .executeTakeFirst(),
    );
    if (!op) throw new NotFoundException('La operación no existe.');
    if (op.type !== 'cancel') {
      throw new BadRequestException('Sólo las cancelaciones se pueden reintentar automáticamente.');
    }
    if (op.status !== 'failed') {
      throw new ConflictException('Sólo se puede reintentar una cancelación fallida.');
    }
    const policy = persistedCancelRetryPolicy(op.result);
    if (!policy.retryable) {
      throw new ConflictException(
        policy.reconciliationRequired
          ? 'La cancelación quedó sin verificar. Hay que conciliarla con el proveedor; está prohibido reenviar el write.'
          : 'Esta cancelación no es reintentable.',
      );
    }

    const latest = await this.latestCancelOperation(tenantId, orderId);
    if (!latest || latest.id !== opId) {
      throw new ConflictException(
        'Esta operación ya no es el último intento de cancelación y no se puede reejecutar.',
      );
    }
    const order = await this.findById(tenantId, orderId);
    if (!order?.provider_order_id) {
      throw new NotFoundException('La reserva no existe o no tiene localizador.');
    }
    if (order.status === 'cancelled') {
      throw new ConflictException('La reserva ya está cancelada.');
    }
    this.assertGenericCancellationAllowed(order);
    const claim = await this.claimCancelRetry(tenantId, opId, order);
    if (!claim) {
      throw new ConflictException('Otra ejecución ya tomó esta operación de cancelación.');
    }
    const { result } = await this.attemptCancelAndMaybeQueue(
      tenantId,
      orderId,
      order.provider_order_id,
      claim,
      actorUserId,
    );
    return { result };
  }

  /**
   * `cancelOrder` elimina una reserva no emitida; no ejecuta VOID ni REFUND de documentos. Una
   * orden emitida debe permanecer intacta hasta que exista un contrato explícito de post-ticketing.
   */
  private assertGenericCancellationAllowed(order: Pick<OrderRow, 'status'>): void {
    if (order.status === 'ticketed') {
      throw new BadRequestException(
        'La reserva está emitida. La cancelación genérica no anula ni reembolsa tiquetes; usa un flujo explícito de VOID/REFUND.',
      );
    }
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
