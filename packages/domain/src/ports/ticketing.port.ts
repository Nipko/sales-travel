import type { SearchContext } from './flight-search.port';
import type { ProviderIssue } from './order-create.port';
import type { TicketDocument } from './order-manage.port';

/**
 * Emisión de tiquetes y consulta de sus condiciones sobre una reserva YA HECHA.
 *
 * Puerto propio y no un método más de `OrderManagePort`: emitir es la única operación del flujo de
 * venta que cruza una frontera irreversible —pasada la ventana de anulación, deshacerla cuesta una
 * penalidad— y no todos los proveedores la tienen. Quien implementa este puerto es porque puede
 * sostenerla sin tarjeta: la forma de pago es la de la cuenta (efectivo, cuenta corriente o
 * factura) y el cobro al cliente va por el medio de pago de la plataforma.
 *
 * La regla de excepciones: **si lanza, no se emitió nada**. Lanza lo que se rechaza antes de salir
 * (datos inválidos, cuenta sin credenciales, la cola local vencida) y la lectura previa que falla.
 * Todo lo que pasa después de mandar la emisión —incluido no saber si se emitió— vuelve como
 * resultado, con `UNVERIFIED` o `NEEDS_HUMAN` cuando hay que releer la reserva antes de tocar nada.
 */

/**
 * En qué quedó una emisión.
 *
 * - `ISSUED`: cada pasajero tiene su tiquete emitido.
 * - `ALREADY_ISSUED`: ya estaban emitidos antes de pedirlo (otro intento, otra persona). Es el
 *   mismo estado final que `ISSUED` y no se mandó una segunda emisión.
 * - `PARTIAL`: unos pasajeros tienen tiquete y otros no. No se reintenta sola.
 * - `NEEDS_HUMAN`: el proveedor declaró un estado que no se puede resolver solo (emisión parcial,
 *   emisión sin confirmar, tiquetes que no pudo leer, precio cambiado con documentos), o devolvió
 *   números de tiquete que la reserva no muestra. Nunca se reintenta: alguien tiene que mirar la
 *   reserva.
 * - `FAILED`: el proveedor la rechazó y no emitió nada. Corregida la causa, se puede volver a pedir.
 * - `UNVERIFIED`: se mandó y no se sabe si se emitió (timeout, error del servidor, respuesta que no
 *   se entiende). **Prohibido repetirla** hasta que una lectura de la reserva diga qué hay. Nunca
 *   lleva números que la emisión haya devuelto: con números en la mano es `NEEDS_HUMAN`.
 */
export const TICKET_ISSUE_OUTCOMES = [
  'ISSUED',
  'ALREADY_ISSUED',
  'PARTIAL',
  'NEEDS_HUMAN',
  'FAILED',
  'UNVERIFIED',
] as const;
export type TicketIssueOutcome = (typeof TICKET_ISSUE_OUTCOMES)[number];

/**
 * Con qué se paga la emisión al proveedor. Ninguna es tarjeta: la plataforma no maneja números de
 * tarjeta (PCI SAQ-A) y el cobro al cliente va por el checkout del medio de pago.
 *
 * - `CASH`: contado en la oficina.
 * - `ON_ACCOUNT`: a la cuenta corriente de la agencia.
 * - `INVOICE`: contra factura de la agencia.
 */
export const TICKETING_FORMS_OF_PAYMENT = ['CASH', 'ON_ACCOUNT', 'INVOICE'] as const;
export type TicketingFormOfPayment = (typeof TICKETING_FORMS_OF_PAYMENT)[number];

/**
 * Avisos de una emisión. Vocabulario cerrado y sin texto del proveedor: viajan al log, al evento y a
 * la pantalla del vendedor.
 *
 * - `provider-email-not-sent`: el proveedor no mandó su correo al pasajero (no tenía correo). La
 *   emisión está bien; la confirmación al cliente es de la plataforma.
 * - `provider-ignored-detail`: el proveedor ignoró algo que se mandó (p. ej. la comisión). Revisar.
 * - `provider-downline-notice`: un sistema detrás del proveedor avisó de algo durante la emisión.
 * - `provider-warning-unrecognized`: un aviso del proveedor que esta versión no sabe clasificar.
 * - `partial-fulfillment`, `fulfillment-not-confirmed`, `documents-not-retrieved`: los tres estados
 *   que el proveedor declara ambiguos. Siempre `NEEDS_HUMAN`.
 * - `price-changed`: el precio cambió al emitir. Sin documentos, la emisión no ocurrió.
 * - `already-fulfilled`: el proveedor dice que la reserva ya estaba emitida.
 * - `provider-rejected`: el proveedor rechazó la emisión sin emitir nada.
 * - `provider-error-uncertain`: el proveedor devolvió un error que no descarta que se emitiera.
 * - `no-response`: no llegó respuesta (timeout, red, error del servidor).
 * - `response-unreadable`: llegó una respuesta que no se entiende.
 * - `document-not-committed`: un tiquete se emitió pero el proveedor no confirmó que quedara
 *   grabado en la reserva.
 * - `documents-missing`: hay menos tiquetes que pasajeros.
 * - `document-number-malformed`, `document-status-unknown`: un documento que no se pudo leer entero.
 * - `issued-before-request`: la reserva ya tenía tiquetes antes de pedir la emisión.
 * - `ticketed-without-documents`: el proveedor dice que hay tiquetes y la lectura no trae ninguno.
 * - `reconciled`: el resultado sale de releer la reserva después de una emisión en duda.
 * - `reconciliation-failed`: la relectura posterior también falló.
 */
export const TICKET_ISSUE_WARNINGS = [
  'provider-email-not-sent',
  'provider-ignored-detail',
  'provider-downline-notice',
  'provider-warning-unrecognized',
  'partial-fulfillment',
  'fulfillment-not-confirmed',
  'documents-not-retrieved',
  'price-changed',
  'already-fulfilled',
  'provider-rejected',
  'provider-error-uncertain',
  'no-response',
  'response-unreadable',
  'document-not-committed',
  'documents-missing',
  'document-number-malformed',
  'document-status-unknown',
  'issued-before-request',
  'ticketed-without-documents',
  'reconciled',
  'reconciliation-failed',
] as const;
export type TicketIssueWarning = (typeof TICKET_ISSUE_WARNINGS)[number];

/** Máximo de pasajeros con tiquete en una reserva: el tope de una reserva aérea por API. */
export const TICKET_ISSUE_MAX_TRAVELERS = 9;

export interface TicketIssueOptions {
  /**
   * Cuántos pasajeros tiene la reserva, infantes incluidos: cada uno lleva su tiquete. Sin este
   * número no se puede distinguir una emisión completa de una parcial, y una parcial dada por
   * completa deja a un pasajero sin poder volar.
   */
  readonly travelerCount: number;
  /** Comisión a reclamar, en porcentaje: de 0 a 99,99 con dos decimales como mucho. */
  readonly commissionPercentage?: number;
  /**
   * Lo que la plataforma vendió como servicios adicionales de la reserva y todavía no cobró
   * (maletas, comidas: SAB-20), en unidades menores y en la moneda de la reserva. Es lo que la
   * cartera de la red tiene retenido por ellos.
   *
   * Un proveedor que cobra esos servicios en la misma emisión (Sabre: EMD) tiene que cobrar
   * EXACTAMENTE esto: si lo que su reserva tiene por cobrar suma otra cosa o viene en otra moneda,
   * o si no sabe cobrarlos, no emite nada y lanza (lo que se cobra de más lo paga la cuenta sin
   * nada retenido; lo que se cobra de menos queda retenido y sin servicio). Ausente o cero = la
   * plataforma no vendió servicios: la emisión no cobra ninguno, aunque la reserva tenga alguno
   * agregado por fuera.
   */
  readonly ancillaryCharge?: { readonly amountMinor: number; readonly currency: string };
}

export interface TicketIssueResult {
  readonly outcome: TicketIssueOutcome;
  /**
   * Los documentos que se vieron: los que devolvió la emisión o, tras una emisión en duda, los que
   * trae la relectura de la reserva. Sin datos de persona.
   */
  readonly documents: readonly TicketDocument[];
  readonly warnings: readonly TicketIssueWarning[];
  /** Problemas del proveedor, sin texto libre: pueden llevar datos del pasajero. */
  readonly issues: readonly ProviderIssue[];
  /**
   * Clave de la emisión: el mismo pedido produce la misma clave. Sirve para reconocer que un
   * segundo intento es el mismo paso y no una emisión nueva. No es una promesa del proveedor.
   */
  readonly idempotencyKey: string;
  readonly formOfPaymentType: TicketingFormOfPayment;
  /** Oficina del proveedor que emitió, si lo informa. Es la que responde por la emisión. */
  readonly ticketingPcc?: string;
}

/**
 * - `yes` / `no`: el proveedor lo dijo.
 * - `unknown`: no lo dijo, o lo dijo sin garantía (la regla de la tarifa no lo asegura, o el tipo de
 *   contenido no lo informa por tiquete). No es `no`: hay que mirar las ofertas de cancelación.
 */
export type TicketEligibility = 'yes' | 'no' | 'unknown';

export interface TicketRefundEstimate {
  /** Lo que se recuperaría, en unidades menores. Es una estimación del proveedor, no un cobro. */
  readonly totalMinor: number;
  /**
   * Penalidad estimada, en unidades menores y en la misma divisa. Ausente si el proveedor no la
   * informó en esa divisa. El proveedor estima con la penalidad más alta posible: es un techo.
   */
  readonly penaltyMinor?: number;
  readonly currency: string;
}

export interface TicketCheckEntry {
  /** Número principal del tiquete. */
  readonly number: string;
  readonly voidable: TicketEligibility;
  readonly refundable: TicketEligibility;
  readonly refund?: TicketRefundEstimate;
}

export const TICKET_CANCEL_OFFER_KINDS = ['VOID', 'REFUND', 'OTHER'] as const;
export type TicketCancelOfferKind = (typeof TICKET_CANCEL_OFFER_KINDS)[number];

/** Una forma de cancelar que el proveedor ofrece para la reserva emitida (contenido NDC). */
export interface TicketCancelOffer {
  /** Referencia opaca de la oferta: la que hay que mandar al cancelar. */
  readonly offerRef: string;
  readonly kind: TicketCancelOfferKind;
  /** Hasta cuándo vale, ISO 8601 en UTC. Ausente si el proveedor no dio fecha y hora. */
  readonly expiresAt?: string;
}

export interface TicketCheckResult {
  /** Cuándo se consultó, ISO 8601 en UTC. Las condiciones cambian con el reloj: no se cachean. */
  readonly checkedAt: string;
  readonly tickets: readonly TicketCheckEntry[];
  readonly cancelOffers: readonly TicketCancelOffer[];
}

export interface TicketingPort {
  /**
   * Emite los tiquetes de la reserva. Antes de mandar nada lee la reserva: si cada pasajero ya
   * tiene su tiquete, devuelve `ALREADY_ISSUED` sin emitir otra vez.
   */
  issueTickets(
    orderId: string,
    ctx: SearchContext,
    options: TicketIssueOptions,
  ): Promise<TicketIssueResult>;
  /**
   * Las condiciones de los tiquetes emitidos: si se pueden anular, si se pueden reembolsar y por
   * cuánto. Es una lectura: no cambia nada y se puede repetir.
   */
  checkTickets(orderId: string, ctx: SearchContext): Promise<TicketCheckResult>;
}

export const TICKETING_PORT = 'TICKETING_PORT';
