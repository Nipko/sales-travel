import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
  UseGuards,
  type OnModuleInit,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequireRecentMfa } from '../auth/decorators/require-recent-mfa.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  ChangeRequestListQuerySchema,
  DecisionSchema,
  GrantInputSchema,
  GrantPlatformAdminSchema,
  RevokeInputSchema,
  RevokePlatformAdminSchema,
  SetSupervisionSchema,
  SupervisionInputSchema,
  Uuid,
  type ChangeRequestListQuery,
  type DecisionDto,
  type GrantPlatformAdminDto,
  type RevokePlatformAdminDto,
  type SetSupervisionDto,
} from './platform-admins.schemas.js';
import { PlatformAdminsService, type PlatformAdminView } from './platform-admins.service.js';
import {
  SupervisionService,
  type ChangeRequestView,
  type PlatformStanding,
} from './supervision.service.js';

/** Los tipos de cambio de esta pantalla, como quedan en platform_change_requests. */
export const PLATFORM_ADMIN_CHANGE_KINDS = {
  grant: 'platform_admins.grant',
  supervision: 'platform_admins.supervision',
  revoke: 'platform_admins.revoke',
} as const;

function requireUser(userId: string | undefined): string {
  if (!userId) throw new UnauthorizedException();
  return userId;
}

/**
 * Plataforma → Superadmins (docs/platform/16): quién es superadmin, pleno o supervisado, y darlo,
 * cambiarlo o quitarlo. Todo superadmin lo ve; cambiarlo es de alto impacto (2FA de los últimos
 * minutos) y, si lo pide un supervisado, queda como solicitud para un pleno.
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/platform-admins')
export class PlatformAdminsController implements OnModuleInit {
  constructor(
    private readonly admins: PlatformAdminsService,
    private readonly supervision: SupervisionService,
  ) {}

  onModuleInit(): void {
    this.supervision.register(PLATFORM_ADMIN_CHANGE_KINDS.grant, {
      schema: GrantInputSchema,
      summary: (i) =>
        `Superadmins: dar acceso ${i.supervised ? 'supervisado' : 'pleno'} a ${i.email}`,
      execute: (actor, i) => this.admins.grant(actor, i),
    });
    this.supervision.register(PLATFORM_ADMIN_CHANGE_KINDS.supervision, {
      schema: SupervisionInputSchema,
      summary: (i) =>
        `Superadmins: pasar a ${i.supervised ? 'supervisado' : 'pleno'} a la cuenta ${i.userId}`,
      execute: (actor, i) => this.admins.setSupervised(actor, i),
    });
    this.supervision.register(PLATFORM_ADMIN_CHANGE_KINDS.revoke, {
      schema: RevokeInputSchema,
      summary: (i) => `Superadmins: quitarle el acceso a la cuenta ${i.userId}`,
      execute: (actor, i) => this.admins.revoke(actor, i),
    });
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@CurrentUser() userId: string | undefined): Promise<PlatformAdminView[]> {
    return this.admins.list(requireUser(userId));
  }

  /** Qué es quien mira: el panel muestra o esconde los botones de aprobar con esto. */
  @Get('me')
  @Header('Cache-Control', 'no-store')
  async me(
    @CurrentUser() userId: string | undefined,
  ): Promise<{ userId: string; standing: PlatformStanding }> {
    const actor = requireUser(userId);
    return { userId: actor, standing: await this.supervision.standing(actor) };
  }

  @Post()
  @RequireRecentMfa()
  async grant(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(GrantPlatformAdminSchema)) dto: GrantPlatformAdminDto,
  ): Promise<PlatformAdminView[]> {
    const actor = requireUser(userId);
    await this.supervision.gate(actor, PLATFORM_ADMIN_CHANGE_KINDS.grant, dto);
    return this.admins.grant(actor, dto);
  }

  @Put(':userId/supervision')
  @RequireRecentMfa()
  async setSupervision(
    @CurrentUser() userId: string | undefined,
    @Param('userId', new ZodValidationPipe(Uuid)) target: string,
    @Body(new ZodValidationPipe(SetSupervisionSchema)) dto: SetSupervisionDto,
  ): Promise<PlatformAdminView[]> {
    const actor = requireUser(userId);
    const input = { userId: target, ...dto };
    await this.supervision.gate(actor, PLATFORM_ADMIN_CHANGE_KINDS.supervision, input);
    return this.admins.setSupervised(actor, input);
  }

  @Post(':userId/revoke')
  @HttpCode(200)
  @RequireRecentMfa()
  async revoke(
    @CurrentUser() userId: string | undefined,
    @Param('userId', new ZodValidationPipe(Uuid)) target: string,
    @Body(new ZodValidationPipe(RevokePlatformAdminSchema)) dto: RevokePlatformAdminDto,
  ): Promise<PlatformAdminView[]> {
    const actor = requireUser(userId);
    const input = { userId: target, ...dto };
    await this.supervision.gate(actor, PLATFORM_ADMIN_CHANGE_KINDS.revoke, input);
    return this.admins.revoke(actor, input);
  }
}

/**
 * Las solicitudes de cambio de los superadmins supervisados. Las ve todo superadmin; las aprueba o
 * rechaza un pleno que no las pidió (aprobar aplica el cambio: 2FA reciente); las cancela quien las
 * pidió.
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/change-requests')
export class ChangeRequestsController {
  constructor(private readonly supervision: SupervisionService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @CurrentUser() userId: string | undefined,
    @Query(new ZodValidationPipe(ChangeRequestListQuerySchema)) query: ChangeRequestListQuery,
  ): Promise<ChangeRequestView[]> {
    return this.supervision.list(requireUser(userId), query.status);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequireRecentMfa()
  async approve(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(Uuid)) id: string,
    @Body(new ZodValidationPipe(DecisionSchema)) dto: DecisionDto,
  ): Promise<ChangeRequestView> {
    return this.supervision.approve(requireUser(userId), id, dto.note);
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(Uuid)) id: string,
    @Body(new ZodValidationPipe(DecisionSchema)) dto: DecisionDto,
  ): Promise<ChangeRequestView> {
    return this.supervision.reject(requireUser(userId), id, dto.note);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(Uuid)) id: string,
  ): Promise<ChangeRequestView> {
    return this.supervision.cancel(requireUser(userId), id);
  }
}
