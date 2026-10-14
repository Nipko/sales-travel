import {
  TICKET_ISSUE_OUTCOMES,
  TICKET_ISSUE_WARNINGS,
  TICKETING_FORMS_OF_PAYMENT,
  type TicketDocument,
  type TicketIssueOutcome,
  type TicketIssueResult,
  type TicketIssueWarning,
  type TicketingFormOfPayment,
} from '@sales-travel/domain';
import { z } from 'zod';
import type { OrderOperationStatus } from '../database/database.types.js';

/*
 * Las decisiones de la emisión de tiquetes (SAB-08), sin base, sin cola y sin proveedor: qué se
 * guarda en la operación `issue`, qué significa cada desenlace del `TicketingPort` y qué se le dice
 * al vendedor. El servicio sólo las ejecuta.
 *
 * La regla que manda sobre todas: una emisión que salió y no se sabe en qué quedó NUNCA se reenvía.
 * Se relee la reserva hasta saberlo, y si no se sabe, lo mira una persona.
 */

/** Las relecturas de una emisión en duda: a los 2, 10 y 30 minutos. La última escala. */
export const ISSUE_VERIFY_DELAYS_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000] as const;

/**
 * Cuánto puede quedar pendiente una emisión antes de que el barrido la considere perdida. Holgado
 * frente a los 45 s que espera la emisión y la cola de un worker ocupado; corto frente al sondeo de
 * dos minutos de la pantalla y a un vendedor que no puede volver a pedirla mientras siga pendiente.
 */
export const ISSUE_STALE_AFTER_MS = 10 * 60_000;

/**
 * Dónde está una emisión pendiente.
 *
 * - `requested`: hay operación y job, y todavía nadie llamó al proveedor. Se puede abandonar.
 * - `sent`: se escribió ANTES de llamar al proveedor (write-ahead). Desde aquí la emisión pudo haber
 *   ocurrido: quien la encuentre así sólo relee la reserva, nunca la reenvía.
 * - `settled`: la operación ya tiene desenlace.
 */
export const ISSUE_STAGES = ['requested', 'sent', 'settled'] as const;
export type IssueStage = (typeof ISSUE_STAGES)[number];

/** El desenlace guardado: el del puerto, o `NOT_SENT` si se decidió antes de mandar nada. */
export const ISSUE_RECORDED_OUTCOMES = [...TICKET_ISSUE_OUTCOMES, 'NOT_SENT'] as const;
export type IssueRecordedOutcome = (typeof ISSUE_RECORDED_OUTCOMES)[number];

/** Qué produjo el desenlace guardado. Vocabulario cerrado para el panel. */
export const ISSUE_SETTLEMENT_SOURCES = [
  'provider',
  'reconciliation',
  'already-ticketed',
  'stale-request',
  'stale-sent',
  'queue-unavailable',
  'pre-check',
] as const;
export type IssueSettlementSource = (typeof ISSUE_SETTLEMENT_SOURCES)[number];

const IssueVerificationSchema = z.object({
  queued: z.boolean(),
  steps: z.number().int().min(0).max(10),
  exhausted: z.boolean().optional(),
});

/**
 * Lo que guarda `order_operations.result` de una operación `issue`. Conteos y vocabulario cerrado:
 * nunca números de tiquete, nunca texto del proveedor, nunca PII. `passthrough` porque una versión
 * vieja tiene que poder leer lo que escribió una nueva.
 */
const IssueOperationResultSchema = z
  .object({
    stage: z.enum(ISSUE_STAGES),
    requestedAt: z.string().optional(),
    sentAt: z.string().optional(),
    settledAt: z.string().optional(),
    outcome: z.enum(ISSUE_RECORDED_OUTCOMES).optional(),
    source: z.enum(ISSUE_SETTLEMENT_SOURCES).optional(),
    documents: z.number().int().min(0).optional(),
    formOfPaymentType: z.enum(TICKETING_FORMS_OF_PAYMENT).optional(),
    warnings: z.array(z.enum(TICKET_ISSUE_WARNINGS)).optional(),
    issueTypes: z.array(z.string()).optional(),
    idempotencyKey: z.string().optional(),
    retryable: z.boolean(),
    reconciliationRequired: z.boolean(),
    retryForbidden: z.boolean(),
    testContent: z.boolean().optional(),
    escalated: z.boolean().optional(),
    verification: IssueVerificationSchema.optional(),
  })
  .passthrough();

export type IssueOperationResult = z.infer<typeof IssueOperationResultSchema>;

/**
 * El `result` guardado, leído sin confiar en su forma. Lo que no se entiende se lee como la peor
 * opción segura: ya mandada y en conciliación. Un `requested` inventado es un permiso para emitir.
 */
export function persistedIssueResult(raw: unknown): IssueOperationResult {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      value = undefined;
    }
  }
  const parsed = IssueOperationResultSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return {
    stage: 'sent',
    retryable: false,
    reconciliationRequired: true,
    retryForbidden: true,
  };
}

/** El `result` con el que nace la operación, antes de que nadie llame al proveedor. */
export function requestedIssueResult(input: {
  readonly at: Date;
  readonly testContent: boolean;
}): IssueOperationResult {
  return {
    stage: 'requested',
    requestedAt: input.at.toISOString(),
    retryable: false,
    reconciliationRequired: false,
    retryForbidden: false,
    testContent: input.testContent,
  };
}

/** Lo que la pantalla puede hacer con una operación `issue` del historial. */
export interface IssueOperationPolicy {
  /** Fallida SIN emitir nada: el vendedor puede volver a pedirla. */
  readonly retryable: boolean;
  /** En duda: se concilia releyendo la reserva. Prohibido volver a emitir. */
  readonly reconciliationRequired: boolean;
}

export function issueOperationPolicy(
  status: OrderOperationStatus,
  raw: unknown,
): IssueOperationPolicy {
  if (status !== 'failed') return { retryable: false, reconciliationRequired: false };
  const result = persistedIssueResult(raw);
  return {
    retryable: result.retryable && !result.retryForbidden && !result.reconciliationRequired,
    reconciliationRequired: result.reconciliationRequired,
  };
}

/**
 * Qué hacer con el desenlace del `TicketingPort`.
 *
 * - `ticketed`: cada pasajero tiene su tiquete. La orden pasa a `ticketed` en una transacción.
 * - `reconcile`: parcial, ambigua o sin confirmar. La operación falla con conciliación obligatoria
 *   y se relee la reserva; nunca se reenvía. Parcial y ambigua escalan ya: alguien tiene que mirar.
 * - `rejected`: el proveedor no emitió nada. El vendedor puede volver a pedirla.
 */
export type IssueDecision =
  | { readonly kind: 'ticketed'; readonly outcome: 'ISSUED' | 'ALREADY_ISSUED' }
  | {
      readonly kind: 'reconcile';
      readonly outcome: 'PARTIAL' | 'NEEDS_HUMAN' | 'UNVERIFIED';
      readonly escalateNow: boolean;
    }
  | { readonly kind: 'rejected'; readonly outcome: 'FAILED'; readonly message: string };

export function decideIssue(
  result: Pick<TicketIssueResult, 'outcome' | 'warnings'>,
): IssueDecision {
  const outcome: TicketIssueOutcome = result.outcome;
  switch (outcome) {
    case 'ISSUED':
    case 'ALREADY_ISSUED':
      return { kind: 'ticketed', outcome };
    case 'PARTIAL':
    case 'NEEDS_HUMAN':
      return { kind: 'reconcile', outcome, escalateNow: true };
    case 'UNVERIFIED':
      return { kind: 'reconcile', outcome, escalateNow: false };
    case 'FAILED':
      return { kind: 'rejected', outcome, message: rejectionMessage(result.warnings) };
  }
}

/** El mensaje durable de una emisión en duda. La pantalla lo dice igual. */
export const ISSUE_UNVERIFIED_MESSAGE =
  'La aerolínea no confirmó la emisión. Revisamos la reserva automáticamente; no vuelvas a emitir.';

/**
 * «No se pudo emitir: …». Es lo que queda en `last_error` de una emisión que no emitió nada y lo
 * que lee el vendedor. El motivo es nuestro (un mensaje humanizado o el vocabulario de abajo),
 * nunca texto del proveedor.
 */
export function issueFailureMessage(reason: string): string {
  const trimmed = reason.trim().replace(/[.\s]+$/u, '');
  const body = trimmed.length === 0 ? 'el proveedor no emitió ningún tiquete' : trimmed;
  return `No se pudo emitir: ${body.charAt(0).toLowerCase()}${body.slice(1)}.`;
}

function rejectionMessage(warnings: readonly TicketIssueWarning[]): string {
  if (warnings.includes('price-changed')) {
    return issueFailureMessage(
      'el precio cambió en la aerolínea. Consulta la reserva y vuelve a cotizar antes de emitir',
    );
  }
  return issueFailureMessage('la aerolínea rechazó la emisión y no se emitió ningún tiquete');
}

/** Motivos de una emisión que se cortó antes de llamar al proveedor. */
export const ISSUE_NOT_SENT_REASONS = {
  orderMissing: 'la reserva ya no existe o no tiene localizador',
  orderNotConfirmed: 'la reserva ya no está confirmada',
  capabilityOff: 'la emisión está deshabilitada para este proveedor',
  noTicketingPort: 'este proveedor no sabe emitir tiquetes',
  staleRequest:
    'la emisión no llegó a empezar. No se emitió nada y puedes volver a pedirla desde Reservas',
  queueUnavailable: 'la cola de post-venta no estaba disponible y no se emitió nada',
} as const;

/** Cuántos pasajeros tiene la reserva: cada uno lleva su tiquete, infantes incluidos. */
export function travelerCountOf(passengers: unknown): number {
  return Array.isArray(passengers) ? passengers.length : 0;
}

/**
 * Cuántos pasajeros tienen su tiquete emitido según una LECTURA de la reserva.
 *
 * - `COMPLETE`: cada pasajero, de 0 a `travelerCount - 1`, tiene un tiquete `ISSUED`.
 * - `PARTIAL`: hay tiquetes emitidos, pero no para todos, o no se sabe de quién son.
 * - `NONE`: ningún tiquete emitido.
 *
 * Un tiquete sin pasajero cuenta para «hay algo emitido», nunca para «está completo»: contarlo
 * podría dar por emitida una reserva con un pasajero sin tiquete. Sin pasajeros no hay completa.
 */
export type TicketCoverage = 'COMPLETE' | 'PARTIAL' | 'NONE';

export function ticketCoverage(
  documents: readonly TicketDocument[],
  travelerCount: number,
): TicketCoverage {
  const issued = documents.filter(
    (document) => document.kind === 'TICKET' && document.status === 'ISSUED',
  );
  if (issued.length === 0) return 'NONE';
  const covered = new Set<number>();
  for (const document of issued) {
    const index = document.travelerIndex;
    if (index !== undefined && index >= 0 && index < travelerCount) covered.add(index);
  }
  return travelerCount > 0 && covered.size >= travelerCount ? 'COMPLETE' : 'PARTIAL';
}

/** Los avisos de una emisión que se pueden guardar: los del vocabulario del puerto. */
export function knownIssueWarnings(warnings: readonly string[]): TicketIssueWarning[] {
  const known: readonly string[] = TICKET_ISSUE_WARNINGS;
  return [...new Set(warnings.filter((w): w is TicketIssueWarning => known.includes(w)))];
}

/** Tipos de incidencia del proveedor que caben en un evento: código, nunca texto libre. */
export function auditableIssueTypes(issues: readonly { readonly type: string }[]): string[] {
  return [
    ...new Set(issues.map((issue) => issue.type).filter((t) => /^[A-Za-z0-9_.-]{1,64}$/.test(t))),
  ];
}

/** Forma de pago guardable: sólo las del puerto, nunca una tarjeta. */
export function formOfPaymentOf(value: string): TicketingFormOfPayment | undefined {
  const known: readonly string[] = TICKETING_FORMS_OF_PAYMENT;
  return known.includes(value) ? (value as TicketingFormOfPayment) : undefined;
}
