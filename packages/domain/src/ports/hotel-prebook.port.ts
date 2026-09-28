import type { HotelRoompack, Money, ProviderRef } from '@sales-travel/canonical';
import type { SearchContext } from './flight-search.port';
import type { HotelProviderOptions } from './hotel-search.port';

export interface HotelPrebookRequest {
  /**
   * La tarifa a revalidar, como la emitió el ACL en la búsqueda.
   *
   * La resuelve el servidor desde su contexto de búsqueda, nunca desde el navegador: el cliente
   * sólo dice cuál de las tarifas que ya se le mostraron quiere.
   */
  offer: ProviderRef;
  /**
   * Instante (ISO 8601 con zona) en que salió la búsqueda que emitió la tarifa. Con él el ACL
   * decide que la oferta venció sin llamar al proveedor.
   */
  searchSentAt?: string;
  language?: 'es' | 'pt' | 'en';
  providerOptions?: HotelProviderOptions;
}

/** Categoría de una condición de la tarifa, deducida del texto: es ayuda visual, no contrato. */
export type HotelRateConditionCategory =
  | 'checkIn'
  | 'checkOut'
  | 'minCheckInAge'
  | 'mandatoryFees'
  | 'optionalFees'
  | 'cardsAccepted'
  | 'specialInstructions'
  | 'other';

/**
 * Una condición de la tarifa ("norma" del hotel), en las dos versiones que exige una disputa:
 * la saneada, que es la que se muestra, y la original.
 */
export interface HotelRateCondition {
  category: HotelRateConditionCategory;
  /** Texto plano: sin HTML, con las entidades decodificadas una sola vez. */
  text: string;
  /** Tal como llegó. Nunca se renderiza como HTML. */
  raw: string;
}

/**
 * Restricciones de la tarifa que cambian si se puede vender. Vocabulario cerrado: el texto del
 * proveedor no decide nada por sí solo.
 */
export type HotelRateSignal = 'PACKAGE_WITH_FLIGHT_ONLY' | 'NO_NAME_CHANGE' | 'MARKET_RESTRICTION';

export interface HotelPrebookResult {
  /**
   * Identificador del prebook si el proveedor lo emite (Despegar). Quien no lo emite lo deja
   * vacío.
   */
  prebookRef?: string;
  /** Neto revalidado, en la moneda del proveedor. */
  total: Money;
  /** ISO 8601 con zona: hay que reservar antes. */
  expiresAt?: string;
  /**
   * El pack con las condiciones que el proveedor da por finales, si las devuelve. Sus políticas
   * llevan `policySource: 'prebook-final'`.
   */
  roompack?: HotelRoompack;
  rateConditions: HotelRateCondition[];
  signals: HotelRateSignal[];
  /** Comisión B2B confirmada, si el proveedor la expone. */
  agencyCommission?: { amount: Money; minAmount?: Money; maxAmount?: Money };
  /** Estado crudo del proveedor, como código. */
  providerStatus?: string;
  warnings: string[];
}

/**
 * Revalida disponibilidad y precio de una tarifa antes de reservar.
 *
 * El puerto NO compara contra lo que vio el vendedor: devuelve lo vigente, y la comparación la
 * hace quien tiene guardado lo que se mostró.
 */
export interface HotelPrebookPort {
  prebook(request: HotelPrebookRequest, ctx: SearchContext): Promise<HotelPrebookResult>;
}

export const HOTEL_PREBOOK_PORT = 'HOTEL_PREBOOK_PORT';
