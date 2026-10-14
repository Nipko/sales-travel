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

/**
 * El mapa de asientos de una oferta antes de reservarla (SAB-16). La misma oferta y los mismos
 * criterios que la revalidación: de los criterios salen los índices de pasajero y quién viaja con un
 * infante en brazos. `strict`: el mapa no recibe nada más del navegador.
 */
export const SeatMapBodySchema = z
  .object({
    offer: OfferSchema,
    searchCriteria: FlightSearchCriteriaSchema,
  })
  .strict();
export type SeatMapBody = z.infer<typeof SeatMapBodySchema>;
