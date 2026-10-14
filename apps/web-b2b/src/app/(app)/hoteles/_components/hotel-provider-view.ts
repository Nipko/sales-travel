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

/** Qué tarifas vienen de una cuenta de prueba de su proveedor, y cómo nombrarlo si se puede. */
export interface TestAccountView {
  /** Proveedores cuya cuenta es de prueba: sus planes llevan la etiqueta «Prueba». */
  readonly codes: ReadonlySet<string>;
  /**
   * Nombre legible del proveedor para el aviso, sólo con la divulgación encendida y uno solo de
   * prueba. Sin él, el aviso habla de «un proveedor».
   */
  readonly providerLabel?: string;
}

/**
 * Los proveedores que aportaron tarifas con una cuenta de prueba (`accountEnvironment: 'test'`).
 * Una reserva con ellos no es una habitación de verdad, así que el aviso va SIEMPRE, como el de una
 * tarifa simulada en vuelos: lo único que respeta el ajuste de divulgación es si se nombra al
 * proveedor. Uno que respondió sin hoteles (`count: 0`) no tiene tarifas a la vista de las que
 * avisar. Sirve igual para la búsqueda y sus tramos (`providers[]`) y para la ficha, que pasa una
 * parte por proveedor con el entorno del detalle y cuántas tarifas dio.
 */
export function testAccountView(
  providers: readonly (Pick<HotelProviderOutcome, 'code' | 'accountEnvironment'> & {
    readonly count?: number;
  })[],
  showProvider: boolean,
): TestAccountView {
  const codes = new Set(
    providers.filter((p) => p.accountEnvironment === 'test' && p.count !== 0).map((p) => p.code),
  );
  const [only] = codes;
  const label =
    codes.size === 1 && only !== undefined ? providerTagFor(only, showProvider)?.label : undefined;
  return label === undefined ? { codes } : { codes, providerLabel: label };
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

/** La nota de los proveedores que no participan de la búsqueda por la configuración de la agencia. */
export interface DisabledProvidersNote {
  /** Lo que se ve con la nota plegada. */
  readonly summary: string;
  /** Lo que se ve al desplegarla: por qué y qué hacer. */
  readonly lines: readonly string[];
}

/** Los apagados para la agencia: por el flag de `opt-in` o por la plataforma. */
const DISABLED_SKIPS: ReadonlySet<string> = new Set(['opt-in-disabled', 'platform-disabled']);

/**
 * Por qué no aparecen los hoteles de un proveedor apagado para la agencia —sobre todo TBO, que es
 * `opt-in`—, en vez de callarlo. No es el aviso de resultados incompletos (no falta por ESTA
 * búsqueda, y el vendedor no lo puede cambiar): es una nota informativa, plegada.
 *
 * Con la divulgación encendida nombra a cada proveedor y dice quién lo resuelve; apagada, no lo
 * nombra (como la pastilla de cada tarifa). El de respaldo que no hizo falta llamar no está apagado:
 * no se menciona.
 */
export function disabledProvidersNote(
  providers: readonly Pick<HotelProviderOutcome, 'code' | 'status' | 'skipReason'>[],
  showProvider: boolean,
): DisabledProvidersNote | undefined {
  const byCode = new Map<string, 'opt-in-disabled' | 'platform-disabled'>();
  for (const p of providers) {
    if (p.status !== 'skipped' || !DISABLED_SKIPS.has(p.skipReason ?? '')) continue;
    // El de la plataforma manda: no se arregla pidiéndoselo a la red.
    if (byCode.get(p.code) !== 'platform-disabled') {
      byCode.set(p.code, p.skipReason as 'opt-in-disabled' | 'platform-disabled');
    }
  }
  const n = byCode.size;
  if (n === 0) return undefined;

  const named = [...byCode].map(([code, reason]) => ({
    reason,
    label: providerTagFor(code, showProvider)?.label,
  }));
  if (showProvider && named.every((p) => p.label !== undefined)) {
    const [first] = named;
    return {
      summary:
        n === 1 && first !== undefined
          ? `${first.label} no participa de esta búsqueda.`
          : `${n} proveedores de hoteles no participan de esta búsqueda.`,
      lines: named.map(({ label, reason }) =>
        reason === 'platform-disabled'
          ? `${label} está apagado por la plataforma en este momento.`
          : `${label} no está habilitado para tu agencia: sus hoteles no aparecen en esta búsqueda. Pídele a quien administra tu red que lo habilite.`,
      ),
    };
  }
  return n === 1
    ? {
        summary: 'Un proveedor de hoteles no participa de esta búsqueda.',
        lines: [
          'Un proveedor de hoteles no está habilitado para tu agencia: sus hoteles no aparecen en esta búsqueda.',
        ],
      }
    : {
        summary: `${n} proveedores de hoteles no participan de esta búsqueda.`,
        lines: [
          `${n} proveedores de hoteles no están habilitados para tu agencia: sus hoteles no aparecen en esta búsqueda.`,
        ],
      };
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
