import type { OrderOperationView } from './cancel-retry-policy';
import { supportsOrderCapability, type OrderCapabilities } from './order-capabilities';

/*
 * Emitir los tiquetes de una reserva desde Reservas (SAB-08), sin React: cuándo se ofrece el botón,
 * qué se manda, qué bloquea el pedido y cómo se lee el desenlace en el historial de operaciones.
 *
 * La emisión corre en la cola del API: el pedido responde 202 con la operación y la pantalla la
 * sigue leyendo `GET /orders/:id/operations` cada 5 s, hasta 2 minutos. Una emisión en duda nunca
 * se ofrece repetir: la revisa el API releyendo la reserva.
 */

/** Cada cuánto se mira el historial mientras la emisión corre. */
export const ISSUE_POLL_EVERY_MS = 5_000;

/** Cuánto se sigue mirando antes de dejarlo en el historial. */
export const ISSUE_POLL_FOR_MS = 120_000;

export const ISSUE_MESSAGES = {
  started: 'Emisión en curso. Te avisamos aquí cuando termine.',
  issued: 'Tiquete emitido.',
  unverified:
    'La aerolínea no confirmó la emisión. Revisamos la reserva automáticamente; no vuelvas a emitir.',
  stillRunning:
    'La emisión sigue en curso. Revisa el historial de la reserva en unos minutos; no la vuelvas a pedir.',
  failedFallback: 'No se pudo emitir.',
  paymentNote:
    'Se emite con pago contra la cuenta de la agencia (sin tarjeta). El cobro al cliente va por tu medio de pago habitual.',
  testNote: 'Entorno de pruebas: no se genera un tiquete real.',
  expiredNote:
    'Plazo vencido: se intenta igual, pero la aerolínea puede haber cancelado la reserva.',
  opsFailed:
    'No pudimos comprobar si hay una emisión anterior. Por seguridad no se envía la operación.',
  pendingBlock: 'Ya hay una emisión en curso para esta reserva.',
  unverifiedBlock:
    'La emisión anterior quedó sin confirmar. No vuelvas a emitir: revisamos la reserva con la aerolínea.',
  issuedBlock: 'La reserva ya registra una emisión. Consulta su estado antes de seguir.',
  sendFailed: 'No pudimos pedir la emisión. Revisa tu conexión y vuelve a intentar.',
} as const;

/** Lo que estas funciones leen de una orden de `GET /orders`. */
export interface IssuableOrder {
  readonly status: string;
  readonly pnr: string | null;
  readonly capabilities?: Partial<OrderCapabilities>;
  readonly totalAmount: number;
  readonly currency: string;
}

/**
 * «Emitir tiquete» se ofrece con la reserva confirmada, con localizador y si el proveedor declara
 * la capacidad (ya filtrada por quien mira: el superadmin no vende). Es independiente de «Pagar /
 * Emitir», que es el pago diferido de otro proveedor.
 */
export function canIssueTicket(order: IssuableOrder): boolean {
  return (
    order.status === 'confirmed' &&
    typeof order.pnr === 'string' &&
    order.pnr.length > 0 &&
    supportsOrderCapability(order.capabilities, 'issue')
  );
}

/** Lo que se manda: el total y la moneda que el vendedor ve. Si cambiaron, el API no emite. */
export function issueRequestBody(order: Pick<IssuableOrder, 'totalAmount' | 'currency'>): {
  expectedTotalMinor: number;
  currency: string;
} {
  return { expectedTotalMinor: order.totalAmount, currency: order.currency };
}

/** La emisión más reciente del historial (el API lo devuelve del más nuevo al más viejo). */
function latestIssue(operations: readonly OrderOperationView[]): OrderOperationView | undefined {
  return operations.find((operation) => operation.type === 'issue');
}

/**
 * Lo que impide pedir otra emisión, o `null`. El API aplica la misma compuerta; esto sólo evita
 * ofrecer un pedido que va a rechazar.
 */
export function issueBlock(operations: readonly OrderOperationView[]): string | null {
  const latest = latestIssue(operations);
  if (latest === undefined) return null;
  if (latest.status === 'pending') return ISSUE_MESSAGES.pendingBlock;
  if (latest.status === 'success') return ISSUE_MESSAGES.issuedBlock;
  if (latest.reconciliationRequired) return ISSUE_MESSAGES.unverifiedBlock;
  return null;
}

/** En qué quedó una emisión pedida, leído del historial. */
export type IssueOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'issued'; readonly message: string }
  | { readonly kind: 'unverified'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

/** «No se pudo emitir: …» con el motivo que dejó el API, o el genérico. */
function failureMessage(lastError: string | null): string {
  const text = lastError?.trim() ?? '';
  if (text.length === 0) return ISSUE_MESSAGES.failedFallback;
  return text.startsWith('No se pudo emitir') ? text : `No se pudo emitir: ${text}`;
}

export function issueOutcomeOf(
  operations: readonly OrderOperationView[],
  operationId: string,
): IssueOutcome {
  const operation = operations.find((op) => op.id === operationId && op.type === 'issue');
  if (operation === undefined || operation.status === 'pending') return { kind: 'pending' };
  if (operation.status === 'success') return { kind: 'issued', message: ISSUE_MESSAGES.issued };
  if (operation.reconciliationRequired) {
    return { kind: 'unverified', message: ISSUE_MESSAGES.unverified };
  }
  return { kind: 'failed', message: failureMessage(operation.last_error) };
}

/** Una emisión que se está siguiendo desde la pantalla. */
export interface TrackedIssue {
  readonly operationId: string;
  /** Epoch ms del 202. */
  readonly startedAt: number;
}

/** Qué hacer en cada vuelta del sondeo: seguir, o cerrar con un mensaje. */
export type IssuePollDecision =
  | { readonly kind: 'keep' }
  | { readonly kind: 'settled'; readonly outcome: Exclude<IssueOutcome, { kind: 'pending' }> }
  | { readonly kind: 'timeout'; readonly message: string };

/**
 * `operations` en `null` = esta lectura falló: se sigue mirando, pero el plazo de 2 minutos corre
 * igual. Pasado el plazo, la emisión no se da por fallida: queda en el historial.
 */
export function issuePollDecision(
  tracked: TrackedIssue,
  now: number,
  operations: readonly OrderOperationView[] | null,
): IssuePollDecision {
  if (operations !== null) {
    const outcome = issueOutcomeOf(operations, tracked.operationId);
    if (outcome.kind !== 'pending') return { kind: 'settled', outcome };
  }
  return now - tracked.startedAt >= ISSUE_POLL_FOR_MS
    ? { kind: 'timeout', message: ISSUE_MESSAGES.stillRunning }
    : { kind: 'keep' };
}

/** La respuesta del pedido: la operación que quedó en cola, o el motivo para mostrar. */
export type IssueResponse =
  | { readonly ok: true; readonly operationId: string }
  | { readonly ok: false; readonly message: string };

function messageOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ['error', 'message']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (Array.isArray(value)) {
      const parts = value.filter((v): v is string => typeof v === 'string');
      if (parts.length > 0) return parts.join('. ');
    }
  }
  return undefined;
}

export function issueResponseOf(status: number, data: unknown): IssueResponse {
  if (status === 202 || status === 200) {
    const operationId =
      typeof data === 'object' && data !== null
        ? (data as { operationId?: unknown }).operationId
        : undefined;
    if (typeof operationId === 'string' && operationId.length > 0) {
      return { ok: true, operationId };
    }
  }
  return { ok: false, message: messageOf(data) ?? ISSUE_MESSAGES.sendFailed };
}
