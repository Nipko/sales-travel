import { Body, Controller, ForbiddenException, Post, UseFilters } from '@nestjs/common';
import {
  FlightSearchCriteriaSchema,
  type FlightSearchCriteria,
  type OfferPriceResult,
} from '@sales-travel/domain';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { ProviderDisclosureService } from '../provider-disclosure/provider-disclosure.service.js';
import { ActiveTenantService } from '../request-context/active-tenant.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { OfferPriceBodySchema, type OfferPriceBody } from './search.schemas.js';
import { SearchService, type FlightSearchResponse } from './search.service.js';
import { LatamNdcExceptionFilter } from '../providers-latam/latam-ndc-exception.filter.js';
import { SabreExceptionFilter } from '../providers-sabre/sabre-exception.filter.js';
import { currentTenantId } from '../request-context/request-context.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';

/**
 * Sobre de la búsqueda de vuelos tal como sale por HTTP.
 *
 * `showProviderInResults` es lo ÚNICO que añade sobre `FlightSearchResponse`, y es una
 * decisión de presentación: dice si la pantalla puede nombrar al proveedor de cada oferta.
 * No filtra ni recorta nada — `offers[].provider` y `providers[]` salen intactos con el
 * ajuste apagado, porque de ahí cuelgan el enrutado de la revalidación de precio y, sobre
 * todo, el aviso de tarifa simulada. Ocultar de quién es una tarifa nunca puede ocultar
 * que esa tarifa es inventada.
 */
export interface FlightSearchEnvelope extends FlightSearchResponse {
  showProviderInResults: boolean;
}

@Roles(...SELLING_ROLES)
@Controller('search')
@UseFilters(LatamNdcExceptionFilter, SabreExceptionFilter)
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly db: DatabaseService,
    private readonly activeTenant: ActiveTenantService,
    private readonly disclosure: ProviderDisclosureService,
  ) {}

  /** El sobre CRECE, no cambia: `{ offers, simulated, providers }` sigue igual. */
  @Post('flights')
  async flights(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(FlightSearchCriteriaSchema))
    criteria: FlightSearchCriteria,
  ): Promise<FlightSearchEnvelope> {
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

    // El ajuste se resuelve FUERA de SearchService a propósito: el servicio cachea la
    // respuesta 90 s por tenant, y meterlo dentro dejaría al vendedor viendo la etiqueta
    // vieja hasta minuto y medio después de que el administrador la cambió.
    const [result, showProviderInResults] = await Promise.all([
      this.search.searchFlights(criteria, tenantId),
      this.disclosure.effective(tenantId),
    ]);

    return { ...result, showProviderInResults };
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
