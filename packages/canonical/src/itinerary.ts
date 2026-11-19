import { z } from '@sales-travel/validation';
import { BaggageSchema } from './baggage';
import { SegmentSchema } from './segment';

/**
 * Un itinerario es una secuencia ordenada de segmentos que el pax recorre
 * de punta a punta. Para un round-trip simple suele haber 2 itinerarios:
 * outbound y inbound. Para multi-city, uno por tramo declarado.
 */
export const ItinerarySchema = z.object({
  segments: z.array(SegmentSchema).min(1).max(8),
  totalDurationMinutes: z.number().int().positive(),
  stops: z.number().int().nonnegative(),
  /**
   * La franquicia de ESTE trayecto, cuando el proveedor la da por tramo. Ausente = no informada
   * por trayecto (vale `Offer.baggage`). Existe porque una ida y vuelta puede llevar franquicias
   * distintas, y mostrar la de la ida en la vuelta es prometer una maleta que no va.
   */
  baggage: BaggageSchema.optional(),
});
export type Itinerary = z.infer<typeof ItinerarySchema>;
