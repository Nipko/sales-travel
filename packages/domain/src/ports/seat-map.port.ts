import type { Offer, SeatMap } from '@sales-travel/canonical';
import type { FlightSearchCriteria, SearchContext } from './flight-search.port';

/**
 * Mapa de asientos ANTES de reservar, para la oferta que el vendedor está por cerrar.
 *
 * Los criterios son imprescindibles: dicen cuántos adultos, niños e infantes viajan, y de ahí
 * salen los índices de pasajero de `SeatOffer.passengerIndex` y quién viaja con un infante en
 * brazos. La lectura posterior a la reserva (por orden) es otro caso y no vive aquí.
 *
 * Un proveedor que no puede pintar el mapa lanza: un mapa vacío se leería como «no quedan
 * asientos», que es otra cosa.
 */
export interface SeatMapPort {
  getSeatMap(offer: Offer, criteria: FlightSearchCriteria, ctx: SearchContext): Promise<SeatMap>;
}

export const SEAT_MAP_PORT = 'SEAT_MAP_PORT';
