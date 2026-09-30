import { Controller, Get, HttpCode, Param, Post, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { TenantIdParamSchema, UuidParamSchema } from './dto.js';
import type { SeatsView } from './seats.policy.js';
import { SeatsService } from './seats.service.js';

/**
 * Puestos simultáneos de un nodo para su admin (pantalla Equipo). Fijar el cupo es del superadmin:
 * `PATCH /admin/tenants/:id/seats`, en AdminController.
 */
@Roles(...AGENCY_ADMIN_ROLES)
@Controller('tenants')
export class SeatsController {
  constructor(private readonly seats: SeatsService) {}

  /** Cupo, uso, inactividad efectiva y quién ocupa un puesto en el subárbol del nodo. */
  @Get(':id/seats')
  async view(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
  ): Promise<SeatsView> {
    if (!userId) throw new UnauthorizedException();
    return this.seats.view(userId, tenantId);
  }

  /** Desconecta a alguien para liberar su puesto. Auditado. */
  @Post(':id/seats/sessions/:sessionId/release')
  @HttpCode(200)
  async release(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('sessionId', new ZodValidationPipe(UuidParamSchema)) sessionId: string,
  ): Promise<{ ok: true }> {
    if (!userId) throw new UnauthorizedException();
    return this.seats.release(userId, tenantId, sessionId);
  }
}
