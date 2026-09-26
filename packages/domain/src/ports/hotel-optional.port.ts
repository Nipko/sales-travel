import type {
  HotelOffer,
  HotelRatesQuery,
  HotelTax,
  Money,
  ProviderRawValue,
} from '@sales-travel/canonical';
import type { SearchContext } from './flight-search.port';
import type { HotelBookingStatus, HotelBookingView } from './hotel-booking-read.port';
import type { HotelProviderOptions } from './hotel-search.port';

/*
 * Capacidades que NO todo proveedor de hoteles tiene. Cada una es un puerto aparte y no un
 * método opcional del adapter: quien la implementa es porque puede sostenerla, y quien la usa la
 * detecta por la presencia del método, como `supportsAuditedCreate` en vuelos. Un método opcional
 * trasladaría la duda a cada llamador en forma de `?.`.
 */

// ───────────────────────── Lectura por nuestra referencia ─────────────────────────

/**
 * Lee una reserva por la referencia que ENVIAMOS al reservar, no por el localizador del
 * proveedor. Es lo único que permite verificar un Book cuya respuesta no llegó.
 */
export interface HotelBookingByClientReferencePort {
  getBookingByClientReference(
    bookingReference: string,
    ctx: SearchContext,
  ): Promise<HotelBookingView>;
}

// ───────────────────────── Reservas por fecha (conciliación) ─────────────────────────

/**
 * Una ventana de fechas de CREACIÓN de reserva, `YYYY-MM-DD`, con los dos extremos incluidos. Nunca
 * más larga que `maxBookingDateWindowDays` del adapter: quien necesita un rango más largo lo parte.
 */
export interface HotelBookingDateRange {
  from: string;
  to: string;
}

/** Una reserva de la cuenta creada dentro de la ventana pedida. Sin datos del huésped. */
export interface HotelBookingSummary {
  providerBookingId: string;
  /** `YYYY-MM-DD`, siempre dentro de la ventana pedida. */
  bookingDate: string;
  /** Nuestra referencia, la que mandamos al reservar, si la fila la trae legible. */
  bookingReference?: string;
  /** Ausente si el proveedor no lo informó en esta lectura. */
  status?: HotelBookingStatus;
  providerStatus?: string;
  /** Cancelada, con el reembolso del proveedor a la cuenta todavía pendiente. */
  refundAwaited?: boolean;
  checkinDate?: string;
  checkoutDate?: string;
  hotelId?: string;
  /** Lo que el proveedor factura por la reserva, con la comisión de la agencia incluida. */
  total?: Money;
  /** La comisión de la agencia titular de la cuenta sobre `total`. */
  agencyCommission?: Money;
  /** Moneda de la fila, aunque sus montos no se hayan podido leer. */
  currency?: string;
  /** Agencia que hizo la reserva según el proveedor: dato comercial del titular de la cuenta. */
  agencyName?: string;
  /** Id interno del proveedor, sólo para soporte. */
  providerRecordId?: string;
}

/**
 * Lo que devolvió UNA ventana, entera: el proveedor respondió con éxito y todas las filas caen
 * dentro de la ventana pedida. Si no, el adapter lanza. De esta lectura sale "la reserva no está en
 * el proveedor", y eso no se concluye con una ventana a medias.
 */
export interface HotelBookingsByDateResult {
  range: HotelBookingDateRange;
  bookings: HotelBookingSummary[];
}

/** Las reservas de la cuenta del adapter, por fecha de creación: la conciliación diaria. */
export interface HotelBookingsByDatePort {
  /** Cuántos días de calendario, con los dos extremos, acepta una ventana. */
  readonly maxBookingDateWindowDays: number;
  listBookingsByDate(
    range: HotelBookingDateRange,
    ctx: SearchContext,
  ): Promise<HotelBookingsByDateResult>;
}

// ───────────────────────── Sugerencias de destino ─────────────────────────

/**
 * Un destino del autocompletado. Los ids son los del espacio de destinos de la plataforma, que
 * hoy es el del proveedor de sugerencias: el resto de los proveedores se enlaza a él por tabla,
 * no con un autocompletado propio.
 */
export interface HotelDestinationSuggestion {
  id: number;
  /** Id geográfico con el que se resuelven los hoteles del destino. */
  gid: string;
  /** Tipo de lugar (ciudad, hotel, …) según el proveedor de sugerencias, sin interpretar. */
  type: number;
  display: string;
  city?: string;
  country?: string;
}

export interface HotelSuggestPort {
  suggestDestinations(
    query: string,
    ctx: SearchContext,
    locale?: string,
  ): Promise<HotelDestinationSuggestion[]>;
}

// ───────────────────────── Tarifas de un hotel ─────────────────────────

/**
 * Todas las tarifas de un solo hotel, con el detalle que el listado no trae (políticas, precio
 * por noche). Es la pantalla desde la que se elige qué reservar.
 */
export interface HotelRatesDetailPort {
  getHotelRates(query: HotelRatesQuery, ctx: SearchContext): Promise<HotelOffer>;
}

// ───────────────────────── Medios de pago ─────────────────────────

export interface HotelPaymentOptionsQuery {
  prebookRef: string;
  inputPoints?: number;
  includeHints?: boolean;
}

export interface HotelPaymentOptionChoice {
  optionType: string;
  /** El plan que el Book exige en cada unidad de pago. */
  planId?: string;
}

export interface HotelPaymentModality {
  modality: string;
  total: Money;
  base?: Money;
  taxes?: Money;
  fees?: Money;
  discount?: Money;
  processingCost?: Money;
  taxBreakdown: HotelTax[];
  options: HotelPaymentOptionChoice[];
}

/** Para el proveedor que cobra con checkout alojado y ofrece planes de pago por prebook. */
export interface HotelPaymentOptionsPort {
  getPaymentOptions(
    query: HotelPaymentOptionsQuery,
    ctx: SearchContext,
  ): Promise<HotelPaymentModality[]>;
}

// ───────────────────────── Salto de precio al reservar ─────────────────────────

/**
 * Respuesta del vendedor a un salto de precio que el proveedor detectó DURANTE el Book y dejó
 * la reserva esperando confirmación.
 */
export interface HotelPriceJumpDecision {
  providerBookingId: string;
  /** Lo que devolvió la lectura de la reserva al detectar el salto; opaco para el dominio. */
  messageType: string;
  confirmations: { productRef: string; accept: boolean }[];
  providerOptions?: HotelProviderOptions;
}

export interface HotelPriceJumpResult {
  /** Respuesta del proveedor, opaca para el dominio. Nunca lleva PII. */
  providerDetail?: Readonly<Record<string, ProviderRawValue>>;
}

export interface HotelPriceJumpRecoveryPort {
  confirmPriceJump(
    decision: HotelPriceJumpDecision,
    ctx: SearchContext,
  ): Promise<HotelPriceJumpResult>;
}
