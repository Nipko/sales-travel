import { Body, Controller, ForbiddenException, Post, UseFilters } from '@nestjs/common';
import {
  FlightSearchCriteriaSchema,
  type FlightSearchCriteria,
  type OfferPriceResult,
} from '@sales-travel/domain';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { OfferPriceBodySchema, type OfferPriceBody } from './search.schemas.js';
import { SearchService, type FlightSearchResponse } from './search.service.js';
import { LatamNdcExceptionFilter } from '../providers-latam/latam-ndc-exception.filter.js';
import { SabreExceptionFilter } from '../providers-sabre/sabre-exception.filter.js';
import { currentTenantId } from '../request-context/request-context.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';

@Roles(...SELLING_ROLES)
@Controller('search')
@UseFilters(LatamNdcExceptionFilter, SabreExceptionFilter)
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly db: DatabaseService,
    private readonly activeTenant: ActiveTenantService,
  ) {}

  /** El sobre CRECE, no cambia: `{ offers, simulated }` sigue igual y `providers[]` se añade. */
  @Post('flights')
  async flights(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(FlightSearchCriteriaSchema))
    criteria: FlightSearchCriteria,
  ): Promise<FlightSearchResponse> {
    if (!userId) throw new ForbiddenException();

    const tenantId = currentTenantId() ?? (await this.activeTenant.resolve(userId));

    // Moneda base del tenant, inyectada en el criterio. (Sin logs de PII/criterios.)
    const tenant = await this.db.db
      .selectFrom('tenants')
      .select(['default_currency', 'country_code', 'name'])
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (tenant?.default_currency) {
      criteria.currency = tenant.default_currency.trim();
    }

    return this.search.searchFlights(criteria, tenantId);
  }

  @Post('offer-price')
  async offerPrice(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(OfferPriceBodySchema)) body: OfferPriceBody,
  ): Promise<OfferPriceResult> {
    if (!userId) throw new ForbiddenException();

    const tenantId = currentTenantId() ?? (await this.activeTenant.resolve(userId));

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
}
