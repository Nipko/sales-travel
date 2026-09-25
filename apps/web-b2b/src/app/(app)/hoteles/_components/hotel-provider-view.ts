import { providerTagFor } from '../../../../lib/provider-disclosure';
import type { HotelProviderOutcome, HotelRoompack } from '../actions';

/**
 * "Me tiene que mostrar de dónde es" (RF-40), del lado de la pantalla de hoteles.
 *
 * Cada tarifa trae su proveedor en `provider.name`, se muestre o no. Qué se PINTA lo decide el
 * mismo ajuste que en vuelos (`showProviderInResults`, resuelto por el API con la cadena de la
 * red) y la misma función que pinta la pastilla en la fila de vuelos: un solo nombre legible por
 * proveedor en toda la aplicación.
 */

/**
 * Nombre legible del proveedor de UNA tarifa, o `undefined` si no se pinta nada: con el ajuste
 * apagado, o con una tarifa que no dice de dónde es (un API anterior a la búsqueda
 * multi-proveedor). Ante la duda, no se muestra.
 */
export function rateProviderLabel(
  pack: Pick<HotelRoompack, 'provider'>,
  showProvider: boolean,
): string | undefined {
  return providerTagFor(pack.provider?.name ?? '', showProvider)?.label;
}

/**
 * La tarifa más barata del hotel: la del "desde". La pastilla del "desde" es la de ESTA tarifa,
 * no la del hotel: un hotel puede tener tarifas de varios proveedores.
 */
export function cheapestRoompack(roompacks: readonly HotelRoompack[]): HotelRoompack | undefined {
  return roompacks.reduce<HotelRoompack | undefined>(
    (min, rp) =>
      min === undefined || rp.price.total.amountMinor < min.price.total.amountMinor ? rp : min,
    undefined,
  );
}

/**
 * Proveedores que dejaron la lista incompleta y el vendedor tiene que saberlo antes de darle un
 * precio al cliente: los que fallaron, los que se omitieron por algo de ESTA búsqueda (moneda,
 * catálogo, ocupación, destino) y los que respondieron pero con tarifas que no se muestran.
 *
 * No entran los apagados para la agencia ni los de respaldo que no hizo falta llamar: no faltan
 * por esta búsqueda, faltan por configuración.
 *
 * Como en vuelos, el aviso nombra al proveedor por su código aunque el ajuste esté en oculto:
 * que esos avisos respeten el ajuste sería un cambio de la política común de las dos verticales.
 */
export function degradedProviders(
  providers: readonly HotelProviderOutcome[],
): HotelProviderOutcome[] {
  return providers.filter((p) => {
    if (p.status === 'error') return true;
    if (p.status === 'skipped') {
      return p.skipReason !== 'opt-in-disabled' && p.skipReason !== 'fallback-not-needed';
    }
    return p.status === 'ok' && (p.droppedForCurrency ?? 0) > 0;
  });
}
