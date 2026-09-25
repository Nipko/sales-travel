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
} from '@sales-travel/domain';
import type {
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
 * Con qué criterio se eligen, de su catálogo, los hoteles que se le piden al proveedor cuando el
 * destino tiene más de los que caben en una búsqueda. Hoy sólo existe el orden por id, que es
 * determinista; el de relevancia llega con el primer proveedor que lo necesite.
 */
export type HotelCatalogOrder = 'hotel_id';

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
    'code' | 'defaultCallPolicy' | 'resolveForTenant' | 'humanizeError'
  > {
  /**
   * Literal y no `ProviderVertical`: un factory de vuelos en la lista de hoteles es un error de
   * cableado y tiene que serlo en compilación.
   */
  readonly vertical: 'hotels';
  readonly capabilities: HotelProviderCapabilities;
  readonly searchProfile: HotelSearchProfile;
}

export interface ResolvedHotelProvider
  extends Omit<ResolvedProvider<HotelProviderAdapter>, 'capabilities'> {
  readonly capabilities: HotelProviderCapabilities;
  readonly searchProfile: HotelSearchProfile;
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
