import {
  CabinClassSchema,
  IataAirportCodeSchema,
  PaxCountSchema,
  type Offer,
} from '@sales-travel/canonical';
import { CurrencyCodeSchema, z } from '@sales-travel/validation';

export const FlightSearchCriteriaSchema = z.object({
  origin: IataAirportCodeSchema,
  destination: IataAirportCodeSchema,
  departureDate: z.string().date(),
  returnDate: z.string().date().optional(),
  paxCount: PaxCountSchema,
  cabin: CabinClassSchema.optional(),
  currency: CurrencyCodeSchema.default('USD'),
});
export type FlightSearchCriteria = z.infer<typeof FlightSearchCriteriaSchema>;

export interface FlightSearchPort {
  /**
   * Devuelve offers válidas (no expiradas) para los criterios dados.
   * Los implementos (ACL por proveedor) se encargan de mapear el DTO crudo
   * del proveedor al modelo canónico Offer/Itinerary/Segment.
   */
  search(criteria: FlightSearchCriteria, ctx: SearchContext): Promise<Offer[]>;
}

export interface SearchContext {
  tenantId: string;
  /** Para distinguir solicitudes en logs/tracing. */
  requestId?: string;
}

/** Token DI para inyectar implementaciones intercambiables del port. */
export const FLIGHT_SEARCH_PORT = 'FLIGHT_SEARCH_PORT';
