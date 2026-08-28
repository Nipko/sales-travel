import type { Offer } from '@sales-travel/canonical';
import type { FlightSearchCriteria, SearchContext } from './flight-search.port';

export interface Passenger {
  /** Id que genera el llamador y usa como referencia interna (LATAM: `<PaxRefID>`). */
  paxId: string;
  /**
   * Índice global, base cero, del viajero en la búsqueda que originó la oferta.
   *
   * Sabre NDC lo exige para enlazar de forma inequívoca cada pasajero real con el `id` que
   * devolvió Offer Price. Es opcional en el puerto compartido porque otros proveedores y el
   * carril ATPCO no lo necesitan; el adapter Sabre falla cerrado si falta en una reserva NDC.
   */
  requestedTravelerIndex?: number;
  /**
   * Id de pasajero EMITIDO por el proveedor en el paso de precio, cuando el proveedor no
   * acepta el nuestro. En Sabre es `travelers[].id` de `createBooking`, y el contrato se
   * contradice sobre quién lo elige: `booking-management-v1.yml:6156-6159` lo describe como
   * emitido por Offer Price, mientras el ejemplo de respuesta de price devuelve el id que
   * mandó el llamador (`offer-price-ndc-v1.yml:2119-2124`). Hasta resolverlo contra CERT el
   * campo es opcional: si basta con `paxId`, queda sin usar y no cuesta nada.
   */
  providerPaxId?: string;
  paxType: 'ADT' | 'CHD' | 'INF';
  title?: 'Mr' | 'Mrs' | 'Miss' | 'Dr';
  givenName: string;
  surname: string;
  birthdate: string;
  gender: 'M' | 'F';
  citizenshipCountryCode: string;
  identityDoc: {
    type: 'P' | 'DNI' | 'CC' | 'CE';
    number: string;
    issuingCountryCode: string;
    issueDate?: string;
    /**
     * OPCIONAL, y ésta es la corrección: una cédula colombiana no vence.
     *
     * Estaba como obligatorio, así que el formulario —que sólo pide vencimiento para pasaporte,
     * porque es el único que lo tiene— rellenaba `''` para satisfacer el tipo. Esa cadena vacía
     * viajaba entera hasta el cable y Sabre rechazaba la reserva con
     * `travelers.0.identityDocuments.0.expiryDate:invalid_string`. Nadie podía reservar con
     * cédula, que en Colombia es el documento del 95% de los pasajeros.
     *
     * `packages/canonical` ya lo tenía opcional (`pax.ts`): eran dos contratos del mismo dato
     * en desacuerdo, y ganaba el equivocado.
     */
    expiryDate?: string;
  };
  loyaltyProgramAccount?: {
    accountNumber: string;
    airlineDesigCode?: string;
  };
}

export interface BookingContactInfo {
  email: string;
  phone: string;
  countryDialingCode?: string;
  areaCode?: string;
  postalAddress?: {
    countryCode: string;
    postalCode: string;
    street: string;
  };
}

export type CardBrandCode = 'VI' | 'AX' | 'CA' | 'DC' | 'TN' | 'HC' | 'EL' | 'TP';
export type PaymentTypeCode = 'Credit Card' | 'Cash' | 'GOV';

export interface PaymentInfo {
  type: PaymentTypeCode;
  card?: {
    brandCode: CardBrandCode;
    holderName: string;
    number: string;
    expirationDate: string;
    securityCode?: string;
  };
  payer?: {
    name: string;
    surname: string;
    taxId?: string;
  };
  amount: number;
  currency: string;
}

export interface OrderCreateRequest {
  offer: Offer;
  criteria: FlightSearchCriteria;
  passengers: Passenger[];
  contactInfo: BookingContactInfo;
  payment?: PaymentInfo;
}

/**
 * Desenlace de una creación de orden. `success: boolean` no puede representar
 * "PNR creado, vuelo confirmado, hotel falló", y ese estado no es un caso raro: es un modo
 * que el cliente ELIGE ANTES de llamar. Sabre lo declara en el contrato como
 * `errorHandlingPolicy`, un array de `CreateErrorPolicyEnum` con 8 valores y default
 * `HALT_ON_ERROR` (VERIFICADO-SPEC `booking-management-v1.yml:698` y `:8918-8935`; seis de
 * los ocho son `DO_NOT_HALT_ON_*`). Ver `docs/sabre/04-create-booking.md` §5.4.
 *
 * - `CONFIRMED`: todos los ítems quedaron confirmados.
 * - `PARTIAL`: hay orden creada, con al menos un ítem fallido o sin confirmar. Exige
 *   compensación selectiva (cancelar por `itemId`), nunca un `cancelAll` ciego.
 * - `PENDING`: el proveedor aceptó pero no resolvió todavía; hay que consultar la orden.
 * - `FAILED`: no hay nada reservado.
 */
export type OrderCreateOutcome = 'CONFIRMED' | 'PARTIAL' | 'PENDING' | 'FAILED';

/**
 * Un problema devuelto por el proveedor, con la forma que el proveedor le da.
 *
 * No se aplana a `string`: Sabre devuelve `errors[]` y `warnings[]` con la misma estructura
 * de seis campos (`Error` en `booking-management-v1.yml:4271`, `Warning` en `:4305`;
 * `category` y `type` son los dos campos requeridos). Aplanarlo a texto obliga a volver a
 * parsear la frase para decidir si hay que compensar.
 */
export interface ProviderIssue {
  /** Sabre: de qué array vino (`errors[]` → ERROR, `warnings[]` → WARNING). */
  severity: 'ERROR' | 'WARNING';
  /** Sabre: `Error.category` — 'BAD_REQUEST' | 'APPLICATION_ERROR' | … (requerido). */
  category: string;
  /** Sabre: `Error.type` — 'REQUIRED_FIELD_MISSING' | … (requerido). */
  type: string;
  /** Sabre: `Error.description`. */
  message?: string;
  /** Sabre: `Error.fieldPath` — p.ej. 'someObject.someFieldName'. */
  fieldPath?: string;
  /** Sabre: `Error.fieldName`. */
  fieldName?: string;
  /**
   * Sabre: `Error.fieldValue` — el VALOR que mandamos, devuelto tal cual.
   *
   * Puede contener PII (número de documento) y, si algún día se activara el flag de tarjeta,
   * un PAN. Vive en el dominio para diagnóstico dentro del proceso, pero NO debe salir en
   * logs, spans ni en el cuerpo de ninguna respuesta HTTP.
   */
  fieldValue?: string;
}

export type OrderItemKind = 'flight' | 'hotel' | 'car' | 'ancillary' | 'seat';

/**
 * Estado de UN ítem de la orden.
 *
 * `UNCONFIRMED` no es `FAILED`: el ítem existe en la reserva pero el proveedor no lo dio por
 * confirmado (lista de espera, `NN` pendiente de respuesta de la aerolínea). Colapsar los dos
 * lleva a cancelar lo que todavía podía confirmarse.
 */
export type OrderItemStatus = 'CONFIRMED' | 'UNCONFIRMED' | 'FAILED';

export interface OrderItemResult {
  kind: OrderItemKind;
  /**
   * Id del ítem DENTRO de la orden del proveedor. Sabre: `flights[].itemId` / `hotels[].itemId`,
   * que es un **string** con patrón `^[A-Z0-9]+$` (`booking-management-v1.yml:1875`), no un
   * número, aunque sus ejemplos sean '12'. Es la clave con la que se compensa ítem a ítem.
   */
  providerItemId?: string;
  status: OrderItemStatus;
  /** Código de estado crudo del vendor, dos letras (`^[A-Z]{2}$`): p.ej. 'HK', 'NN', 'UC'. */
  statusCode?: string;
  message?: string;
}

export interface OrderCreateResult {
  outcome: OrderCreateOutcome;
  /** Id de orden del proveedor. Sabre NDC: `booking.bookingId`. */
  orderId?: string;
  /** PNR / localizador del sistema del proveedor. Sabre: `confirmationId` de la raíz. */
  pnr?: string;
  /**
   * Firma de concurrencia, si el proveedor la devolviera al crear.
   *
   * Sabre NO la devuelve en `createBooking` (`bookingSignature` no aparece ni en `Booking` ni
   * en `CreateBookingResponse`): con Sabre este campo queda vacío y toda modificación posterior
   * exige encadenar un `getBooking`. Ver `retrieveForModification` en `order-manage.port.ts`.
   */
  revision?: string;
  /** Un elemento por ítem que el proveedor reportó, confirmado o no. Vacío si no hay orden. */
  items: OrderItemResult[];
  /** Mapea 1:1 con `errors[]` + `warnings[]` del proveedor. Vacío = sin incidencias. */
  issues: ProviderIssue[];
  /**
   * Qué se puede deshacer si hay que revertir. La actividad de compensación cancela por
   * `itemId`, **nunca** con un `cancelAll: true` ciego.
   */
  compensation?: { cancellableItemIds: string[] };
}

export interface OrderCreatePort {
  createOrder(request: OrderCreateRequest, ctx: SearchContext): Promise<OrderCreateResult>;
}

export const ORDER_CREATE_PORT = 'ORDER_CREATE_PORT';
