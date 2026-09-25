import type { SearchContext } from './flight-search.port';
import type { HotelBookingStatus } from './hotel-booking-read.port';
import type { HotelProviderOptions } from './hotel-search.port';
import type { OrderCancelResult } from './order-manage.port';

export interface HotelCancelRequest {
  providerBookingId: string;
  providerOptions?: HotelProviderOptions;
}

/**
 * Resultado de cancelar una reserva de hotel.
 *
 * Extiende `OrderCancelResult` para que la cancelación genérica de órdenes lo consuma sin
 * adaptarlo. `success` sólo dice que el proveedor aceptó el pedido; `bookingStatus` dice si
 * quedó cancelada o sólo en curso, que es lo que `success` no puede expresar.
 *
 * `refundAmount` queda vacío si el proveedor no lo informa: una estimación nuestra no se
 * presenta como dato del proveedor.
 */
export interface HotelCancelResult extends OrderCancelResult {
  /** Estado leído después del pedido. Ausente si esa lectura no se hizo o falló. */
  bookingStatus?: HotelBookingStatus;
  providerStatus?: string;
}

export interface HotelCancelPort {
  cancelBooking(request: HotelCancelRequest, ctx: SearchContext): Promise<HotelCancelResult>;
}

export const HOTEL_CANCEL_PORT = 'HOTEL_CANCEL_PORT';
