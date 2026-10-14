import { Controller, HttpCode, Param, Post, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequireRecentMfa } from '../auth/decorators/require-recent-mfa.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { TenantIdParamSchema, UuidParamSchema } from './dto.js';
import { MemberSupportService } from './member-support.service.js';

/**
 * Acciones de soporte sobre un miembro desde Equipo. Quién puede: ver assertCanSupportMember
 * (administrar todos sus nodos y superarlo en rango, o superadmin; nunca sobre uno mismo).
 *
 * Restablecer su 2FA y forzar el cambio de contraseña le abren la puerta de la cuenta a otro: piden
 * el 2FA de los últimos minutos (`@RequireRecentMfa`, USR-13). Enviarle el enlace, sólo si es admin
 * (lo decide el servicio). Desbloquear y cerrar sesiones son el soporte de todos los días: no.
 */
@Roles(...AGENCY_ADMIN_ROLES)
@Controller('tenants')
export class MemberSupportController {
  constructor(private readonly support: MemberSupportService) {}

  /** Restablece su 2FA: sin factor, sin códigos, sin equipos de confianza y sin sesiones. */
  @RequireRecentMfa()
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

  /**
   * Le envía un enlace de un solo uso para que elija una contraseña nueva. La respuesta dice si el
   * correo salió y cuándo vence el enlace; nunca trae el enlace ni el token.
   */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post(':id/members/:userId/send-password-reset')
  @HttpCode(200)
  async sendPasswordReset(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('userId', new ZodValidationPipe(UuidParamSchema)) targetUserId: string,
  ): Promise<{ sent: boolean; expiresAt: string }> {
    if (!userId) throw new UnauthorizedException();
    return this.support.sendPasswordReset(userId, tenantId, targetUserId);
  }

  /**
   * Lo obliga a elegir una contraseña nueva antes de volver a ingresar: cierra sus sesiones y le
   * envía el enlace. La respuesta dice si el correo salió y cuántas sesiones se cerraron; nunca trae
   * el enlace ni el token.
   */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @RequireRecentMfa()
  @Post(':id/members/:userId/require-password-reset')
  @HttpCode(200)
  async requirePasswordReset(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('userId', new ZodValidationPipe(UuidParamSchema)) targetUserId: string,
  ): Promise<{ sent: boolean; revokedSessions: number }> {
    if (!userId) throw new UnauthorizedException();
    return this.support.requirePasswordReset(userId, tenantId, targetUserId);
  }

  /** Levanta el bloqueo por intentos fallidos. No toca contraseña, 2FA ni estado. */
  @Post(':id/members/:userId/unlock')
  @HttpCode(200)
  async unlock(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('userId', new ZodValidationPipe(UuidParamSchema)) targetUserId: string,
  ): Promise<{ unlocked: boolean }> {
    if (!userId) throw new UnauthorizedException();
    return this.support.unlock(userId, tenantId, targetUserId);
  }
}
