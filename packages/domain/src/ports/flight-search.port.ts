import {
  CabinClassSchema,
  IataAirportCodeSchema,
  PaxCountSchema,
  type Offer,
} from '@sales-travel/canonical';
import { CurrencyCodeSchema, z } from '@sales-travel/validation';

/**
 * Qué nombra el código de origen o destino: una ciudad entera (código de ciudad o metropolitano,
 * p. ej. SAO = GRU + CGH + VCP, o MDE = MDE + EOH) o un aeropuerto concreto.
 *
 * Hace falta porque el código solo no lo dice: MDE es a la vez Medellín y su aeropuerto
 * principal. Sin el dato cada proveedor aplica su default (Sabre BFM: ciudad).
 */
export const LocationKindSchema = z.enum(['city', 'airport']);
export type LocationKind = z.infer<typeof LocationKindSchema>;

export const FlightSearchCriteriaSchema = z.object({
  origin: IataAirportCodeSchema,
  destination: IataAirportCodeSchema,
  originKind: LocationKindSchema.optional(),
  destinationKind: LocationKindSchema.optional(),
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

/**
 * Port OPCIONAL: las vueltas que combinan con una ida ya elegida, cada una con su precio de ida y
 * vuelta. Es el segundo paso de «elegir ida + tarifa, después vuelta + tarifa». Sabre lo hace con
 * Anchored Search (docs/sabre/15 §2.5); un proveedor que no lo implemente deja que la UI elija la
 * vuelta entre las combinaciones de la primera búsqueda.
 */
export interface FlightReturnSearchPort {
  searchReturns(
    criteria: FlightSearchCriteria,
    outbound: Offer,
    ctx: SearchContext,
  ): Promise<Offer[]>;
}

export interface SearchContext {
  tenantId: string;
  /** Para distinguir solicitudes en logs/tracing. */
  requestId?: string;
}

/** Token DI para inyectar implementaciones intercambiables del port. */
export const FLIGHT_SEARCH_PORT = 'FLIGHT_SEARCH_PORT';
