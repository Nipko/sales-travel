import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseFilters,
} from '@nestjs/common';
import type { ProviderIssue } from '@sales-travel/domain';
import { AgentCarsExceptionFilter } from '../cars/agent-cars-exception.filter.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { ProviderCapabilities, ProviderCapability } from '../providers/provider.types.js';
import { LatamNdcExceptionFilter } from '../providers-latam/latam-ndc-exception.filter.js';
import { SabreExceptionFilter } from '../providers-sabre/sabre-exception.filter.js';
import { TboHotelsExceptionFilter } from '../providers-tbo/tbo-hotels-exception.filter.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { orderConfirmationEmailHtml } from '../mail/templates.js';
import { BrandingService } from '../branding/branding.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { CreateOrderSchema, PayOrderSchema, ReshopOrderSchema } from './dto.js';
import {
  HotelOrderReadsService,
  type PublicHotelOrderTracking,
} from './hotel-order-reads.service.js';
import { OrdersService, type CreateOrderDto, type OrderRow } from './orders.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SalesOperation } from '../auth/decorators/sales-operation.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';

/** Lista blanca HTTP: ningún texto libre ni valor reenviado por el proveedor cruza este borde. */
type PublicProviderIssue = Pick<
  ProviderIssue,
  'severity' | 'category' | 'type' | 'fieldPath' | 'fieldName'
>;

const NO_FLIGHT_CAPABILITIES: ProviderCapabilities = {
  retrieve: false,
  cancel: false,
  pay: false,
  services: false,
  reshop: false,
};

/** AgentCars no tiene registry: su factory es único y hoy sólo expone cancelación dentro de Orders. */
const AGENT_CARS_ORDER_CAPABILITIES: ProviderCapabilities = {
  retrieve: false,
  cancel: true,
  pay: false,
  services: false,
  reshop: false,
};

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
  constructor(
    private readonly orders: OrdersService,
    private readonly db: DatabaseService,
    private readonly mailer: MailerService,
    private readonly branding: BrandingService,
    private readonly activeTenant: ActiveTenantService,
    private readonly registry: FlightProviderRegistry,
    private readonly hotelReads: HotelOrderReadsService,
  ) {}

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
    if (saga.kind === 'settled' && saga.status === 'confirmed') {
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
    const to = this.contactEmail(order);
    if (!to) throw new NotFoundException('La reserva no tiene email de contacto');
    const sent = await this.sendConfirmationEmail(tenantId, order);
    return { sent, to };
  }

  private contactEmail(order: OrderRow): string {
    const ci = order.contact_info;
    if (ci && typeof ci === 'object' && 'email' in ci) {
      const email = (ci as { email?: unknown }).email;
      return typeof email === 'string' ? email : '';
    }
    return '';
  }

  private async sendConfirmationEmail(tenantId: string, order: OrderRow): Promise<boolean> {
    const to = this.contactEmail(order);
    if (!to) return false;
    const mail = orderConfirmationEmailHtml({
      orderNumber: order.order_number,
      pnr: order.provider_order_id,
      searchCriteria: order.search_criteria,
      passengers: order.passengers,
      totalAmount: order.total_amount,
      currency: order.currency,
      brand: await this.branding.resolve(tenantId),
    });
    return this.mailer.sendToTenant(tenantId, {
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
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
    return { orders: rows.map((r) => this.serialize(r, tracking.get(r.id))) };
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
    return { order: this.serialize(row, tracking?.get(row.id)) };
  }

  @Post(':id/retrieve')
  async retrieve(@CurrentUser() userId: string | undefined, @Param('id') id: string) {
    if (!userId) throw new ForbiddenException();
    const tenantId = await this.activeTenant.resolve(userId);
    const row = await this.orders.findById(tenantId, id);
    if (!row?.provider_order_id) throw new NotFoundException('Order not found or has no PNR');
    this.assertSupports(row, 'retrieve');
    // La fila ya se leyó con el tenant fijado: una orden de otra agencia no llega hasta aquí.
    return this.orders.retrieveOrder(tenantId, row, userId);
  }

  /**
   * Rechaza la operación si el proveedor de la reserva no la sabe hacer.
   *
   * Antes esto era `row.provider !== '<un proveedor concreto>'`: cada proveedor nuevo obligaba
   * a acordarse de tocar este `if`, y olvidarlo significaba mandar una operación a un adapter
   * que no la implementa. Ahora lo decide el propio proveedor, declarando sus capacidades.
   */
  private assertSupports(row: OrderRow, capability: ProviderCapability): void {
    if (capability === 'cancel' && row.status === 'ticketed') {
      throw new BadRequestException(
        'La reserva está emitida. Esta cancelación no ejecuta VOID ni REFUND de tiquetes.',
      );
    }
    if (!this.capabilitiesForOrder(row)[capability]) {
      throw new BadRequestException(
        `La operación no está disponible para reservas de proveedor '${row.provider}'.`,
      );
    }
  }

  /** Lo declara el registry de la vertical del proveedor; ninguna vertical se fija aquí. */
  private capabilitiesFor(provider: string): ProviderCapabilities {
    if (provider === 'agent-cars') return AGENT_CARS_ORDER_CAPABILITIES;
    return (
      this.hotelReads.capabilitiesOf(provider) ??
      this.registry.capabilitiesOf(provider) ??
      NO_FLIGHT_CAPABILITIES
    );
  }

  private capabilitiesForOrder(row: Pick<OrderRow, 'provider' | 'status'>): ProviderCapabilities {
    const capabilities = this.capabilitiesFor(row.provider);
    return row.status === 'ticketed' ? { ...capabilities, cancel: false } : capabilities;
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
      providerTracking: tracking ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
