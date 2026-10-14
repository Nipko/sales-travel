import type { LoggerPort } from '@sales-travel/core';
import {
  TICKET_ISSUE_MAX_TRAVELERS,
  type ProviderIssue,
  type SearchContext,
  type TicketCancelOffer,
  type TicketCancelOfferKind,
  type TicketCheckEntry,
  type TicketCheckResult,
  type TicketDocument,
  type TicketEligibility,
  type TicketIssueOptions,
  type TicketIssueOutcome,
  type TicketIssueResult,
  type TicketIssueWarning,
  type TicketRefundEstimate,
  type TicketingPort,
} from '@sales-travel/domain';
import type {
  SabreCancelOffer,
  SabreCheckedTicket,
  SabreTicketCheckEvidence,
} from './booking/cancel.request.builder';
import { parseSabreDecimalToMinor } from './booking/cancel.response.mapper';
import {
  SABRE_DISPLAY_SECTIONS_POST_SALE,
  type SabreReturnOnly,
} from './booking/get.request.builder';
import type { SabreBookingSnapshot } from './booking/get.response.mapper';
import type { SabreTicketingFormOfPayment } from './booking/ticketing-policy';
import { SABRE_AUTH_PATH, sabreConversationIdPrefix, type SabreConfig } from './config';
import { SabreApiError, type SabreIssue } from './errors';
import type { SabreHttpClient, SabreResult } from './http/sabre-http.client';
import { logRedacted, type SabreLogLevel } from './redaction';
import { SabreOrderManageAdapter } from './sabre-order-manage.adapter';
import { pendingSabreAncillaryEmds, sabreAncillaryChargeVerdict } from './ticketing/ancillary-emd';
import { mergeSabreTicketDocuments, sabrePrimaryDocumentNumber } from './ticketing/document-status';
import {
  SABRE_FULFILL_PATH,
  buildSabreFulfillRequest,
  describeSabreFulfillRequest,
  sabreFulfillIdempotencyKey,
  type SabreFulfillPrinters,
  type SabreFulfillTicketsRequest,
} from './ticketing/fulfill.request.builder';
import {
  classifySabreFulfillIssues,
  mapSabreFulfillResponse,
  sabreTicketCoverage,
  type SabreFulfillVerdict,
} from './ticketing/fulfill.response.mapper';

/**
 * Adapter de emisión de Sabre: el `TicketingPort` del dominio sobre `fulfillFlightTickets` y
 * `checkFlightTickets` (RF-13, docs/sabre/06 §9.2).
 *
 *   issueTickets  → `getBooking` (lectura) + `fulfillFlightTickets` (escritura, SIN reintentos) y,
 *                   si la emisión queda en duda, UNA lectura más de conciliación.
 *   checkTickets  → `checkFlightTickets` (lectura), vía `SabreOrderManageAdapter`.
 *
 * ## El orden de `issueTickets`, y por qué ninguno de los pasos es opcional
 *
 *  1. **Construir el cuerpo antes de tocar la red.** Un dato inválido lanza sin llamar a nadie.
 *  2. **Leer la reserva antes de emitir.** Si cada pasajero ya tiene su tiquete, `ALREADY_ISSUED`
 *     sin mandar una segunda emisión. Si algunos sí y otros no, `PARTIAL` sin mandar nada: volver a
 *     emitir sobre una reserva a medias es la forma de duplicar tiquetes.
 *  3. **Emitir una vez, con 45 s de margen.** El path está en `SABRE_NON_IDEMPOTENT_PATHS`, así que
 *     el cliente HTTP no la reintenta aunque se lo pidan. La emisión orquesta varios servicios por
 *     detrás (docs/sabre/06 §1.5) y el timeout genérico de 30 s la cortaría a medias.
 *  4. **Ante la duda, releer; nunca reintentar.** Un timeout, un 5xx, una respuesta ilegible, un
 *     aviso ambiguo o un «ya estaba emitida» se resuelven con UNA lectura de la reserva, que
 *     devuelve los documentos que de verdad hay.
 *
 * ## Sin tarjeta (D1)
 *
 * La forma de pago es la de la cuenta (`CASH`, `ON_ACCOUNT` o `INVOICE`) y viene de la config, no
 * del llamador: el puerto ni siquiera tiene dónde recibir una tarjeta.
 *
 * ## Si lanza, no se emitió nada
 *
 * Lanza lo que se rechaza antes de salir —entrada inválida, PCC de emisión sin grupo, la lectura
 * previa que falla, la cola local vencida, el token que no se pudo obtener— y siempre con
 * `sentToProvider: false` cuando es nuestro.
 * Todo lo que pasa después de mandar la emisión vuelve como resultado.
 */

/** Margen de la emisión. Ver el paso 3 de la cabecera. */
export const SABRE_FULFILL_TIMEOUT_MS = 45_000;

/** Lo que la cuenta decide sobre la emisión. Lo arma el factory desde la config de la cuenta. */
export interface SabreTicketingAdapterSettings {
  /** Default `CASH`, el carril verificado. */
  readonly formOfPayment?: SabreTicketingFormOfPayment;
  /** PCC de emisión → `targetPcc`. Exige `sabreGroup` o `sabreCurrentCity` en la config. */
  readonly ticketingPcc?: string;
  /** Sólo con `INVOICE`. */
  readonly invoiceDescription?: string;
  readonly validatingAirlineCode?: string;
  readonly printers?: SabreFulfillPrinters;
  /**
   * Emitir como EMD, junto con el tiquete, los servicios adicionales confirmados y sin cobrar de la
   * reserva (SAB-20). Default `false`: sin él, la lectura previa no pide los servicios y la emisión
   * es sólo de tiquetes, como antes. Lo enciende el factory con `services` en `SABRE_OPERATIONS`.
   */
  readonly issueAncillaryEmds?: boolean;
}

/** La lectura previa a emitir, con los servicios adicionales para saber qué EMD van. */
const SECTIONS_WITH_ANCILLARIES: readonly SabreReturnOnly[] = Object.freeze([
  ...SABRE_DISPLAY_SECTIONS_POST_SALE,
  'ANCILLARIES',
] as const satisfies readonly SabreReturnOnly[]);

export interface SabreTicketingDeps {
  readonly logger?: LoggerPort;
  readonly now?: () => number;
  /** La post-venta de la MISMA cuenta. Sin ella se construye una sobre el mismo cliente HTTP. */
  readonly orderManage?: SabreOrderManageAdapter;
}

export type SabreTicketingRefusal =
  | 'TRAVELER_COUNT_INVALID'
  | 'TARGET_PCC_NOT_ADDRESSABLE'
  | 'BOOKING_CANCELLED'
  /** Lo cobrable de la reserva como EMD no es lo que la plataforma vendió (SAB-20). */
  | 'ANCILLARY_CHARGE_MISMATCH'
  /** Hay servicios vendidos y la emisión de EMD está apagada en este despliegue (SAB-20). */
  | 'ANCILLARY_CHARGE_UNAVAILABLE';

/** La emisión no salió: la decisión se tomó antes del cable. */
export class SabreTicketingNotSentError extends Error {
  readonly sentToProvider = false as const;

  constructor(
    readonly code: SabreTicketingRefusal,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'SabreTicketingNotSentError';
  }
}

/** Lo que queda decidido de una emisión antes de armar el resultado del puerto. */
interface SabreIssueSettlement {
  readonly outcome: TicketIssueOutcome;
  readonly documents: readonly TicketDocument[];
  readonly warnings: ReadonlySet<TicketIssueWarning>;
  readonly ticketingPcc?: string;
  /** Hubo lectura de conciliación después de mandar la emisión, y se pudo hacer. */
  readonly reconciled: boolean;
}

interface SabreIssueProvisional {
  readonly verdict: SabreFulfillVerdict;
  readonly documents: readonly TicketDocument[];
  readonly warnings: readonly TicketIssueWarning[];
  readonly ticketingPcc?: string;
}

export class SabreTicketingAdapter implements TicketingPort {
  private readonly manage: SabreOrderManageAdapter;

  constructor(
    private readonly cfg: SabreConfig,
    private readonly http: SabreHttpClient,
    private readonly deps: SabreTicketingDeps = {},
    private readonly settings: SabreTicketingAdapterSettings = {},
  ) {
    this.manage =
      deps.orderManage ??
      new SabreOrderManageAdapter(cfg, http, {
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
  }

  async issueTickets(
    orderId: string,
    ctx: SearchContext,
    options: TicketIssueOptions,
  ): Promise<TicketIssueResult> {
    const travelerCount = assertTravelerCount(options.travelerCount);
    // El cuerpo se arma ANTES de leer: un dato inválido no llega a tocar la red.
    let request = this.buildRequest(orderId, options, []);
    const formOfPaymentType = this.formOfPayment();
    const withEmds = this.settings.issueAncillaryEmds === true;
    const sold = options.ancillaryCharge;
    if (!withEmds && sold !== undefined && sold.amountMinor !== 0) {
      // Lo vendido no se puede cobrar con los servicios apagados: emitir sólo los tiquetes dejaría
      // retenido en la red lo que la aerolínea nunca cobró ni dio.
      throw new SabreTicketingNotSentError(
        'ANCILLARY_CHARGE_UNAVAILABLE',
        'la reserva tiene servicios adicionales vendidos y la emisión de EMD está apagada',
      );
    }

    const before = withEmds
      ? await this.manage.snapshotForDisplay(orderId, ctx, { sections: SECTIONS_WITH_ANCILLARIES })
      : await this.manage.snapshotForDisplay(orderId, ctx);
    if (before.status === 'CANCELLED') {
      throw new SabreTicketingNotSentError(
        'BOOKING_CANCELLED',
        'la reserva figura cancelada en el proveedor: no hay nada que emitir',
      );
    }
    // Los servicios confirmados y sin cobrar salen como EMD en la misma emisión, con la misma
    // forma de pago, si son EXACTAMENTE lo que la plataforma vendió (y la red retiene). Se deciden
    // con la lectura; quien llama sólo dice cuánto vendió.
    const emds = withEmds ? pendingSabreAncillaryEmds(before) : undefined;
    const verdict = emds === undefined ? undefined : sabreAncillaryChargeVerdict(emds, sold);
    if (verdict === 'mismatch') {
      throw new SabreTicketingNotSentError(
        'ANCILLARY_CHARGE_MISMATCH',
        'los servicios cobrables de la reserva no son los que vendió la plataforma',
      );
    }
    if (emds !== undefined && verdict === 'charge') {
      request = this.buildRequest(orderId, options, emds.itemIds);
    }
    const idempotencyKey = sabreFulfillIdempotencyKey(request);
    const shape = {
      ...describeSabreFulfillRequest(request),
      ...(emds === undefined
        ? {}
        : {
            ancillariesSkipped:
              verdict === 'not-sold'
                ? { ...emds.skipped, 'not-sold': emds.itemIds.length }
                : emds.skipped,
          }),
    };
    const preflight = preflightOf(before, travelerCount);
    if (preflight !== undefined) {
      return this.finish(ctx, preflight, [], {
        idempotencyKey,
        formOfPaymentType,
        meta: { ...shape, sent: false, travelerCount },
      });
    }

    let result: SabreResult<unknown>;
    try {
      // Sin `idempotent`, y aunque se pidiera el path está en `SABRE_NON_IDEMPOTENT_PATHS`.
      result = await this.http.postJson<unknown>(SABRE_FULFILL_PATH, request, {
        timeoutMs: SABRE_FULFILL_TIMEOUT_MS,
        ...this.conversation(ctx),
      });
    } catch (error) {
      if (!(error instanceof SabreApiError) || !wasSent(error)) throw error;
      const settled = await this.settle(orderId, ctx, travelerCount, {
        ...failureOf(error),
        documents: [],
      });
      return this.finish(ctx, settled, providerIssues(error.issues), {
        idempotencyKey,
        formOfPaymentType,
        meta: {
          ...shape,
          sent: true,
          travelerCount,
          status: error.status,
          kind: error.failure.kind,
        },
      });
    }

    let provisional: SabreIssueProvisional;
    try {
      provisional = mapSabreFulfillResponse(result.data, { travelerCount });
    } catch {
      // La emisión ya salió: una respuesta que no se entiende no es un fallo, es una duda.
      provisional = { verdict: 'UNVERIFIED', documents: [], warnings: ['response-unreadable'] };
    }
    const settled = await this.settle(orderId, ctx, travelerCount, provisional);
    return this.finish(ctx, settled, providerIssues(result.warnings), {
      idempotencyKey,
      formOfPaymentType,
      meta: {
        ...shape,
        sent: true,
        travelerCount,
        status: result.status,
        conversationId: result.conversationId,
        durationMs: result.durationMs,
      },
    });
  }

  /**
   * Las condiciones de los tiquetes (`checkFlightTickets`). La respuesta pasa por
   * `readSabreTicketCheck` dentro de `SabreOrderManageAdapter`, el único sitio que la lee; aquí sólo
   * se traduce al vocabulario del dominio, con los importes en unidades menores.
   */
  async checkTickets(orderId: string, ctx: SearchContext): Promise<TicketCheckResult> {
    const evidence = await this.manage.checkFlightTickets(orderId, ctx);
    return toTicketCheckResult(evidence, new Date((this.deps.now ?? Date.now)()).toISOString());
  }

  private formOfPayment(): SabreTicketingFormOfPayment {
    return this.settings.formOfPayment ?? 'CASH';
  }

  private buildRequest(
    orderId: string,
    options: TicketIssueOptions,
    ancillaryItemIds: readonly string[],
  ): SabreFulfillTicketsRequest {
    const targetPcc = this.settings.ticketingPcc;
    if (
      targetPcc !== undefined &&
      this.cfg.sabreGroup === undefined &&
      this.cfg.sabreCurrentCity === undefined
    ) {
      // `targetPcc` cambia el contexto del PCC y el API no lo revierte (`:708`). Sin grupo en la
      // cabecera, la llamada actuaría sobre el PCC propio. La misma regla que aplica la creación.
      throw new SabreTicketingNotSentError(
        'TARGET_PCC_NOT_ADDRESSABLE',
        'el PCC de emisión exige sabreGroup o sabreCurrentCity en la config de la cuenta',
      );
    }
    return buildSabreFulfillRequest({
      confirmationId: orderId,
      formOfPayment: this.formOfPayment(),
      ...(this.settings.invoiceDescription === undefined
        ? {}
        : { invoiceDescription: this.settings.invoiceDescription }),
      ...(this.settings.validatingAirlineCode === undefined
        ? {}
        : { validatingAirlineCode: this.settings.validatingAirlineCode }),
      ...(options.commissionPercentage === undefined
        ? {}
        : { commissionPercentage: options.commissionPercentage }),
      ...(targetPcc === undefined ? {} : { targetPcc }),
      ...(this.settings.printers === undefined ? {} : { printers: this.settings.printers }),
      ...(ancillaryItemIds.length === 0 ? {} : { ancillaryItemIds }),
    });
  }

  /**
   * Resuelve una emisión que salió. Sólo relee la reserva cuando la respuesta deja duda
   * (`UNVERIFIED`, `NEEDS_HUMAN`, `ALREADY_FULFILLED`), y sólo UNA vez: si la relectura también
   * falla, el desenlace se queda en duda y lo resuelve quien lleve la cola, no un bucle aquí.
   *
   * `NEEDS_HUMAN` no se resuelve con la lectura aunque muestre todo emitido: el proveedor declaró
   * un estado ambiguo y eso lo mira una persona. La lectura sí aporta los documentos que hay.
   *
   * `UNVERIFIED` nunca sale con documentos de la emisión: si el proveedor devolvió números y la
   * lectura no los confirma, es `NEEDS_HUMAN`.
   */
  private async settle(
    orderId: string,
    ctx: SearchContext,
    travelerCount: number,
    provisional: SabreIssueProvisional,
  ): Promise<SabreIssueSettlement> {
    const warnings = new Set<TicketIssueWarning>(provisional.warnings);
    const base = {
      ...(provisional.ticketingPcc === undefined ? {} : { ticketingPcc: provisional.ticketingPcc }),
    };
    const verdict = provisional.verdict;
    if (verdict === 'ISSUED' || verdict === 'PARTIAL' || verdict === 'FAILED') {
      return {
        ...base,
        outcome: verdict,
        documents: provisional.documents,
        warnings,
        reconciled: false,
      };
    }
    // La emisión devolvió números de documento: algo se emitió. Si la relectura no lo confirma —un
    // tiquete fantasma (`isCommitted: false`) que nunca llegó a la reserva, un estado que no se sabe
    // leer— o no se puede hacer, `UNVERIFIED` dejaría repetir la emisión en cuanto una lectura
    // dijera «nada», y eso es un segundo tiquete sobre el mismo pasajero. Con números en la mano la
    // duda la resuelve una persona.
    const providerReturnedDocuments = provisional.documents.length > 0;

    let snapshot: SabreBookingSnapshot;
    try {
      snapshot = await this.manage.snapshotForDisplay(orderId, ctx);
    } catch {
      warnings.add('reconciliation-failed');
      return {
        ...base,
        outcome:
          verdict === 'ALREADY_FULFILLED' || providerReturnedDocuments ? 'NEEDS_HUMAN' : verdict,
        documents: provisional.documents,
        warnings,
        reconciled: false,
      };
    }

    const seen = snapshot.view.documents ?? [];
    const documents = mergeSabreTicketDocuments(provisional.documents, seen);
    const settled = (outcome: TicketIssueOutcome): SabreIssueSettlement => ({
      ...base,
      outcome,
      documents,
      warnings,
      reconciled: true,
    });
    if (verdict === 'NEEDS_HUMAN') return settled('NEEDS_HUMAN');

    const coverage = sabreTicketCoverage(seen, travelerCount);
    if (coverage === 'COMPLETE') {
      warnings.add('reconciled');
      warnings.delete('documents-missing');
      return settled(verdict === 'ALREADY_FULFILLED' ? 'ALREADY_ISSUED' : 'ISSUED');
    }
    if (coverage === 'PARTIAL') {
      warnings.add('reconciled');
      warnings.add('documents-missing');
      return settled('PARTIAL');
    }
    if (verdict === 'ALREADY_FULFILLED') {
      // El proveedor dice que está emitida y la reserva no muestra un solo tiquete: no se adivina.
      warnings.add('ticketed-without-documents');
      return settled('NEEDS_HUMAN');
    }
    if (providerReturnedDocuments) {
      // La emisión dio números y la reserva no los tiene: el tiquete no quedó grabado en ella.
      warnings.add('document-not-committed');
      return settled('NEEDS_HUMAN');
    }
    return settled('UNVERIFIED');
  }

  private finish(
    ctx: SearchContext,
    settlement: SabreIssueSettlement,
    issues: readonly ProviderIssue[],
    context: {
      readonly idempotencyKey: string;
      readonly formOfPaymentType: SabreTicketingFormOfPayment;
      readonly meta: Record<string, unknown>;
    },
  ): TicketIssueResult {
    const warnings = [...settlement.warnings];
    const success = settlement.outcome === 'ISSUED' || settlement.outcome === 'ALREADY_ISSUED';
    // `info` en el éxito: una emisión es dinero irreversible y producción descarta `debug`.
    this.log(success ? 'info' : 'warn', 'sabre.fulfillFlightTickets', {
      tenantId: ctx.tenantId,
      ...context.meta,
      outcome: settlement.outcome,
      reconciled: settlement.reconciled,
      documents: settlement.documents.length,
      issuedTickets: settlement.documents.filter(
        (document) => document.kind === 'TICKET' && document.status === 'ISSUED',
      ).length,
      issuedEmds: settlement.documents.filter(
        (document) => document.kind === 'EMD' && document.status === 'ISSUED',
      ).length,
      warnings,
      // Sólo el vocabulario cerrado del proveedor; `description` es texto libre y no sale nunca.
      issueTypes: issues.map((issue) => issue.type),
    });
    return {
      outcome: settlement.outcome,
      documents: [...settlement.documents],
      warnings,
      issues: [...issues],
      idempotencyKey: context.idempotencyKey,
      formOfPaymentType: context.formOfPaymentType,
      ...(settlement.ticketingPcc === undefined ? {} : { ticketingPcc: settlement.ticketingPcc }),
    };
  }

  private conversation(ctx: SearchContext): { conversationId?: string } {
    if (ctx.requestId === undefined) return {};
    return { conversationId: `${sabreConversationIdPrefix(this.cfg)}-${ctx.requestId}` };
  }

  private log(level: SabreLogLevel, message: string, meta: Record<string, unknown>): void {
    logRedacted(this.deps.logger, level, message, meta);
  }
}

// ---------------------------------------------------------------------------------------------
// Antes del cable
// ---------------------------------------------------------------------------------------------

function assertTravelerCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > TICKET_ISSUE_MAX_TRAVELERS) {
    throw new SabreTicketingNotSentError(
      'TRAVELER_COUNT_INVALID',
      `travelerCount es un entero de 1 a ${String(TICKET_ISSUE_MAX_TRAVELERS)}`,
    );
  }
  return value;
}

/**
 * Lo que la lectura previa decide sin emitir, o `undefined` si hay que emitir.
 *
 * Una reserva que el proveedor da por emitida sin un solo tiquete emitido legible (`isTicketed`
 * con tiquetes anulados, o sin la sección de tiquetes) tampoco se emite: no se sabe sobre qué.
 */
function preflightOf(
  snapshot: SabreBookingSnapshot,
  travelerCount: number,
): SabreIssueSettlement | undefined {
  const documents = snapshot.view.documents ?? [];
  const coverage = sabreTicketCoverage(documents, travelerCount);
  const settled = (
    outcome: TicketIssueOutcome,
    warnings: readonly TicketIssueWarning[],
  ): SabreIssueSettlement => ({
    outcome,
    documents,
    warnings: new Set(warnings),
    reconciled: false,
  });
  if (coverage === 'COMPLETE') return settled('ALREADY_ISSUED', []);
  if (coverage === 'PARTIAL') {
    return settled('PARTIAL', ['issued-before-request', 'documents-missing']);
  }
  if (snapshot.isTicketed === true) return settled('NEEDS_HUMAN', ['ticketed-without-documents']);
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Después del cable
// ---------------------------------------------------------------------------------------------

/**
 * ¿Llegó la emisión al proveedor? Dicen que no la cola local vencida (`sentToProvider: false`) y el
 * token que no se pudo obtener: el cliente HTTP lo pide antes de abrir la petición, y la emisión no
 * se reintenta, así que un fallo de `/v2/auth/token` es una emisión que nunca salió —darla por «en
 * duda» mandaría a revisar una reserva intacta—. Todo lo demás —un 4xx incluido— ya salió, y se
 * decide con {@link failureOf}.
 */
function wasSent(error: SabreApiError): boolean {
  if (error.path === SABRE_AUTH_PATH) return false;
  return (error as { sentToProvider?: unknown }).sentToProvider !== false;
}

/**
 * Qué se sabe de una emisión que terminó en `SabreApiError`.
 *
 * - `2xx`: el proveedor la procesó y devolvió `errors[]`; decide la tabla del mapper.
 * - `4xx` (salvo `408`): el gateway la rechazó antes de ejecutarla —petición inválida, credencial,
 *   permiso, cuota—. `FAILED`.
 * - `408`, `5xx` y status `0` (timeout, red, cuerpo cortado): no se sabe. `UNVERIFIED`.
 */
function failureOf(error: SabreApiError): Omit<SabreIssueProvisional, 'documents'> {
  if (error.status >= 200 && error.status < 300) {
    return classifySabreFulfillIssues(
      error.issues.map((issue) => ({
        severity: issue.severity,
        ...(issue.category === undefined ? {} : { category: issue.category }),
        ...(issue.type === undefined ? {} : { type: issue.type }),
      })),
    );
  }
  if (error.status >= 400 && error.status < 500 && error.status !== 408) {
    return { verdict: 'FAILED', warnings: ['provider-rejected'] };
  }
  return { verdict: 'UNVERIFIED', warnings: ['no-response'] };
}

/** `SabreIssue` ya pasó la puerta de vocabulario del cliente: sin texto libre ni valores. */
function providerIssues(issues: readonly SabreIssue[]): ProviderIssue[] {
  return issues.map((issue) => ({
    severity: issue.severity === 'error' ? 'ERROR' : 'WARNING',
    category: issue.category ?? 'UNKNOWN',
    type: issue.type ?? 'UNKNOWN',
    ...(issue.fieldPath === undefined ? {} : { fieldPath: issue.fieldPath }),
  }));
}

// ---------------------------------------------------------------------------------------------
// checkFlightTickets → TicketCheckResult
// ---------------------------------------------------------------------------------------------

const OFFER_REF_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const OFFER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OFFER_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function toTicketCheckResult(
  evidence: SabreTicketCheckEvidence,
  checkedAt: string,
): TicketCheckResult {
  const tickets: TicketCheckEntry[] = [];
  for (const ticket of evidence.tickets) {
    const number = sabrePrimaryDocumentNumber(ticket.number);
    if (number === undefined) continue;
    const refund = refundOf(ticket);
    tickets.push({
      number,
      voidable: eligibility(ticket.isVoidable),
      refundable: refundabilityOf(ticket),
      ...(refund === undefined ? {} : { refund }),
    });
  }
  const cancelOffers: TicketCancelOffer[] = [];
  for (const offer of evidence.cancelOffers) {
    if (!OFFER_REF_PATTERN.test(offer.offerItemId)) continue;
    const expiresAt = offerExpiryOf(offer);
    cancelOffers.push({
      offerRef: offer.offerItemId,
      kind: offerKindOf(offer.offerType),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
  }
  return { checkedAt, tickets, cancelOffers };
}

function eligibility(value: boolean | undefined): TicketEligibility {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return 'unknown';
}

/**
 * `isRefundable: true` con una penalidad de origen `Category 16` NO es «sí»: el contrato dice que
 * entonces la reembolsabilidad no está garantizada (docs/sabre/06 §4.3, advertencia 2).
 */
function refundabilityOf(ticket: SabreCheckedTicket): TicketEligibility {
  const base = eligibility(ticket.isRefundable);
  if (base !== 'yes') return base;
  const unguaranteed = (ticket.refundPenalties ?? []).some(
    (penalty) => penalty.source === 'Category 16',
  );
  return unguaranteed ? 'unknown' : 'yes';
}

/**
 * La estimación de reembolso en unidades menores. La penalidad es la tasa de cancelación del
 * reembolso automatizado (`refundFee`) o, sin ella, la mayor de las penalidades estimadas en la
 * misma divisa: el proveedor ya estima con la peor, y aquí no se elige la más amable.
 */
function refundOf(ticket: SabreCheckedTicket): TicketRefundEstimate | undefined {
  const total = ticket.refundTotal;
  if (total === undefined) return undefined;
  const totalMinor = parseSabreDecimalToMinor(total.amount, total.currency);
  if (totalMinor === undefined) return undefined;

  let penaltyMinor: number | undefined;
  if (ticket.refundFee !== undefined && ticket.refundFee.currency === total.currency) {
    penaltyMinor = parseSabreDecimalToMinor(ticket.refundFee.amount, total.currency);
  } else {
    for (const penalty of ticket.refundPenalties ?? []) {
      if (penalty.currency !== total.currency) continue;
      const minor = parseSabreDecimalToMinor(penalty.amount, total.currency);
      if (minor !== undefined && (penaltyMinor === undefined || minor > penaltyMinor)) {
        penaltyMinor = minor;
      }
    }
  }
  return {
    totalMinor,
    currency: total.currency,
    ...(penaltyMinor === undefined ? {} : { penaltyMinor }),
  };
}

function offerKindOf(offerType: string | undefined): TicketCancelOfferKind {
  return offerType === 'VOID' || offerType === 'REFUND' ? offerType : 'OTHER';
}

/**
 * `offerExpirationDate` + `offerExpirationTime`, que el contrato declara en UTC (`:6517-6528`). Sin
 * hora no se inventa una: la oferta sale sin caducidad y la pantalla no promete un plazo.
 */
function offerExpiryOf(offer: SabreCancelOffer): string | undefined {
  const { expirationDate: date, expirationTime: time } = offer;
  if (date === undefined || time === undefined) return undefined;
  if (!OFFER_DATE_PATTERN.test(date) || !OFFER_TIME_PATTERN.test(time)) return undefined;
  const at = Date.parse(`${date}T${time}:00.000Z`);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}
