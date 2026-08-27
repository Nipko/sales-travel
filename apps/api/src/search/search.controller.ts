import { Body, Controller, ForbiddenException, Logger, Post, UseFilters } from '@nestjs/common';
import {
  FlightSearchCriteriaSchema,
  type FlightSearchCriteria,
  type OfferPriceResult,
} from '@sales-travel/domain';
import { CurrencyCodeSchema } from '@sales-travel/validation';
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

/**
 * `tenants.default_currency` → moneda del criterio, o `undefined` si no es utilizable.
 *
 * La columna es `CHAR(3)` (`db/migrations/0001_init.sql:13`), así que Postgres la devuelve
 * rellena con espacios, y no hay `CHECK` que obligue a mayúsculas. Ese valor se INYECTA en el
 * criterio **después** de que `ZodValidationPipe` validó el body, o sea que entra sin pasar por
 * ningún borde: un `'cop '` se iría tal cual a `PriceRequestInformation.CurrencyCode` y a la
 * comparación contra `offer.total.currency`, que sí llega en mayúsculas. Resultado: TODAS las
 * ofertas parecerían de otra moneda y la búsqueda se vaciaría. Se normaliza y se vuelve a
 * validar contra el mismo esquema del borde.
 *
 * Si el valor no es un ISO-4217 de tres letras se devuelve `undefined` y el criterio conserva su
 * default: preferimos buscar en la moneda por defecto que mandarle al proveedor un código que no
 * entiende.
 */
function tenantCurrency(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const parsed = CurrencyCodeSchema.safeParse(raw.trim().toUpperCase());
  return parsed.success ? parsed.data : undefined;
}

@Roles(...SELLING_ROLES)
@Controller('search')
@UseFilters(LatamNdcExceptionFilter, SabreExceptionFilter)
export class SearchController {
  private readonly logger = new Logger(SearchController.name);

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
    const moneda = await this.monedaDelTenant(tenantId);
    if (moneda !== undefined) criteria.currency = moneda;

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

    // La revalidación tiene que pedir la MISMA moneda que la búsqueda que produjo la oferta:
    // pedir otra devolvería un precio en otra unidad justo antes de reservar.
    const moneda = await this.monedaDelTenant(tenantId);
    if (moneda !== undefined) body.searchCriteria.currency = moneda;

    return this.search.priceOffer(body.offer, body.searchCriteria, tenantId);
  }

  /** Moneda de venta de la agencia, ya normalizada y validada. Ver {@link tenantCurrency}. */
  private async monedaDelTenant(tenantId: string): Promise<string | undefined> {
    const tenant = await this.db.db
      .selectFrom('tenants')
      .select(['default_currency', 'country_code', 'name'])
      .where('id', '=', tenantId)
      .executeTakeFirst();

    const moneda = tenantCurrency(tenant?.default_currency);
    if (moneda === undefined && tenant?.default_currency) {
      // Sin el valor: un `default_currency` corrupto es dato de configuración, no un secreto,
      // pero tampoco hace falta para arreglarlo — basta con saber QUÉ tenant hay que revisar.
      this.logger.warn(`search.tenant_currency_invalida tenant=${tenantId}`);
    }
    return moneda;
  }
}
