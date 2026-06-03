import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import type { ProviderAccountStatus } from '../database/database.types.js';
import { ProviderCredentialsService } from './provider-credentials.service.js';

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
@Controller('provider-accounts')
export class ProviderCredentialsController {
  constructor(
    private readonly service: ProviderCredentialsService,
    private readonly db: DatabaseService,
  ) {}

  @Post()
  async upsert(
    @CurrentUser() userId: string | undefined,
    @Body() body: UpsertProviderAccountBody,
  ): Promise<{ id: string }> {
    await this.assertAdmin(userId);
    return this.service.upsert({
      tenantId: body.tenantId,
      providerCode: body.providerCode,
      label: body.label,
      credentials: body.credentials,
      config: body.config,
      isInheritable: body.isInheritable,
      status: body.status,
    });
  }

  @Get()
  async list(
    @CurrentUser() userId: string | undefined,
    @Query('tenantId') tenantId: string,
  ): Promise<{ accounts: unknown[] }> {
    await this.assertAdmin(userId);
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
    await this.assertAdmin(userId);
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

  private async assertAdmin(userId: string | undefined): Promise<void> {
    if (!userId) throw new UnauthorizedException();
    const row = await this.db.withRequestContext({ userId }, async (trx) =>
      trx
        .selectFrom('memberships')
        .select('role')
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .where('role', 'in', ['superadmin', 'tenant_admin', 'admin'])
        .executeTakeFirst(),
    );
    if (!row) throw new ForbiddenException('admin access required');
  }
}
