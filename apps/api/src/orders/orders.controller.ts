import {
  Body,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Post,
  ServiceUnavailableException,
  UseFilters,
} from '@nestjs/common';
import type { ProviderIssue } from '@sales-travel/domain';
import { AgentCarsExceptionFilter } from '../cars/agent-cars-exception.filter.js';
import type { ProviderCapabilities, ProviderCapability } from '../providers/provider.types.js';
import { LatamNdcExceptionFilter } from '../providers-latam/latam-ndc-exception.filter.js';
import { SabreExceptionFilter } from '../providers-sabre/sabre-exception.filter.js';
import { TboHotelsExceptionFilter } from '../providers-tbo/tbo-hotels-exception.filter.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { BookingHoldLedger, type OpenWalletHold } from '../portfolios/booking-hold.ledger.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  AddServicesSchema,
  CreateOrderSchema,
  IssueOrderSchema,
  PayOrderSchema,
  RemoveServicesSchema,
  ReshopOrderSchema,
  isSameMinorAmount,
  type AddServicesInput,
  type IssueOrderInput,
  type RemoveServicesInput,
} from './dto.js';
import {
  FlightOrderTrackingStore,
  publicFlightOrderTracking,
  type PublicFlightOrderTracking,
} from './flight-order-tracking.store.js';
import {
  HotelOrderReadsService,
  type PublicHotelOrderTracking,
} from './hotel-order-reads.service.js';
import { OrderCapabilitiesService } from './order-capabilities.service.js';
import { OrderConfirmationService, isTestContent } from './order-confirmation.service.js';
import { OrdersService, type CreateOrderDto, type OrderRow } from './orders.service.js';
import { SERVICES_MESSAGES } from './order-services.plan.js';
import {
  FlightServicesService,
  type ServicesAddReply,
  type ServicesRemoveReply,
} from './order-services.service.js';
import { ISSUE_CLAIM_MESSAGES, FlightTicketIssueService } from './ticket-issue.service.js';
import {
  TICKET_VOID_MESSAGES,
  publicTicketCheck,
  type PublicTicketCheck,
  type TicketVoidReply,
} from './ticket-void.plan.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SalesOperation } from '../auth/decorators/sales-operation.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';

/** Lista blanca HTTP: ningún texto libre ni valor reenviado por el proveedor cruza este borde. */
type PublicProviderIssue = Pick<
  ProviderIssue,
  'severity' | 'category' | 'type' | 'fieldPath' | 'fieldName'
>;

/**
 * Selecciona campos estructurados antes de que la incidencia salga del backend. `message` y
 * `fieldValue` son texto libre: ambos pueden contener PII que Sabre haya copiado del request.
 */
function publicIssue(issue: ProviderIssue): PublicProviderIssue {
  return {
    severity: issue.severity,
    category: issue.category,
    type: issue.type,
    ...(issue.fieldPath === undefined ? {} : { fieldPath: issue.fieldPath }),
    ...(issue.fieldName === undefined ? {} : { fieldName: issue.fieldName }),
  };
}

@Roles(...SELLING_ROLES)
@Controller('orders')
@UseFilters(
  LatamNdcExceptionFilter,
  SabreExceptionFilter,
  AgentCarsExceptionFilter,
  TboHotelsExceptionFilter,
)
export class OrdersController {
  private readonly logger = new Logger(OrdersController.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly activeTenant: ActiveTenantService,
    private readonly hotelReads: HotelOrderReadsService,
    private readonly confirmation: OrderConfirmationService,
    private readonly capabilities: OrderCapabilitiesService,
    /**
     * Localizadores, documentos y plazo de emisión guardados de las órdenes de vuelo (0082).
     * Opcional sólo para los dobles de las suites que no los miran: en la app siempre está.
     */
    @Optional() private readonly flightTracking?: FlightOrderTrackingStore,
    /** La emisión de tiquetes (SAB-08). Opcional por lo mismo: en la app siempre está. */
    @Optional() private readonly ticketIssues?: FlightTicketIssueService,
    /**
     * Qué órdenes tienen saldo retenido en la cartera (0060; SAB-10), para que Reservas avise que
     * cancelar o anular lo libera. Opcional por lo mismo: en la app siempre está.
     */
    @Optional() private readonly walletHolds?: BookingHoldLedger,
    /** Maletas y servicios antes de emitir (SAB-20). Opcional por lo mismo: en la app siempre está. */
    @Optional() private readonly services?: FlightServicesService,
  ) {}

  /** Vuelo = ni hotel ni auto; lo decide `OrderCapabilitiesService`. */
  private isFlightOrder(row: Pick<OrderRow, 'provider'>): boolean {
    return this.capabilities.isFlightOrder(row);
  }

  /**
   * El seguimiento guardado de las órdenes de vuelo pedidas, en una sola lectura. Si la base falla,
   * la lista sale igual sin él (`flightTracking: null`): no se tumba Reservas por un dato que se
   * puede volver a consultar.
   */
  private async flightTrackingOf(
    tenantId: string,
    rows: readonly Pick<OrderRow, 'id' | 'provider'>[],
  ): Promise<Map<string, PublicFlightOrderTracking>> {
    const ids = rows.filter((row) => this.isFlightOrder(row)).map((row) => row.id);
    if (this.flightTracking === undefined || ids.length === 0) return new Map();
    try {
      const records = await this.flightTracking.listTracking(tenantId, ids);
      return new Map([...records].map(([id, record]) => [id, publicFlightOrderTracking(record)]));
    } catch (error) {
      this.logger.warn(
        `flights.tracking.read_failed orders=${ids.length} error=${error instanceof Error ? error.name.slice(0, 64) : 'UnknownError'}`,
      );
      return new Map();
    }
  }

  /**
   * La retención abierta de las órdenes pedidas, en una sola lectura. Si la base falla, la lista
   * sale igual sin ella (`walletHold: null`): el aviso de la cancelación no tumba Reservas.
   */
  private async walletHoldsOf(
    tenantId: string,
    rows: readonly Pick<OrderRow, 'id'>[],
  ): Promise<Map<string, OpenWalletHold>> {
    if (this.walletHolds === undefined || rows.length === 0) return new Map();
    try {
      return await this.walletHolds.openHoldsOf(
        tenantId,
        rows.map((row) => row.id),
      );
    } catch (error) {
      this.logger.warn(
        `orders.wallet_hold.read_failed orders=${rows.length} error=${error instanceof Error ? error.name.slice(0, 64) : 'UnknownError'}`,
      );
      return new Map();
    }
  }

  @SalesOperation()
  @Post()
  async create(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CreateOrderSchema)) body: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);

    const { order, providerResult, saga } = await this.orders.createOrder(
      tenantId,
      userId,
      body,
      idempotencyKey,
    );

    // Confirmación por email al contacto (best-effort: nunca rompe la reserva).
    //
    // La condición es el desenlace del SAGA, no el del proveedor. Un `CONFIRMED` que la lectura
    // de cierre no pudo verificar —o que el proveedor ya da por cancelado— no es una reserva
    // confirmada: es una que todavía no sabemos si existe, y mandarle al pasajero "tu reserva
    // está confirmada" es la mentira que se descubre en el mostrador.
    //
    // Tampoco sale con una reserva de la cuenta de pruebas del proveedor: el pasajero recibiría un
    // localizador que no le sirve para viajar. Si el vendedor quiere mandarla, la reenvía a mano y
    // sale marcada como prueba (`send-confirmation`).
    if (saga.kind === 'settled' && saga.status === 'confirmed' && !isTestContent(order)) {
      void this.sendConfirmationEmail(tenantId, order);
    }

    const createReconciliationRequired =
      saga.kind === 'escalate' &&
      (saga.reason === 'result-persistence-unavailable' ||
        saga.reason === 'post-create-finalization-unavailable');

    return {
      order: this.serialize(order),
      providerResult: {
        outcome: providerResult.outcome,
        pnr: providerResult.pnr,
        orderId: providerResult.orderId,
        items: providerResult.items,
        issues: providerResult.issues.map(publicIssue),
      },
      // Qué pasó con la reserva DESPUÉS de crearla. Sin esto, una compensación en curso o una
      // reserva que necesita revisión humana se ven en la pantalla igual que una confirmada.
      saga: {
        kind: saga.kind,
        status: saga.status,
        ...(saga.kind === 'settled' ? {} : { reason: saga.reason }),
      },
      ...(createReconciliationRequired
        ? {
            orderId: order.id,
            retryForbidden: true as const,
            reconciliationRequired: true as const,
          }
        : {}),
    };
  }

  /** Reenvía la confirmación de reserva por email al contacto. */
  @Post(':id/send-confirmation')
  @HttpCode(200)
  async sendConfirmation(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
  ): Promise<{ sent: boolean; to: string }> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const order = await this.orders.findById(tenantId, id);
    if (!order) throw new NotFoundException();
    const { sent, to } = await this.confirmation.resend(tenantId, order);
    return { sent, to };
  }

  private async sendConfirmationEmail(tenantId: string, order: OrderRow): Promise<boolean> {
    return (await this.confirmation.send(tenantId, order)).sent;
  }

  @Get()
  async list(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const rows = await this.orders.findAll(tenantId);
    const tracking = await this.hotelReads.trackingOf(
      tenantId,
      rows.filter((r) => this.hotelReads.handles(r.provider)).map((r) => r.id),
    );
    const flights = await this.flightTrackingOf(tenantId, rows);
    const holds = await this.walletHoldsOf(tenantId, rows);
    return {
      orders: rows.map((r) =>
        this.serialize(r, tracking.get(r.id), flights.get(r.id), holds.get(r.id)),
      ),
    };
  }

  @Get(':id')
  async findOne(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row) return { order: null };
    const tracking = this.hotelReads.handles(row.provider)
      ? await this.hotelReads.trackingOf(tenantId, [row.id])
      : undefined;
    const flights = await this.flightTrackingOf(tenantId, [row]);
    const holds = await this.walletHoldsOf(tenantId, [row]);
    return {
      order: this.serialize(row, tracking?.get(row.id), flights.get(row.id), holds.get(row.id)),
    };
  }

  /**
   * Consulta la reserva en el proveedor. En un vuelo, la respuesta suma `flightTracking`: lo que
   * quedó guardado tras esta lectura, para que la pantalla refresque la fila sin releer la lista.
   */
  @Post(':id/retrieve')
  async retrieve(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException('Order not found or has no PNR');
    this.assertSupports(row, 'retrieve');
    // La fila ya se leyó con el tenant fijado: una orden de otra agencia no llega hasta aquí.
    const result = await this.orders.retrieveOrder(tenantId, row, userId);
    if (!this.isFlightOrder(row)) return result;
    const flights = await this.flightTrackingOf(tenantId, [row]);
    return { ...result, flightTracking: flights.get(row.id) ?? null };
  }

  /** Rechaza la operación si el proveedor de la reserva no la sabe hacer. */
  private assertSupports(row: OrderRow, capability: ProviderCapability): void {
    this.capabilities.assertSupports(row, capability);
  }

  private capabilitiesForOrder(row: Pick<OrderRow, 'provider' | 'status'>): ProviderCapabilities {
    return this.capabilities.capabilitiesForOrder(row);
  }

  @Post(':id/cancel')
  async cancel(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException('Order not found or has no PNR');
    this.assertSupports(row, 'cancel');
    const { result } = await this.orders.cancelOrder(tenantId, id, row.provider_order_id, userId);
    return result;
  }

  /**
   * La penalidad estimada de cancelar una reserva de hotel, para mostrarla antes de confirmar
   * (docs/tbo/08 RF-25; D-TBO-26 A). No llama al proveedor: sale del snapshot del PreBook que la
   * orden guardó, y es nuestra estimación, no un dato del proveedor.
   */
  @Get(':id/cancellation-estimate')
  async cancellationEstimate(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException('Order not found or has no PNR');
    this.assertSupports(row, 'cancel');
    return { orderId: row.id, estimate: this.orders.cancellationEstimate(row) };
  }

  /** Historial durable de operaciones de post-venta de la reserva. */
  @Get(':id/operations')
  async operations(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const operations = await this.orders.listOperations(tenantId, id);
    return { operations };
  }

  /** Reintenta una operación fallida (hoy: cancelación). */
  @Post(':id/operations/:opId/retry')
  async retryOperation(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Param('opId') opId: string,
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException('Order not found or has no PNR');
    this.assertSupports(row, 'cancel');
    const { result } = await this.orders.retryOperation(tenantId, id, opId, userId);
    return result;
  }

  /**
   * Pide la emisión de los tiquetes de una reserva confirmada. Responde 202 con la operación: la
   * emisión corre en la cola de post-venta y la pantalla la sigue por `GET :id/operations`.
   *
   * Es VENTA (`@SalesOperation`): compromete el dinero de la reserva, y el superadmin no vende.
   * Emite cualquiera que vende (SAB-FD-3 A). Sin tarjeta: la forma de pago es la de la cuenta.
   */
  @SalesOperation()
  @Roles(...SELLING_ROLES)
  @Post(':id/issue')
  @HttpCode(202)
  async issue(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(IssueOrderSchema)) body: IssueOrderInput,
  ): Promise<{ operationId: string; status: 'pending' }> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    // En español: el diálogo de emisión muestra este texto tal cual.
    if (!row?.provider_order_id) throw new NotFoundException(ISSUE_CLAIM_MESSAGES['not-found']);
    if (row.status !== 'confirmed') {
      throw new ConflictException(ISSUE_CLAIM_MESSAGES['not-confirmed']);
    }
    this.assertSupports(row, 'issue');
    // Lo que el vendedor vio al confirmar es lo que se emite: si la orden cambió, se vuelve a mirar.
    if (
      !isSameMinorAmount(row.total_amount, body.expectedTotalMinor) ||
      row.currency !== body.currency
    ) {
      throw new ConflictException(
        'El total cambió desde que abriste la reserva. Vuelve a consultarla antes de emitir.',
      );
    }
    if (this.ticketIssues === undefined) {
      throw new ServiceUnavailableException('La emisión de tiquetes no está disponible.');
    }
    return this.ticketIssues.requestIssue(tenantId, row, userId);
  }

  /**
   * Las condiciones de los tiquetes de una reserva emitida, leídas en vivo del proveedor (SAB-09):
   * si se pueden anular sin costo y hasta cuándo, si son reembolsables. Nunca se calcula ni se
   * guarda: la ventana de anulación cambia con el reloj, y por eso tampoco se cachea.
   *
   * Post-venta de lectura: no es `@SalesOperation`, y la plataforma la ve como la ve la agencia.
   */
  @Get(':id/ticket-check')
  @Header('Cache-Control', 'no-store')
  async ticketCheck(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
  ): Promise<PublicTicketCheck> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException(TICKET_VOID_MESSAGES.notFound);
    if (row.status !== 'ticketed') {
      throw new ConflictException(TICKET_VOID_MESSAGES.notTicketedCheck);
    }
    this.assertSupports(row, 'ticketCheck');
    const check = await this.orders.checkTickets(tenantId, row);
    return publicTicketCheck(check, new Date());
  }

  /**
   * Anula (VOID) los tiquetes de una reserva emitida, que queda cancelada (SAB-09). Antes consulta
   * en vivo las condiciones: si el proveedor no dice que se puede anular sin costo, 409 sin tocar
   * nada. Corre en el request, con el mismo claim durable que cualquier cancelación, y no se
   * reintenta sola.
   *
   * No es `@SalesOperation`: deshace lo vendido, como cancelar. Anulan los roles que venden
   * (SAB-FD-3 A).
   */
  @Roles(...SELLING_ROLES)
  @Post(':id/void')
  @HttpCode(200)
  async voidTickets(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
  ): Promise<TicketVoidReply> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException(TICKET_VOID_MESSAGES.notFound);
    if (row.status !== 'ticketed') throw new ConflictException(TICKET_VOID_MESSAGES.notTicketed);
    this.assertSupports(row, 'void');
    return this.orders.voidTickets(tenantId, row, userId);
  }

  @SalesOperation()
  @Post(':id/services')
  async listServices(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException('Order not found or has no PNR');
    this.assertSupports(row, 'services');
    return this.orders.listServices(tenantId, row);
  }

  /**
   * Agrega maletas y servicios a una reserva confirmada y sin emitir (SAB-20). Corre en el request:
   * claim durable (0083), total y retención de cartera ajustados ANTES de llamar al proveedor, UNA
   * llamada y el desenlace por línea. Lo agregado se emite como EMD junto con el tiquete, con la
   * forma de pago de la cuenta (sin tarjeta).
   *
   * Es VENTA (`@SalesOperation`): compromete dinero, y el superadmin no vende. Lo pueden pedir los
   * roles que venden, como emitir (SAB-FD-3 A).
   */
  @SalesOperation()
  @Roles(...SELLING_ROLES)
  @Post(':id/services/add')
  @HttpCode(200)
  async addServices(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddServicesSchema)) body: AddServicesInput,
  ): Promise<ServicesAddReply> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException(SERVICES_MESSAGES.notFound);
    if (row.status !== 'confirmed') throw new ConflictException(SERVICES_MESSAGES.notConfirmed);
    this.assertSupports(row, 'addServices');
    if (this.services === undefined) {
      throw new ServiceUnavailableException(SERVICES_MESSAGES.unavailable);
    }
    return this.services.requestAdd(tenantId, row, userId, body);
  }

  /**
   * Quita servicios agregados mientras la reserva no se emita (SAB-20), y libera su parte de la
   * retención de cartera. No es `@SalesOperation`: deshace lo vendido, como cancelar o anular.
   */
  @Roles(...SELLING_ROLES)
  @Post(':id/services/remove')
  @HttpCode(200)
  async removeServices(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RemoveServicesSchema)) body: RemoveServicesInput,
  ): Promise<ServicesRemoveReply> {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException(SERVICES_MESSAGES.notFound);
    if (row.status !== 'confirmed') throw new ConflictException(SERVICES_MESSAGES.notConfirmed);
    this.assertSupports(row, 'addServices');
    if (this.services === undefined) {
      throw new ServiceUnavailableException(SERVICES_MESSAGES.unavailable);
    }
    return this.services.requestRemove(tenantId, row, userId, body);
  }

  @SalesOperation()
  @Post(':id/reshop')
  async reshopOrder(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReshopOrderSchema))
    body: { paidOrderId: string; bnplOrderId: string; ticketDocIds: string[] },
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException('Order not found or has no PNR');
    this.assertSupports(row, 'reshop');
    return this.orders.reshopOrder(tenantId, row, body, userId);
  }

  @SalesOperation()
  @Post(':id/pay')
  async payOrder(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PayOrderSchema)) body: { payment: unknown },
  ) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException('Order not found or has no PNR');
    this.assertSupports(row, 'pay');
    return this.orders.payOrder(tenantId, id, row, body.payment as never, userId);
  }

  /**
   * `providerTracking`: el seguimiento de una orden de hotel (subestado, estado del proveedor y
   * HCN), sólo códigos y localizadores. `null` en las demás verticales y en una orden de hotel que
   * todavía no tiene lecturas.
   *
   * `flightTracking`: lo guardado de una orden de vuelo (0082): localizadores de la aerolínea,
   * tiquetes con su estado y plazo de emisión. `null` en las demás verticales y en un vuelo que
   * todavía no tiene lecturas guardadas.
   *
   * `walletHold`: la retención de cartera abierta de la orden (`held` o `captured`), o `null` si no
   * tiene una que liberar: sin retención, exenta por la cuenta propia, ya liberada o en conflicto.
   */
  private serialize(
    row: {
      id: string;
      tenant_id: string;
      user_id: string;
      quotation_id: string | null;
      provider: string;
      provider_order_id: string | null;
      status: string;
      search_criteria: unknown;
      selected_offer: unknown;
      passengers: unknown;
      contact_info: unknown;
      total_amount: number;
      currency: string;
      order_number: number;
      error_message: string | null;
      created_at: Date;
      updated_at: Date;
    },
    tracking?: PublicHotelOrderTracking,
    flightTracking?: PublicFlightOrderTracking,
    walletHold?: OpenWalletHold,
  ) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      quotationId: row.quotation_id,
      provider: row.provider,
      capabilities: this.capabilitiesForOrder(row as Pick<OrderRow, 'provider' | 'status'>),
      pnr: row.provider_order_id,
      status: row.status,
      searchCriteria: row.search_criteria,
      selectedOffer: row.selected_offer,
      passengers: row.passengers,
      contactInfo: row.contact_info,
      totalAmount: row.total_amount,
      currency: row.currency,
      orderNumber: row.order_number,
      errorMessage: row.error_message,
      // Reserva de la cuenta de pruebas del proveedor: la pantalla la marca para que nadie la
      // gestione como una venta real.
      testContent: isTestContent(row),
      providerTracking: tracking ?? null,
      flightTracking: flightTracking ?? null,
      walletHold: walletHold ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
