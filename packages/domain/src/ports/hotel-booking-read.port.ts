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
  /**
   * Si el proveedor ya emitió el voucher. Ausente = no lo informó o informó algo que no se
   * entiende. Una reserva confirmada con `false` sigue confirmada y se avisa: hay proveedores
   * que sólo reservan con voucher, y un "confirmada sin voucher" es algo que mirar.
   */
  voucherIssued?: boolean;
  /** Número de confirmación del HOTEL, que no es el localizador del proveedor y llega más tarde. */
  hotelConfirmationNumber?: string;
  warnings: string[];
}

/**
 * Para qué se lee una reserva. Un proveedor con cupo de llamadas por cuenta elige con esto el cupo y
 * los reintentos, para que un job no le quite capacidad al vendedor ni al revés; uno sin cupos lo
 * ignora. Sin propósito, el adapter decide como siempre.
 *
 * - `interactive`: una persona espera la respuesta en el panel.
 * - `booking`: la lectura que cierra una reserva recién hecha, dentro de la misma venta.
 * - `verification`: un job que busca una reserva cuyo Book no respondió. No espera detrás de las
 *   búsquedas, y una ráfaga de verificaciones no les quita más que su propio techo.
 * - `background`: el resto de los jobs (HCN, verificación de una cancelación, conciliación). Cede
 *   ante las ventas.
 */
export type HotelBookingReadPurpose = 'interactive' | 'booking' | 'verification' | 'background';

export interface HotelBookingReadOptions {
  readonly purpose?: HotelBookingReadPurpose;
}

export interface HotelBookingReadPort {
  getBooking(
    providerBookingId: string,
    ctx: SearchContext,
    options?: HotelBookingReadOptions,
  ): Promise<HotelBookingView>;
}

export const HOTEL_BOOKING_READ_PORT = 'HOTEL_BOOKING_READ_PORT';
