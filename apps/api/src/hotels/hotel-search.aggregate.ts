import {
  HotelOfferSchema,
  type HotelOffer,
  type HotelProviderHotel,
  type HotelRoomOccupancy,
} from '@sales-travel/canonical';
import type { z } from '@sales-travel/validation';
import type {
  HotelOccupancyLimits,
  HotelSearchProfile,
} from '../providers/hotel-provider.types.js';
import type { UnavailableProvider, UnavailableReason } from '../providers/provider.types.js';
import type { ProviderSearchSlice } from '../search/search-telemetry.service.js';

/*
 * Lo que la búsqueda de hoteles decide sin I/O: a quién no se le pregunta y por qué, puerta de
 * moneda, parte por proveedor, contenido de catálogo, fusión de resultados por hotel canónico y
 * filas de telemetría.
 *
 * Vive aparte del servicio para que cada regla se pruebe con datos y no con dobles de Nest.
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
 * - `guest-nationality-missing`: tarifa según la nacionalidad del pasajero principal y la búsqueda
 *   no la trae. No se le llamó.
 * - `currency-mismatch`: SÍ se le llamó y todas sus tarifas vinieron en otra moneda.
 */
export type HotelSkipReason =
  | 'opt-in-disabled'
  | 'fallback-not-needed'
  | 'catalog-empty'
  | 'no-destination-map'
  | 'foreign-hotel-ids'
  | 'occupancy-limits'
  | 'guest-nationality-missing'
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
  /**
   * Parte de sus hoteles no se consultó o falló, y otra parte sí respondió (RF-14 CA-3). `count` y
   * `status` son los de lo que respondió; `reason` dice qué faltó. Sólo presente en `true`.
   */
  readonly partial?: true;
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
  'guest-nationality-missing':
    'Cotiza según la nacionalidad del pasajero principal: indicala en la búsqueda para ver sus tarifas.',
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

/** Lo de la búsqueda que decide, antes de llamarlo, si un proveedor puede participar. */
export interface SearchEligibilityInput {
  readonly rooms: readonly HotelRoomOccupancy[];
  readonly guestNationality?: string;
}

/**
 * Parte `skipped` de un proveedor activo que no puede buscar ESTA búsqueda, o `undefined` si puede.
 *
 * Primero la ocupación: no se arregla completando un campo, y pedirle la nacionalidad al vendedor
 * para que después el proveedor igual quede fuera sería mandarlo a hacer algo inútil.
 *
 * La nacionalidad que falta no se completa con nada —ni el país de la agencia ni uno guardado en la
 * cuenta del proveedor—: fijarla es lo que TBO pide no hacer y por lo que declina responsabilidad
 * (KP-1, p. 71). El resto de los proveedores busca igual (RF-06).
 */
export function searchEligibilitySkip(
  code: string,
  search: SearchEligibilityInput,
  profile: Pick<HotelSearchProfile, 'occupancy' | 'requiresGuestNationality'>,
): HotelProviderOutcome | undefined {
  const excess = occupancyViolation(search.rooms, profile.occupancy);
  if (excess !== undefined) return skippedOutcome(code, 'occupancy-limits', excess);

  // En blanco cuenta como ausente, igual que en el ACL de TBO: si aquí pasara, el proveedor
  // respondería con un error en vez de quedar fuera con el motivo.
  const nationality = search.guestNationality?.trim() ?? '';
  if (profile.requiresGuestNationality === true && nationality === '') {
    return skippedOutcome(
      code,
      'guest-nationality-missing',
      SKIP_REASON_TEXT['guest-nationality-missing'],
    );
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

/**
 * La parte de un proveedor que respondió sólo en parte (RF-14 CA-3). No cambia `status` ni
 * `count`, que dicen lo que SÍ llegó; marca `partial` y antepone qué faltó al motivo que ya
 * hubiera (por ejemplo, el de moneda).
 */
export function partialOutcome(
  outcome: HotelProviderOutcome,
  reason: string,
): HotelProviderOutcome {
  return {
    ...outcome,
    partial: true,
    reason: outcome.reason === undefined ? reason : `${reason} ${outcome.reason}`,
  };
}

// ───────────────────────── Contenido desde el catálogo ─────────────────────────

/**
 * La fila de `hotel_inventory` de UN hotel de UN proveedor, con lo que la tarjeta muestra. Los
 * nombres son los de la tabla; `stars` es `NUMERIC` y llega como texto.
 */
export interface HotelCatalogRow {
  readonly hotel_id: string;
  readonly name: string | null;
  readonly stars: string | number | null;
  readonly address: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export type HotelCatalogFacts = Pick<HotelOffer, 'name' | 'stars' | 'address' | 'location'>;

const OfferShape = HotelOfferSchema.shape;

/** El valor si cumple el contrato de la oferta; si no, ausente: nunca una oferta inválida. */
function valid<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> | undefined {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? (parsed.data as z.infer<S>) : undefined;
}

function textOf(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Lo que la fila del catálogo aporta a la oferta, validado contra el contrato neutral: el sync
 * escribe lo que mandó el proveedor (una dirección con espacios al final, p. 67; unas estrellas
 * fuera de rango), y un campo que no cumple se omite en vez de invalidar la oferta entera.
 */
export function catalogFactsOf(row: HotelCatalogRow): HotelCatalogFacts {
  const facts: HotelCatalogFacts = {};
  const name = valid(OfferShape.name, textOf(row.name));
  if (name !== undefined) facts.name = name;
  const stars = valid(OfferShape.stars, row.stars === null ? undefined : Number(row.stars));
  if (stars !== undefined) facts.stars = stars;
  const address = valid(OfferShape.address, textOf(row.address));
  if (address !== undefined) facts.address = address;
  if (row.latitude !== null && row.longitude !== null) {
    const location = valid(OfferShape.location, { lat: row.latitude, lng: row.longitude });
    if (location !== undefined) facts.location = location;
  }
  return facts;
}

/**
 * Completa la oferta con el catálogo SÓLO donde el proveedor no informó el dato: lo que dice el
 * proveedor que vende la tarifa gana siempre (RF-34). Sin nada que completar, sale el mismo
 * objeto.
 */
export function withCatalogFacts(
  offer: HotelOffer,
  facts: HotelCatalogFacts | undefined,
): HotelOffer {
  if (facts === undefined) return offer;
  const filled: HotelOffer = { ...offer };
  let changed = false;
  for (const key of ['name', 'stars', 'address', 'location'] as const) {
    if (offer[key] === undefined && facts[key] !== undefined) {
      Object.assign(filled, { [key]: facts[key] });
      changed = true;
    }
  }
  return changed ? filled : offer;
}

// ───────────────────────── Fusión ─────────────────────────

export interface ProviderOffers {
  readonly code: string;
  readonly offers: readonly HotelOffer[];
  /** Motivo ya humanizado de lo que NO respondió, si respondió sólo en parte (RF-14 CA-3). */
  readonly partialReason?: string;
}

/**
 * Hotel canónico de un hotel de un proveedor, o `undefined` si no tiene equivalencia conocida.
 */
export type CanonicalHotelKeyOf = (providerCode: string, hotelId: string) => string | undefined;

interface MergedCard {
  readonly at: number;
  readonly hotels: HotelProviderHotel[];
}

/**
 * Une lo que aportó cada proveedor en una sola lista.
 *
 * Sin `canonicalKeyOf` se concatena en el orden estable de los proveedores y, dentro de cada uno,
 * en el suyo: con un solo proveedor la lista es exactamente la que devolvió.
 *
 * Con `canonicalKeyOf` (equivalencias aceptadas de `hotel_match`, RF-34), el mismo hotel de dos
 * proveedores se funde en una tarjeta que SUMA sus tarifas en vez de quedarse con la más barata:
 * el vendedor perdería regímenes y políticas. El primero que aparece pone nombre, estrellas,
 * dirección y ubicación, y el siguiente sólo completa lo que falte. Cada tarifa conserva su
 * `provider`, así que la tarjeta sigue diciendo de dónde es cada una (RF-40) y ninguna atribuye el
 * hotel entero a un proveedor; `providerHotels` dice con qué id lo conoce cada uno.
 *
 * Nunca se funden dos hoteles de un MISMO proveedor, aunque compartan clave: el proveedor dice que
 * son dos, y una fusión falsa es peor que un duplicado (docs/tbo/05 §9.3). Un hotel sin clave
 * tampoco se funde con nada.
 */
export function mergeProviderOffers(
  batches: readonly ProviderOffers[],
  canonicalKeyOf?: CanonicalHotelKeyOf,
): HotelOffer[] {
  if (canonicalKeyOf === undefined) return batches.flatMap((b) => b.offers);

  const merged: HotelOffer[] = [];
  const cards = new Map<string, MergedCard>();
  for (const batch of batches) {
    for (const offer of batch.offers) {
      const key = canonicalKeyOf(batch.code, offer.hotelId);
      const card = key === undefined ? undefined : cards.get(key);
      if (card === undefined || card.hotels.some((h) => h.provider === batch.code)) {
        if (key !== undefined && card === undefined) {
          cards.set(key, {
            at: merged.length,
            hotels: [{ provider: batch.code, hotelId: offer.hotelId }],
          });
        }
        merged.push(offer);
        continue;
      }
      card.hotels.push({ provider: batch.code, hotelId: offer.hotelId });
      const first = withCatalogFacts(merged[card.at] as HotelOffer, offer);
      merged[card.at] = {
        ...first,
        roompacks: [...first.roompacks, ...offer.roompacks],
        providerHotels: [...card.hotels],
      };
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
