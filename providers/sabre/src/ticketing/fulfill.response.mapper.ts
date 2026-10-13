import type { TicketDocument, TicketIssueWarning } from '@sales-travel/domain';
import { z } from 'zod';
import {
  classifySabreTicketStatus,
  mergeSabreTicketDocuments,
  sabrePrimaryDocumentNumber,
} from './document-status';

/**
 * Mapper de `FulfillTicketsResponse` (`booking-management-v1.yml:1022-1050`) — RF-13.
 *
 * ## Un 200 no dice que se emitió
 *
 * La emisión devuelve `200` con `warnings[]` en escenarios donde el negocio está roto, y el default
 * del proveedor —`ALLOW_PARTIAL_FULFILLMENT`, que no se puede apagar con el enum del contrato— hace
 * que ése sea el camino normal del fallo (docs/sabre/06 §2.8). El criterio de `ISSUED` es:
 *
 *   sin `errors[]`, sin ninguno de los tres avisos ambiguos, con tantos tiquetes emitidos como
 *   pasajeros y todos grabados en la reserva (`isCommitted` no es `false`).
 *
 * Cualquier otra combinación es `PARTIAL`, `NEEDS_HUMAN`, `FAILED` o `UNVERIFIED`, nunca `ISSUED`.
 *
 * ## Los siete avisos del contrato
 *
 * La tabla {@link SABRE_FULFILL_WARNING_RULES} es la lista oficial completa
 * (`help/booking-management-api-v1/help-documentation-fulfill-flight-tickets-warning-list.txt`), y
 * su test la cruza con ese fichero: un aviso nuevo del proveedor no puede entrar sin decidir qué
 * significa. Uno que no está en la tabla sale como `provider-warning-unrecognized` y no cambia el
 * desenlace, pero se ve.
 *
 * ## Sin texto del proveedor
 *
 * `description` es texto libre: el de `DOWNLINE_SERVICE_WARNING` es un mensaje de terminal
 * reempaquetado y el de `PRICE_CHANGE` lleva importes interpolados. Los tiquetes traen nombre y
 * apellido del pasajero (`travelerGivenName`, `travelerSurname`). Nada de eso se lee: el `type` sólo
 * se compara contra las tablas de este módulo y nunca se copia a la salida.
 */

/**
 * Qué hizo la emisión según la respuesta, antes de releer la reserva.
 *
 * `ALREADY_FULFILLED` es el `BOOKING_FULFILLED` del proveedor: dice que ya estaba emitida, pero no
 * qué hay. Sólo una lectura de la reserva lo convierte en `ALREADY_ISSUED`.
 */
export type SabreFulfillVerdict =
  | 'ISSUED'
  | 'PARTIAL'
  | 'NEEDS_HUMAN'
  | 'FAILED'
  | 'UNVERIFIED'
  | 'ALREADY_FULFILLED';

/**
 * - `INFO`: la emisión está bien; se avisa y nada más.
 * - `NOTICE`: un sistema detrás del proveedor avisó; se registra y no cambia el desenlace.
 * - `NEEDS_HUMAN`: estado ambiguo declarado por el proveedor. Nunca se reintenta.
 * - `PRICE_CHANGE`: sin documentos, la emisión no ocurrió (`FAILED`); con documentos, se emitió a
 *   un precio que nadie vio y alguien tiene que mirarlo.
 */
export type SabreFulfillWarningEffect = 'INFO' | 'NOTICE' | 'NEEDS_HUMAN' | 'PRICE_CHANGE';

export interface SabreFulfillWarningRule {
  /** La categoría con que la lista oficial publica el aviso. Documental: se decide por `type`. */
  readonly category: string;
  readonly effect: SabreFulfillWarningEffect;
  readonly warning: TicketIssueWarning;
}

/**
 * Los siete avisos de `fulfillFlightTickets`, uno por fila de la lista oficial. Se decide por `type`
 * y nunca por `category`: `UNABLE_TO_RETRIEVE_TICKETS` llega como aviso o como error según el
 * momento (docs/sabre/06 §2.8).
 */
export const SABRE_FULFILL_WARNING_RULES: Readonly<Record<string, SabreFulfillWarningRule>> =
  Object.freeze({
    EMAIL_NOT_FOUND: Object.freeze({
      category: 'MISSING_DATA',
      effect: 'INFO',
      warning: 'provider-email-not-sent',
    }),
    DOWNLINE_SERVICE_WARNING: Object.freeze({
      category: 'PROCESSING_WARNING',
      effect: 'NOTICE',
      warning: 'provider-downline-notice',
    }),
    FULFILLMENT_NOT_CONFIRMED: Object.freeze({
      category: 'PROCESSING_WARNING',
      effect: 'NEEDS_HUMAN',
      warning: 'fulfillment-not-confirmed',
    }),
    PARTIAL_FULFILLMENT: Object.freeze({
      category: 'PROCESSING_WARNING',
      effect: 'NEEDS_HUMAN',
      warning: 'partial-fulfillment',
    }),
    PRICE_CHANGE: Object.freeze({
      category: 'PROCESSING_WARNING',
      effect: 'PRICE_CHANGE',
      warning: 'price-changed',
    }),
    UNABLE_TO_RETRIEVE_TICKETS: Object.freeze({
      category: 'PROCESSING_WARNING',
      effect: 'NEEDS_HUMAN',
      warning: 'documents-not-retrieved',
    }),
    FUNCTIONALITY_NOT_APPLICABLE: Object.freeze({
      category: 'IGNORED_DETAILS',
      effect: 'INFO',
      warning: 'provider-ignored-detail',
    }),
  } satisfies Record<string, SabreFulfillWarningRule>);

/** «La reserva ya está emitida» (`help-documentation-fulfill-flight-tickets-error-list.txt`). */
export const SABRE_FULFILL_ALREADY_FULFILLED_TYPES: ReadonlySet<string> = new Set([
  'BOOKING_FULFILLED',
]);

/**
 * Los tres estados ambiguos, también cuando llegan en `errors[]`: `UNABLE_TO_RETRIEVE_TICKETS` como
 * error dice literalmente «Tickets might have been issued successfully».
 */
export const SABRE_FULFILL_HUMAN_REVIEW_TYPES: ReadonlySet<string> = new Set([
  'PARTIAL_FULFILLMENT',
  'FULFILLMENT_NOT_CONFIRMED',
  'UNABLE_TO_RETRIEVE_TICKETS',
]);

/**
 * Errores que no descartan que algo se emitiera. `PAYMENT_CARD_ISSUE` dice «At least one fulfillment
 * operation was not processed correctly»; `INTERNAL_SERVER_TIMEOUT` tiene dos textos con el mismo
 * `type`, y uno de ellos es el timeout del servicio de emisión; `DOWNLINE_SERVICE_ERROR` es un error
 * del servicio que emite, reempaquetado.
 */
export const SABRE_FULFILL_UNCERTAIN_TYPES: ReadonlySet<string> = new Set([
  'PAYMENT_CARD_ISSUE',
  'INTERNAL_SERVER_TIMEOUT',
  'DOWNLINE_SERVICE_ERROR',
]);

/**
 * Errores cuyo texto oficial dice que no se emitió nada («No new tickets have been issued…», «The
 * fulfillment operation cannot be processed…»). Con éstos el pedido se puede corregir y repetir.
 */
export const SABRE_FULFILL_NOT_ISSUED_TYPES: ReadonlySet<string> = new Set([
  'PRICE_MISMATCH',
  'PRINTER_NOT_ASSIGNED',
  'PAYMENT_REQUIRED',
  'PRICE_QUOTE_RECORD_NUMBER_INVALID',
  'PRICE_QUOTE_REISSUE_RECORD_NUMBER_INVALID',
  'AIR_TICKET_VALIDATING_AIRLINE_MISSING',
  'MINIMUM_CONNECT_TIME_NOT_VALID',
  'SECURE_FLIGHT_PASSENGER_DATA_MISSING',
  'MISSING_TICKET_ASSIGNATION',
  'MISSING_PRICE_QUOTE_AIR_EXTRAS_DETAILS',
  'PENDING_PAYMENT',
  'FAILED_PAYMENT',
  'PAYMENT_CARD_CVV_INVALID',
  'PAYMENT_CARD_CVV_MISSING',
  'PAYMENT_CARD_DECLINED',
  'PAYMENT_CARD_EXPIRATION_DATE_INVALID',
]);

/**
 * Categorías de rechazo previo a la ejecución: la petición no pasó la validación o pide algo que no
 * existe en la reserva. Todo el `BAD_REQUEST` del catálogo, el `INVALID_DATA` de un ítem que no se
 * encuentra y el `RESOURCE_NOT_FOUND` de una reserva que no existe.
 */
export const SABRE_FULFILL_REJECTED_CATEGORIES: ReadonlySet<string> = new Set([
  'BAD_REQUEST',
  'INVALID_DATA',
  'RESOURCE_NOT_FOUND',
  'REQUEST_NOT_ALLOWED',
]);

/** Un problema reducido a lo que decide: de qué array vino, `category` y `type`. Nada de texto. */
export interface SabreFulfillIssueSignal {
  readonly severity: 'error' | 'warning';
  readonly category?: string;
  readonly type?: string;
}

export interface SabreFulfillFailureVerdict {
  readonly verdict: Extract<
    SabreFulfillVerdict,
    'ALREADY_FULFILLED' | 'NEEDS_HUMAN' | 'UNVERIFIED' | 'FAILED'
  >;
  readonly warnings: readonly TicketIssueWarning[];
}

/**
 * Qué significa una emisión que el proveedor devolvió con `errors[]`. Lo usan el mapper, cuando el
 * cuerpo trae `errors[]`, y el adapter, cuando el cliente HTTP lo convierte en `SabreApiError` con
 * los problemas ya pasados por la puerta de vocabulario de `errors.ts`.
 *
 * El orden importa y va del peor caso al mejor: un aviso ambiguo gana a todo; un error que no
 * descarta la emisión gana a «ya estaba emitida»; y `FAILED` exige que TODOS los errores sean de los
 * que dicen que no se emitió nada. Un error que no está en ninguna tabla no se da por rechazo: sale
 * `UNVERIFIED`, y lo resuelve una lectura de la reserva en vez de un reintento.
 */
export function classifySabreFulfillIssues(
  issues: readonly SabreFulfillIssueSignal[],
): SabreFulfillFailureVerdict {
  const warnings = new Set<TicketIssueWarning>();
  for (const issue of issues) {
    const rule = issue.type === undefined ? undefined : warningRuleOf(issue.type);
    if (rule !== undefined) warnings.add(rule.warning);
  }

  if (issues.some((issue) => issue.type !== undefined && isHumanReviewType(issue.type))) {
    return { verdict: 'NEEDS_HUMAN', warnings: [...warnings] };
  }
  if (
    issues.some(
      (issue) => issue.type !== undefined && SABRE_FULFILL_UNCERTAIN_TYPES.has(issue.type),
    )
  ) {
    warnings.add('provider-error-uncertain');
    return { verdict: 'UNVERIFIED', warnings: [...warnings] };
  }

  const errors = issues.filter((issue) => issue.severity === 'error');
  if (
    errors.length > 0 &&
    errors.every(
      (issue) => issue.type !== undefined && SABRE_FULFILL_ALREADY_FULFILLED_TYPES.has(issue.type),
    )
  ) {
    warnings.add('already-fulfilled');
    return { verdict: 'ALREADY_FULFILLED', warnings: [...warnings] };
  }
  if (errors.length > 0 && errors.every(isNotIssuedError)) {
    warnings.add('provider-rejected');
    if (errors.some((issue) => issue.type === 'PRICE_MISMATCH')) warnings.add('price-changed');
    return { verdict: 'FAILED', warnings: [...warnings] };
  }
  warnings.add('provider-error-uncertain');
  return { verdict: 'UNVERIFIED', warnings: [...warnings] };
}

function isHumanReviewType(type: string): boolean {
  return SABRE_FULFILL_HUMAN_REVIEW_TYPES.has(type);
}

function isNotIssuedError(issue: SabreFulfillIssueSignal): boolean {
  if (issue.type !== undefined && SABRE_FULFILL_NOT_ISSUED_TYPES.has(issue.type)) return true;
  return issue.category !== undefined && SABRE_FULFILL_REJECTED_CATEGORIES.has(issue.category);
}

function warningRuleOf(type: string): SabreFulfillWarningRule | undefined {
  return Object.hasOwn(SABRE_FULFILL_WARNING_RULES, type)
    ? SABRE_FULFILL_WARNING_RULES[type]
    : undefined;
}

// ---------------------------------------------------------------------------------------------
// Zod en el borde de salida del proveedor
// ---------------------------------------------------------------------------------------------

/** `category` y `type` se leen como `unknown` y sólo se comparan: nunca se copian. */
const IssueSchema = z.object({
  category: z.unknown().optional(),
  type: z.unknown().optional(),
});

/**
 * `FulfillTicket` (`:7965-8019`). Los nombres del pasajero no se declaran: el objeto de Zod los
 * descarta al parsear y no llegan a ninguna variable.
 */
const FulfillTicketSchema = z.object({
  isCommitted: z.unknown().optional(),
  number: z.unknown().optional(),
  ticketStatusCode: z.unknown().optional(),
  ticketingPcc: z.unknown().optional(),
});

export const SabreFulfillResponseSchema = z.object({
  tickets: z.array(FulfillTicketSchema).optional(),
  errors: z.array(IssueSchema).optional(),
  warnings: z.array(IssueSchema).optional(),
});

/** `FulfillTicket.ticketingPcc` — `^[A-Z0-9]{3,4}$` (`:8014-8019`). */
const TICKETING_PCC_PATTERN = /^[A-Z0-9]{3,4}$/;

/** La respuesta no encaja con el contrato. Lleva **rutas de Zod, nunca valores**. */
export class SabreFulfillMappingError extends Error {
  constructor(readonly issuePaths: readonly string[]) {
    super(
      `respuesta de fulfillFlightTickets fuera de contrato (${issuePaths.join(', ') || '<root>'})`,
    );
    this.name = 'SabreFulfillMappingError';
  }
}

export interface SabreFulfillMapContext {
  /** Pasajeros de la reserva: cada uno lleva un tiquete. De 1 a 9. */
  readonly travelerCount: number;
}

export interface SabreFulfillMapped {
  readonly verdict: SabreFulfillVerdict;
  /** Los documentos de la respuesta, uno por número principal. Sin pasajero: no lo informa. */
  readonly documents: readonly TicketDocument[];
  readonly warnings: readonly TicketIssueWarning[];
  /** Tiquetes (no EMD) emitidos distintos que trajo la respuesta. */
  readonly issuedTickets: number;
  /** La oficina que emitió, si todos los documentos dicen la misma. Sólo ATPCO la informa. */
  readonly ticketingPcc?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Traduce la respuesta de la emisión. Lanza {@link SabreFulfillMappingError} si la forma no es la del
 * contrato: quien llama ya mandó la emisión, así que ese error se trata como «no se sabe» y se relee
 * la reserva.
 */
export function mapSabreFulfillResponse(
  raw: unknown,
  ctx: SabreFulfillMapContext,
): SabreFulfillMapped {
  if (!Number.isSafeInteger(ctx.travelerCount) || ctx.travelerCount < 1) {
    throw new SabreFulfillMappingError(['travelerCount:invalid']);
  }
  const parsed = SabreFulfillResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SabreFulfillMappingError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`),
    );
  }
  const response = parsed.data;
  const warnings = new Set<TicketIssueWarning>();

  let documents: TicketDocument[] = [];
  let notCommitted = false;
  const pccs = new Set<string>();
  for (const ticket of response.tickets ?? []) {
    const rawNumber = text(ticket.number);
    const number = rawNumber === undefined ? undefined : sabrePrimaryDocumentNumber(rawNumber);
    if (number === undefined) {
      warnings.add('document-number-malformed');
      continue;
    }
    const classified = classifySabreTicketStatus(ticket.ticketStatusCode);
    if (classified.status === 'UNKNOWN') warnings.add('document-status-unknown');
    // Sólo `false` explícito: el campo es de ATPCO (`:7973-7977`) y NDC no lo manda.
    if (ticket.isCommitted === false) notCommitted = true;
    const pcc = text(ticket.ticketingPcc);
    if (pcc !== undefined && TICKETING_PCC_PATTERN.test(pcc)) pccs.add(pcc);
    documents = mergeSabreTicketDocuments(documents, [
      {
        number,
        kind: classified.kind,
        status: classified.status,
        ...(classified.providerStatusCode === undefined
          ? {}
          : { providerStatusCode: classified.providerStatusCode }),
      },
    ]);
  }
  const issuedTickets = documents.filter(
    (document) => document.kind === 'TICKET' && document.status === 'ISSUED',
  ).length;
  const ticketingPcc = pccs.size === 1 ? [...pccs][0] : undefined;
  const base = {
    documents,
    issuedTickets,
    ...(ticketingPcc === undefined ? {} : { ticketingPcc }),
  };

  const signals: SabreFulfillIssueSignal[] = [
    ...(response.errors ?? []).map((issue) => signalOf('error', issue)),
    ...(response.warnings ?? []).map((issue) => signalOf('warning', issue)),
  ];
  if ((response.errors ?? []).length > 0) {
    const failure = classifySabreFulfillIssues(signals);
    for (const warning of failure.warnings) warnings.add(warning);
    return { ...base, verdict: failure.verdict, warnings: [...warnings] };
  }

  let needsHuman = false;
  let priceChanged = false;
  for (const signal of signals) {
    const rule = signal.type === undefined ? undefined : warningRuleOf(signal.type);
    if (rule === undefined) {
      warnings.add('provider-warning-unrecognized');
      continue;
    }
    warnings.add(rule.warning);
    if (rule.effect === 'NEEDS_HUMAN') needsHuman = true;
    if (rule.effect === 'PRICE_CHANGE') priceChanged = true;
  }
  if (notCommitted) warnings.add('document-not-committed');
  if (issuedTickets < ctx.travelerCount) warnings.add('documents-missing');

  return { ...base, verdict: resolveVerdict(), warnings: [...warnings] };

  function resolveVerdict(): SabreFulfillVerdict {
    if (needsHuman) return 'NEEDS_HUMAN';
    // Con `acceptPriceChanges: false` el cambio de precio sin documentos es la emisión que no
    // ocurrió. Con documentos, el proveedor emitió a un precio que nadie vio: no se da por bueno.
    if (priceChanged) return documents.length === 0 ? 'FAILED' : 'NEEDS_HUMAN';
    if (notCommitted) return 'UNVERIFIED';
    if (issuedTickets === 0) return 'UNVERIFIED';
    return issuedTickets < ctx.travelerCount ? 'PARTIAL' : 'ISSUED';
  }
}

function signalOf(
  severity: 'error' | 'warning',
  issue: z.infer<typeof IssueSchema>,
): SabreFulfillIssueSignal {
  const category = text(issue.category);
  const type = text(issue.type);
  return {
    severity,
    ...(category === undefined ? {} : { category }),
    ...(type === undefined ? {} : { type }),
  };
}

/**
 * Cuántos pasajeros tienen ya su tiquete emitido según una LECTURA de la reserva, que es la única
 * que dice de quién es cada tiquete (`FlightTicket.travelerIndex`, obligatorio en el contrato).
 *
 * - `COMPLETE`: cada pasajero, de 0 a `travelerCount - 1`, tiene un tiquete `ISSUED`.
 * - `PARTIAL`: hay tiquetes emitidos, pero no para todos —o no se sabe para quién—.
 * - `NONE`: ningún tiquete emitido.
 *
 * Un tiquete emitido sin pasajero cuenta para «hay algo emitido», nunca para «está completo»:
 * contarlo para completar podría dar por emitida la reserva con un pasajero sin tiquete.
 */
export type SabreTicketCoverage = 'COMPLETE' | 'PARTIAL' | 'NONE';

export function sabreTicketCoverage(
  documents: readonly TicketDocument[],
  travelerCount: number,
): SabreTicketCoverage {
  const issued = documents.filter(
    (document) => document.kind === 'TICKET' && document.status === 'ISSUED',
  );
  if (issued.length === 0) return 'NONE';
  const covered = new Set<number>();
  for (const document of issued) {
    if (document.travelerIndex !== undefined && document.travelerIndex < travelerCount) {
      covered.add(document.travelerIndex);
    }
  }
  return covered.size >= travelerCount ? 'COMPLETE' : 'PARTIAL';
}
