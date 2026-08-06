import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { ProviderAccountStatus } from '../database/database.types.js';
import { NetworkService } from '../network/network.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { UpsertProviderAccountSchema } from './dto.js';
import { ProviderCredentialsService } from './provider-credentials.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';

interface UpsertProviderAccountBody {
  tenantId: string;
  providerCode: string;
  label?: string;
  credentials: Record<string, unknown>;
  config?: Record<string, unknown>;
  isInheritable?: boolean;
  status?: ProviderAccountStatus;
}

/**
 * Gestión de credenciales BYOC por tenant. Sólo admins. El secreto NUNCA se
 * devuelve: las respuestas exponen sólo metadata (config no-secreta, status...).
 */
@Roles(...AGENCY_ADMIN_ROLES)
@Controller('provider-accounts')
export class ProviderCredentialsController {
  constructor(
    private readonly service: ProviderCredentialsService,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  async upsert(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(UpsertProviderAccountSchema)) body: UpsertProviderAccountBody,
  ): Promise<{ id: string }> {
    await this.assertCanManage(userId, body.tenantId);
    const result = await this.service.upsert({
      tenantId: body.tenantId,
      providerCode: body.providerCode,
      label: body.label,
      credentials: body.credentials,
      config: body.config,
      isInheritable: body.isInheritable,
      status: body.status,
    });
    // Auditoría: registra el cambio SIN el secreto.
    await this.audit.emit({
      eventType: 'ProviderCredentialsUpdated',
      tenantId: body.tenantId,
      actorUserId: userId,
      aggregateType: 'provider_account',
      aggregateId: result.id,
      payload: {
        providerCode: body.providerCode,
        label: body.label ?? 'default',
        status: body.status ?? 'sandbox',
        isInheritable: body.isInheritable ?? true,
      },
    });
    return result;
  }

  @Get()
  async list(
    @CurrentUser() userId: string | undefined,
    @Query('tenantId') tenantId: string,
  ): Promise<{ accounts: unknown[] }> {
    await this.assertCanManage(userId, tenantId);
    const accounts = await this.service.listSafe(tenantId);
    return { accounts };
  }

  /**
   * Diagnóstico: qué cuenta resolvería un tenant para un proveedor (propia o
   * heredada del consolidador). NO devuelve el secreto, sólo de dónde sale.
   */
  @Get('resolve')
  async resolve(
    @CurrentUser() userId: string | undefined,
    @Query('tenantId') tenantId: string,
    @Query('providerCode') providerCode: string,
  ): Promise<{
    id: string;
    ownerTenantId: string;
    providerCode: string;
    label: string;
    inherited: boolean;
  }> {
    await this.assertCanManage(userId, tenantId);
    const resolved = await this.service.resolve(tenantId, providerCode);
    // Se omite `credentials` deliberadamente.
    return {
      id: resolved.id,
      ownerTenantId: resolved.ownerTenantId,
      providerCode: resolved.providerCode,
      label: resolved.label,
      inherited: resolved.inherited,
    };
  }

  /**
   * Autorización jerárquica: el usuario sólo puede gestionar credenciales de un tenant
   * dentro de su subárbol (su nodo admin o descendientes), o cualquiera si es superadmin.
   * Cierra el hueco previo donde cualquier admin podía escribir credenciales de cualquier tenant.
   */
  private async assertCanManage(userId: string | undefined, tenantId: string): Promise<void> {
    if (!userId) throw new UnauthorizedException();
    if (!tenantId) throw new ForbiddenException('tenantId required');
    const ok = await this.network.canManageTenant(userId, tenantId);
    if (!ok) throw new ForbiddenException('not authorized to manage this tenant');
  }
}
