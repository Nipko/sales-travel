import { Controller, ForbiddenException, Get, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';

@Controller('admin')
export class AdminController {
  constructor(private readonly db: DatabaseService) {}

  @Get('tenants')
  async listTenants(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new UnauthorizedException();
    await this.assertAdmin(userId);

    const rows = await this.db.db
      .selectFrom('tenants')
      .select([
        'tenants.id',
        'tenants.slug',
        'tenants.name',
        'tenants.country_code',
        'tenants.default_currency',
        'tenants.status',
        'tenants.created_at',
      ])
      .orderBy('tenants.created_at', 'desc')
      .execute();

    const tenantIds = rows.map((r) => r.id);
    const counts =
      tenantIds.length > 0
        ? await this.db.db
            .selectFrom('memberships')
            .select(['tenant_id'])
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .where('tenant_id', 'in', tenantIds)
            .groupBy('tenant_id')
            .execute()
        : [];

    const countMap = new Map(counts.map((c) => [c.tenant_id, Number(c.count)]));

    return {
      tenants: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        countryCode: r.country_code,
        defaultCurrency: r.default_currency,
        status: r.status,
        userCount: countMap.get(r.id) ?? 0,
        createdAt: r.created_at,
      })),
    };
  }

  @Get('users')
  async listUsers(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new UnauthorizedException();
    await this.assertAdmin(userId);

    const rows = await this.db.db
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .innerJoin('tenants', 'tenants.id', 'memberships.tenant_id')
      .select([
        'users.id',
        'users.email',
        'users.name',
        'users.status',
        'memberships.role',
        'tenants.name as tenantName',
        'users.created_at',
      ])
      .orderBy('users.created_at', 'desc')
      .execute();

    return {
      users: rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        status: r.status,
        role: r.role,
        tenantName: r.tenantName,
        createdAt: r.created_at,
        lastLoginAt: null,
      })),
    };
  }

  private async assertAdmin(userId: string): Promise<void> {
    const row = await this.db.db
      .selectFrom('memberships')
      .select('role')
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .where('role', 'in', ['superadmin', 'tenant_admin', 'admin'])
      .executeTakeFirst();
    if (!row) throw new ForbiddenException('admin access required');
  }
}
