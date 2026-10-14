import { Controller, Get, HttpCode, Param, Post, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { TenantIdParamSchema, UuidParamSchema } from './dto.js';
import { MemberDetailService, type MemberDetail } from './member-detail.service.js';

/**
 * La ficha de un usuario: perfil, seguridad, nodos y roles, sesiones abiertas e invitaciones, y
 * cerrar una sesión puntual. Desde Equipo (`/tenants/:id/members/:userId`), para quien administra
 * el nodo; desde Plataforma → Usuarios (`/admin/users/:userId`), para el superadmin. Quién ve qué:
 * MemberDetailService.
 *
 * `/admin/users/:userId` no choca con lo de AdminController: `GET /admin/users` (el directorio),
 * `GET /admin/users/:userId/impact` y `PATCH /admin/users/status` son otras rutas o métodos, y un
 * `GET /admin/users/status` no pasa el UUID del parámetro (400).
 */
@Roles(...AGENCY_ADMIN_ROLES)
@Controller()
export class MemberDetailController {
  constructor(private readonly detail: MemberDetailService) {}

  @Get('tenants/:id/members/:userId')
  async memberDetail(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('userId', new ZodValidationPipe(UuidParamSchema)) targetUserId: string,
  ): Promise<MemberDetail> {
    if (!userId) throw new UnauthorizedException();
    return this.detail.detail(userId, tenantId, targetUserId);
  }

  @Get('admin/users/:userId')
  async platformUserDetail(
    @CurrentUser() userId: string | undefined,
    @Param('userId', new ZodValidationPipe(UuidParamSchema)) targetUserId: string,
  ): Promise<MemberDetail> {
    if (!userId) throw new UnauthorizedException();
    return this.detail.platformDetail(userId, targetUserId);
  }

  /** Cierra UNA de sus sesiones abiertas en el subárbol del nodo. Las demás siguen. Auditado. */
  @Post('tenants/:id/members/:userId/sessions/:sessionId/revoke')
  @HttpCode(200)
  async revokeSession(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('userId', new ZodValidationPipe(UuidParamSchema)) targetUserId: string,
    @Param('sessionId', new ZodValidationPipe(UuidParamSchema)) sessionId: string,
  ): Promise<{ ok: true }> {
    if (!userId) throw new UnauthorizedException();
    return this.detail.revokeSession(userId, tenantId, targetUserId, sessionId);
  }
}
