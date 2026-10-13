import { Controller, Get, Param, Query, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { NetworkService } from '../network/network.service.js';
import { TenantIdParamSchema, UuidParamSchema } from '../tenants/dto.js';
import { SuperadminOnlyError } from '../tenants/member-detail.errors.js';
import { UserNotFoundError } from '../tenants/platform-users.errors.js';
import { MemberNotFoundError, TenantNotManagedError } from '../tenants/tenant-admin.policy.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { decodeAuditCursor, UserAuditQuerySchema, type UserAuditQuery } from './audit.schemas.js';
import { AuditService, type AuditPage, type AuditPageOptions } from './audit.service.js';

function pageOptions(query: UserAuditQuery): AuditPageOptions {
  return {
    before: query.before === undefined ? undefined : decodeAuditCursor(query.before),
    limit: query.limit,
  };
}

/**
 * El historial de una persona: qué hizo y qué le hicieron. Desde Equipo
 * (`/tenants/:id/members/:userId/audit`), para quien administra el nodo, acotado a su subárbol;
 * desde Plataforma → Usuarios (`/admin/users/:userId/audit`), para el superadmin, con los eventos
 * sin nodo (ingresos fallidos, pedidos de restablecer la contraseña).
 *
 * El orden importa, como en la ficha (MemberDetailService): primero si el actor administra el nodo
 * (403 sin leer nada de la persona), después si la persona tiene una membership en ese subárbol
 * (404). Así quien no administra el nodo no averigua si alguien pertenece a él.
 *
 * Las rutas no chocan con las de la ficha ni con las de AdminController: `GET .../:userId` y
 * `GET /admin/users/:userId/impact` son otras.
 */
@Roles(...AGENCY_ADMIN_ROLES)
@Controller()
export class UserAuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly network: NetworkService,
  ) {}

  @Get('tenants/:id/members/:userId/audit')
  async memberAudit(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Param('userId', new ZodValidationPipe(UuidParamSchema)) targetUserId: string,
    @Query(new ZodValidationPipe(UserAuditQuerySchema)) query: UserAuditQuery,
  ): Promise<AuditPage> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.canManageTenant(userId, tenantId))) throw new TenantNotManagedError();
    const page = await this.audit.userAuditTrail(
      userId,
      tenantId,
      targetUserId,
      pageOptions(query),
    );
    if (page === undefined) throw new MemberNotFoundError();
    return page;
  }

  @Get('admin/users/:userId/audit')
  async platformUserAudit(
    @CurrentUser() userId: string | undefined,
    @Param('userId', new ZodValidationPipe(UuidParamSchema)) targetUserId: string,
    @Query(new ZodValidationPipe(UserAuditQuerySchema)) query: UserAuditQuery,
  ): Promise<AuditPage> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.isSuperadmin(userId))) throw new SuperadminOnlyError();
    const page = await this.audit.platformUserAuditTrail(userId, targetUserId, pageOptions(query));
    if (page === undefined) throw new UserNotFoundError();
    return page;
  }
}
