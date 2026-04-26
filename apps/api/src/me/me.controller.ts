import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';

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
