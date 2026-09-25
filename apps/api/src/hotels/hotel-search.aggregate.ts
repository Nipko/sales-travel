import type { HotelOffer, HotelRoomOccupancy } from '@sales-travel/canonical';
import type { HotelOccupancyLimits } from '../providers/hotel-provider.types.js';
import type { UnavailableProvider, UnavailableReason } from '../providers/provider.types.js';
import type { ProviderSearchSlice } from '../search/search-telemetry.service.js';

/*
 * Lo que la búsqueda de hoteles hace con lo que devolvió cada proveedor, sin I/O: puerta de
 * moneda, parte por proveedor, fusión de resultados y filas de telemetría.
 *
 * Vive aparte del servicio para que cada regla se pruebe con datos y no con dobles de Nest, y
 * porque es lo que va a crecer: la agrupación por hotel canónico (PR-2.6) y los motivos de
 * omisión por proveedor (PR-2.4) entran aquí sin tocar cómo se llama a nadie.
 */

// ───────────────────────── Parte por proveedor ─────────────────────────

/**
 * Por qué un proveedor habilitado no aportó tarifas a ESTA búsqueda, aunque podía.
 *
 * - `opt-in-disabled`: está apagado para esta agencia (flag de `opt-in`). No se le llamó.
 * - `fallback-not-needed`: es de respaldo y los demás ya trajeron suficiente. No se le llamó.
 * - `catalog-empty`: su catálogo no tiene hoteles para el destino. No se le llamó.
 * - `no-destination-map`: el destino no está vinculado con sus ciudades. No se le llamó.
 * - `foreign-hotel-ids`: los ids que escribió el vendedor son de otro espacio. No se le llamó.
 * - `occupancy-limits`: la ocupación pedida excede sus topes. No se le llamó.
 * - `currency-mismatch`: SÍ se le llamó y todas sus tarifas vinieron en otra moneda.
 */
export type HotelSkipReason =
  | 'opt-in-disabled'
  | 'fallback-not-needed'
  | 'catalog-empty'
  | 'no-destination-map'
  | 'foreign-hotel-ids'
  | 'occupancy-limits'
  | 'currency-mismatch';

/**
 * Qué pasó con cada proveedor en una búsqueda. Viaja en la respuesta: sin esto, que un
 * proveedor no respondiera se veía igual que "no hay más hoteles" (RNF-13).
 *
 * No es `ProviderOutcome` de vuelos: aquel arrastra `simulated`, un residuo que hoteles nunca
 * tuvo, y sus motivos de omisión son otros.
 */
export interface HotelProviderOutcome {
  readonly code: string;
  readonly status: 'ok' | 'empty' | 'error' | 'skipped' | 'unavailable';
  /** Hoteles que este proveedor aporta a la respuesta. */
  readonly count: number;
  /**
   * Motivo ya humanizado. En `error` lo escribe el factory del proveedor y puede citar, corto, el
   * mensaje de su rechazo (como hacía el filtro de Despegar); nunca el cuerpo crudo. Presente en
   * `error`, `skipped` y `unavailable`, y en `ok` cuando parte de sus tarifas no se muestra.
   */
  readonly reason?: string;
  /** Sólo si `status === 'skipped'`. */
  readonly skipReason?: HotelSkipReason;
  /** Sólo si `status === 'unavailable'`. */
  readonly unavailableReason?: UnavailableReason;
  /** Tarifas que respondió y no se muestran por venir en otra moneda. Sólo si hubo alguna. */
  readonly droppedForCurrency?: number;
}

/**
 * Respuesta de la búsqueda. `hotels` conserva forma y orden de antes para un solo proveedor;
 * `providers` se AÑADE.
 */
export interface HotelSearchResponse {
  hotels: HotelOffer[];
  providers: HotelProviderOutcome[];
}

/** Motivos con el vocabulario del vendedor y del panel. Sin ids ni texto del proveedor. */
export const SKIP_REASON_TEXT: Readonly<
  Record<Exclude<HotelSkipReason, 'occupancy-limits' | 'currency-mismatch'>, string>
> = {
  'opt-in-disabled': 'Este proveedor no está activado para esta agencia.',
  'fallback-not-needed':
    'Es un proveedor de respaldo y los demás ya trajeron suficientes hoteles: no se le consultó.',
  'catalog-empty': 'Su catálogo de hoteles para este destino todavía no está sincronizado.',
  'no-destination-map':
    'Este destino todavía no está vinculado con las ciudades de este proveedor.',
  'foreign-hotel-ids':
    'Los IDs de hotel escritos a mano son de otro catálogo: buscá por destino para ver sus tarifas.',
};

export function skippedOutcome(
  code: string,
  skipReason: HotelSkipReason,
  reason: string,
): HotelProviderOutcome {
  return { code, status: 'skipped', count: 0, skipReason, reason };
}

export function errorOutcome(code: string, reason: string): HotelProviderOutcome {
  return { code, status: 'error', count: 0, reason };
}

export function unavailableOutcome(absence: UnavailableProvider): HotelProviderOutcome {
  return {
    code: absence.code,
    status: 'unavailable',
    count: 0,
    unavailableReason: absence.reason,
    ...(absence.detail === undefined ? {} : { reason: absence.detail }),
  };
}

/** En el orden estable del registry: alfabético por código. */
export function sortOutcomes(outcomes: readonly HotelProviderOutcome[]): HotelProviderOutcome[] {
  return [...outcomes].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

// ───────────────────────── Ocupación ─────────────────────────

/**
 * Por qué la ocupación pedida no entra en los topes del proveedor, o `undefined` si entra.
 *
 * El proveedor queda fuera de la búsqueda con este motivo: no se trunca ni se reparte la
 * ocupación para que entre, porque eso sería cotizarle al cliente otra cosa que la que pidió.
 */
export function occupancyViolation(
  rooms: readonly HotelRoomOccupancy[],
  limits: HotelOccupancyLimits | undefined,
): string | undefined {
  if (limits === undefined) return undefined;
  const { maxRooms, maxAdultsPerRoom, maxChildrenPerRoom, maxChildAge } = limits;

  if (maxRooms !== undefined && rooms.length > maxRooms) {
    return `Admite hasta ${maxRooms} habitaciones por búsqueda.`;
  }
  for (const room of rooms) {
    if (maxAdultsPerRoom !== undefined && room.adults > maxAdultsPerRoom) {
      return `Admite hasta ${maxAdultsPerRoom} adultos por habitación.`;
    }
    if (maxChildrenPerRoom !== undefined && room.childrenAges.length > maxChildrenPerRoom) {
      return `Admite hasta ${maxChildrenPerRoom} niños por habitación.`;
    }
    if (maxChildAge !== undefined && room.childrenAges.some((age) => age > maxChildAge)) {
      return `Admite niños de hasta ${maxChildAge} años.`;
    }
  }
  return undefined;
}

// ───────────────────────── Puerta de moneda ─────────────────────────

export interface CurrencyGateResult {
  readonly offers: HotelOffer[];
  /** Tarifas descartadas. */
  readonly dropped: number;
  /** Monedas en las que vinieron las descartadas, ordenadas. */
  readonly droppedCurrencies: readonly string[];
}

/**
 * Deja sólo las tarifas en la moneda de venta de la búsqueda.
 *
 * Es la misma puerta que vuelos (`search.service.ts`, `splitByCurrency`) y por los mismos
 * motivos: dos monedas en una lista se comparan como si fueran una, el orden por precio no ordena
 * y una conversión con una tasa que no tenemos es un precio que nadie puede cobrar. Va en el
 * servicio y no en el ACL porque es el único punto que ve a todos los proveedores juntos.
 *
 * Decide por `price.total`: el resto del precio de un pack ya viene en su moneda (lo exige el
 * esquema neutral) y los suplementos que se pagan en el hotel no entran en la puerta.
 *
 * Un hotel que no pierde nada sale como llegó —el mismo objeto—, y uno que llegó sin tarifas
 * también: la puerta no filtra hoteles, sólo tarifas. El que se queda sin tarifas POR la puerta
 * sí sale, porque tenía disponibilidad y ninguna se puede cotizar.
 */
export function gateByCurrency(
  offers: readonly HotelOffer[],
  currency: string,
): CurrencyGateResult {
  const kept: HotelOffer[] = [];
  const currencies = new Set<string>();
  let dropped = 0;

  for (const offer of offers) {
    const packs = offer.roompacks.filter((p) => p.price.total.currency === currency);
    if (packs.length === offer.roompacks.length) {
      kept.push(offer);
      continue;
    }
    for (const p of offer.roompacks) {
      if (p.price.total.currency !== currency) currencies.add(p.price.total.currency);
    }
    dropped += offer.roompacks.length - packs.length;
    if (packs.length > 0) kept.push({ ...offer, roompacks: packs });
  }

  return { offers: kept, dropped, droppedCurrencies: [...currencies].sort() };
}

/** Motivo para el vendedor: sólo códigos de moneda, que no son PII y son el dato accionable. */
function currencyMismatchReason(droppedCurrencies: readonly string[], expected: string): string {
  return `Cotiza en ${droppedCurrencies.join(', ')} y esta búsqueda es en ${expected}: sus tarifas no se pueden mostrar sin convertir la moneda. Revisá la moneda de la cuenta del proveedor en Mi Red → Credenciales.`;
}

function partialDropReason(
  dropped: number,
  droppedCurrencies: readonly string[],
  expected: string,
): string {
  const monedas = droppedCurrencies.join(', ');
  return dropped === 1
    ? `1 tarifa en ${monedas} no se muestra: esta búsqueda es en ${expected}.`
    : `${dropped} tarifas en ${monedas} no se muestran: esta búsqueda es en ${expected}.`;
}

/**
 * Parte de un proveedor que SÍ respondió, después de la puerta de moneda, y los hoteles que
 * aporta.
 *
 * - Nada descartado: `ok` si aporta hoteles, `empty` si no.
 * - Todo descartado: `skipped` por moneda y no aporta nada. No es `empty` —`empty` afirma que no
 *   había hoteles, y sí los había— ni `error`, porque el proveedor respondió bien.
 * - Parte descartada: sigue `ok`, con el motivo y el conteo de lo que no se muestra. Un descarte
 *   callado es la misma mentira que la mezcla, sólo que más difícil de ver.
 */
export function respondedOutcome(
  code: string,
  gate: CurrencyGateResult,
  expected: string,
): { outcome: HotelProviderOutcome; offers: HotelOffer[] } {
  if (gate.dropped === 0) {
    const count = gate.offers.length;
    return { outcome: { code, status: count > 0 ? 'ok' : 'empty', count }, offers: gate.offers };
  }

  const keptPacks = gate.offers.reduce((n, o) => n + o.roompacks.length, 0);
  if (keptPacks === 0) {
    return {
      outcome: {
        ...skippedOutcome(
          code,
          'currency-mismatch',
          currencyMismatchReason(gate.droppedCurrencies, expected),
        ),
        droppedForCurrency: gate.dropped,
      },
      offers: [],
    };
  }

  return {
    outcome: {
      code,
      status: 'ok',
      count: gate.offers.length,
      reason: partialDropReason(gate.dropped, gate.droppedCurrencies, expected),
      droppedForCurrency: gate.dropped,
    },
    offers: gate.offers,
  };
}

// ───────────────────────── Fusión ─────────────────────────

export interface ProviderOffers {
  readonly code: string;
  readonly offers: readonly HotelOffer[];
}

/**
 * Hotel canónico de un hotel de un proveedor, o `undefined` si no tiene equivalencia conocida.
 */
export type CanonicalHotelKeyOf = (providerCode: string, hotelId: string) => string | undefined;

/**
 * Une lo que aportó cada proveedor en una sola lista.
 *
 * Sin `canonicalKeyOf` —así corre hasta PR-2.6— se concatena en el orden estable de los
 * proveedores y, dentro de cada uno, en el suyo: con un solo proveedor la lista es exactamente la
 * que devolvió.
 *
 * Con `canonicalKeyOf`, los hoteles con la misma clave se funden en una tarjeta: el primero que
 * aparece pone nombre, estrellas y ubicación, y las tarifas se suman en orden. Cada tarifa
 * conserva su `provider`, así que la tarjeta sigue diciendo de dónde es cada una (RF-40); ninguna
 * atribuye el hotel entero a un solo proveedor. Un hotel sin clave no se funde con nada.
 */
export function mergeProviderOffers(
  batches: readonly ProviderOffers[],
  canonicalKeyOf?: CanonicalHotelKeyOf,
): HotelOffer[] {
  if (canonicalKeyOf === undefined) return batches.flatMap((b) => b.offers);

  const merged: HotelOffer[] = [];
  const byKey = new Map<string, number>();
  for (const batch of batches) {
    for (const offer of batch.offers) {
      const key = canonicalKeyOf(batch.code, offer.hotelId);
      const at = key === undefined ? undefined : byKey.get(key);
      if (at === undefined) {
        if (key !== undefined) byKey.set(key, merged.length);
        merged.push(offer);
        continue;
      }
      const first = merged[at] as HotelOffer;
      merged[at] = { ...first, roompacks: [...first.roompacks, ...offer.roompacks] };
    }
  }
  return merged;
}

// ───────────────────────── Telemetría ─────────────────────────

/**
 * Filas de `search_logs`, una por proveedor LLAMADO.
 *
 * Los omitidos antes de llamar no generan fila: no se les preguntó nada, y anotarlos como `empty`
 * diría que respondieron sin hoteles. El descartado por moneda sí se llamó y cuenta como `error`
 * con su propio código, igual que en vuelos, donde ese caso cae en los fallos.
 */
export function telemetrySlices(
  outcomes: readonly HotelProviderOutcome[],
  called: ReadonlySet<string>,
  durations: ReadonlyMap<string, number>,
): ProviderSearchSlice[] {
  return outcomes
    .filter((o) => called.has(o.code))
    .map((o): ProviderSearchSlice => {
      const base = { providerCode: o.code, durationMs: durations.get(o.code) ?? 0 };
      if (o.status === 'error') {
        return { ...base, resultCount: 0, outcome: 'error', errorCode: 'ProviderCallError' };
      }
      if (o.status === 'skipped') {
        return { ...base, resultCount: 0, outcome: 'error', errorCode: 'CurrencyMismatch' };
      }
      return { ...base, resultCount: o.count, outcome: o.count > 0 ? 'ok' : 'empty' };
    });
}
