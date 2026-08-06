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
import { currentRole } from '../request-context/request-context.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  AcceptInvitationSchema,
  InviteUserSchema,
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

  @Roles(...AGENCY_ADMIN_ROLES)
  @Post()
  async invite(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(InviteUserSchema)) body: InviteUserDto,
  ) {
    if (!userId) throw new UnauthorizedException();

    const superadmin = await this.network.isSuperadmin(userId);
    if (!superadmin && !(await this.network.canManageTenant(userId, body.tenantId))) {
      throw new ForbiddenException('target tenant is outside your network');
    }

    // No se puede invitar a alguien con rango igual o superior al propio.
    const actorRole = currentRole();
    if (!superadmin && (!actorRole || !canGrantRole(actorRole, body.role))) {
      throw new ForbiddenException('no podés invitar con un rol igual o superior al tuyo');
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
  async list(@CurrentUser() userId: string | undefined, @Query('tenantId') tenantId?: string) {
    if (!userId) throw new UnauthorizedException();
    if (!tenantId) throw new ForbiddenException('tenantId es obligatorio');

    const superadmin = await this.network.isSuperadmin(userId);
    if (!superadmin && !(await this.network.canManageTenant(userId, tenantId))) {
      throw new ForbiddenException('target tenant is outside your network');
    }
    return { invitations: await this.invitations.listPending(userId, tenantId) };
  }

  @Roles(...AGENCY_ADMIN_ROLES)
  @Post(':id/revoke')
  async revoke(
    @CurrentUser() userId: string | undefined,
    @Param('id') id: string,
    @Query('tenantId') tenantId?: string,
  ) {
    if (!userId) throw new UnauthorizedException();
    if (!tenantId) throw new ForbiddenException('tenantId es obligatorio');

    const superadmin = await this.network.isSuperadmin(userId);
    if (!superadmin && !(await this.network.canManageTenant(userId, tenantId))) {
      throw new ForbiddenException('target tenant is outside your network');
    }
    return this.invitations.revoke(userId, tenantId, id);
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
