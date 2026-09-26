import type { HotelOffer, HotelRatesQuery, HotelSearchCriteria } from '@sales-travel/canonical';
import type {
  HotelBookPort,
  HotelBookingByClientReferencePort,
  HotelBookingReadPort,
  HotelBookingsByDatePort,
  HotelCancelPort,
  HotelPaymentOptionsPort,
  HotelPrebookPort,
  HotelPriceJumpRecoveryPort,
  HotelRatesDetailPort,
  HotelSearchPort,
  HotelSuggestPort,
  SearchContext,
} from '@sales-travel/domain';
import type { ProviderCircuitOptions } from '../search/circuit-breaker.service.js';
import type {
  ProviderErrorContext,
  ResolvedProvider,
  SkippedProvider,
  TenantProviderFactory,
  UnavailableProvider,
} from './provider.types.js';

/**
 * Un adapter de hoteles = los cinco puertos que todo proveedor de hoteles tiene que sostener:
 * disponibilidad, revalidación, reserva, lectura y cancelación.
 *
 * Lo que no todos saben hacer (sugerencias de destino, tarifas de un hotel, medios de pago,
 * salto de precio, lectura por nuestra referencia, reservas por fecha) NO va aquí como método
 * opcional: cada cosa es un puerto aparte y se detecta por la presencia del método con los
 * `supportsHotel*` de abajo. Un `?` en el contrato trasladaría la duda a cada llamador.
 */
export interface HotelProviderAdapter
  extends HotelSearchPort,
    HotelPrebookPort,
    HotelBookPort,
    HotelBookingReadPort,
    HotelCancelPort {}

/**
 * Qué sabe hacer un proveedor de hoteles. Estático por proveedor: sirve para gatear la
 * post-venta sin resolver credenciales.
 *
 * No es `ProviderCapabilities` de vuelos: `pay`, `services` y `reshop` no significan nada en un
 * hotel, y en cambio falta lo que decide si una reserva cuya respuesta no llegó se puede
 * verificar sin reservar dos veces.
 */
export interface HotelProviderCapabilities {
  readonly retrieve: boolean;
  readonly cancel: boolean;
  /**
   * Lee una reserva por la referencia que ENVIAMOS. Es lo único que permite verificar un Book
   * que se cortó antes de devolver el localizador del proveedor.
   */
  readonly retrieveByClientReference: boolean;
  /** Lista las reservas de la cuenta por fecha, para la conciliación diaria. */
  readonly reconcileByDate: boolean;
}

export type HotelProviderCapability = keyof HotelProviderCapabilities;

// ───────────────────────── Cómo se le pregunta a cada proveedor ─────────────────────────

/**
 * En qué espacio de ids viven los destinos y los hoteles del proveedor.
 *
 * - `platform`: los del autocompletado de destinos y los `hotelIds` que escribe el vendedor. Sus
 *   hoteles se buscan en `hotel_inventory.city_id` con el destino tal cual.
 * - `provider`: un espacio propio (`hotel_inventory.provider_city_code`). El destino se traduce
 *   con `hotel_destination_map` y un id que escribió el vendedor no le sirve: mandárselo podría
 *   traer OTRO hotel con el mismo número.
 */
export type HotelIdSpace = 'platform' | 'provider';

/**
 * Proveedor cuyo espacio de ids ES el de la plataforma: su autocompletado da el `destinationId`
 * del borde HTTP y su catálogo usa `hotel_inventory.city_id`. Es el `source_provider_code` de las
 * filas de `hotel_destination_map` con que un proveedor de ids propios traduce ese destino a sus
 * ciudades (docs/tbo/05 §8.1).
 */
export const PLATFORM_ID_SPACE_PROVIDER = 'despegar-hotels';

/**
 * Con qué criterio se eligen, de su catálogo, los hoteles que se le piden al proveedor cuando el
 * destino tiene más de los que caben en una búsqueda.
 *
 * - `hotel_id`: determinista y sin criterio comercial. Es el de Despegar, que no se cambia sin
 *   telemetría (docs/tbo/09 PR-0.5).
 * - `relevance`: primero los de más estrellas, los que no las informan al final y el id como
 *   desempate (docs/tbo/02 §4.3; D-TBO-17 A). Con cientos de hoteles en una ciudad, el orden por
 *   id dejaba fuera a los que el vendedor más busca.
 */
export type HotelCatalogOrder = 'hotel_id' | 'relevance';

/**
 * Topes de ocupación del PROVEEDOR, más estrechos que los del borde HTTP. Un campo ausente
 * significa que el proveedor acepta lo mismo que el borde.
 */
export interface HotelOccupancyLimits {
  readonly maxRooms?: number;
  readonly maxAdultsPerRoom?: number;
  readonly maxChildrenPerRoom?: number;
  readonly maxChildAge?: number;
}

/**
 * Lo que el servicio de búsqueda necesita saber de un proveedor ANTES de llamarlo. Estático por
 * proveedor, como las capacidades: se lee sin tocar credenciales.
 */
export interface HotelSearchProfile {
  readonly idSpace: HotelIdSpace;
  /** Cuántos hoteles de su catálogo se le piden, como mucho, por búsqueda. */
  readonly maxHotelsPerSearch: number;
  readonly catalogOrder: HotelCatalogOrder;
  readonly occupancy?: HotelOccupancyLimits;
  /**
   * Tarifa según la nacionalidad del pasajero principal (TBO, p. 10): sin ella en la búsqueda, el
   * proveedor queda fuera con motivo y los demás buscan. Ausente, no la necesita.
   */
  readonly requiresGuestNationality?: boolean;
  /**
   * Su disponibilidad no trae nombre, estrellas, dirección ni coordenadas (TBO, pp. 13-15): el
   * servicio los completa desde SU fila de `hotel_inventory`, sólo donde el proveedor no los
   * informó. Ausente, el proveedor los trae y el catálogo no se consulta para eso.
   */
  readonly contentFromCatalog?: boolean;
}

/**
 * Contrato del factory de un proveedor de hoteles: `TenantProviderFactory` con las capacidades
 * de hoteles y SIN `forTenant`.
 *
 * `forTenant` queda fuera porque el registry no lo usa —resuelve con `resolveForTenant`, que es
 * lo que dice de dónde salieron las credenciales—. El de Despegar lo conserva para las rutas de
 * reserva que todavía hablan sus DTOs (`DespegarHotelReservationsService`); exigirlo aquí
 * obligaría a cada proveedor nuevo a exponer su ACL concreto.
 */
export interface HotelProviderFactory
  extends Pick<
    TenantProviderFactory<HotelProviderAdapter>,
    'code' | 'defaultCallPolicy' | 'resolveForTenant'
  > {
  /**
   * Literal y no `ProviderVertical`: un factory de vuelos en la lista de hoteles es un error de
   * cableado y tiene que serlo en compilación.
   */
  readonly vertical: 'hotels';
  readonly capabilities: HotelProviderCapabilities;
  readonly searchProfile: HotelSearchProfile;
  /**
   * Como el de `TenantProviderFactory`, más lo que sabe quien llama: con una cuenta heredada el
   * mensaje de una credencial rechazada va dirigido al consolidador, no a la agencia. Un factory
   * que no lo necesita lo ignora.
   */
  humanizeError(err: unknown, context?: ProviderErrorContext): string;
}

export interface ResolvedHotelProvider
  extends Omit<ResolvedProvider<HotelProviderAdapter>, 'capabilities'> {
  readonly capabilities: HotelProviderCapabilities;
  readonly searchProfile: HotelSearchProfile;
  /** Lo que el factory declaró para el breaker; se pasa tal cual en cada llamada al adapter. */
  readonly circuit?: ProviderCircuitOptions;
}

/** Un proveedor conocido por la plataforma, sin resolver credenciales de nadie. */
export interface HotelProviderRegistration {
  readonly code: string;
  readonly searchProfile: HotelSearchProfile;
}

export interface HotelProviderResolution {
  /** Proveedores llamables, en orden ESTABLE (alfabético por code). */
  readonly active: ResolvedHotelProvider[];
  /** Habilitados pero no llamados en esta búsqueda, con el motivo. */
  readonly skipped: SkippedProvider[];
  /** Conocidos por la plataforma pero no resolubles para este tenant, con el motivo. */
  readonly unavailable: UnavailableProvider[];
}

/** Token DI del listado de factories de hoteles. Sumar un proveedor = una línea en el módulo. */
export const HOTEL_PROVIDER_FACTORIES = 'HOTEL_PROVIDER_FACTORIES';

/**
 * Token DI del gobierno por tenant de `callPolicy: 'opt-in'` en hoteles. Es otro token que el de
 * vuelos a propósito: activar un proveedor de vuelos para una agencia no puede encender uno de
 * hoteles, que factura distinto.
 */
export const HOTEL_PROVIDER_FLAGS = 'HOTEL_PROVIDER_FLAGS';

// ───────────────────────── Contexto de búsqueda en el servidor (RF-08) ─────────────────────────

/**
 * Huella de la cuenta con la que un adapter sale al proveedor: id de la cuenta y su versión,
 * NUNCA el secreto. Al reservar se compara con la de la búsqueda: si la credencial rotó, o la
 * agencia pasó de heredada a propia, la tarifa se buscó con otra cuenta y se vuelve a buscar.
 */
export interface HotelProviderAccountFingerprint {
  readonly accountId: string;
  /** `provider_accounts.updated_at` en ISO 8601: cambia al rotar la credencial. */
  readonly updatedAt: string;
}

/**
 * Lo que la reserva de UNA tarifa necesita reenviar al proveedor y el navegador no puede aportar.
 * En TBO: `HotelCode`, `BookingCode` y el literal de `TotalFare` (docs/tbo/02 §9.3).
 */
export interface HotelSearchPackContext {
  readonly hotelId: string;
  /** El mismo `provider.offerRef` del roompack. */
  readonly offerRef: string;
  /**
   * El total tal como lo escribió el proveedor. El Book de TBO lo reenvía y no puede ser una
   * reconstrucción desde unidades menores (02 §8.3).
   */
  readonly totalText: string;
  readonly currency: string;
}

/** Lo que una búsqueda deja en el servidor además de las ofertas. */
export interface HotelSearchContextData {
  /** Id NUESTRO de la búsqueda: única clave que viaja en `provider.raw` de cada pack. */
  readonly searchId: string;
  /** Epoch en ms en que salió el Search: el reloj de la oferta arranca aquí (RF-09). */
  readonly searchSentAt: number;
  /** Epoch en ms hasta el que el proveedor sostiene las tarifas: el TTL del contexto. */
  readonly expiresAt: number;
  readonly packs: readonly HotelSearchPackContext[];
}

export interface HotelSearchWithContext extends HotelSearchContextData {
  readonly offers: HotelOffer[];
  /**
   * Presente si parte de los hoteles pedidos no se consultó o su consulta falló, y otra parte sí
   * respondió (RF-14 CA-3): las ofertas son las de lo que respondió. `cause` es el error del primer
   * tramo que no aportó, para humanizarlo como cualquier fallo del proveedor. Sin esto, un lote
   * caído se vería como "no hay más hoteles" (RNF-13).
   */
  readonly partial?: { readonly cause: unknown };
}

export interface HotelRatesWithContext extends HotelSearchContextData {
  readonly offer: HotelOffer;
}

/**
 * Un proveedor cuya reserva depende de lo que dejó su búsqueda (RF-08): el PreBook de TBO recibe
 * sólo el `BookingCode` y el Book no lleva fechas, edades ni nacionalidad (pp. 19, 32-34). Sin
 * este registro del lado del servidor, la ocupación y el importe que llegan al proveedor los
 * pondría el navegador.
 */
export interface HotelSearchContextPort {
  readonly searchAccount: HotelProviderAccountFingerprint;
  searchAvailabilityWithContext(
    criteria: HotelSearchCriteria,
    ctx: SearchContext,
  ): Promise<HotelSearchWithContext>;
}

/**
 * Igual que `HotelSearchContextPort`, para el detalle de un hotel: un proveedor cuyo detalle es
 * otra búsqueda emite tarifas nuevas, y la que se reserva es la del detalle.
 */
export interface HotelRatesContextPort {
  readonly searchAccount: HotelProviderAccountFingerprint;
  getHotelRatesWithContext(
    query: HotelRatesQuery,
    ctx: SearchContext,
  ): Promise<HotelRatesWithContext>;
}

// ───────────────────────── Capacidades opcionales, por presencia ─────────────────────────
//
// Mismo criterio que `supportsAuditedCreate` en vuelos: el registry entrega
// `HotelProviderAdapter`, y preguntar por la clase concreta de un proveedor es el
// `if (provider === 'x')` que el registry existe para quitar.

/**
 * El nombre se tipa contra el puerto: con un `string` suelto, una errata o un renombre del
 * puerto dejaría la guarda en `false` para siempre, y el saga no vería una verificación que el
 * adapter sí sabe hacer.
 */
function hasMethod<TPort extends object>(adapter: object, name: keyof TPort & string): boolean {
  return typeof (adapter as Record<string, unknown>)[name] === 'function';
}

export function supportsHotelSuggest<T extends object>(
  adapter: T,
): adapter is T & HotelSuggestPort {
  return hasMethod<HotelSuggestPort>(adapter, 'suggestDestinations');
}

export function supportsHotelRatesDetail<T extends object>(
  adapter: T,
): adapter is T & HotelRatesDetailPort {
  return hasMethod<HotelRatesDetailPort>(adapter, 'getHotelRates');
}

export function supportsHotelPaymentOptions<T extends object>(
  adapter: T,
): adapter is T & HotelPaymentOptionsPort {
  return hasMethod<HotelPaymentOptionsPort>(adapter, 'getPaymentOptions');
}

export function supportsHotelPriceJumpRecovery<T extends object>(
  adapter: T,
): adapter is T & HotelPriceJumpRecoveryPort {
  return hasMethod<HotelPriceJumpRecoveryPort>(adapter, 'confirmPriceJump');
}

export function supportsHotelBookingByClientReference<T extends object>(
  adapter: T,
): adapter is T & HotelBookingByClientReferencePort {
  return hasMethod<HotelBookingByClientReferencePort>(adapter, 'getBookingByClientReference');
}

export function supportsHotelBookingsByDate<T extends object>(
  adapter: T,
): adapter is T & HotelBookingsByDatePort {
  return hasMethod<HotelBookingsByDatePort>(adapter, 'listBookingsByDate');
}

export function supportsHotelSearchContext<T extends object>(
  adapter: T,
): adapter is T & HotelSearchContextPort {
  return hasMethod<HotelSearchContextPort>(adapter, 'searchAvailabilityWithContext');
}

export function supportsHotelRatesContext<T extends object>(
  adapter: T,
): adapter is T & HotelRatesContextPort {
  return hasMethod<HotelRatesContextPort>(adapter, 'getHotelRatesWithContext');
}
