import type { SearchContext } from './flight-search.port';
import type { BookingContactInfo, PaymentInfo } from './order-create.port';

/**
 * Localizador de la AEROLÍNEA. No es el PNR del GDS ni nuestro `orderId`: es el código con el
 * que el pasajero hace check-in en la web del transportista, y en una reserva con dos
 * aerolíneas hay dos. Por eso es array y no escalar (RF-23 CA-1).
 *
 * Va como tipo propio para que el compilador impida colapsar los tres identificadores en un
 * solo "código de reserva" (RF-23 CA-2): `pnr`, `orderId` y `locator` son strings, y sin
 * campos distintos nada impide pasar uno donde va el otro.
 */
export interface AirlineLocator {
  /** Código IATA de dos letras del transportista que emitió el localizador. */
  carrierCode: string;
  locator: string;
}

/**
 * Qué documento es. Un tiquete (`TICKET`) paga el vuelo; un EMD (documento misceláneo
 * electrónico) paga un servicio aparte: una maleta, un asiento, una penalidad.
 */
export const TICKET_DOCUMENT_KINDS = ['TICKET', 'EMD'] as const;
export type TicketDocumentKind = (typeof TICKET_DOCUMENT_KINDS)[number];

/**
 * En qué quedó un documento según la última lectura del proveedor.
 *
 * `UNKNOWN` es "el proveedor mandó un estado que no sabemos traducir" (o no mandó ninguno), y no
 * "no emitido": quien concilia una emisión no puede leer un `UNKNOWN` como fallo ni como éxito.
 */
export const TICKET_DOCUMENT_STATUSES = [
  'ISSUED',
  'VOIDED',
  'REFUNDED',
  'EXCHANGED',
  'UNKNOWN',
] as const;
export type TicketDocumentStatus = (typeof TICKET_DOCUMENT_STATUSES)[number];

/** Un tiquete o EMD emitido para la reserva. Sin datos de persona: el pasajero va por posición. */
export interface TicketDocument {
  /**
   * Número del documento: sólo dígitos, de 10 a 16 (los tres del emisor y el serial). Un tiquete
   * conjuntivo se identifica por su PRIMER número, que es el que usan la anulación y el reembolso.
   */
  number: string;
  kind: TicketDocumentKind;
  /**
   * Posición del pasajero en la reserva, empezando en 0 (el orden con que se mandaron los
   * pasajeros). Ausente si el proveedor no la dio o la dio fuera de rango.
   */
  travelerIndex?: number;
  status: TicketDocumentStatus;
  /** El código de estado del proveedor, tal cual, para revisar un `UNKNOWN`. Letras y dígitos. */
  providerStatusCode?: string;
}

/**
 * En qué reloj está el plazo de emisión.
 *
 * - `UTC`: la fecha y la hora son UTC y se pueden convertir a la hora de quien mira.
 * - `PROVIDER_LOCAL`: la fecha y la hora son las de la oficina del proveedor, que no dice en qué
 *   zona está. Se muestran tal cual y nunca se convierten: inventar la zona es imprimir otra hora.
 */
export const TICKETING_DEADLINE_ZONES = ['UTC', 'PROVIDER_LOCAL'] as const;
export type TicketingDeadlineZone = (typeof TICKETING_DEADLINE_ZONES)[number];

/** Hasta cuándo se puede emitir la reserva antes de que la aerolínea la cancele. */
export interface TicketingDeadline {
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`, 24 h. Ausente si el proveedor sólo dio el día. */
  time?: string;
  zone: TicketingDeadlineZone;
}

/**
 * Vista de SÓLO LECTURA de una orden. Es lo que devuelve `retrieveForDisplay`.
 *
 * No tiene —ni puede tener— firma de concurrencia. No es una decisión de estilo: el
 * fabricante lo dice literalmente, _"To obtain a valid bookingSignature value, you must make a
 * Get Booking call **without** the returnOnly parameter"_
 * (`help-documentation-modify-booking-0.txt`). Una lectura filtrada y cacheable **no sirve**
 * como paso previo de una modificación, así que el tipo tampoco la deja pasar. Ver
 * `docs/sabre/05-get-modify-cancel-booking.md` §2.2 y RF-09 CA-1.
 */
export interface OrderView {
  found: boolean;
  /** Nuestro/el id de orden del proveedor. Sabre NDC: `bookingId`. */
  orderId?: string;
  /** PNR del sistema del proveedor. Sabre: `confirmationId`, patrón `^[A-Z0-9]{6,}$`. */
  pnr?: string;
  status?: string;
  ticketNumbers?: string[];
  /**
   * Vacío significa "el proveedor no nos dio ninguno en esta lectura", que es un dato ausente
   * y VISIBLE, no "la aerolínea no da código" (RNF-13: la degradación parcial nunca es
   * silenciosa). El adapter que no lo sepa mapear devuelve `[]`, no lo omite.
   */
  airlineLocators: AirlineLocator[];
  /**
   * Los documentos que la lectura trajo, uno por número. Ausente = el adapter no sabe leer su
   * estado, y quien guarda la reserva usa `ticketNumbers` con estado `UNKNOWN`. Presente, aunque
   * sea vacía, manda sobre `ticketNumbers`. Un documento que no aparece en una lectura no se da
   * por borrado: una lectura puede venir filtrada.
   */
  documents?: TicketDocument[];
  /** Plazo de emisión que el proveedor tiene para la reserva, si lo informa. */
  ticketingDeadline?: TicketingDeadline;
  warnings: string[];
}

/**
 * Firma de concurrencia + el perfil de flags con el que se obtuvo, INSEPARABLES.
 *
 * Viajan juntos porque el contrato los ata: _"The same `extraFeatures` data should be sent in
 * the preceding Get Booking request to avoid issues with `bookingSignature` verification"_
 * (`booking-management-v1.yml:884-889`). Una firma sin su perfil es una firma que el modify
 * va a rechazar, y separarlos invita a reconstruir el perfil de memoria en el sitio equivocado.
 */
export interface OrderVersionStamp {
  /** Opaco para el dominio. Sabre: `bookingSignature`. NUNCA se cachea ni se persiste. */
  readonly signature: string;
  /**
   * Los flags exactos con los que se leyó, para reenviarlos idénticos en el write. El dominio
   * no los interpreta: los transporta. Cada proveedor nombra los suyos.
   */
  readonly featureProfile: Readonly<Record<string, boolean>>;
  /** Instante de la lectura (ISO 8601 UTC). Sirve para descartar sellos viejos, no para renovarlos. */
  readonly retrievedAt: string;
}

/**
 * Resultado de `retrieveForModification`. Unión discriminada a propósito: sin narrowing no se
 * llega al `versionStamp`, así que no hay forma de construir un write sobre una lectura que
 * falló.
 */
export type OrderForModification =
  | { readonly retrieved: false; readonly warnings: string[] }
  | {
      readonly retrieved: true;
      readonly order: OrderView;
      readonly versionStamp: OrderVersionStamp;
    };

/**
 * En qué quedó una cancelación aceptada.
 *
 * - `final`: la reserva ya figura cancelada en el proveedor.
 * - `in-progress`: el proveedor aceptó el pedido y todavía lo procesa (p. ej. lo mandó al hotel),
 *   o la lectura que lo diría no se pudo hacer, o su respuesta no llegó dentro del tiempo de la
 *   petición y la cancelación sigue en la plataforma. La orden queda pendiente hasta que una lectura
 *   la cierre; mostrarla como cancelada sería prometer una habitación liberada que sigue cobrable.
 */
export type OrderCancelSettlement = 'final' | 'in-progress';

export interface OrderCancelResult {
  success: boolean;
  refundAmount?: { amountMinor: number; currency: string };
  warnings: string[];
  error?: string;
  /** Ausente = `final`: los proveedores que responden con el estado final no lo informan. */
  settlement?: OrderCancelSettlement;
  /**
   * Penalidad ESTIMADA por la plataforma con las políticas que se aceptaron al reservar. No es dato
   * del proveedor y por eso no va en `refundAmount`, que sólo lleva lo que el proveedor informa.
   */
  estimatedPenalty?: { amountMinor: number; currency: string };
}

export interface OrderPayRequest {
  orderId: string;
  payment: PaymentInfo;
  contactInfo: BookingContactInfo;
  passengers: { paxId: string; paxType: string }[];
}

export interface OrderPayResult {
  success: boolean;
  orderId?: string;
  status?: string;
  warnings: string[];
  error?: string;
}

export interface ServiceListRequest {
  offerId?: string;
  orderId?: string;
  passengers: { paxId: string; paxType: string }[];
  itemType?: 'BAGGAGE';
}

export interface ServiceItem {
  offerItemId: string;
  serviceId: string;
  serviceDefinitionId: string;
  description: string;
  journeyRefId?: string;
  paxRefIds: string[];
  price: { amount: number; currency: string };
  cancellable: boolean;
}

export interface ServiceListResult {
  services: ServiceItem[];
  warnings: string[];
}

export interface OrderReshopRequest {
  paidOrderId: string;
  bnplOrderId: string;
  ticketDocIds: string[];
}

export interface OrderReshopResult {
  success: boolean;
  offerRefId?: string;
  amountDue: { amount: number; currency: string };
  isResidualValue: boolean;
  warnings: string[];
  error?: string;
}

export interface OrderManagePort {
  /**
   * Lectura barata y cacheable (TTL 30-60 s). Es la que alimenta pantallas, emails y WhatsApp.
   * Su tipo de retorno no lleva firma, así que no puede alimentar una modificación.
   */
  retrieveForDisplay(orderId: string, ctx: SearchContext): Promise<OrderView>;
  cancelOrder(orderId: string, ctx: SearchContext): Promise<OrderCancelResult>;
  cancelBnplOrder(orderId: string, ctx: SearchContext): Promise<OrderCancelResult>;
  payOrder(request: OrderPayRequest, ctx: SearchContext): Promise<OrderPayResult>;
  listServices(request: ServiceListRequest, ctx: SearchContext): Promise<ServiceListResult>;
  reshopWithTickets(request: OrderReshopRequest, ctx: SearchContext): Promise<OrderReshopResult>;
}

export const ORDER_MANAGE_PORT = 'ORDER_MANAGE_PORT';

/**
 * Lectura CARA y no cacheable, la única que produce `OrderVersionStamp`.
 *
 * Va en un puerto aparte de `OrderManagePort` y no como método opcional: hay proveedores que
 * no tienen ningún concepto de firma de concurrencia (LATAM NDC es uno). Obligarles a
 * implementar el método les obligaría a fabricar un sello que no existe, y un método opcional
 * traslada la duda a cada llamador en forma de `?.`. Quien implementa este puerto es porque
 * puede sostenerlo.
 */
export interface OrderModificationReadPort {
  retrieveForModification(orderId: string, ctx: SearchContext): Promise<OrderForModification>;
}

export const ORDER_MODIFICATION_READ_PORT = 'ORDER_MODIFICATION_READ_PORT';
