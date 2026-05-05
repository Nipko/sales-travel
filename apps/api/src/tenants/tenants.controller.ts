import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  UnauthorizedException,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';

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

@Controller('tenants')
export class TenantsController {
  constructor(private readonly db: DatabaseService) {}

  @Get(':id/branding')
  async getBranding(
    @CurrentUser() userId: string | undefined,
    @Param('id') tenantId: string,
  ): Promise<BrandingView> {
    if (!userId) throw new UnauthorizedException();
    await this.assertMembership(userId, tenantId);

    const row = await this.db.db
      .selectFrom('tenants')
      .select(['logo_url', 'primary_color', 'accent_color'])
      .where('id', '=', tenantId)
      .executeTakeFirst();

    return {
      logoUrl: row?.logo_url ?? null,
      primaryColor: row?.primary_color ?? null,
      accentColor: row?.accent_color ?? null,
    };
  }

  @Patch(':id/branding')
  async updateBranding(
    @CurrentUser() userId: string | undefined,
    @Param('id') tenantId: string,
    @Body() dto: UpdateBrandingDto,
  ): Promise<BrandingView> {
    if (!userId) throw new UnauthorizedException();
    await this.assertAdminMembership(userId, tenantId);

    await this.db.db
      .updateTable('tenants')
      .set({
        ...(dto.logoUrl !== undefined ? { logo_url: dto.logoUrl } : {}),
        ...(dto.primaryColor !== undefined ? { primary_color: dto.primaryColor } : {}),
        ...(dto.accentColor !== undefined ? { accent_color: dto.accentColor } : {}),
      })
      .where('id', '=', tenantId)
      .execute();

    const row = await this.db.db
      .selectFrom('tenants')
      .select(['logo_url', 'primary_color', 'accent_color'])
      .where('id', '=', tenantId)
      .executeTakeFirstOrThrow();

    return {
      logoUrl: row.logo_url,
      primaryColor: row.primary_color,
      accentColor: row.accent_color,
    };
  }

  private async assertMembership(userId: string, tenantId: string): Promise<void> {
    const row = await this.db.db
      .selectFrom('memberships')
      .select('id')
      .where('user_id', '=', userId)
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!row) throw new ForbiddenException('not a member of this tenant');
  }

  private async assertAdminMembership(userId: string, tenantId: string): Promise<void> {
    const row = await this.db.db
      .selectFrom('memberships')
      .select('role')
      .where('user_id', '=', userId)
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!row) throw new ForbiddenException('not a member of this tenant');
    if (row.role !== 'tenant_admin' && row.role !== 'superadmin' && row.role !== 'admin') {
      throw new ForbiddenException('admin role required');
    }
  }
}
