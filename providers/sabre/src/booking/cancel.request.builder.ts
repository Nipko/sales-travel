import { createHash } from 'node:crypto';
import { z } from 'zod';
import { indexValue, type SabreIndex } from '../indices';
import {
  SABRE_CONFIRMATION_ID_PATTERN,
  SABRE_PCC_PATTERN,
  resolveBookingSource,
  type SabreBookingSource,
} from './get.request.builder';
import type { SabreBookingItem, SabreContentLane } from './get.response.mapper';

/**
 * Builder de `cancelBooking` (RF-10).
 *
 * `POST /v1/trip/orders/cancelBooking` — `booking-management-v1.yml:39`, cuerpo
 * `CancelBookingRequest` (`:323-438`). Cada campo cita su línea.
 *
 * ## La regla dura: **contenido NDC no se cancela sin `checkFlightTickets` previo**
 *
 * No es una preferencia de estilo. La cancelación NDC con void o refund se hace **por oferta**:
 * el `offerItemId` que Sabre acepta sale de `CheckTicketsResponse.cancelOffers[].offerItemId`
 * (`:418-420`, _"available based on checkFlightTicketsResponse for the tickets belonging to the
 * requested confirmationId"_; y el ejemplo oficial lo repite: _"offerItemId can be retrieved from
 * CheckTicketsResponse.cancelOffer.offerItemId"_). Sin ese paso previo no se sabe si el billete
 * es anulable, si es reembolsable, ni cuánto se recupera: se manda una cancelación a ciegas sobre
 * un documento que puede estar ya emitido. **Así es como se pierde dinero de verdad.**
 *
 * Por eso {@link buildSabreCancelBookingRequest} exige `content` —lo que se va a cancelar, tal
 * como lo devolvió el `getBooking`— y, cuando ese contenido lo requiere
 * ({@link requiresTicketCheck}), una {@link SabreTicketCheckEvidence} que **sólo** se obtiene
 * pasando una respuesta real de `checkFlightTickets` por {@link readSabreTicketCheck}. No hay
 * flag para saltárselo y no se puede fabricar el objeto a mano: la marca la pone el lector.
 *
 * ## Idempotencia
 *
 * `cancelBooking` está en `SABRE_NON_IDEMPOTENT_PATHS`, así que el cliente HTTP **nunca** la
 * reintenta: un timeout no dice si la cancelación se ejecutó. La deduplicación es del saga, y
 * este módulo le da la herramienta: {@link sabreCancelIdempotencyKey} es un hash estable del
 * cuerpo canónico, así que dos intentos del mismo paso producen la misma clave y el saga puede
 * reconocer el reintento. El cuerpo es determinista por construcción: aquí no hay relojes, ni
 * UUIDs, ni orden de claves dependiente del orden de llegada.
 *
 * Y el otro lado de la idempotencia vive en el mapper: cancelar dos veces devuelve
 * `BOOKING_ALREADY_CANCELED`, que `cancel.response.mapper.ts` traduce al **mismo** resultado de
 * dominio que la primera cancelación, con cero importes reembolsados la segunda vez.
 */

/** `booking-management-v1.yml:39`, con `basePath: /v1/trip/orders` (`:15`). */
export const SABRE_CANCEL_BOOKING_PATH = '/v1/trip/orders/cancelBooking';

/** `booking-management-v1.yml:114`. Es una LECTURA: no mueve dinero, sólo informa de si se puede. */
export const SABRE_CHECK_FLIGHT_TICKETS_PATH = '/v1/trip/orders/checkFlightTickets';

/** `CancelErrorPolicyEnum` — `:8942-8952`. Default del contrato: `HALT_ON_ERROR`. */
export const SABRE_CANCEL_ERROR_POLICIES = ['HALT_ON_ERROR', 'ALLOW_PARTIAL_CANCEL'] as const;
export type SabreCancelErrorPolicy = (typeof SABRE_CANCEL_ERROR_POLICIES)[number];

/**
 * Nuestro default, que además es el del contrato — y **es transaccional**:
 * _"Execution is stopped when an error is encountered. A rollback is executed if some products
 * were successfully executed to ensure the original state of the reservation is preserved"_
 * (`help-documentation-cancel-booking.txt`). La cancelación multi-producto del Package Studio es
 * atómica mientras nadie toque esto (RF-10 CA-1).
 */
export const SABRE_CANCEL_DEFAULT_POLICY: SabreCancelErrorPolicy = 'HALT_ON_ERROR';

/** `FlightTicketOperationEnum` — `:9166-9172`. Ausente ⇒ no se toca el billete. */
export const SABRE_FLIGHT_TICKET_OPERATIONS = ['VOID', 'REFUND'] as const;
export type SabreFlightTicketOperation = (typeof SABRE_FLIGHT_TICKET_OPERATIONS)[number];

/** `DocumentsTypeEnum` — `:9422-9430`. Default del contrato: `Tickets`. */
export const SABRE_REFUND_DOCUMENT_TYPES = ['Tickets', 'EMDs', 'Tickets and EMDs'] as const;
export type SabreRefundDocumentsType = (typeof SABRE_REFUND_DOCUMENT_TYPES)[number];

/** `NotificationEmailEnum` — `:8954-8966`. Sabre manda el correo al pasajero por nosotros. */
export const SABRE_NOTIFICATION_EMAILS = ['DEFAULT', 'INVOICE', 'ETICKET', 'ITINERARY'] as const;
export type SabreNotificationEmail = (typeof SABRE_NOTIFICATION_EMAILS)[number];

/** `retentionLabel` — `:432-436`, `^[a-zA-Z0-9 ,.*?\-\/]{0,215}$`. */
export const SABRE_RETENTION_LABEL_PATTERN = /^[a-zA-Z0-9 ,.*?\-/]{0,215}$/;

/**
 * Cota del VALOR de una cola. `Queue.queueNumber` — `:4558-4563`: `integer`, `format: int32`,
 * `minimum: 0`, `maximum: 999`. `NotificationQueue` (`:8586-8591`) es un `allOf` de `Queue`, así
 * que hereda la cota tal cual.
 *
 * Existe porque validar el TAMAÑO del array (`minItems: 1`/`maxItems: 3`, `:4543-4550`) y no
 * validar el valor es media validación: `queueNumbers: [4000]` pasaba el control de tamaño y
 * salía al cable. Una cola fuera de rango no es un error de forma que se note —la cancelación
 * puede ejecutarse igual— sino un PNR encolado donde nadie lo mira.
 */
export const SABRE_QUEUE_NUMBER_MIN = 0;
export const SABRE_QUEUE_NUMBER_MAX = 999;

/**
 * Aviso permanente sobre cancelar por `segments[].sequence`. Del propio fabricante:
 * _"there is a risk that the desired product(s) to be cancelled may not be in the exact
 * segment+sequence as seen in a previously executed PNR read API call. This option is not
 * recommended"_ (`help-documentation-cancel-booking-examples.txt`).
 *
 * No se prohíbe —hay reservas donde el `itemId` no está disponible— pero quien lo use tiene que
 * verlo en el log: la posición se renumera cuando otro agente toca la reserva entre la lectura y
 * la cancelación, y entonces se cancela el segmento equivocado.
 */
export const SABRE_CANCEL_SEQUENCE_ADVISORY =
  'cancelar por segments[].sequence es la vía frágil: la posición se renumera entre la lectura y ' +
  'la cancelación. Preferir segments[].id o los itemId por producto.';

/** Qué se cancela. `ALL` es excluyente con las listas (`INVALID_FLAGS_COMBINATION`). */
export type SabreCancelScope = 'ALL' | 'ITEMS' | 'SEGMENTS';

/** Motivo del rechazo, estable, para el log y el `domain_event`. */
export type SabreCancelRule =
  | 'CONFIRMATION_ID_INVALID'
  | 'TARGET_PCC_INVALID'
  | 'CANCEL_DATA_MISSING'
  | 'INVALID_FLAGS_COMBINATION'
  | 'ITEM_ID_INVALID'
  | 'SEGMENT_REFERENCE_MISSING'
  | 'RETENTION_INVALID'
  | 'QUEUE_NUMBER_INVALID'
  | 'RECEIVED_FROM_INVALID'
  | 'NDC_CANCEL_WITHOUT_TICKET_CHECK'
  | 'NDC_ORDER_PARTIAL_CANCEL'
  | 'TICKET_CHECK_MALFORMED'
  | 'TICKET_CHECK_FOR_ANOTHER_BOOKING'
  | 'OFFER_ITEM_ID_NOT_OFFERED'
  | 'CANCEL_OFFER_EXPIRED';

/**
 * Cancelación mal formada **antes** de salir al cable. Bug nuestro, no del proveedor: ni cuenta
 * para el circuit breaker ni se reintenta.
 *
 * El mensaje nombra reglas y campos, **nunca valores**: un `confirmationId` es un localizador y
 * este mensaje acaba en un log.
 */
export class SabreCancelBookingBuildError extends Error {
  constructor(
    readonly rule: SabreCancelRule,
    message: string,
  ) {
    super(`${rule}: ${message}`);
    this.name = 'SabreCancelBookingBuildError';
  }
}

// ---------------------------------------------------------------------------------------------
// Evidencia de `checkFlightTickets`
// ---------------------------------------------------------------------------------------------

/** Una oferta de cancelación NDC — `CancelOffer`, `:6504-6531`. */
export interface SabreCancelOffer {
  readonly offerItemId: string;
  readonly offerType?: string;
  /** `:6521-6525` — `YYYY-MM-DD`. */
  readonly expirationDate?: string;
  /** `:6526-6531` — `HH:MM`, **UTC**. */
  readonly expirationTime?: string;
}

/** Un billete comprobado — `CheckedTicket`, `:8496`. Sólo lo que decide la cancelación. */
export interface SabreCheckedTicket {
  readonly number: string;
  readonly isVoidable?: boolean;
  readonly isRefundable?: boolean;
}

/**
 * Prueba de que se llamó a `checkFlightTickets` **antes** de cancelar.
 *
 * La marca `__sabreTicketCheck` no es azúcar: es lo que impide construir la evidencia con un
 * objeto literal. Sólo {@link readSabreTicketCheck} la pone, y sólo lo hace sobre una respuesta
 * real del proveedor. El mismo patrón nominal que `indices.ts` usa para los índices, y por la
 * misma razón: la defensa la da el tipo, no la disciplina de quien escribe el adapter.
 */
export interface SabreTicketCheckEvidence {
  readonly __sabreTicketCheck: 'checkFlightTickets';
  /** La reserva que se comprobó. Tiene que ser la misma que se cancela. */
  readonly confirmationId: string;
  /** `timestamp` de la respuesta, o el reloj inyectado. */
  readonly checkedAt: string;
  readonly cancelOffers: readonly SabreCancelOffer[];
  readonly tickets: readonly SabreCheckedTicket[];
}

const CheckTicketsResponseSchema = z.object({
  timestamp: z.string().optional(),
  request: z.object({ confirmationId: z.string().optional() }).optional(),
  tickets: z
    .array(
      z.object({
        number: z.string().optional(),
        isVoidable: z.boolean().optional(),
        isRefundable: z.boolean().optional(),
      }),
    )
    .optional(),
  cancelOffers: z
    .array(
      z.object({
        offerItemId: z.string().optional(),
        offerType: z.string().optional(),
        offerExpirationDate: z.string().optional(),
        offerExpirationTime: z.string().optional(),
      }),
    )
    .optional(),
});

export interface SabreTicketCheckReadContext {
  /** La reserva sobre la que se pidió la comprobación. Se contrasta con el eco de la respuesta. */
  readonly confirmationId: string;
  /** ISO 8601. Se usa si la respuesta no trae `timestamp`. Inyectable para tests. */
  readonly now?: string;
}

/**
 * Convierte una respuesta real de `checkFlightTickets` en la evidencia que exige el builder.
 *
 * Es el ÚNICO sitio que pone la marca. Si el eco de la respuesta declara otro `confirmationId`
 * que el que dice quien llama, se rechaza: una evidencia de otra reserva es peor que ninguna,
 * porque pasa el control y cancela a ciegas la que importa.
 */
export function readSabreTicketCheck(
  raw: unknown,
  ctx: SabreTicketCheckReadContext,
): SabreTicketCheckEvidence {
  const confirmationId = z
    .string()
    .regex(SABRE_CONFIRMATION_ID_PATTERN)
    .safeParse(ctx.confirmationId);
  if (!confirmationId.success) {
    throw new SabreCancelBookingBuildError(
      'CONFIRMATION_ID_INVALID',
      'la evidencia se ata a un confirmationId con patrón ^[A-Z0-9]{6,}$ (booking-management-v1.yml:328-333)',
    );
  }

  const parsed = CheckTicketsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SabreCancelBookingBuildError(
      'TICKET_CHECK_MALFORMED',
      'la respuesta de checkFlightTickets no encaja con CheckTicketsResponse (booking-management-v1.yml:660-692)',
    );
  }

  const echoed = parsed.data.request?.confirmationId;
  if (echoed !== undefined && echoed !== confirmationId.data) {
    throw new SabreCancelBookingBuildError(
      'TICKET_CHECK_FOR_ANOTHER_BOOKING',
      'el eco de checkFlightTickets declara otra reserva que la que se va a cancelar',
    );
  }

  const cancelOffers: SabreCancelOffer[] = [];
  for (const offer of parsed.data.cancelOffers ?? []) {
    if (offer.offerItemId === undefined || offer.offerItemId.length === 0) continue;
    cancelOffers.push({
      offerItemId: offer.offerItemId,
      ...(offer.offerType === undefined ? {} : { offerType: offer.offerType }),
      ...(offer.offerExpirationDate === undefined
        ? {}
        : { expirationDate: offer.offerExpirationDate }),
      ...(offer.offerExpirationTime === undefined
        ? {}
        : { expirationTime: offer.offerExpirationTime }),
    });
  }

  const tickets: SabreCheckedTicket[] = [];
  for (const ticket of parsed.data.tickets ?? []) {
    if (ticket.number === undefined) continue;
    tickets.push({
      number: ticket.number,
      ...(ticket.isVoidable === undefined ? {} : { isVoidable: ticket.isVoidable }),
      ...(ticket.isRefundable === undefined ? {} : { isRefundable: ticket.isRefundable }),
    });
  }

  return {
    __sabreTicketCheck: 'checkFlightTickets',
    confirmationId: confirmationId.data,
    checkedAt: parsed.data.timestamp ?? ctx.now ?? new Date().toISOString(),
    cancelOffers,
    tickets,
  };
}

// ---------------------------------------------------------------------------------------------
// Opciones y cuerpo
// ---------------------------------------------------------------------------------------------

/**
 * Lo que hay dentro de la reserva, **tal como lo devolvió el `getBooking`**.
 *
 * Es obligatorio y no tiene default. Cancelar sin saber qué se cancela es precisamente la
 * operación que este módulo existe para impedir: los carriles de contenido deciden si hace falta
 * `checkFlightTickets`, y un default vacío convertiría esa comprobación en opcional de hecho.
 */
export interface SabreCancelContentContext {
  /** `SabreBookingSnapshot.items`. Vacío significa "la lectura no vio ítems", no "no hay". */
  readonly items: readonly SabreBookingItem[];
  /** `Booking.isTicketed` (`:1081-1085`). */
  readonly isTicketed?: boolean;
}

export interface SabreCancelSegmentRef {
  /** `Segment.id` — `:4137-4145`, `^[A-Z0-9]+$`. La vía robusta. */
  readonly id?: string;
  /**
   * `Segment.sequence` — `:4117-4122`. Posición en el PNR, que empieza en 1: por eso el tipo es
   * `SabreIndex` y no `number`, y sólo se obtiene pasando por `indices.ts`. El contrato **no**
   * declara `minimum` aquí; el rail de ≥1 es nuestro, y sale de que las posiciones de un PNR se
   * cuentan desde 1 (los cuerpos de la colección mandan `sequence: 1` y `sequence: 3`).
   */
  readonly sequence?: SabreIndex;
}

export type SabreCancelNotification =
  | { readonly email: SabreNotificationEmail; readonly queueNumbers?: never }
  | { readonly email?: never; readonly queueNumbers: readonly number[] };

export interface SabreCancelBookingOptions {
  readonly confirmationId: string;
  readonly bookingSource?: SabreBookingSource;
  readonly scope: SabreCancelScope;
  readonly content: SabreCancelContentContext;
  /** Para `scope: 'ITEMS'`. `itemId` es string `^[A-Z0-9]+$`, nunca número. */
  readonly items?: readonly { readonly itemId: string; readonly kind: SabreBookingItem['kind'] }[];
  /** Para `scope: 'SEGMENTS'`. */
  readonly segments?: readonly SabreCancelSegmentRef[];
  readonly ticketCheck?: SabreTicketCheckEvidence;
  /** `VOID` o `REFUND`. Excluyente con `offerItemId` (`INVALID_FLAGS_COMBINATION`). */
  readonly ticketOperation?: SabreFlightTicketOperation;
  /** Oferta NDC de void/refund. Tiene que ser una de las que devolvió `checkFlightTickets`. */
  readonly offerItemId?: string;
  readonly errorHandlingPolicy?: SabreCancelErrorPolicy;
  /** `true` ⇒ la respuesta trae lo que quedó vivo. Cuesta latencia; lo vale tras un parcial. */
  readonly retrieveBooking?: boolean;
  /**
   * Firma del cambio en el historial del PNR (`:344-347`, default de Sabre `LW CANCEL API`).
   * **No poner aquí el nombre de una persona**: viaja al historial y vuelve en el eco.
   */
  readonly receivedFrom?: string;
  readonly targetPcc?: string;
  readonly notification?: SabreCancelNotification;
  readonly retention?: { readonly endDate: string; readonly label: string };
  readonly voidNonElectronicTickets?: boolean;
  readonly refundDocumentsType?: SabreRefundDocumentsType;
  /** ISO 8601. Se usa para caducar ofertas de cancelación. Inyectable para tests. */
  readonly now?: string;
}

/** Cuerpo de `CancelBookingRequest` (`:323-438`). Sólo campos del contrato. */
export interface SabreCancelBookingRequest {
  readonly confirmationId: string;
  readonly bookingSource: SabreBookingSource;
  readonly cancelAll: boolean;
  readonly errorHandlingPolicy: SabreCancelErrorPolicy;
  readonly retrieveBooking: boolean;
  readonly flights?: readonly { readonly itemId: string }[];
  readonly hotels?: readonly { readonly itemId: string }[];
  readonly cars?: readonly { readonly itemId: string }[];
  readonly trains?: readonly { readonly itemId: string }[];
  readonly cruises?: readonly { readonly itemId: string }[];
  readonly segments?: readonly { readonly id?: string; readonly sequence?: number }[];
  readonly flightTicketOperation?: SabreFlightTicketOperation;
  readonly offerItemId?: string;
  readonly receivedFrom?: string;
  readonly targetPcc?: string;
  readonly notification?: {
    readonly email?: SabreNotificationEmail;
    readonly queuePlacement?: readonly { readonly queueNumber: number }[];
  };
  readonly retentionEndDate?: string;
  readonly retentionLabel?: string;
  readonly voidNonElectronicTickets?: boolean;
  readonly refundDocumentsType?: SabreRefundDocumentsType;
}

const ItemIdSchema = z.string().regex(/^[A-Z0-9]+$/);
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/**
 * `receivedFrom` no tiene patrón en el contrato. El rail es nuestro y es de seguridad, no de
 * forma: acotarlo a identificadores impide que alguien meta ahí el nombre del pasajero o una nota
 * libre que acabe en el historial del PNR y en el eco de la respuesta.
 */
const ReceivedFromSchema = z.string().regex(/^[A-Za-z0-9 ._/-]{1,60}$/);
/** El VALOR de una cola. Ver {@link SABRE_QUEUE_NUMBER_MIN}. `int()` además descarta `1.5` y `NaN`. */
const QueueNumberSchema = z.number().int().min(SABRE_QUEUE_NUMBER_MIN).max(SABRE_QUEUE_NUMBER_MAX);

/**
 * ¿Hace falta `checkFlightTickets` antes de cancelar esto?
 *
 * Se exporta porque la UI necesita saberlo **antes** de ofrecer el botón, y porque una regla que
 * sólo existe dentro de un `if` del builder no se puede probar de frente.
 *
 * Los tres casos que la disparan, y por qué cada uno:
 *
 *  1. **Hay un vuelo NDC.** Es el caso del contrato: el `offerItemId` sale de la comprobación, y
 *     los segmentos NDC sólo se cancelan en bloque (`help-documentation-cancel-booking.txt`,
 *     _Limitations_).
 *  2. **Hay un vuelo cuyo carril no conocemos** (`sourceType` ausente en la lectura). Fail-closed:
 *     "no sé si es NDC" se trata como "puede serlo". El coste de equivocarse hacia este lado es
 *     una llamada de lectura; hacia el otro, un billete emitido cancelado a ciegas.
 *  3. **La reserva está emitida y la lectura no vio vuelos.** Hay documentos vivos y no sabemos
 *     sobre qué. Misma razón que el 2.
 */
export function requiresTicketCheck(content: SabreCancelContentContext): boolean {
  const flights = content.items.filter((item) => item.kind === 'FLIGHT');
  if (flights.some((item) => item.lane === 'NDC' || item.lane === undefined)) return true;
  return content.isTicketed === true && flights.length === 0;
}

/** Los ítems de vuelo NDC de la reserva. Los NDC se cancelan **todos o ninguno**. */
function ndcFlightItems(content: SabreCancelContentContext): readonly SabreBookingItem[] {
  return content.items.filter((item) => item.kind === 'FLIGHT' && item.lane === 'NDC');
}

/** `YYYY-MM-DD` + `HH:MM` UTC → instante. Devuelve `undefined` si la oferta no declara caducidad. */
function offerExpiryMs(offer: SabreCancelOffer): number | undefined {
  if (offer.expirationDate === undefined) return undefined;
  const time = offer.expirationTime ?? '23:59';
  const parsed = Date.parse(`${offer.expirationDate}T${time}:00Z`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

const ITEM_KEY_BY_KIND = {
  FLIGHT: 'flights',
  HOTEL: 'hotels',
  CAR: 'cars',
  TRAIN: 'trains',
  CRUISE: 'cruises',
} as const satisfies Record<SabreBookingItem['kind'], string>;

/**
 * Construye el cuerpo de `cancelBooking`, o lanza explicando qué regla se rompió.
 *
 * Cada comprobación replica un error real del catálogo oficial
 * (`help-documentation-cancel-booking-error-list.txt`): son viajes de ida y vuelta que ya sabemos
 * que van a fallar, y en una operación que mueve dinero el viaje de más no es gratis.
 */
export function buildSabreCancelBookingRequest(
  options: SabreCancelBookingOptions,
): SabreCancelBookingRequest {
  const confirmationId = z
    .string()
    .regex(SABRE_CONFIRMATION_ID_PATTERN)
    .safeParse(options.confirmationId);
  if (!confirmationId.success) {
    throw new SabreCancelBookingBuildError(
      'CONFIRMATION_ID_INVALID',
      'se espera ^[A-Z0-9]{6,}$ (booking-management-v1.yml:328-333)',
    );
  }

  const cancelAll = options.scope === 'ALL';
  const items = options.items ?? [];
  const segments = options.segments ?? [];

  // `INVALID_FLAGS_COMBINATION`: "CancelAll flag and list of flights/hotels/cars/cruises/trains/
  // segments cannot be combined" (error-list:32-37).
  if (cancelAll && (items.length > 0 || segments.length > 0)) {
    throw new SabreCancelBookingBuildError(
      'INVALID_FLAGS_COMBINATION',
      'cancelAll es excluyente con las listas de productos y de segmentos',
    );
  }

  // "If cancelAll=false, then at least one from the following properties must be provided:
  // flights, hotels, cars, trains, cruises, or segments" (help-documentation-cancel-booking.txt).
  // Sin esto sale `CANCEL_DATA_MISSING`: "No cancel data provided. Nothing was cancelled".
  if (!cancelAll && items.length === 0 && segments.length === 0) {
    throw new SabreCancelBookingBuildError(
      'CANCEL_DATA_MISSING',
      'con scope distinto de ALL hay que enumerar al menos un producto o un segmento',
    );
  }
  if (options.scope === 'ITEMS' && items.length === 0) {
    throw new SabreCancelBookingBuildError('CANCEL_DATA_MISSING', 'scope ITEMS sin items');
  }
  if (options.scope === 'SEGMENTS' && segments.length === 0) {
    throw new SabreCancelBookingBuildError('CANCEL_DATA_MISSING', 'scope SEGMENTS sin segments');
  }

  // "Combination of offerItemId and flightTicketOperation is not supported" (error-list:39-44).
  if (options.offerItemId !== undefined && options.ticketOperation !== undefined) {
    throw new SabreCancelBookingBuildError(
      'INVALID_FLAGS_COMBINATION',
      'offerItemId y flightTicketOperation son mutuamente excluyentes (RF-10 CA-2)',
    );
  }

  // "Flag cancelAll cannot be combined with notification email" (error-list:60-65).
  if (cancelAll && options.notification?.email !== undefined) {
    throw new SabreCancelBookingBuildError(
      'INVALID_FLAGS_COMBINATION',
      'cancelAll no admite notificación por correo: el envío exige itinerario en la reserva',
    );
  }

  // ─── La regla dura: NDC sin comprobación previa de billetes ─────────────────────────────────
  const needsCheck = requiresTicketCheck(options.content);
  if (needsCheck && options.ticketCheck === undefined) {
    throw new SabreCancelBookingBuildError(
      'NDC_CANCEL_WITHOUT_TICKET_CHECK',
      'esta reserva exige un checkFlightTickets previo: sin él no se sabe si el billete es ' +
        'anulable ni cuánto se reembolsa, y se cancela a ciegas sobre un documento emitido',
    );
  }

  if (options.ticketCheck !== undefined) {
    if (options.ticketCheck.confirmationId !== confirmationId.data) {
      throw new SabreCancelBookingBuildError(
        'TICKET_CHECK_FOR_ANOTHER_BOOKING',
        'la evidencia de checkFlightTickets es de otra reserva',
      );
    }
  }

  // Los segmentos NDC sólo se cancelan en bloque: "you cannot cancel individual NDC segments and
  // leave other NDC segments" (`help-documentation-cancel-booking.txt`, _Limitations_; errores
  // `NDC_ORDER_PARTIAL_CANCEL` y `MISSING_NDC_SEGMENTS`).
  if (!cancelAll) {
    const ndcItems = ndcFlightItems(options.content);
    const selected = new Set(items.map((item) => item.itemId));
    const touchesNdc = ndcItems.some((item) => selected.has(item.itemId));
    const leavesNdcBehind = ndcItems.some((item) => !selected.has(item.itemId));
    if (touchesNdc && leavesNdcBehind) {
      throw new SabreCancelBookingBuildError(
        'NDC_ORDER_PARTIAL_CANCEL',
        'una orden NDC se cancela entera o no se cancela: no se pueden dejar segmentos NDC vivos',
      );
    }
  }

  if (options.offerItemId !== undefined) {
    const offers = options.ticketCheck?.cancelOffers ?? [];
    const offer = offers.find((candidate) => candidate.offerItemId === options.offerItemId);
    if (offer === undefined) {
      // Un `offerItemId` que no salió de la comprobación es un identificador inventado o rancio.
      // Mandarlo es cancelar contra una oferta que Sabre no reconoce.
      throw new SabreCancelBookingBuildError(
        'OFFER_ITEM_ID_NOT_OFFERED',
        'el offerItemId no está entre las cancelOffers que devolvió checkFlightTickets',
      );
    }
    const expiry = offerExpiryMs(offer);
    const now = Date.parse(options.now ?? new Date().toISOString());
    if (expiry !== undefined && !Number.isNaN(now) && now > expiry) {
      throw new SabreCancelBookingBuildError(
        'CANCEL_OFFER_EXPIRED',
        'la oferta de cancelación ya caducó: hay que repetir el checkFlightTickets',
      );
    }
  }

  const body: {
    confirmationId: string;
    bookingSource: SabreBookingSource;
    cancelAll: boolean;
    errorHandlingPolicy: SabreCancelErrorPolicy;
    retrieveBooking: boolean;
    flights?: { itemId: string }[];
    hotels?: { itemId: string }[];
    cars?: { itemId: string }[];
    trains?: { itemId: string }[];
    cruises?: { itemId: string }[];
    segments?: { id?: string; sequence?: number }[];
    flightTicketOperation?: SabreFlightTicketOperation;
    offerItemId?: string;
    receivedFrom?: string;
    targetPcc?: string;
    notification?: {
      email?: SabreNotificationEmail;
      queuePlacement?: { queueNumber: number }[];
    };
    retentionEndDate?: string;
    retentionLabel?: string;
    voidNonElectronicTickets?: boolean;
    refundDocumentsType?: SabreRefundDocumentsType;
  } = {
    confirmationId: confirmationId.data,
    bookingSource: options.bookingSource ?? resolveBookingSource(confirmationId.data),
    cancelAll,
    // Explícito SIEMPRE, aunque coincida con el default del contrato: el default es una promesa
    // del proveedor que puede cambiar de versión, y de este flag depende si la cancelación
    // multi-producto hace rollback o deja la reserva a medias.
    errorHandlingPolicy: options.errorHandlingPolicy ?? SABRE_CANCEL_DEFAULT_POLICY,
    retrieveBooking: options.retrieveBooking ?? false,
  };

  for (const kind of ['FLIGHT', 'HOTEL', 'CAR', 'TRAIN', 'CRUISE'] as const) {
    const ofKind = items.filter((item) => item.kind === kind);
    if (ofKind.length === 0) continue;
    // Orden canónico por `itemId`. Cancelar {A,B} y cancelar {B,A} es LA MISMA operación; si el
    // orden de la lista viajase tal cual, {@link sabreCancelIdempotencyKey} daría dos claves
    // distintas y el saga trataría el reintento como una cancelación nueva.
    const refs = [...ofKind]
      .sort((left, right) => (left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0))
      .map((item) => {
        const itemId = ItemIdSchema.safeParse(item.itemId);
        if (!itemId.success) {
          // Los cuerpos de la colección mandan `{"itemId": 9}` sin comillas; es laxitud del sandbox.
          // El contrato dice `type: string, pattern: ^[A-Z0-9]+$` (`:1874-1880`) y aquí se emite
          // string siempre.
          throw new SabreCancelBookingBuildError(
            'ITEM_ID_INVALID',
            'itemId es string con patrón ^[A-Z0-9]+$, no número (booking-management-v1.yml:1874-1880)',
          );
        }
        return { itemId: itemId.data };
      });
    body[ITEM_KEY_BY_KIND[kind]] = refs;
  }

  if (segments.length > 0) {
    body.segments = segments.map((segment) => {
      if (segment.id === undefined && segment.sequence === undefined) {
        throw new SabreCancelBookingBuildError(
          'SEGMENT_REFERENCE_MISSING',
          'un segmento se identifica por id o por sequence, y llegó sin ninguno de los dos',
        );
      }
      const ref: { id?: string; sequence?: number } = {};
      if (segment.id !== undefined) {
        const id = ItemIdSchema.safeParse(segment.id);
        if (!id.success) {
          throw new SabreCancelBookingBuildError(
            'ITEM_ID_INVALID',
            'Segment.id es string con patrón ^[A-Z0-9]+$ (booking-management-v1.yml:4137-4145)',
          );
        }
        ref.id = id.data;
      }
      // `indexValue` es identidad en runtime; el viaje por `indices.ts` es lo que garantiza que
      // nadie escribió un `sequence: 0` a mano ni pasó una posición de array.
      if (segment.sequence !== undefined) ref.sequence = indexValue(segment.sequence);
      return ref;
    });
  }

  if (options.ticketOperation !== undefined) body.flightTicketOperation = options.ticketOperation;
  if (options.offerItemId !== undefined) body.offerItemId = options.offerItemId;

  if (options.receivedFrom !== undefined) {
    const receivedFrom = ReceivedFromSchema.safeParse(options.receivedFrom);
    if (!receivedFrom.success) {
      throw new SabreCancelBookingBuildError(
        'RECEIVED_FROM_INVALID',
        'receivedFrom se acota a un identificador de agencia/vendedor: viaja al historial del PNR',
      );
    }
    body.receivedFrom = receivedFrom.data;
  }

  if (options.targetPcc !== undefined) {
    const targetPcc = z.string().regex(SABRE_PCC_PATTERN).safeParse(options.targetPcc);
    if (!targetPcc.success) {
      throw new SabreCancelBookingBuildError(
        'TARGET_PCC_INVALID',
        'se espera ^[A-Z0-9]{3,4}$ (booking-management-v1.yml:394-398)',
      );
    }
    body.targetPcc = targetPcc.data;
  }

  if (options.notification !== undefined) {
    const { email, queueNumbers } = options.notification;
    if (email !== undefined && queueNumbers !== undefined) {
      // "Request contains too many notification options. Select email or queuePlacement"
      // (error-list:53-58). El tipo ya lo impide; esto cubre a quien llegue por un `as`.
      throw new SabreCancelBookingBuildError(
        'INVALID_FLAGS_COMBINATION',
        'notification admite email O queuePlacement, nunca los dos',
      );
    }
    if (email !== undefined) body.notification = { email };
    if (queueNumbers !== undefined) {
      if (queueNumbers.length === 0 || queueNumbers.length > 3) {
        // `Notification.queuePlacement` — `:4543-4550`, `minItems: 1`, `maxItems: 3`.
        throw new SabreCancelBookingBuildError(
          'INVALID_FLAGS_COMBINATION',
          'queuePlacement admite entre 1 y 3 colas (booking-management-v1.yml:4543-4550)',
        );
      }
      body.notification = {
        queuePlacement: queueNumbers.map((n) => {
          const queueNumber = QueueNumberSchema.safeParse(n);
          if (!queueNumber.success) {
            // El mensaje nombra la cota, nunca el valor: esta línea acaba en un log.
            throw new SabreCancelBookingBuildError(
              'QUEUE_NUMBER_INVALID',
              `queueNumber es un entero entre ${SABRE_QUEUE_NUMBER_MIN} y ` +
                `${SABRE_QUEUE_NUMBER_MAX} (booking-management-v1.yml:4558-4563, heredado por ` +
                `NotificationQueue en :8586-8591)`,
            );
          }
          return { queueNumber: queueNumber.data };
        }),
      };
    }
  }

  if (options.retention !== undefined) {
    const endDate = IsoDateSchema.safeParse(options.retention.endDate);
    const label = z
      .string()
      .regex(SABRE_RETENTION_LABEL_PATTERN)
      .safeParse(options.retention.label);
    if (!endDate.success || !label.success) {
      throw new SabreCancelBookingBuildError(
        'RETENTION_INVALID',
        'retentionEndDate es YYYY-MM-DD y retentionLabel casa ^[a-zA-Z0-9 ,.*?\\-/]{0,215}$',
      );
    }
    body.retentionEndDate = endDate.data;
    body.retentionLabel = label.data;
  }

  if (options.voidNonElectronicTickets !== undefined) {
    body.voidNonElectronicTickets = options.voidNonElectronicTickets;
  }
  if (options.refundDocumentsType !== undefined) {
    body.refundDocumentsType = options.refundDocumentsType;
  }

  return body;
}

/** Serialización canónica: claves ordenadas en todo el árbol. Misma petición ⇒ mismos bytes. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
}

/**
 * Clave de idempotencia del saga.
 *
 * `cancelBooking` está en `SABRE_NON_IDEMPOTENT_PATHS`: el cliente HTTP no reintenta, porque un
 * timeout no dice si la cancelación se ejecutó. Quien reintenta es el saga, y necesita reconocer
 * que el segundo intento es **el mismo paso** y no una cancelación nueva. Esta clave es eso: el
 * hash del cuerpo canónico, estable entre procesos porque el cuerpo no lleva relojes ni UUIDs.
 *
 * No es un secreto ni un dato personal —es un hash de identificadores de reserva— pero tampoco
 * hay razón para publicarla fuera del saga.
 */
export function sabreCancelIdempotencyKey(request: SabreCancelBookingRequest): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}

/** Línea de log estructurado. Nombra la forma de la cancelación, **nunca los identificadores**. */
export function describeSabreCancelRequest(
  request: SabreCancelBookingRequest,
): Record<string, unknown> {
  const bySequence = (request.segments ?? []).some((segment) => segment.sequence !== undefined);
  return {
    operation: SABRE_CANCEL_BOOKING_PATH,
    cancelAll: request.cancelAll,
    errorHandlingPolicy: request.errorHandlingPolicy,
    retrieveBooking: request.retrieveBooking,
    flightTicketOperation: request.flightTicketOperation ?? 'NONE',
    withOffer: request.offerItemId !== undefined,
    counts: {
      flights: request.flights?.length ?? 0,
      hotels: request.hotels?.length ?? 0,
      cars: request.cars?.length ?? 0,
      trains: request.trains?.length ?? 0,
      cruises: request.cruises?.length ?? 0,
      segments: request.segments?.length ?? 0,
    },
    withTargetPcc: request.targetPcc !== undefined,
    ...(bySequence ? { advisory: SABRE_CANCEL_SEQUENCE_ADVISORY } : {}),
  };
}

/** Reexportado para que el builder de cancelación y el mapper hablen del mismo vocabulario. */
export type { SabreContentLane };
