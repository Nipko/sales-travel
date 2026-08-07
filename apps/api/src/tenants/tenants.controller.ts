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
import { sql, type Transaction } from 'kysely';
import { AuditService, type AuditEntry } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import {
  NetworkService,
  type NetworkSalesRow,
  type NetworkTenant,
  type NetworkUser,
} from '../network/network.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  UpdateBrandingSchema,
  UpdateConfigSchema,
  type UpdateBrandingDto,
  type UpdateConfigDto,
} from './branding.schemas.js';

/**
 * Branding EFECTIVO: lo que hay que pintar. Los campos que el tenant no configuró
 * vienen heredados de su cadena de ancestros (ver resolve_tenant_branding, 0030).
 */
interface BrandingView {
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  commercialName: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
}

interface BrandingRow {
  logo_url: string | null;
  favicon_url: string | null;
  primary_color: string | null;
  accent_color: string | null;
  commercial_name: string | null;
  support_email: string | null;
  support_phone: string | null;
  website_url: string | null;
}

function toBrandingView(row: BrandingRow | undefined): BrandingView {
  return {
    logoUrl: row?.logo_url ?? null,
    faviconUrl: row?.favicon_url ?? null,
    primaryColor: row?.primary_color ?? null,
    accentColor: row?.accent_color ?? null,
    commercialName: row?.commercial_name ?? null,
    supportEmail: row?.support_email ?? null,
    supportPhone: row?.support_phone ?? null,
    websiteUrl: row?.website_url ?? null,
  };
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
  @Roles(...AGENCY_ADMIN_ROLES)
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
  @Roles(...AGENCY_ADMIN_ROLES)
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

  /** Usuarios (memberships) de un nodo de la red. Gateado por canManageTenant. */
  @Roles(...AGENCY_ADMIN_ROLES)
  @Get('network/users')
  async getNetworkUsers(
    @CurrentUser() userId: string | undefined,
    @Query('tenantId') tenantId: string,
  ): Promise<{ users: NetworkUser[] }> {
    if (!userId) throw new UnauthorizedException();
    if (!tenantId) throw new ForbiddenException('tenantId required');
    const users = await this.network.listTenantUsers(userId, tenantId);
    return { users };
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

      // Branding EFECTIVO, no el crudo de la fila: una sub-agencia que sólo configuró su
      // logo hereda el color de su agencia, y en última instancia el del consolidador.
      const res = await sql<BrandingRow>`
        SELECT * FROM resolve_tenant_branding(${tenantId}::uuid)
      `.execute(trx);

      return toBrandingView(res.rows[0]);
    });
  }

  /**
   * Branding PROPIO del tenant, sin heredar. Es lo que necesita el formulario de
   * configuración: mezclar lo heredado haría que al guardar se persistiera como propio
   * lo que en realidad venía del padre, rompiendo la herencia en silencio.
   */
  @Roles(...AGENCY_ADMIN_ROLES)
  @Get(':id/branding/own')
  async getOwnBranding(
    @CurrentUser() userId: string | undefined,
    @Param('id') tenantId: string,
  ): Promise<BrandingView> {
    if (!userId) throw new UnauthorizedException();
    await this.assertCanManage(userId, tenantId);

    return this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      const row = await trx
        .selectFrom('tenants')
        .select([
          'logo_url',
          'favicon_url',
          'primary_color',
          'accent_color',
          'commercial_name',
          'support_email',
          'support_phone',
          'website_url',
        ])
        .where('id', '=', tenantId)
        .executeTakeFirst();

      return toBrandingView(row);
    });
  }

  @Roles(...AGENCY_ADMIN_ROLES)
  @Patch(':id/branding')
  async updateBranding(
    @CurrentUser() userId: string | undefined,
    @Param('id') tenantId: string,
    @Body(new ZodValidationPipe(UpdateBrandingSchema)) dto: UpdateBrandingDto,
  ): Promise<BrandingView> {
    if (!userId) throw new UnauthorizedException();
    // Por jerarquía, no por membership directa: un consolidador debe poder administrar
    // el branding de las agencias de su red sin ser miembro de cada una.
    await this.assertCanManage(userId, tenantId);

    const view = await this.db.withRequestContext({ userId, tenantId }, async (trx) => {
      await trx
        .updateTable('tenants')
        .set({
          ...(dto.logoUrl !== undefined ? { logo_url: dto.logoUrl } : {}),
          ...(dto.faviconUrl !== undefined ? { favicon_url: dto.faviconUrl } : {}),
          ...(dto.primaryColor !== undefined ? { primary_color: dto.primaryColor } : {}),
          ...(dto.accentColor !== undefined ? { accent_color: dto.accentColor } : {}),
          ...(dto.commercialName !== undefined ? { commercial_name: dto.commercialName } : {}),
          ...(dto.supportEmail !== undefined ? { support_email: dto.supportEmail } : {}),
          ...(dto.supportPhone !== undefined ? { support_phone: dto.supportPhone } : {}),
          ...(dto.websiteUrl !== undefined ? { website_url: dto.websiteUrl } : {}),
        })
        .where('id', '=', tenantId)
        .execute();

      const res = await sql<BrandingRow>`
        SELECT * FROM resolve_tenant_branding(${tenantId}::uuid)
      `.execute(trx);
      return toBrandingView(res.rows[0]);
    });

    // Cambiar la marca de una agencia afecta lo que ve su cliente final: queda auditado.
    // Sólo los campos tocados, nunca sus valores (una URL de logo puede ser de un tercero).
    await this.audit.emit({
      eventType: 'tenant.branding.updated',
      tenantId,
      actorUserId: userId,
      aggregateType: 'tenant',
      aggregateId: tenantId,
      payload: { changed: Object.keys(dto) },
    });

    return view;
  }

  @Roles(...AGENCY_ADMIN_ROLES)
  @Patch(':id/config')
  async updateConfig(
    @CurrentUser() userId: string | undefined,
    @Param('id') tenantId: string,
    @Body(new ZodValidationPipe(UpdateConfigSchema)) dto: UpdateConfigDto,
  ) {
    if (!userId) throw new UnauthorizedException();
    await this.assertCanManage(userId, tenantId);

    const result = await this.db.withRequestContext({ userId, tenantId }, async (trx) => {
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

    await this.audit.emit({
      eventType: 'tenant.config.updated',
      tenantId,
      actorUserId: userId,
      aggregateType: 'tenant',
      aggregateId: tenantId,
      payload: { changed: Object.keys(dto) },
    });

    return result;
  }

  /**
   * Autorización JERÁRQUICA sobre un tenant de la red.
   *
   * Reemplaza a assertAdminMembership en los caminos de branding y configuración: esa
   * exigía membership DIRECTA, con lo que un consolidador no podía administrar la marca
   * de las agencias de su propia red pese a ser exactamente su rol.
   */
  private async assertCanManage(userId: string, tenantId: string): Promise<void> {
    if (await this.network.isSuperadmin(userId)) return;
    if (!(await this.network.canManageTenant(userId, tenantId))) {
      throw new ForbiddenException('target tenant is outside your network');
    }
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
