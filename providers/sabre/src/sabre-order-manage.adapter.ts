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
  describeSabreCancelRequest,
  readSabreTicketCheck,
  requiresTicketCheck,
  sabreCancelIdempotencyKey,
  type SabreCancelBookingOptions,
  type SabreCancelBookingRequest,
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
  /** Obligatorio para una reserva ATPCO/LCC emitida: VOID o REFUND no son equivalentes. */
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
    this.log('debug', 'sabre.getBooking', {
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

    const needsCheck = requiresTicketCheck({
      items: snapshot.items,
      ...(snapshot.isTicketed === undefined ? {} : { isTicketed: snapshot.isTicketed }),
    });
    const ticketCheck = needsCheck ? await this.checkFlightTickets(orderId, ctx) : undefined;

    const policy = options.errorHandlingPolicy ?? SABRE_CANCEL_DEFAULT_POLICY;
    const request: SabreCancelBookingRequest = buildSabreCancelBookingRequest({
      confirmationId: orderId,
      scope: options.scope ?? 'ALL',
      content: {
        items: snapshot.items,
        ...(snapshot.isTicketed === undefined ? {} : { isTicketed: snapshot.isTicketed }),
      },
      errorHandlingPolicy: policy,
      now: new Date((this.deps.now ?? Date.now)()).toISOString(),
      ...(ticketCheck === undefined ? {} : { ticketCheck }),
      ...(options.items === undefined ? {} : { items: options.items }),
      ...(options.segments === undefined ? {} : { segments: options.segments }),
      ...(options.retrieveBooking === undefined
        ? {}
        : { retrieveBooking: options.retrieveBooking }),
      ...(options.receivedFrom === undefined ? {} : { receivedFrom: options.receivedFrom }),
      ...(options.targetPcc === undefined ? {} : { targetPcc: options.targetPcc }),
      ...(options.ticketOperation === undefined
        ? {}
        : { ticketOperation: options.ticketOperation }),
      ...(options.offerItemId === undefined ? {} : { offerItemId: options.offerItemId }),
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

    this.log(detail.success ? 'debug' : 'warn', 'sabre.cancelBooking', {
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
