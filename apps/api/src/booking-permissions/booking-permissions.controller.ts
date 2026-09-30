import { Body, Controller, Get, Param, Put, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  BookingPermissionsTenantIdSchema,
  UpdateBookingPermissionsSchema,
  type UpdateBookingPermissionsDto,
} from './booking-permissions.schemas.js';
import {
  BookingPermissionsService,
  type FinancedBookingPermissionsView,
} from './booking-permissions.service.js';

/**
 * Los permisos de reserva de un nodo, que fija quien lo financia: el superadmin desde Gestión de
 * Agencias (cualquier nodo) y un consolidador o una agencia desde Mi Red (sus agencias o sus
 * sub-agencias), junto a Carteras.
 *
 * `@Roles` sólo deja fuera a quien no administra ningún nodo; si quien actúa financia a ESE nodo lo
 * decide la base (`can_finance_tenant`) en el servicio, y otra vez la RLS al escribir.
 */
@Roles(...AGENCY_ADMIN_ROLES)
@Controller('tenants/:tenantId/booking-permissions')
export class BookingPermissionsController {
  constructor(private readonly permissions: BookingPermissionsService) {}

  @Get()
  async view(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(BookingPermissionsTenantIdSchema)) tenantId: string,
  ): Promise<FinancedBookingPermissionsView> {
    return this.permissions.financedView(actor(userId), tenantId);
  }

  @Put()
  async update(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(BookingPermissionsTenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(UpdateBookingPermissionsSchema)) body: UpdateBookingPermissionsDto,
  ): Promise<FinancedBookingPermissionsView> {
    return this.permissions.setNonRefundableRates(actor(userId), tenantId, body);
  }
}

function actor(userId: string | undefined): string {
  if (!userId) throw new UnauthorizedException();
  return userId;
}
