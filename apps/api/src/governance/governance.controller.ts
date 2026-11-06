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
  type OnModuleInit,
} from '@nestjs/common';
import type { GovernedProvider } from '@sales-travel/domain';
import { z } from '@sales-travel/validation';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { NetworkService } from '../network/network.service.js';
import { SuperadminGuard } from '../network/superadmin.guard.js';
import { SupervisionService } from '../platform-admins/supervision.service.js';
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
 * Los cambios del gobierno que un superadmin supervisado no aplica solo: quedan como solicitud para
 * un pleno (docs/platform/16). Duplicar un perfil no cambia a ningún nodo y no pasa por acá.
 */
export const GOVERNANCE_CHANGE_KINDS = {
  createProfile: 'governance.profile.create',
  updateProfile: 'governance.profile.update',
  archiveProfile: 'governance.profile.archive',
  setDefault: 'governance.profile.default',
  assignProfile: 'governance.profile.assign',
  setRule: 'governance.rule.set',
} as const;

const UpdateProfileInput = z.object({ id: UuidParamSchema, dto: UpdateProfileSchema }).strict();
const ProfileIdInput = z.object({ id: UuidParamSchema }).strict();
const SetDefaultInput = z.object({ id: UuidParamSchema, dto: SetDefaultSchema }).strict();
const AssignProfileInput = z
  .object({ tenantId: UuidParamSchema, dto: AssignProfileSchema })
  .strict();

function ruleTarget(dto: SetRuleDto): string {
  const item = dto.method === '' ? dto.provider : `${dto.provider}.${dto.method}`;
  const scope = dto.tenantId === null ? 'global' : `nodo ${dto.tenantId}`;
  const action = dto.enabled === null ? 'quitar la regla' : dto.enabled ? 'encender' : 'apagar';
  return `Gobierno: ${action} ${item} (${scope})${dto.reason ? ` — ${dto.reason}` : ''}`;
}

/**
 * Gobierno de proveedores y formas de pago (docs/platform/17-opciones-de-pago.md): catálogo,
 * perfiles enlazados, asignación a nodos, reglas a mano y la vista efectiva de un nodo.
 *
 * Sólo el superadmin, como el panel de proveedores: `@Roles` deja fuera a todo rol de nodo,
 * {@link SuperadminGuard} corre antes de los pipes y cada ruta lo vuelve a comprobar para tener el
 * actor. La base lo exige de nuevo al escribir (RLS de 0089).
 */
@Roles(...PLATFORM_ROLES)
@UseGuards(SuperadminGuard)
@Controller('admin/governance')
export class GovernanceController implements OnModuleInit {
  constructor(
    private readonly governance: GovernanceAdminService,
    private readonly network: NetworkService,
    private readonly supervision: SupervisionService,
  ) {}

  onModuleInit(): void {
    const k = GOVERNANCE_CHANGE_KINDS;
    this.supervision.register(k.createProfile, {
      schema: CreateProfileSchema,
      summary: (dto) => `Gobierno: crear el perfil «${dto.name}»`,
      execute: (actor, dto) => this.governance.createProfile(actor, dto),
    });
    this.supervision.register(k.updateProfile, {
      schema: UpdateProfileInput,
      summary: (i) => `Gobierno: editar el perfil ${i.dto.name ? `«${i.dto.name}»` : i.id}`,
      execute: (actor, i) => this.governance.updateProfile(actor, i.id, i.dto),
    });
    this.supervision.register(k.archiveProfile, {
      schema: ProfileIdInput,
      summary: (i) => `Gobierno: archivar el perfil ${i.id}`,
      execute: (actor, i) => this.governance.archiveProfile(actor, i.id),
    });
    this.supervision.register(k.setDefault, {
      schema: SetDefaultInput,
      summary: (i) =>
        `Gobierno: ${i.dto.isDefault ? 'usar' : 'dejar de usar'} el perfil ${i.id} para los nodos nuevos`,
      execute: (actor, i) => this.governance.setDefault(actor, i.id, i.dto.isDefault),
    });
    this.supervision.register(k.assignProfile, {
      schema: AssignProfileInput,
      summary: (i) =>
        i.dto.profileId === null
          ? `Gobierno: quitarle el perfil al nodo ${i.tenantId}`
          : `Gobierno: asignar el perfil ${i.dto.profileId} al nodo ${i.tenantId}`,
      execute: (actor, i) => this.governance.assignProfile(actor, i.tenantId, i.dto.profileId),
    });
    this.supervision.register(k.setRule, {
      schema: SetRuleSchema,
      summary: ruleTarget,
      execute: (actor, dto) => this.applyRule(actor, dto),
    });
  }

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
    await this.supervision.gate(actor, GOVERNANCE_CHANGE_KINDS.createProfile, dto);
    return this.governance.createProfile(actor, dto);
  }

  @Put('profiles/:id')
  async updateProfile(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(UuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) dto: UpdateProfileDto,
  ): Promise<ProfileView> {
    const actor = await this.assertSuperadmin(userId);
    await this.supervision.gate(actor, GOVERNANCE_CHANGE_KINDS.updateProfile, { id, dto });
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
    await this.supervision.gate(actor, GOVERNANCE_CHANGE_KINDS.archiveProfile, { id });
    return this.governance.archiveProfile(actor, id);
  }

  @Put('profiles/:id/default')
  async setDefault(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ZodValidationPipe(UuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(SetDefaultSchema)) dto: SetDefaultDto,
  ): Promise<ProfileView> {
    const actor = await this.assertSuperadmin(userId);
    await this.supervision.gate(actor, GOVERNANCE_CHANGE_KINDS.setDefault, { id, dto });
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
    await this.supervision.gate(actor, GOVERNANCE_CHANGE_KINDS.setRule, dto);
    return this.applyRule(actor, dto);
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
    await this.supervision.gate(actor, GOVERNANCE_CHANGE_KINDS.assignProfile, { tenantId, dto });
    return this.governance.assignProfile(actor, tenantId, dto.profileId);
  }

  private applyRule(actor: string, dto: SetRuleDto): Promise<RuleView[]> {
    return this.governance.setRule(
      actor,
      { provider: dto.provider, method: dto.method },
      dto.tenantId,
      dto.enabled === null ? null : { enabled: dto.enabled, reason: dto.reason ?? null },
    );
  }

  private async assertSuperadmin(userId: string | undefined): Promise<string> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.isSuperadmin(userId))) {
      throw new ForbiddenException('superadmin access required');
    }
    return userId;
  }
}
