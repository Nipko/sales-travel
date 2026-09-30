import { Controller, HttpCode, Param, Post, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { TenantIdParamSchema, UuidParamSchema } from './dto.js';
import { MemberSupportService } from './member-support.service.js';

/**
 * Acciones de soporte sobre un miembro desde Equipo. Quién puede: ver assertCanSupportMember
 * (administrar todos sus nodos y superarlo en rango, o superadmin; nunca sobre uno mismo).
 */
@Roles(...AGENCY_ADMIN_ROLES)
@Controller('tenants')
export class MemberSupportController {
  constructor(private readonly support: MemberSupportService) {}

  /** Restablece su 2FA: sin factor, sin códigos, sin equipos de confianza y sin sesiones. */
  @Post(':id/members/:userId/reset-mfa')
  @HttpCode(200)
  async resetMfa(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('userId', new ZodValidationPipe(UuidParamSchema)) targetUserId: string,
  ): Promise<{ ok: true }> {
    if (!userId) throw new UnauthorizedException();
    return this.support.resetMfa(userId, tenantId, targetUserId);
  }

  /** Cierra todas sus sesiones sin tocarle la membership. */
  @Post(':id/members/:userId/revoke-sessions')
  @HttpCode(200)
  async revokeSessions(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('userId', new ZodValidationPipe(UuidParamSchema)) targetUserId: string,
  ): Promise<{ revoked: number }> {
    if (!userId) throw new UnauthorizedException();
    return this.support.revokeSessions(userId, tenantId, targetUserId);
  }
}
