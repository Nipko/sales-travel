import { z } from '@sales-travel/validation';
import { OfferSchema } from '@sales-travel/canonical';
import { FlightSearchCriteriaSchema } from '@sales-travel/domain';

/**
 * Revalidación de precio antes de reservar.
 *
 * El body llegaba sin ninguna validación (`@Body() body: { offer; searchCriteria }`), así
 * que una oferta malformada entraba tal cual al adapter del proveedor. Se valida contra
 * el mismo esquema canónico que produce la búsqueda.
 */
export const OfferPriceBodySchema = z.object({
  offer: OfferSchema,
  searchCriteria: FlightSearchCriteriaSchema,
});
export type OfferPriceBody = z.infer<typeof OfferPriceBodySchema>;
