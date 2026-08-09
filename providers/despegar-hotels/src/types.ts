import type { BoardType, Money } from '@sales-travel/canonical';

/** Sugerencia geográfica del autocomplete (ciudad u hotel). `gid` resuelve hoteles por destino. */
export interface GeoSuggestion {
  id: number;
  gid: string;
  type: number;
  display: string;
  city?: string;
  country?: string;
}

export type CancellationStatus = 'non_refundable' | 'partially_refundable' | 'fully_refundable';

export interface CancellationRule {
  type: string;
  penaltyPercentage?: number;
  penaltyNights?: number;
  fromHours?: number;
  toHours?: number;
}

export interface HotelCancellation {
  refundable: boolean;
  status: CancellationStatus;
  hoursBeforePenalty?: number;
  vendorNotes?: string;
  rules: CancellationRule[];
}

export interface HotelTax {
  code: string;
  amount: Money;
}

/** Desglose de precio del roompack. Montos en unidades menores (Money). */
export interface HotelPrice {
  /** Neto del proveedor (lo que cuesta la estadía). */
  total: Money;
  taxes?: Money;
  taxesDetail: HotelTax[];
  /** A pagar en el hotel (no se cobra en la reserva). */
  chargeAtDestination?: Money;
  /** Comisión B2B que expone Despegar (base para el waterfall del consolidador). */
  agencyCommission?: { amount: Money; percentage: number };
}

export interface HotelRoomItem {
  name: string;
  reference: number;
  roomTypeId?: string;
  maxCapacity?: number;
  bedOptions: string[];
  /** Token bookable — sólo presente en el detalle (availability/{hotel_id}). */
  choiceId?: string;
}

/**
 * Pricing waterfall del consolidador aplicado a un roompack.
 *
 * Mismo contrato que el de vuelos (canonical Offer.pricing): `price.total` sigue siendo
 * el NETO del proveedor y nunca se muta; `finalMinor` es el precio de VENTA.
 */
export interface HotelPricing {
  /** Lo que le cuesta a ESTE tenant: neto del proveedor + markup de su red por encima. */
  costMinor: number;
  finalMinor: number;
  /** Margen propio del tenant. No incluye el de sus ancestros. */
  ownMarkupMinor: number;
  currency: string;
}

/** Combinación bookable de habitaciones con un único precio (roompack de Despegar). */
export interface HotelRoompack {
  id: string;
  board: BoardType;
  rooms: HotelRoomItem[];
  cancellation: HotelCancellation;
  price: HotelPrice;
  /** Ausente si el tenant no tiene reglas de markup: precio de venta = neto. */
  pricing?: HotelPricing;
}

export interface HotelOffer {
  hotelId: string;
  name?: string;
  stars?: number;
  type?: string;
  location?: { lat: number; lng: number };
  roompacks: HotelRoompack[];
}

/** Distribución de una habitación: adultos + edades de los niños. */
export interface RoomDistribution {
  adults: number;
  childrenAges: number[];
}

export interface AvailabilityQuery {
  checkinDate: string; // YYYY-MM-DD
  checkoutDate: string; // YYYY-MM-DD
  currency: string;
  hotelIds: string[]; // hasta 100 (50 recomendado)
  rooms: RoomDistribution[]; // → distribution string
  countryCode?: string;
  language?: 'EN' | 'ES' | 'PT';
  ttl?: number;
  refundableOnly?: boolean;
}

export interface HotelDetailQuery {
  hotelId: string;
  checkinDate: string;
  checkoutDate: string;
  currency: string;
  rooms: RoomDistribution[];
  roompackId?: string;
  countryCode?: string;
  language?: 'EN' | 'ES' | 'PT';
  ttl?: number;
  refundableOnly?: boolean;
}
