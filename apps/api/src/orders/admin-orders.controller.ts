import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import type { AdminOrderDetail, AdminOrdersPage } from './admin-order-view.js';
import { AdminOrdersQuerySchema, type AdminOrdersQuery } from './admin-orders.schemas.js';
import { AdminOrdersService } from './admin-orders.service.js';

/**
 * Plataforma → Reservas de la red: buscar cualquier reserva de cualquier nodo y abrir su ficha.
 *
 * Sólo el superadmin, como el resto del panel de la plataforma: `@Roles` deja fuera a los roles de
 * nodo y {@link SuperadminGuard} a `platform_admin`. Sólo lee y no es venta (nunca
 * `@SalesOperation`): el superadmin revisa las reservas de la red pero no vende.
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  @Get()
  async list(
    @CurrentUser() userId: string,
    @Query(new ZodValidationPipe(AdminOrdersQuerySchema)) query: AdminOrdersQuery,
  ): Promise<AdminOrdersPage> {
    return this.orders.search(userId, query);
  }

  @Get(':id')
  async detail(
    @CurrentUser() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AdminOrderDetail> {
    return this.orders.detail(userId, id);
  }
}
