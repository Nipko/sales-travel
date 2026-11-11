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

/**
 * Las vueltas para una ida ya elegida (docs/sabre/15 §5). La ida es una oferta de la búsqueda de ida
 * y vuelta tal como la recibió el navegador, con su marca por trayecto en `fareComponents`.
 */
export const ReturnSearchBodySchema = z
  .object({
    outbound: OfferSchema,
    searchCriteria: FlightSearchCriteriaSchema,
  })
  .strict();
export type ReturnSearchBody = z.infer<typeof ReturnSearchBodySchema>;

/**
 * Más tarifas de UN vuelo (docs/platform/18): las ofertas que la pantalla ya tiene de ese vuelo
 * (pocas: las de un solo itinerario), su aerolínea y el trayecto cuya marca se mueve. Con
 * `leg: 1`, la ida elegida.
 */
export const MoreFaresBodySchema = z
  .object({
    searchCriteria: FlightSearchCriteriaSchema,
    carrier: z.string().regex(/^[A-Z0-9]{2,3}$/),
    leg: z.number().int().min(0).max(1),
    known: z.array(OfferSchema).min(1).max(20),
    outbound: OfferSchema.optional(),
  })
  .strict();
export type MoreFaresBody = z.infer<typeof MoreFaresBodySchema>;
