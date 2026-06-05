import { Body, Controller, ForbiddenException, Post } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import {
  FlightSearchCriteriaSchema,
  type FlightSearchCriteria,
  type OfferPriceResult,
} from '@sales-travel/domain';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { SearchService } from './search.service.js';
import { currentTenantId } from '../request-context/request-context.js';

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

    const tenantId = currentTenantId() ?? (await this.resolveActiveTenant(userId));

    // Moneda base del tenant, inyectada en el criterio. (Sin logs de PII/criterios.)
    const tenant = await this.db.db
      .selectFrom('tenants')
      .select(['default_currency', 'country_code', 'name'])
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (tenant?.default_currency) {
      criteria.currency = tenant.default_currency.trim();
    }

    const offers = await this.search.searchFlights(criteria, tenantId);
    return { offers };
  }

  @Post('offer-price')
  async offerPrice(
    @CurrentUser() userId: string | undefined,
    @Body() body: { offer: Offer; searchCriteria: FlightSearchCriteria },
  ): Promise<OfferPriceResult> {
    if (!userId) throw new ForbiddenException();

    const tenantId = currentTenantId() ?? (await this.resolveActiveTenant(userId));

    const tenant = await this.db.db
      .selectFrom('tenants')
      .select(['default_currency', 'country_code', 'name'])
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (tenant?.default_currency) {
      body.searchCriteria.currency = tenant.default_currency.trim();
    }

    return this.search.priceOffer(body.offer, body.searchCriteria, tenantId);
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
