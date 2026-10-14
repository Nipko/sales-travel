import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { OrderCancelResult } from '@sales-travel/domain';
import type { Response } from 'express';
import { EXPORT_ROWS_HEADER } from '../audit/admin-audit.controller.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequireRecentMfa } from '../auth/decorators/require-recent-mfa.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { AgentCarsExceptionFilter } from '../cars/agent-cars-exception.filter.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { LatamNdcExceptionFilter } from '../providers-latam/latam-ndc-exception.filter.js';
import { SabreExceptionFilter } from '../providers-sabre/sabre-exception.filter.js';
import { TboHotelsExceptionFilter } from '../providers-tbo/tbo-hotels-exception.filter.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  AdminOrderActionsService,
  type AdminCancellationEstimate,
  type AdminOrderRetrieveResult,
} from './admin-order-actions.service.js';
import type { AdminOrderDetail, AdminOrdersPage } from './admin-order-view.js';
import {
  AdminOrderActionSchema,
  AdminOrderCancelSchema,
  AdminOrdersExportQuerySchema,
  AdminOrdersQuerySchema,
  type AdminOrderActionDto,
  type AdminOrderCancelDto,
  type AdminOrdersExportQuery,
  type AdminOrdersQuery,
} from './admin-orders.schemas.js';
import { AdminOrdersService } from './admin-orders.service.js';
import type { OrderConfirmationSent } from './order-confirmation.service.js';

/**
 * Plataforma → Reservas de la red: buscar cualquier reserva de cualquier nodo, exportar la vista
 * filtrada a CSV, abrir su ficha y, desde ella, la post-venta que la agencia haría (FD-1 C): reenviar
 * la confirmación, consultar al proveedor, reintentar una cancelación fallida y cancelar en su nombre.
 *
 * Sólo el superadmin, como el resto del panel de la plataforma: `@Roles` deja fuera a los roles de
 * nodo y {@link SuperadminGuard} a `platform_admin`. Ninguna ruta es venta (nunca
 * `@SalesOperation`): el superadmin no vende, y pagar, emitir, servicios o recotizar no existen
 * aquí. Los filtros de los proveedores traducen sus errores como en Reservas de la agencia.
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/orders')
@UseFilters(
  LatamNdcExceptionFilter,
  SabreExceptionFilter,
  AgentCarsExceptionFilter,
  TboHotelsExceptionFilter,
)
export class AdminOrdersController {
  constructor(
    private readonly orders: AdminOrdersService,
    private readonly actions: AdminOrderActionsService,
  ) {}

  @Get()
  async list(
    @CurrentUser() userId: string,
    @Query(new ZodValidationPipe(AdminOrdersQuerySchema)) query: AdminOrdersQuery,
  ): Promise<AdminOrdersPage> {
    return this.orders.search(userId, query);
  }

  /**
   * La vista filtrada de la lista, entera, en CSV: hasta 5.000 reservas (más, 422 EXPORT_TOO_LARGE).
   * `X-Export-Rows` dice cuántas. Exportar es de alto impacto (founder D1 = C): pide el 2FA de los
   * últimos 10 minutos y queda en la auditoría (`platform.orders.exported`).
   *
   * Va antes de `:id`: Express prueba las rutas en orden y `export` no es un UUID.
   */
  @Get('export')
  @RequireRecentMfa()
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async export(
    @CurrentUser() userId: string,
    @Query(new ZodValidationPipe(AdminOrdersExportQuerySchema)) query: AdminOrdersExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const out = await this.orders.exportCsv(userId, query);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader(EXPORT_ROWS_HEADER, String(out.rows));
    return out.csv;
  }

  @Get(':id')
  async detail(
    @CurrentUser() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AdminOrderDetail> {
    return this.orders.detail(userId, id);
  }

  /** Reenvía la confirmación al contacto, con la marca y el correo del nodo de la reserva. */
  @Post(':id/send-confirmation')
  @HttpCode(200)
  async sendConfirmation(
    @CurrentUser() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(AdminOrderActionSchema)) body: AdminOrderActionDto,
  ): Promise<OrderConfirmationSent> {
    return this.actions.sendConfirmation(userId, id, body);
  }

  /** Consulta el estado al proveedor y devuelve la ficha actualizada. */
  @Post(':id/retrieve')
  @HttpCode(200)
  async retrieve(
    @CurrentUser() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(AdminOrderActionSchema)) body: AdminOrderActionDto,
  ): Promise<AdminOrderRetrieveResult> {
    return this.actions.retrieve(userId, id, body);
  }

  /** Reintenta una cancelación que la agencia ya pidió y falló. */
  @Post(':id/operations/:opId/retry')
  @HttpCode(200)
  async retry(
    @CurrentUser() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('opId', new ParseUUIDPipe()) opId: string,
    @Body(new ZodValidationPipe(AdminOrderActionSchema)) body: AdminOrderActionDto,
  ): Promise<OrderCancelResult> {
    return this.actions.retryCancellation(userId, id, opId, body);
  }

  /** La penalidad estimada de cancelar una reserva de hotel. Sólo lee. */
  @Get(':id/cancellation-estimate')
  async cancellationEstimate(
    @CurrentUser() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AdminCancellationEstimate> {
    return this.actions.cancellationEstimate(userId, id);
  }

  /** Cancela la reserva en nombre de la agencia, con el motivo y su número escrito para confirmar. */
  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(
    @CurrentUser() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(AdminOrderCancelSchema)) body: AdminOrderCancelDto,
  ): Promise<OrderCancelResult> {
    return this.actions.cancel(userId, id, body);
  }
}
