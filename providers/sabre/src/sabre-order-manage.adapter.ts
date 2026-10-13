import type { LoggerPort } from '@sales-travel/core';
import type {
  OrderCancelResult,
  OrderForModification,
  OrderModificationReadPort,
  OrderView,
  SearchContext,
} from '@sales-travel/domain';
import {
  SABRE_CANCEL_BOOKING_PATH,
  SABRE_CHECK_FLIGHT_TICKETS_PATH,
  SABRE_CANCEL_DEFAULT_POLICY,
  buildSabreCancelBookingRequest,
  cancelOfferExpiryMs,
  describeSabreCancelRequest,
  readSabreTicketCheck,
  requiresTicketCheck,
  sabreCancelIdempotencyKey,
  type SabreCancelBookingOptions,
  type SabreCancelBookingRequest,
  type SabreCancelContentContext,
  type SabreCancelErrorPolicy,
  type SabreCancelScope,
  type SabreFlightTicketOperation,
  type SabreRefundDocumentsType,
  type SabreTicketCheckEvidence,
  SabreCancelBookingBuildError,
} from './booking/cancel.request.builder';
import {
  mapSabreCancelResponse,
  toOrderCancelResult,
  type SabreCancelOutcome,
  type SabreCancelResult,
} from './booking/cancel.response.mapper';
import {
  SABRE_DISPLAY_SECTIONS_POST_SALE,
  SABRE_GET_BOOKING_PATH,
  buildSabreGetBookingForDisplay,
  buildSabreGetBookingForModification,
  describeSabreGetBookingRequest,
  type SabreReturnOnly,
} from './booking/get.request.builder';
import {
  mapSabreGetBookingForDisplay,
  mapSabreGetBookingForModification,
  notFoundOrderView,
  toOrderForModification,
  type SabreBookingItem,
  type SabreBookingSnapshot,
} from './booking/get.response.mapper';
import { sabreConversationIdPrefix, type SabreConfig } from './config';
import type { SabreHttpClient, SabreResult } from './http/sabre-http.client';
import { logRedacted, type SabreLogLevel } from './redaction';

/**
 * Adapter de post-venta de Sabre: `getBooking` (las dos lecturas) y `cancelBooking` — RF-09,
 * RF-10, RF-12 (docs/sabre/05).
 *
 * Antes de este fichero, los cuatro módulos de `booking/get.*` y `booking/cancel.*` estaban
 * escritos y **nadie los llamaba**. Aquí se encadenan, y el orden de las llamadas es la parte que
 * importa:
 *
 *  - **Leer para mostrar** es barato y cacheable, lleva `returnOnly`, y por eso el contrato
 *    garantiza que la respuesta NO trae `bookingSignature`. Es una LECTURA: los reintentos son
 *    seguros y se piden explícitamente.
 *  - **Leer para modificar** es caro, no se cachea, va sin `returnOnly` y es la única lectura que
 *    produce firma.
 *  - **Cancelar** exige antes una lectura —para saber qué hay dentro— y, en los carriles que lo
 *    piden, una llamada a `checkFlightTickets` cuya respuesta CRUDA pasa por
 *    `readSabreTicketCheck`. El builder no fabrica esa evidencia: la exige. Este adapter es quien
 *    la va a buscar.
 *
 * `cancelBooking` está en `SABRE_NON_IDEMPOTENT_PATHS`: el cliente HTTP no reintenta, porque un
 * timeout no dice si se ejecutó. Quien reintenta es el saga, y para reconocer que el segundo
 * intento es el mismo paso usa {@link SabreOrderCancelOutcome.idempotencyKey}.
 */

/** Un desenlace de cancelación con lo que el saga necesita para decidir el siguiente paso. */
export interface SabreOrderCancelOutcome {
  /** Ya en el vocabulario del dominio. `success` sólo en `CANCELLED`/`ALREADY_CANCELLED`. */
  readonly result: OrderCancelResult;
  readonly outcome: SabreCancelOutcome;
  /** El detalle del ACL: reembolsos, estimaciones, incidencias sin texto libre. */
  readonly detail: SabreCancelResult;
  /**
   * `sha256` del cuerpo canónico. Estable entre procesos porque el cuerpo no lleva relojes ni
   * UUIDs: es la clave de deduplicación del saga.
   */
  readonly idempotencyKey: string;
  readonly errorHandlingPolicy: SabreCancelErrorPolicy;
  /** `true` cuando hubo que llamar a `checkFlightTickets` antes de cancelar. */
  readonly ticketCheckPerformed: boolean;
  readonly conversationId: string;
  /** Lo mismo que va al log: forma de la cancelación, **nunca identificadores**. */
  readonly shape: Record<string, unknown>;
}

export interface SabreOrderManageDeps {
  readonly logger?: LoggerPort;
  readonly now?: () => number;
}

export interface SabreOrderManageOptions {
  /** PCC de la agencia de la red cuya reserva se toca. BYOC. */
  readonly targetPcc?: string;
  /** Apellido para el control de acceso ligero del contrato. Es PII y vuelve en el eco. */
  readonly surname?: string;
  /** Secciones de la lectura de display. Default: las de post-venta. */
  readonly sections?: readonly SabreReturnOnly[];
}

export interface SabreCancelOptions extends SabreOrderManageOptions {
  readonly scope?: SabreCancelScope;
  readonly items?: SabreCancelBookingOptions['items'];
  readonly segments?: SabreCancelBookingOptions['segments'];
  readonly errorHandlingPolicy?: SabreCancelErrorPolicy;
  /** `true` ⇒ la respuesta trae lo que quedó vivo. Cuesta latencia; lo vale tras un parcial. */
  readonly retrieveBooking?: boolean;
  readonly receivedFrom?: string;
  /**
   * Obligatorio para una reserva emitida: VOID o REFUND no son equivalentes.
   *
   * `VOID` sin `offerItemId` lo resuelve el adapter con la comprobación previa, que entonces se hace
   * SIEMPRE: en ATPCO viaja como `flightTicketOperation` sólo si cada tiquete es `isVoidable`; en NDC
   * se cambia por la oferta `VOID` vigente ({@link cancelOfferFor}). Si no se puede anular, lanza
   * `VOID_NOT_AVAILABLE` antes del cable.
   */
  readonly ticketOperation?: SabreFlightTicketOperation;
  /** Oferta de cancelación elegida en el check previo de una orden NDC emitida. */
  readonly offerItemId?: string;
  readonly voidNonElectronicTickets?: boolean;
  readonly refundDocumentsType?: SabreRefundDocumentsType;
}

/**
 * Implementa la mitad de `OrderManagePort` que Sabre sabe hacer en esta fase —lectura y
 * cancelación— más `OrderModificationReadPort` entero.
 *
 * `payOrder`, `listServices`, `reshopWithTickets` y `cancelBnplOrder` NO están aquí: no son
 * operaciones de este contrato y fingirlas con un resultado plausible es lo que vende un asiento
 * que no existe. Quien componga el `FlightProviderAdapter` completo las rechaza explícitamente.
 */
export class SabreOrderManageAdapter implements OrderModificationReadPort {
  constructor(
    private readonly cfg: SabreConfig,
    private readonly http: SabreHttpClient,
    private readonly deps: SabreOrderManageDeps = {},
  ) {}

  /**
   * Lectura de SÓLO VISUALIZACIÓN (`OrderManagePort.retrieveForDisplay`).
   *
   * `idempotent: true` con todas las letras: es una lectura, no cambia nada, y un 5xx transitorio
   * en la pantalla del vendedor no tiene por qué convertirse en "la reserva no existe".
   */
  async retrieveForDisplay(
    orderId: string,
    ctx: SearchContext,
    options: SabreOrderManageOptions = {},
  ): Promise<OrderView> {
    const snapshot = await this.snapshotForDisplay(orderId, ctx, options);
    return snapshot.view;
  }

  /** Como {@link retrieveForDisplay}, pero devolviendo el snapshot que la cancelación necesita. */
  async snapshotForDisplay(
    orderId: string,
    ctx: SearchContext,
    options: SabreOrderManageOptions = {},
  ): Promise<SabreBookingSnapshot> {
    const request = buildSabreGetBookingForDisplay({
      confirmationId: orderId,
      sections: options.sections ?? SABRE_DISPLAY_SECTIONS_POST_SALE,
      ...(options.targetPcc === undefined ? {} : { targetPcc: options.targetPcc }),
      ...(options.surname === undefined ? {} : { surname: options.surname }),
    });

    const result = await this.http.postJson<unknown>(SABRE_GET_BOOKING_PATH, request, {
      idempotent: true,
      ...this.conversation(ctx),
    });

    const snapshot = mapSabreGetBookingForDisplay(result.data);
    // `info`: es la lectura con la que el saga CIERRA una creación, y producción descarta `debug`.
    this.log('info', 'sabre.getBooking', {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      ...describeSabreGetBookingRequest(request),
      status: snapshot.status,
      items: snapshot.items.length,
      contentLanes: [...snapshot.contentLanes],
      warnings: [...snapshot.warnings],
    });
    return snapshot;
  }

  /**
   * Lectura CARA (`OrderModificationReadPort.retrieveForModification`). Nunca se cachea y va sin
   * `returnOnly`, que es la condición que el fabricante pone para que llegue `bookingSignature`.
   *
   * Se marca `idempotent: true` por lo mismo que la de display: sigue siendo una lectura. Lo que
   * NO se puede reintentar es el write que venga después con la firma que ésta devuelva.
   */
  async retrieveForModification(
    orderId: string,
    ctx: SearchContext,
    options: SabreOrderManageOptions = {},
  ): Promise<OrderForModification> {
    const request = buildSabreGetBookingForModification({
      confirmationId: orderId,
      ...(options.targetPcc === undefined ? {} : { targetPcc: options.targetPcc }),
      ...(options.surname === undefined ? {} : { surname: options.surname }),
    });

    const result = await this.http.postJson<unknown>(SABRE_GET_BOOKING_PATH, request, {
      idempotent: true,
      ...this.conversation(ctx),
    });

    const mapped = mapSabreGetBookingForModification(result.data, {
      now: new Date((this.deps.now ?? Date.now)()).toISOString(),
    });

    this.log(mapped.retrieved ? 'debug' : 'warn', 'sabre.getBooking.forModification', {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      ...describeSabreGetBookingRequest(request),
      retrieved: mapped.retrieved,
      // Los avisos sólo existen en la rama fallida: la unión discriminada no los lleva en la que
      // sí trajo firma, y eso es deliberado — un sello válido no tiene nada que advertir.
      ...(mapped.retrieved ? {} : { warnings: [...mapped.warnings] }),
    });

    return toOrderForModification(mapped);
  }

  /** `found: false` con la forma que el puerto exige, sin llamar al proveedor. */
  notFound(warnings: readonly string[] = []): OrderView {
    return notFoundOrderView(warnings);
  }

  /**
   * Cancela (`OrderManagePort.cancelOrder`).
   *
   * La secuencia completa, y ninguno de los pasos es opcional:
   *
   *  1. `getBooking` de display → qué hay dentro (`items`, `isTicketed`, carriles).
   *  2. Si el contenido lo exige (`requiresTicketCheck`), `checkFlightTickets` y su respuesta
   *     CRUDA por `readSabreTicketCheck`. Sin ese paso el builder lanza
   *     `NDC_CANCEL_WITHOUT_TICKET_CHECK`, que es el comportamiento pedido, no un bug.
   *  3. `cancelBooking` **sin** `idempotent` — y aunque se pidiera, el path está en
   *     `SABRE_NON_IDEMPOTENT_PATHS` y el cliente lo ignoraría.
   *  4. Mapeo al desenlace, que distingue `UNVERIFIED` de `FAILED`.
   */
  async cancelOrder(
    orderId: string,
    ctx: SearchContext,
    options: SabreCancelOptions = {},
  ): Promise<OrderCancelResult> {
    return (await this.cancelBooking(orderId, ctx, options)).result;
  }

  /** La cancelación completa, con la clave de idempotencia y el desenlace fino para el saga. */
  async cancelBooking(
    orderId: string,
    ctx: SearchContext,
    options: SabreCancelOptions = {},
  ): Promise<SabreOrderCancelOutcome> {
    const snapshot = await this.snapshotForDisplay(orderId, ctx, options);

    if (
      snapshot.isTicketed === true &&
      options.ticketOperation === undefined &&
      options.offerItemId === undefined
    ) {
      throw new SabreCancelBookingBuildError(
        'TICKET_OPERATION_REQUIRED',
        'la reserva ya está emitida: hay que elegir explícitamente VOID, REFUND o una oferta NDC después de comprobar los billetes',
      );
    }

    const content: SabreCancelContentContext = {
      items: snapshot.items,
      ...(snapshot.isTicketed === undefined ? {} : { isTicketed: snapshot.isTicketed }),
    };
    // Anular sin oferta elegida: la comprobación de tiquetes decide si se puede, y cómo, aunque la
    // lectura no diga que la reserva está emitida. Sin ella, un VOID sale a ciegas.
    const voiding = options.ticketOperation === 'VOID' && options.offerItemId === undefined;
    const needsCheck = voiding || requiresTicketCheck(content);
    const ticketCheck = needsCheck ? await this.checkFlightTickets(orderId, ctx) : undefined;
    const now = new Date((this.deps.now ?? Date.now)()).toISOString();

    let ticketOperation = options.ticketOperation;
    let offerItemId = options.offerItemId;
    if (voiding && ticketCheck !== undefined) {
      const selection = voidSelectionFor(content, ticketCheck, now);
      ticketOperation = selection.ticketOperation;
      offerItemId = selection.offerItemId;
    }

    const policy = options.errorHandlingPolicy ?? SABRE_CANCEL_DEFAULT_POLICY;
    const request: SabreCancelBookingRequest = buildSabreCancelBookingRequest({
      confirmationId: orderId,
      scope: options.scope ?? 'ALL',
      content,
      errorHandlingPolicy: policy,
      now,
      ...(ticketCheck === undefined ? {} : { ticketCheck }),
      ...(options.items === undefined ? {} : { items: options.items }),
      ...(options.segments === undefined ? {} : { segments: options.segments }),
      ...(options.retrieveBooking === undefined
        ? {}
        : { retrieveBooking: options.retrieveBooking }),
      ...(options.receivedFrom === undefined ? {} : { receivedFrom: options.receivedFrom }),
      ...(options.targetPcc === undefined ? {} : { targetPcc: options.targetPcc }),
      ...(ticketOperation === undefined ? {} : { ticketOperation }),
      ...(offerItemId === undefined ? {} : { offerItemId }),
      ...(options.voidNonElectronicTickets === undefined
        ? {}
        : { voidNonElectronicTickets: options.voidNonElectronicTickets }),
      ...(options.refundDocumentsType === undefined
        ? {}
        : { refundDocumentsType: options.refundDocumentsType }),
    });

    const shape = describeSabreCancelRequest(request);
    const idempotencyKey = sabreCancelIdempotencyKey(request);

    const result: SabreResult<unknown> = await this.http.postJson<unknown>(
      SABRE_CANCEL_BOOKING_PATH,
      request,
      this.conversation(ctx),
    );

    const detail = mapSabreCancelResponse(result.data, { requestedPolicy: policy });

    // `info` en el éxito por lo mismo que createBooking: una cancelación limpia también es una
    // escritura con dinero detrás, y en `debug` no llegaba al log de producción.
    this.log(detail.success ? 'info' : 'warn', 'sabre.cancelBooking', {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      ...shape,
      ticketCheckPerformed: needsCheck,
      outcome: detail.outcome,
      refunds: detail.refunds.length,
      estimates: detail.estimates.length,
      mapWarnings: [...detail.mapWarnings],
      // Sólo el vocabulario cerrado del proveedor. `description` es texto libre y no sale nunca.
      errorTypes: detail.errors.map((issue) => issue.type),
    });

    return {
      result: toOrderCancelResult(detail),
      outcome: detail.outcome,
      detail,
      idempotencyKey,
      errorHandlingPolicy: policy,
      ticketCheckPerformed: needsCheck,
      conversationId: result.conversationId,
      shape,
    };
  }

  /**
   * `POST /v1/trip/orders/checkFlightTickets` (RF-12).
   *
   * La respuesta cruda pasa por `readSabreTicketCheck`, que es el ÚNICO sitio que fabrica la
   * evidencia y el que comprueba que el eco declara la misma reserva que se va a cancelar. Aquí
   * no se construye ninguna evidencia a mano: no se puede, el tipo lo impide.
   *
   * Es una consulta —no cancela ni emite— y el path no está en `SABRE_NON_IDEMPOTENT_PATHS`, así
   * que se puede reintentar.
   */
  async checkFlightTickets(orderId: string, ctx: SearchContext): Promise<SabreTicketCheckEvidence> {
    const result = await this.http.postJson<unknown>(
      SABRE_CHECK_FLIGHT_TICKETS_PATH,
      { confirmationId: orderId },
      { idempotent: true, ...this.conversation(ctx) },
    );

    const evidence = readSabreTicketCheck(result.data, {
      confirmationId: orderId,
      now: new Date((this.deps.now ?? Date.now)()).toISOString(),
    });

    this.log('debug', 'sabre.checkFlightTickets', {
      tenantId: ctx.tenantId,
      conversationId: result.conversationId,
      durationMs: result.durationMs,
      cancelOffers: evidence.cancelOffers.length,
      tickets: evidence.tickets.length,
      voidable: evidence.tickets.filter((ticket) => ticket.isVoidable === true).length,
      refundable: evidence.tickets.filter((ticket) => ticket.isRefundable === true).length,
    });

    return evidence;
  }

  private conversation(ctx: SearchContext): { conversationId?: string } {
    if (ctx.requestId === undefined) return {};
    return { conversationId: `${sabreConversationIdPrefix(this.cfg)}-${ctx.requestId}` };
  }

  private log(level: SabreLogLevel, message: string, meta: Record<string, unknown>): void {
    logRedacted(this.deps.logger, level, message, meta);
  }
}

/**
 * La oferta de cancelación NDC con la que se anula (`cancelBooking.offerItemId`), elegida entre las
 * que devolvió `checkFlightTickets`, que es su única fuente (`booking-management-v1.yml:415-420`).
 *
 * En NDC la ventana de anulación no se calcula: se lee. Mientras se puede anular sin costo el
 * proveedor ofrece una oferta `VOID` con su caducidad en UTC; pasada la ventana, ofrece `REFUND` en
 * su lugar (`help-documentation-check-flight-tickets-examples.txt`, use case 4; docs/sabre/06 §4.3).
 * Se toma la primera `VOID` vigente con la misma regla de caducidad que vuelve a aplicar el builder.
 *
 * Sin una, lanza `VOID_NOT_AVAILABLE` antes del cable: cancelar igual es cancelar sin saber qué
 * pasa con los tiquetes.
 */
export function cancelOfferFor(
  kind: 'VOID',
  evidence: SabreTicketCheckEvidence,
  now: string,
): string {
  const at = Date.parse(now);
  for (const offer of evidence.cancelOffers) {
    if (offer.offerType !== kind) continue;
    const expiry = cancelOfferExpiryMs(offer);
    if (expiry !== undefined && !Number.isNaN(at) && at > expiry) continue;
    return offer.offerItemId;
  }
  throw new SabreCancelBookingBuildError(
    'VOID_NOT_AVAILABLE',
    'checkFlightTickets no ofrece una anulación (VOID) vigente para esta reserva',
  );
}

/** Cómo viaja una anulación: el VOID de ATPCO, o la oferta VOID de NDC. Nunca los dos. */
type SabreVoidSelection =
  | { readonly ticketOperation: 'VOID'; readonly offerItemId?: undefined }
  | { readonly ticketOperation?: undefined; readonly offerItemId: string };

/**
 * Decide, con la comprobación en la mano, si una anulación puede salir y cómo.
 *
 * - **Con algún vuelo NDC**: por la oferta `VOID` vigente ({@link cancelOfferFor}). En NDC
 *   `isVoidable` no existe (_«Not supported for NDC»_), así que no se mira.
 * - **El resto** (ATPCO, LCC, o vuelos sin carril declarado): `flightTicketOperation: VOID` sólo si
 *   la comprobación trae tiquetes y CADA uno es `isVoidable: true`. Sabre calcula la ventana con la
 *   regla de la aerolínea y del BSP y la expone en ese booleano (docs/sabre/06 §5.3); un tiquete que
 *   no lo dice, o que dice que no, no se manda a anular. Fail-closed: con un vuelo sin carril, un
 *   NDC no trae `isVoidable` y cae aquí en `VOID_NOT_AVAILABLE`, nunca en una anulación a ciegas.
 */
function voidSelectionFor(
  content: SabreCancelContentContext,
  evidence: SabreTicketCheckEvidence,
  now: string,
): SabreVoidSelection {
  const ndc = content.items.some((item) => item.kind === 'FLIGHT' && item.lane === 'NDC');
  if (ndc) return { offerItemId: cancelOfferFor('VOID', evidence, now) };
  const voidable =
    evidence.tickets.length > 0 && evidence.tickets.every((ticket) => ticket.isVoidable === true);
  if (!voidable) {
    throw new SabreCancelBookingBuildError(
      'VOID_NOT_AVAILABLE',
      'checkFlightTickets no declara anulables todos los tiquetes de la reserva',
    );
  }
  return { ticketOperation: 'VOID' };
}

/**
 * Los ítems cancelables de un snapshot, para la compensación selectiva de un `PARTIAL`.
 *
 * Se cancela **por `itemId`**, nunca con un `cancelAll` ciego: en un éxito parcial hay ítems que
 * sí quedaron confirmados y tirar de la manta cancela también lo que estaba bien.
 */
export function cancellableItemsOf(
  snapshot: SabreBookingSnapshot,
): readonly { readonly itemId: string; readonly kind: SabreBookingItem['kind'] }[] {
  return snapshot.items.map((item) => ({ itemId: item.itemId, kind: item.kind }));
}
