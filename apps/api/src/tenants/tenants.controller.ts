import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import type { Transaction } from 'kysely';
import { AuditService, type AuditEntry } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import {
  NetworkService,
  type NetworkSalesRow,
  type NetworkTenant,
} from '../network/network.service.js';

interface BrandingView {
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
}

interface UpdateBrandingDto {
  logoUrl?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
}

interface UpdateConfigDto {
  name?: string;
  countryCode?: string;
  defaultCurrency?: string;
  defaultLanguage?: 'es' | 'pt' | 'en';
}

@Controller('tenants')
export class TenantsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
  ) {}

  /** Subárbol de tenants que el usuario administra (su red de agencias/sub-agencias). */
  @Get('network')
  async getNetwork(
    @CurrentUser() userId: string | undefined,
  ): Promise<{ tenants: NetworkTenant[] }> {
    if (!userId) throw new UnauthorizedException();
    const tenants = await this.network.listNetwork(userId);
    return { tenants };
  }

  /** Agregado de ventas (orders/quotations) de toda la red bajo el tenant indicado. */
  @Get('network/sales')
  async getNetworkSales(
    @CurrentUser() userId: string | undefined,
    @Query('tenantId') tenantId: string,
  ): Promise<{ summary: NetworkSalesRow[] }> {
    if (!userId) throw new UnauthorizedException();
    if (!tenantId) throw new ForbiddenException('tenantId required');
    const summary = await this.network.networkSalesSummary(userId, tenantId);
    return { summary };
  }

  /** Actividad reciente (audit log) de toda la red bajo el tenant indicado. */
  @Get('network/audit')
  async getNetworkAudit(
    @CurrentUser() userId: string | undefined,
    @Query('tenantId') tenantId: string,
    @Query('limit') limit?: string,
  ): Promise<{ events: AuditEntry[] }> {
    if (!userId) throw new UnauthorizedException();
    if (!tenantId) throw new ForbiddenException('tenantId required');
    if (!(await this.network.canManageTenant(userId, tenantId))) {
      throw new ForbiddenException('not authorized for this network');
    }
    const events = await this.audit.networkAudit(tenantId, Number(limit) || 50);
    return { events };
  }

  @Get(':id/config')
  async getConfig(@CurrentUser() userId: string | undefined, @Param('id') tenantId: string) {
    if (!userId) throw new UnauthorizedException();

    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      await this.assertMembership(trx, userId, tenantId);

      const row = await trx
        .selectFrom('tenants')
        .select(['name', 'slug', 'country_code', 'default_currency', 'default_language'])
        .where('id', '=', tenantId)
        .executeTakeFirstOrThrow();

      return {
        name: row.name,
        slug: row.slug,
        countryCode: row.country_code,
        defaultCurrency: row.default_currency,
        defaultLanguage: row.default_language,
      };
    });
  }

  @Get(':id/branding')
  async getBranding(
    @CurrentUser() userId: string | undefined,
    @Param('id') tenantId: string,
  ): Promise<BrandingView> {
    if (!userId) throw new UnauthorizedException();

    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      await this.assertMembership(trx, userId, tenantId);

      const row = await trx
        .selectFrom('tenants')
        .select(['logo_url', 'primary_color', 'accent_color'])
        .where('id', '=', tenantId)
        .executeTakeFirst();

      return {
        logoUrl: row?.logo_url ?? null,
        primaryColor: row?.primary_color ?? null,
        accentColor: row?.accent_color ?? null,
      };
    });
  }

  @Patch(':id/branding')
  async updateBranding(
    @CurrentUser() userId: string | undefined,
    @Param('id') tenantId: string,
    @Body() dto: UpdateBrandingDto,
  ): Promise<BrandingView> {
    if (!userId) throw new UnauthorizedException();

    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      await this.assertAdminMembership(trx, userId, tenantId);

      await trx
        .updateTable('tenants')
        .set({
          ...(dto.logoUrl !== undefined ? { logo_url: dto.logoUrl } : {}),
          ...(dto.primaryColor !== undefined ? { primary_color: dto.primaryColor } : {}),
          ...(dto.accentColor !== undefined ? { accent_color: dto.accentColor } : {}),
        })
        .where('id', '=', tenantId)
        .execute();

      const row = await trx
        .selectFrom('tenants')
        .select(['logo_url', 'primary_color', 'accent_color'])
        .where('id', '=', tenantId)
        .executeTakeFirstOrThrow();

      return {
        logoUrl: row.logo_url,
        primaryColor: row.primary_color,
        accentColor: row.accent_color,
      };
    });
  }

  @Patch(':id/config')
  async updateConfig(
    @CurrentUser() userId: string | undefined,
    @Param('id') tenantId: string,
    @Body() dto: UpdateConfigDto,
  ) {
    if (!userId) throw new UnauthorizedException();

    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      await this.assertAdminMembership(trx, userId, tenantId);

      await trx
        .updateTable('tenants')
        .set({
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.countryCode !== undefined ? { country_code: dto.countryCode } : {}),
          ...(dto.defaultCurrency !== undefined ? { default_currency: dto.defaultCurrency } : {}),
          ...(dto.defaultLanguage !== undefined ? { default_language: dto.defaultLanguage } : {}),
        })
        .where('id', '=', tenantId)
        .execute();

      const row = await trx
        .selectFrom('tenants')
        .select(['name', 'slug', 'country_code', 'default_currency', 'default_language'])
        .where('id', '=', tenantId)
        .executeTakeFirstOrThrow();

      return {
        name: row.name,
        slug: row.slug,
        countryCode: row.country_code,
        defaultCurrency: row.default_currency,
        defaultLanguage: row.default_language,
      };
    });
  }

  private async assertMembership(
    trx: Transaction<DB>,
    userId: string,
    tenantId: string,
  ): Promise<void> {
    const row = await trx
      .selectFrom('memberships')
      .select('id')
      .where('user_id', '=', userId)
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!row) throw new ForbiddenException('not a member of this tenant');
  }

  private async assertAdminMembership(
    trx: Transaction<DB>,
    userId: string,
    tenantId: string,
  ): Promise<void> {
    const row = await trx
      .selectFrom('memberships')
      .select('role')
      .where('user_id', '=', userId)
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!row) throw new ForbiddenException('not a member of this tenant');
    const adminRoles = [
      'superadmin',
      'platform_admin',
      'consolidator_admin',
      'tenant_admin',
      'agency_admin',
      'admin',
    ];
    if (!adminRoles.includes(row.role)) {
      throw new ForbiddenException('admin role required');
    }
  }
}
