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
    console.warn(
      `[SearchController.flights] Resolving flights for userId: ${userId}, tenantId: ${tenantId}`,
    );

    // Obtener la moneda base del tenant/agencia e inyectarla
    const tenant = await this.db.db
      .selectFrom('tenants')
      .select(['default_currency', 'country_code', 'name'])
      .where('id', '=', tenantId)
      .executeTakeFirst();

    console.warn(
      `[SearchController.flights] Tenant configuration from DB: ${JSON.stringify(tenant)}`,
    );
    console.warn(
      `[SearchController.flights] Search criteria before injected currency: ${JSON.stringify(criteria)}`,
    );

    if (tenant?.default_currency) {
      criteria.currency = tenant.default_currency.trim();
      console.warn(
        `[SearchController.flights] Injected tenant default currency: ${criteria.currency}`,
      );
    } else {
      console.warn(
        `[SearchController.flights] No default_currency found for tenant ${tenantId}, using criteria default: ${criteria.currency}`,
      );
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
    console.warn(
      `[SearchController.offerPrice] Resolving offerPrice for userId: ${userId}, tenantId: ${tenantId}`,
    );

    // Obtener la moneda base del tenant/agencia e inyectarla
    const tenant = await this.db.db
      .selectFrom('tenants')
      .select(['default_currency', 'country_code', 'name'])
      .where('id', '=', tenantId)
      .executeTakeFirst();

    console.warn(
      `[SearchController.offerPrice] Tenant configuration from DB: ${JSON.stringify(tenant)}`,
    );
    console.warn(
      `[SearchController.offerPrice] Search criteria before injected currency: ${JSON.stringify(body.searchCriteria)}`,
    );

    if (tenant?.default_currency) {
      body.searchCriteria.currency = tenant.default_currency.trim();
      console.warn(
        `[SearchController.offerPrice] Injected tenant default currency: ${body.searchCriteria.currency}`,
      );
    } else {
      console.warn(
        `[SearchController.offerPrice] No default_currency found for tenant ${tenantId}, using criteria default: ${body.searchCriteria.currency}`,
      );
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
