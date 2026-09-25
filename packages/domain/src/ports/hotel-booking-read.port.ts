import type { SearchContext } from './flight-search.port';

/**
 * Estado normalizado de una reserva de hotel en el proveedor.
 *
 * `CANCELLATION_IN_PROGRESS` existe porque hay proveedores que aceptan una cancelación sin
 * terminarla (pedido enviado al hotel, pendiente de respuesta). Colapsarlo con `CANCELLED` da por
 * liberada una habitación que sigue cobrable; colapsarlo con `CONFIRMED` invita a cancelar dos
 * veces. `UNKNOWN` es un valor del proveedor fuera de su propia enumeración: se escala, no se
 * adivina.
 */
export type HotelBookingStatus =
  | 'CONFIRMED'
  | 'PENDING'
  | 'CANCELLATION_IN_PROGRESS'
  | 'CANCELLED'
  | 'FAILED'
  | 'UNKNOWN';

/** Vista de sólo lectura de una reserva de hotel. */
export interface HotelBookingView {
  found: boolean;
  providerBookingId?: string;
  /** Nuestra referencia, enviada al reservar. */
  bookingReference?: string;
  status?: HotelBookingStatus;
  /** Valor crudo del proveedor, como código y sin texto libre. */
  providerStatus?: string;
  providerSubStatus?: string;
  /** Cancelada, con el reembolso del proveedor a la cuenta todavía pendiente. */
  refundAwaited?: boolean;
  /** Número de confirmación del HOTEL, que no es el localizador del proveedor y llega más tarde. */
  hotelConfirmationNumber?: string;
  warnings: string[];
}

export interface HotelBookingReadPort {
  getBooking(providerBookingId: string, ctx: SearchContext): Promise<HotelBookingView>;
}

export const HOTEL_BOOKING_READ_PORT = 'HOTEL_BOOKING_READ_PORT';
