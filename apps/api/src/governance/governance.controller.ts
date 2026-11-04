import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { GovernedProvider } from '@sales-travel/domain';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { NetworkService } from '../network/network.service.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  GovernanceAdminService,
  type ProfileView,
  type RuleView,
  type TenantGovernanceView,
} from './governance-admin.service.js';
import {
  AssignProfileSchema,
  CreateProfileSchema,
  DuplicateProfileSchema,
  SetDefaultSchema,
  SetRuleSchema,
  UpdateProfileSchema,
  UuidParamSchema,
  type AssignProfileDto,
  type CreateProfileDto,
  type DuplicateProfileDto,
  type SetDefaultDto,
  type SetRuleDto,
  type UpdateProfileDto,
} from './governance.schemas.js';

/**
 * Gobierno de proveedores y formas de pago (docs/platform/14-opciones-de-pago.md): catálogo,
 * perfiles enlazados, asignación a nodos, reglas a mano y la vista efectiva de un nodo.
 *
 * Sólo el superadmin, como el panel de proveedores: `@Roles` deja fuera a todo rol de nodo,
 * {@link SuperadminGuard} corre antes de los pipes y cada ruta lo vuelve a comprobar para tener el
 * actor. La base lo exige de nuevo al escribir (RLS de 0089).
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/governance')
export class GovernanceController {
  constructor(
    private readonly governance: GovernanceAdminService,
    private readonly network: NetworkService,
  ) {}

  @Get('catalog')
  async catalog(@CurrentUser() userId: string | undefined): Promise<readonly GovernedProvider[]> {
    await this.assertSuperadmin(userId);
    return this.governance.catalog();
  }

  @Get('profiles')
  async profiles(@CurrentUser() userId: string | undefined): Promise<ProfileView[]> {
    await this.assertSuperadmin(userId);
    return this.governance.listProfiles();
  }

  @Post('profiles')
  async createProfile(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(CreateProfileSchema)) dto: CreateProfileDto,
  ): Promise<ProfileView> {
    const actor = await this.assertSuperadmin(userId);
    return this.governance.createProfile(actor, dto);
  }

  @Put('profiles/:id')
  async updateProfile(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(UuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) dto: UpdateProfileDto,
  ): Promise<ProfileView> {
    const actor = await this.assertSuperadmin(userId);
    return this.governance.updateProfile(actor, id, dto);
  }

  @Post('profiles/:id/duplicate')
  async duplicateProfile(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(UuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(DuplicateProfileSchema)) dto: DuplicateProfileDto,
  ): Promise<ProfileView> {
    const actor = await this.assertSuperadmin(userId);
    return this.governance.duplicateProfile(actor, id, dto.name);
  }

  @Post('profiles/:id/archive')
  async archiveProfile(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(UuidParamSchema)) id: string,
  ): Promise<ProfileView> {
    const actor = await this.assertSuperadmin(userId);
    return this.governance.archiveProfile(actor, id);
  }

  @Put('profiles/:id/default')
  async setDefault(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(UuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(SetDefaultSchema)) dto: SetDefaultDto,
  ): Promise<ProfileView> {
    const actor = await this.assertSuperadmin(userId);
    return this.governance.setDefault(actor, id, dto.isDefault);
  }

  /** Las reglas globales (las de toda la plataforma). */
  @Get('rules')
  async globalRules(@CurrentUser() userId: string | undefined): Promise<RuleView[]> {
    await this.assertSuperadmin(userId);
    return this.governance.rules(null);
  }

  @Put('rules')
  async setRule(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(SetRuleSchema)) dto: SetRuleDto,
  ): Promise<RuleView[]> {
    const actor = await this.assertSuperadmin(userId);
    return this.governance.setRule(
      actor,
      { provider: dto.provider, method: dto.method },
      dto.tenantId,
      dto.enabled === null ? null : { enabled: dto.enabled, reason: dto.reason ?? null },
    );
  }

  @Get('tenants/:tenantId')
  async tenantView(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(UuidParamSchema)) tenantId: string,
  ): Promise<TenantGovernanceView> {
    await this.assertSuperadmin(userId);
    return this.governance.tenantView(tenantId);
  }

  @Put('tenants/:tenantId/profile')
  async assignProfile(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(UuidParamSchema)) tenantId: string,
    @Body(new ZodValidationPipe(AssignProfileSchema)) dto: AssignProfileDto,
  ): Promise<TenantGovernanceView> {
    const actor = await this.assertSuperadmin(userId);
    return this.governance.assignProfile(actor, tenantId, dto.profileId);
  }

  private async assertSuperadmin(userId: string | undefined): Promise<string> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.isSuperadmin(userId))) {
      throw new ForbiddenException('superadmin access required');
    }
    return userId;
  }
}
