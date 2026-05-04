import { Body, Controller, ForbiddenException, Post } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import { FlightSearchCriteriaSchema, type FlightSearchCriteria } from '@sales-travel/domain';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { SearchService } from './search.service.js';

@Controller('search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly db: DatabaseService,
  ) {}

  @Post('flights')
  async flights(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(FlightSearchCriteriaSchema))
    criteria: FlightSearchCriteria,
  ): Promise<{ offers: Offer[] }> {
    if (!userId) throw new ForbiddenException();

    const tenantId = await this.resolveActiveTenant(userId);
    const offers = await this.search.searchFlights(criteria, tenantId);
    return { offers };
  }

  /**
   * Sprint 0 simplificado: el primer tenant activo del usuario es el "tenant
   * actual". Cuando implementemos /auth/switch-tenant, esto va a leer un
   * claim del JWT.
   */
  private async resolveActiveTenant(userId: string): Promise<string> {
    return this.db.withRequestContext({ userId }, async (trx) => {
      const row = await trx
        .selectFrom('memberships')
        .select(['tenant_id'])
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .orderBy('created_at')
        .limit(1)
        .executeTakeFirst();
      if (!row) throw new ForbiddenException('user has no active membership');
      return row.tenant_id;
    });
  }
}
