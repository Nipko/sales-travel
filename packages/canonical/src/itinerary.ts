import { z } from '@sales-travel/validation';
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
});
export type Itinerary = z.infer<typeof ItinerarySchema>;
