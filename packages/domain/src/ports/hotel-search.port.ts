import type { HotelOffer, HotelSearchCriteria, ProviderRawValue } from '@sales-travel/canonical';
import type { SearchContext } from './flight-search.port';

/**
 * Opciones que sólo interpreta el ACL del proveedor al que va la llamada (p. ej. el motivo de
 * cancelación con el vocabulario de Despegar, o un escenario de sandbox).
 *
 * Existen para que el puerto no crezca con un campo por cada rareza de un proveedor. Mismas
 * reglas que `ProviderRef.raw`: nunca las lee el dominio ni `apps/`, y nunca llevan secretos,
 * PAN ni PII. Lo que tiene PII o es un token de pago va en un campo tipado del puerto.
 */
export type HotelProviderOptions = Readonly<Record<string, ProviderRawValue>>;

/**
 * Disponibilidad de hoteles de UN proveedor.
 *
 * - `criteria.hotelIds` ya viene en el espacio de ids del proveedor.
 * - Cada roompack devuelto lleva `provider.name` con el código del registry: por él se enruta el
 *   PreBook y con él la web dice de qué proveedor es cada tarifa.
 * - El ACL no convierte ni descarta por moneda: devuelve la del proveedor y la puerta de moneda
 *   la aplica el servicio, que ve a todos los proveedores juntos.
 * - Sin disponibilidad es `[]`, no un error.
 */
export interface HotelSearchPort {
  searchAvailability(criteria: HotelSearchCriteria, ctx: SearchContext): Promise<HotelOffer[]>;
}

export const HOTEL_SEARCH_PORT = 'HOTEL_SEARCH_PORT';
