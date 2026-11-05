import type { Offer } from '../cotizaciones/actions';
import type { OrderCapabilities } from './order-capabilities';

/*
 * Una orden tal como la devuelven `GET /api/orders` y `GET /api/orders/:id`, compartida por la
 * lista de Reservas y el detalle de cada reserva. Todo lo polimórfico es opcional: una orden de
 * auto o de hotel no trae itinerario, y una vieja puede no traer lo que se agregó después.
 */

export interface OrderSegment {
  carrier: string;
  operatingCarrier?: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  arrivalAt: string;
  durationMinutes: number;
  cabin?: string;
  bookingClass?: string;
  aircraft?: string;
}

export interface OrderPassenger {
  givenName: string;
  surname: string;
  paxType: string;
  birthdate?: string;
  /**
   * El API nunca manda el número entero del documento: sólo sus últimos caracteres (`numberLast4`),
   * nunca más de la mitad. La pantalla lo muestra para reconocerlo, no para copiarlo.
   */
  identityDoc?: { type?: string; numberLast4?: string };
}

export interface Order {
  id: string;
  pnr: string | null;
  status: string;
  orderNumber: number;
  provider?: string;
  /** La cotización de la que salió (vuelos): ahí vive la facturación. */
  quotationId?: string | null;
  capabilities?: Partial<OrderCapabilities>;
  // searchCriteria es polimórfico por vertical: vuelos traen origin/destination/departureDate,
  // autos traen vertical:'cars' + campos de pickup/dropoff, hoteles vertical:'hotels' + la estadía.
  // Todo opcional para no romper render.
  searchCriteria: {
    // vuelos
    origin?: string;
    destination?: string;
    departureDate?: string;
    returnDate?: string;
    tripType?: string;
    cabin?: string;
    paxCount?: { adults: number; children: number; infants: number };
    // autos
    vertical?: string;
    pickUpLocation?: string;
    dropOffLocation?: string;
    pickUpDate?: string;
    dropOffDate?: string;
    pickUpHour?: string;
    dropOffHour?: string;
  };
  selectedOffer?: {
    // vuelos (la oferta canónica entera; aquí sólo lo que la lista lee)
    itineraries?: { segments: OrderSegment[]; totalDurationMinutes: number; stops: number }[];
    provider?: { name?: string; raw?: Record<string, unknown>; environment?: string };
    fareFamily?: { name: string };
    total?: { amountMinor: number; currency: string };
    // autos
    category?: string;
    carModel?: string;
    companyName?: string;
    sippCode?: string;
  };
  passengers: OrderPassenger[];
  contactInfo?: { email?: string; phone?: string };
  totalAmount: number;
  currency: string;
  errorMessage?: string | null;
  /** `true` = se reservó con la cuenta de pruebas del proveedor: no es un tiquete válido. */
  testContent?: boolean;
  /** Sólo en hoteles: subestado, estado del proveedor y HCN, sin PII (RF-26). */
  providerTracking?: unknown;
  /** Sólo en vuelos: localizadores de la aerolínea, tiquetes y plazo guardados (0082). */
  flightTracking?: unknown;
  /** Saldo retenido en la cartera que cancelar libera (SAB-10); `null` si no hay nada que liberar. */
  walletHold?: 'held' | 'captured' | null;
  createdAt: string;
  updatedAt?: string;
}

export interface ServiceItem {
  offerItemId: string;
  serviceId: string;
  description: string;
  journeyRefId?: string;
  paxRefIds: string[];
  price: { amount: number; currency: string };
  cancellable: boolean;
}

export const ORDER_STATUS_CONFIG: Readonly<Record<string, { label: string; className: string }>> = {
  pending: { label: 'Pendiente', className: 'bg-amber-50 text-amber-700' },
  confirmed: { label: 'Confirmada', className: 'bg-blue-50 text-blue-700' },
  ticketed: { label: 'Emitida', className: 'bg-green-50 text-green-700' },
  cancelled: { label: 'Cancelada', className: 'bg-red-50 text-red-700' },
  failed: { label: 'Fallida', className: 'bg-red-50 text-red-700' },
};

export const PAX_TYPE_LABEL: Readonly<Record<string, string>> = {
  ADT: 'Adulto',
  CHD: 'Niño',
  INF: 'Infante',
  DRIVER: 'Conductor',
};

/** Montos de la lista: sin decimales, como siempre los mostró Reservas. */
export function formatOrderMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);
}

export function formatRelativeDate(iso: string, now: number = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Hace un momento';
  if (minutes < 60) return `Hace ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Hace ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Ayer';
  if (days < 7) return `Hace ${days} días`;
  return new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * La oferta canónica de una orden de vuelo, si se puede pintar: con itinerarios y montos. Lo que
 * no tenga esa forma (una orden de hotel o de auto, una orden vieja) da `null`.
 */
export function flightOfferOf(order: Pick<Order, 'selectedOffer'>): Offer | null {
  const offer: unknown = order.selectedOffer;
  if (!isRecord(offer)) return null;
  const itineraries = offer['itineraries'];
  if (!Array.isArray(itineraries) || itineraries.length === 0) return null;
  const okMoney = (value: unknown) =>
    isRecord(value) &&
    typeof value['amountMinor'] === 'number' &&
    typeof value['currency'] === 'string';
  if (!okMoney(offer['total']) || !okMoney(offer['taxes']) || !okMoney(offer['baseFare'])) {
    return null;
  }
  if (!isRecord(offer['provider'])) return null;
  const legsOk = itineraries.every(
    (it) =>
      isRecord(it) &&
      Array.isArray(it['segments']) &&
      it['segments'].every(
        (s) =>
          isRecord(s) &&
          typeof s['origin'] === 'string' &&
          typeof s['destination'] === 'string' &&
          typeof s['departureAt'] === 'string' &&
          typeof s['arrivalAt'] === 'string' &&
          typeof s['carrier'] === 'string',
      ),
  );
  return legsOk ? (offer as unknown as Offer) : null;
}
