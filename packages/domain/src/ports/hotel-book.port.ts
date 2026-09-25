import type { ProviderRef } from '@sales-travel/canonical';
import type { SearchContext } from './flight-search.port';
import type { HotelProviderOptions } from './hotel-search.port';

export interface HotelGuestDocument {
  type: 'PASSPORT' | 'NATIONAL_ID';
  number: string;
  /** ISO 3166-1 alfa-2. */
  issuingCountry?: string;
}

export interface HotelGuest {
  paxType: 'ADT' | 'CHD';
  title?: 'Mr' | 'Mrs' | 'Ms';
  firstName: string;
  lastName: string;
  gender?: 'M' | 'F';
  /**
   * Edad al viajar. Obligatoria en la práctica para un `CHD`: la tarifa se cotizó con ella.
   */
  age?: number;
  /** YYYY-MM-DD. */
  birthDate?: string;
  /** ISO 3166-1 alfa-2. */
  nationality?: string;
  document?: HotelGuestDocument;
}

/**
 * Los huéspedes de UNA habitación del pack, en el mismo orden que `rooms` de la búsqueda: el
 * proveedor asocia la lista j con la habitación j. El primero es el huésped principal.
 */
export interface HotelBookingRoomGuests {
  guests: HotelGuest[];
}

export interface HotelBookingContact {
  email: string;
  phone: { countryCode: string; areaCode?: string; number: string };
}

/** Un pago con token del checkout alojado (PCI SAQ-A). */
export interface HotelPaymentTokenUnit {
  /** Plan de pago que eligió el vendedor entre los que ofreció el proveedor. */
  planId: string;
  /** Token de la tokenización alojada. Nunca PAN ni CVV. */
  secureToken: string;
  type?: string;
  invoiceReference?: number;
  cardHolderDocument?: HotelGuestDocument;
}

/**
 * Datos de facturación fiscal (DIAN, SUNAT, NF-e) que algunos proveedores emiten con la
 * reserva.
 */
export interface HotelFiscalInvoice {
  reference: number;
  fiscalName: string;
  firstName?: string;
  lastName?: string;
  fiscalStatus: string;
  fiscalId: { type: string; number: string; issuingCountry?: string; expirationDate?: string };
  fiscalAddress: {
    street: string;
    number: string;
    apartment?: string;
    floor?: string;
    neighborhood?: string;
    cityId: string;
    zipCode: string;
  };
}

/**
 * Cómo se paga la reserva al proveedor. Ninguna rama admite datos de tarjeta: o lo carga el
 * proveedor al crédito de la cuenta, o llega un token de un checkout alojado.
 */
export type HotelBookPayment =
  | { kind: 'agency-credit' }
  | {
      kind: 'hosted-token';
      optionType: string;
      units: HotelPaymentTokenUnit[];
      invoices?: HotelFiscalInvoice[];
    };

export interface HotelBookRequest {
  /** La tarifa revalidada que el vendedor aceptó, desde el snapshot del servidor. */
  offer: ProviderRef;
  /** Prebook del proveedor, si lo emitió. */
  prebookRef?: string;
  /**
   * Referencia NUESTRA de la reserva, generada y persistida antes de llamar. Es con la que se
   * busca la reserva si la respuesta del Book no llega.
   */
  bookingReference: string;
  /** Una entrada por habitación del pack, en su orden. */
  rooms: HotelBookingRoomGuests[];
  contact: HotelBookingContact;
  payment: HotelBookPayment;
  /** Contexto del cliente que algunos proveedores piden para antifraude. */
  client?: { ip?: string; userAgent?: string };
  providerOptions?: HotelProviderOptions;
}

/**
 * Desenlace de un Book.
 *
 * - `CONFIRMED`: el proveedor confirmó la reserva.
 * - `PENDING`: el proveedor la aceptó pero todavía no la resolvió; hay que consultarla.
 * - `FAILED`: el proveedor dijo que no reservó nada.
 * - `UNCERTAIN`: respondió, pero sin lo que prueba la reserva (sin localizador, o con una
 *   referencia que no es la enviada). Puede existir: se verifica leyendo, nunca reintentando.
 *
 * Una excepción tampoco es `FAILED`: un timeout es el proveedor no diciendo nada.
 */
export type HotelBookOutcome = 'CONFIRMED' | 'PENDING' | 'FAILED' | 'UNCERTAIN';

export interface HotelBookResult {
  outcome: HotelBookOutcome;
  /** Localizador de la reserva en el proveedor. */
  providerBookingId?: string;
  /** La referencia que el proveedor devolvió, para compararla con la enviada. */
  bookingReference?: string;
  /** Estado crudo del proveedor, como código y sin texto libre. */
  providerStatus?: string;
  providerSubStatus?: string;
  warnings: string[];
}

export interface HotelBookPort {
  book(request: HotelBookRequest, ctx: SearchContext): Promise<HotelBookResult>;
}

export const HOTEL_BOOK_PORT = 'HOTEL_BOOK_PORT';
