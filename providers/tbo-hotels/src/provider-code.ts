/**
 * Código de TBO en el registry de hoteles y en `provider.name` de cada roompack.
 *
 * Es el mismo que usa el factory de `apps/api` (`PROVIDER_CODE`), el catálogo `hotel_inventory` y
 * la web para buscar la ficha legible del proveedor (`apps/web-b2b/src/lib/provider-display.ts`).
 * Con él se enruta el PreBook y la web dice de dónde es cada tarifa (RF-40, D-TBO-06 A): un
 * literal escrito dos veces es cómo un día una tarifa sale con un proveedor que nadie reconoce.
 */
export const TBO_HOTELS_PROVIDER_CODE = 'tbo-hotels';
