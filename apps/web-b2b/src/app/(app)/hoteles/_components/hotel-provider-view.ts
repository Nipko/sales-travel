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
 * Omisiones que no son de ESTA búsqueda sino de la configuración: apagado para la agencia (flag
 * `opt-in` o la plataforma) o de respaldo que no hizo falta llamar.
 */
const CONFIG_SKIPS: ReadonlySet<string> = new Set([
  'opt-in-disabled',
  'platform-disabled',
  'fallback-not-needed',
]);

/**
 * Proveedores que dejaron la lista incompleta y el vendedor tiene que saberlo antes de darle un
 * precio al cliente: los que fallaron, los que se omitieron por algo de ESTA búsqueda (moneda,
 * catálogo, ocupación, destino), los que respondieron sólo por una parte de sus hoteles y los que
 * respondieron con tarifas que no se muestran.
 *
 * No entran los apagados para la agencia —por su flag o por la plataforma— ni los de respaldo que
 * no hizo falta llamar: no faltan por esta búsqueda, faltan por configuración, y un aviso en cada
 * búsqueda por algo que el vendedor no puede cambiar sólo tapa los avisos que sí importan.
 *
 * Como en vuelos, el aviso nombra al proveedor por su código aunque el ajuste esté en oculto:
 * que esos avisos respeten el ajuste sería un cambio de la política común de las dos verticales.
 */
export function degradedProviders(
  providers: readonly HotelProviderOutcome[],
): HotelProviderOutcome[] {
  return providers.filter((p) => {
    if (p.status === 'error') return true;
    if (p.status === 'skipped') return !CONFIG_SKIPS.has(p.skipReason ?? '');
    if (p.partial === true) return true;
    return p.status === 'ok' && (p.droppedForCurrency ?? 0) > 0;
  });
}

/** El estado vacío de la búsqueda (U-08): qué decir cuando no hay ningún hotel. */
export interface EmptyResultsView {
  readonly title: string;
  readonly hint: string;
}

/**
 * Sin hoteles hay lecturas muy distintas, y el vendedor le repite la que ve al cliente:
 * "no hay disponibilidad" sólo es cierto si todos los proveedores contestaron. Si alguno faltó,
 * la lista vacía es la de los que respondieron, y el aviso de arriba dice quién faltó. Y si no
 * contestó ninguno —fallaron, se omitieron o la agencia no tiene ninguno activo—, no se buscó.
 */
export function emptyResultsView(providers: readonly HotelProviderOutcome[]): EmptyResultsView {
  const missing = degradedProviders(providers).length;
  // Contestar es responder, con hoteles o sin ellos: un `error`, un `skipped` o un
  // `unavailable` no buscó nada.
  const answered = providers.some((p) => p.status === 'ok' || p.status === 'empty');
  if (!answered) {
    if (missing > 0) {
      return {
        title: 'Ningún proveedor pudo buscar esta vez.',
        hint: 'Revisa el aviso de arriba: dice qué pasó con cada uno. Que no haya resultados no quiere decir que no haya lugar.',
      };
    }
    return {
      title: 'Tu agencia no tiene proveedores de hoteles activos.',
      hint: noProvidersHint(providers),
    };
  }
  if (missing > 0) {
    return {
      title: 'Los proveedores que respondieron no tienen tarifas para mostrar.',
      hint:
        missing === 1
          ? 'Un proveedor no aportó todas sus tarifas: revisa el aviso de arriba antes de decirle al cliente que no hay lugar.'
          : `${missing} proveedores no aportaron todas sus tarifas: revisa el aviso de arriba antes de decirle al cliente que no hay lugar.`,
    };
  }
  return {
    title: 'No hay disponibilidad para ese destino y esas fechas.',
    hint: 'Prueba con otras fechas, otro destino o menos habitaciones.',
  };
}

/**
 * Qué hacer cuando la agencia no tiene ningún proveedor activo. Un proveedor que apagó la
 * plataforma no se arregla en Proveedores (GDS): mandar ahí al administrador es mandarlo a buscar
 * un interruptor que no tiene.
 */
function noProvidersHint(providers: readonly HotelProviderOutcome[]): string {
  const byPlatform = providers.filter(
    (p) => p.status === 'skipped' && p.skipReason === 'platform-disabled',
  ).length;
  if (byPlatform > 0 && byPlatform === providers.length) {
    return 'La plataforma los deshabilitó para tu agencia. Consulta con el equipo de la plataforma.';
  }
  if (byPlatform > 0) {
    return 'Un administrador puede conectar los que faltan en Proveedores (GDS); los que deshabilitó la plataforma sólo los reactiva la plataforma.';
  }
  return 'Un administrador puede conectarlos en Proveedores (GDS).';
}
