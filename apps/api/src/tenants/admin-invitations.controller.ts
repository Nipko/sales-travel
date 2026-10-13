import { Controller, Get, Query, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  AdminInvitationsService,
  type PlatformInvitationsPage,
} from './admin-invitations.service.js';
import { ListPlatformInvitationsQuerySchema, type ListPlatformInvitationsQuery } from './dto.js';

/**
 * Las invitaciones sin aceptar de toda la red (Plataforma → Usuarios → Invitaciones). Sólo
 * superadmin: lo decide AdminInvitationsService.list antes de leer nada. Aparte de
 * InvitationsController, que es la de un nodo y la del canje; reenviar y revocar siguen allá.
 *
 * `GET /admin/invitations` no choca con AdminController (`/admin/...`): no tiene ninguna ruta
 * `invitations`.
 */
@Roles(...AGENCY_ADMIN_ROLES)
@Controller('admin/invitations')
export class AdminInvitationsController {
  constructor(private readonly invitations: AdminInvitationsService) {}

  @Get()
  async list(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(ListPlatformInvitationsQuerySchema))
    query: ListPlatformInvitationsQuery,
  ): Promise<PlatformInvitationsPage> {
    if (!userId) throw new UnauthorizedException();
    return this.invitations.list(userId, query);
  }
}
