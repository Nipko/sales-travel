import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PLATFORM_ROLES } from '../auth/roles.js';
import { NetworkService } from '../network/network.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  ProviderCodeParamSchema,
  SetProviderEnablementSchema,
  TenantIdParamSchema,
  type SetProviderEnablementDto,
} from './provider-enablement.schemas.js';
import {
  ProviderEnablementService,
  type PlatformProviderView,
  type TenantProvidersView,
} from './provider-enablement.service.js';

/**
 * Qué proveedores puede usar cada tenant, desde el panel de la plataforma.
 *
 * Sólo el superadmin: `@Roles` deja fuera a todo rol de nodo (un consolidador no enciende ni apaga
 * proveedores de la plataforma, ni siquiera para su red), y la comprobación explícita deja fuera a
 * `platform_admin`, como el resto del panel de plataforma (`/admin/tenants`). La base lo vuelve a
 * exigir al escribir (RLS de 0048).
 */
@Roles(...PLATFORM_ROLES)
@Controller('admin/providers')
export class ProviderEnablementController {
  constructor(
    private readonly enablement: ProviderEnablementService,
    private readonly network: NetworkService,
  ) {}

  @Get()
  async list(@CurrentUser() userId: string | undefined): Promise<PlatformProviderView[]> {
    await this.assertSuperadmin(userId);
    return this.enablement.list();
  }

  @Get('tenants/:tenantId')
  async forTenant(
    @CurrentUser() userId: string | undefined,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
  ): Promise<TenantProvidersView> {
    await this.assertSuperadmin(userId);
    return this.enablement.forTenant(tenantId);
  }

  @Put(':code/global')
  async setGlobal(
    @CurrentUser() userId: string | undefined,
    @Param('code', new ZodValidationPipe(ProviderCodeParamSchema)) code: string,
    @Body(new ZodValidationPipe(SetProviderEnablementSchema)) dto: SetProviderEnablementDto,
  ): Promise<PlatformProviderView> {
    const actor = await this.assertSuperadmin(userId);
    return this.enablement.setGlobal(actor, code, {
      enabled: dto.enabled,
      reason: dto.reason ?? null,
    });
  }

  @Delete(':code/global')
  async clearGlobal(
    @CurrentUser() userId: string | undefined,
    @Param('code', new ZodValidationPipe(ProviderCodeParamSchema)) code: string,
  ): Promise<PlatformProviderView> {
    const actor = await this.assertSuperadmin(userId);
    return this.enablement.clearGlobal(actor, code);
  }

  @Put(':code/tenants/:tenantId')
  async setTenant(
    @CurrentUser() userId: string | undefined,
    @Param('code', new ZodValidationPipe(ProviderCodeParamSchema)) code: string,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Body(new ZodValidationPipe(SetProviderEnablementSchema)) dto: SetProviderEnablementDto,
  ): Promise<PlatformProviderView> {
    const actor = await this.assertSuperadmin(userId);
    return this.enablement.setTenant(actor, code, tenantId, {
      enabled: dto.enabled,
      reason: dto.reason ?? null,
    });
  }

  @Delete(':code/tenants/:tenantId')
  async clearTenant(
    @CurrentUser() userId: string | undefined,
    @Param('code', new ZodValidationPipe(ProviderCodeParamSchema)) code: string,
    @Param('tenantId', new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
  ): Promise<PlatformProviderView> {
    const actor = await this.assertSuperadmin(userId);
    return this.enablement.clearTenant(actor, code, tenantId);
  }

  private async assertSuperadmin(userId: string | undefined): Promise<string> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.isSuperadmin(userId))) {
      throw new ForbiddenException('superadmin access required');
    }
    return userId;
  }
}
