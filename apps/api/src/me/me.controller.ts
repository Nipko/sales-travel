import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';

interface MeView {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
}

interface MembershipView {
  id: string;
  role: string;
  status: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
}

@Controller('me')
export class MeController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async me(@CurrentUser() userId: string | undefined): Promise<MeView> {
    if (!userId) throw new UnauthorizedException();
    const row = await this.db.db
      .selectFrom('users')
      .select(['id', 'email', 'name', 'email_verified_at'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!row) throw new UnauthorizedException();
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      emailVerified: row.email_verified_at != null,
    };
  }

  @Get('memberships')
  async memberships(@CurrentUser() userId: string | undefined): Promise<MembershipView[]> {
    if (!userId) throw new UnauthorizedException();

    return this.db.withRequestContext({ userId }, async (trx) => {
      const rows = await trx
        .selectFrom('memberships')
        .innerJoin('tenants', 'tenants.id', 'memberships.tenant_id')
        .select([
          'memberships.id',
          'memberships.role',
          'memberships.status',
          'tenants.id as tenantId',
          'tenants.slug as tenantSlug',
          'tenants.name as tenantName',
        ])
        .where('memberships.user_id', '=', userId)
        .orderBy('tenants.name')
        .execute();
      return rows;
    });
  }
}
