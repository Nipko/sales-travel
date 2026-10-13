import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES, canGrantRole } from '../auth/roles.js';
import { NetworkService } from '../network/network.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  AcceptInvitationSchema,
  InviteUserSchema,
  TenantIdParamSchema,
  UuidParamSchema,
  type AcceptInvitationDto,
  type InviteUserDto,
} from './dto.js';
import { InvitationsService } from './invitations.service.js';

@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly network: NetworkService,
  ) {}

  /**
   * Con throttle: cada invitación manda un correo desde la cuenta del nodo, y un admin (o una sesión
   * robada) no puede usarla para llenar buzones ajenos.
   */
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Roles(...AGENCY_ADMIN_ROLES)
  @Post()
  async invite(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(InviteUserSchema)) body: InviteUserDto,
  ) {
    if (!userId) throw new UnauthorizedException();

    // El rol con que el actor administra el nodo DESTINO (G-06), no el de su tenant activo:
    // quien es consolidator_admin en su red y admin en otra no invita tenant_admins en la segunda.
    const actorRole = await this.network.roleOver(userId, body.tenantId);
    if (actorRole === undefined) {
      throw new ForbiddenException('Ese nodo no está en tu red.');
    }
    // No se puede invitar a alguien con rango igual o superior al propio.
    if (!canGrantRole(actorRole, body.role)) {
      throw new ForbiddenException('no puedes invitar con un rol igual o superior al tuyo');
    }

    return this.invitations.invite({
      actorUserId: userId,
      tenantId: body.tenantId,
      email: body.email,
      role: body.role,
    });
  }

  @Roles(...AGENCY_ADMIN_ROLES)
  @Get()
  async list(
    @CurrentUser() userId: string | undefined,
    @Query('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
  ) {
    if (!userId) throw new UnauthorizedException();

    const superadmin = await this.network.isSuperadmin(userId);
    if (!superadmin && !(await this.network.canManageTenant(userId, tenantId))) {
      throw new ForbiddenException('Ese nodo no está en tu red.');
    }
    return { invitations: await this.invitations.listPending(userId, tenantId) };
  }

  /**
   * Revoca una invitación pendiente. Como reenviar, el rango se mide sobre el nodo de la invitación:
   * el servicio lo compara con su rol.
   */
  @Roles(...AGENCY_ADMIN_ROLES)
  @Post(':id/revoke')
  async revoke(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(UuidParamSchema)) id: string,
    @Query('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
  ) {
    if (!userId) throw new UnauthorizedException();

    const actorRole = await this.network.roleOver(userId, tenantId);
    if (actorRole === undefined) {
      throw new ForbiddenException('Ese nodo no está en tu red.');
    }
    return this.invitations.revoke(userId, actorRole, tenantId, id);
  }

  /**
   * Reenvía una invitación pendiente con un enlace nuevo (el anterior deja de valer). El rango se
   * mide sobre el nodo de la invitación, como al invitar: el servicio lo compara con su rol.
   */
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Roles(...AGENCY_ADMIN_ROLES)
  @Post(':id/resend')
  async resend(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(UuidParamSchema)) id: string,
    @Query('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
  ) {
    if (!userId) throw new UnauthorizedException();

    const actorRole = await this.network.roleOver(userId, tenantId);
    if (actorRole === undefined) {
      throw new ForbiddenException('Ese nodo no está en tu red.');
    }
    return this.invitations.resend({ actorUserId: userId, actorRole, tenantId, invitationId: id });
  }

  /**
   * Canje de la invitación: el invitado elige su propia contraseña. Público por
   * definición —todavía no tiene cuenta— y con throttle, porque acepta un token.
   */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Public()
  @Post('accept')
  accept(@Body(new ZodValidationPipe(AcceptInvitationSchema)) body: AcceptInvitationDto) {
    return this.invitations.accept(body);
  }
}
