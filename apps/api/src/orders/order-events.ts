import type { OrderCreateResult, ProviderIssue } from '@sales-travel/domain';

/**
 * Vocabulario de `domain_events` para las operaciones con dinero de una orden (RNF-08).
 *
 * Los nombres son constantes y no literales sueltos por un motivo práctico: el panel de red los
 * consulta por `event_type`, y un evento con el nombre mal escrito no falla — desaparece.
 *
 * Todo evento de esta familia lleva `tenant_id` y `actor_user_id` (los pone `AuditService` desde
 * el contexto de request si no se le pasan) y un `payload` con **vocabulario cerrado**: códigos
 * nuestros, códigos del proveedor de enums declarados, y conteos. Nunca texto libre del
 * proveedor, nunca PII, nunca datos de tarjeta. `domain_events` es append-only: lo que entra ahí
 * no se puede quitar después.
 */
export const ORDER_EVENTS = {
  /** Se va a llamar al proveedor. Se emite ANTES para que un timeout deje rastro igualmente. */
  createRequested: 'OrderCreateRequested',
  /** El proveedor contestó. Lleva la `errorHandlingPolicy` con la que se pidió. */
  created: 'OrderCreated',
  /** El proveedor LANZÓ: puede haber reserva del otro lado y no lo sabemos. */
  createFailed: 'OrderCreateFailed',
  /** La lectura de cierre obligatoria. */
  verified: 'OrderCreationVerified',
  /** Hay que deshacer parte de lo creado; se encoló la compensación selectiva. */
  compensationScheduled: 'OrderCompensationScheduled',
  /** Necesita una persona. Es la rama que impide que un desenlace desconocido pase por bueno. */
  escalated: 'OrderEscalated',
  /** Cancelación ejecutada contra el proveedor (exitosa o rechazada). */
  cancelled: 'OrderCancellationAttempted',

  // Post-venta de una reserva leída al proveedor (docs/tbo/04 §6.5). Los emite quien observa: la
  // consulta manual, la verificación, el seguimiento del HCN o la conciliación, con su `source`.

  /**
   * Una lectura vio un estado del proveedor distinto del guardado. `previous` y `current` son el
   * código del enum del proveedor o `'unknown'`, nunca un valor que no se reconoce: ese se queda en
   * la fila de seguimiento para que lo revise una persona.
   */
  providerStatusChanged: 'OrderProviderStatusChanged',
  /** El número de confirmación del HOTEL apareció o cambió. Es un localizador, como el PNR. */
  hotelConfirmationNumberReceived: 'HotelConfirmationNumberReceived',
  /** Se agotaron el SLA y los reintentos sin HCN: hay tarea de operaciones (RF-27). */
  hotelConfirmationNumberMissing: 'HotelConfirmationNumberMissing',
  /**
   * El proveedor tiene la reserva en otro estado que la orden (`kind` R1 a R8 de 04 §9.4). Va al
   * tenant de la orden: es SU reserva la que diverge.
   */
  reconciliationDiscrepancy: 'OrderReconciliationDiscrepancy',
  /**
   * Una reserva de la cuenta que no es de ninguna orden (R2). Va al tenant DUEÑO de la cuenta, con
   * `aggregateType: 'provider_account'`: una agencia de la red no ve reservas que no son suyas.
   */
  providerBookingUnmatched: 'ProviderBookingUnmatched',
} as const;

export type OrderEventType = (typeof ORDER_EVENTS)[keyof typeof ORDER_EVENTS];

/**
 * Motivos de `OrderEscalated` que suma la post-venta (04 §6.5), además de los de la saga de
 * creación (`EscalationReason`) y de la verificación de un Book incierto. Vocabulario cerrado: el
 * panel filtra por él.
 */
export const POST_SALE_ESCALATION_REASONS = [
  /** La verificación agotó su calendario sin encontrar la reserva; la cierra la conciliación. */
  'create-not-found',
  /** La cancelación sigue en un estado intermedio después del último intento de lectura. */
  'cancellation-stuck',
  /** El proveedor devolvió un estado que no está en su propio vocabulario. */
  'provider-status-unknown',
] as const;
export type PostSaleEscalationReason = (typeof POST_SALE_ESCALATION_REASONS)[number];

/** Clasificación de una divergencia con el proveedor (04 §9.4). */
export const RECONCILIATION_DISCREPANCY_KINDS = [
  'R1',
  'R2',
  'R3',
  'R4',
  'R5',
  'R6',
  'R7',
  'R8',
] as const;
export type ReconciliationDiscrepancyKind = (typeof RECONCILIATION_DISCREPANCY_KINDS)[number];

export const DISCREPANCY_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type DiscrepancySeverity = (typeof DISCREPANCY_SEVERITIES)[number];

/**
 * Un estado del proveedor como puede quedar en un `domain_event` o salir por la API: un código de
 * letras y dígitos (el enum del proveedor, `Confirmed`, `CxlRequestSentToHotel`…), o `'unknown'`.
 *
 * `known` lo dice quien leyó: un valor fuera del enum del proveedor sale como `'unknown'` aunque
 * tenga forma de código. La forma se comprueba igual, porque un valor guardado antes puede venir de
 * cualquier lado, y lo que no la cumple podría ser texto libre del proveedor.
 */
export function publicProviderStatus(raw: string | null | undefined, known: boolean): string {
  if (!known || raw === null || raw === undefined) return 'unknown';
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(raw) ? raw : 'unknown';
}

/**
 * Incidencias del proveedor en la forma que puede vivir en un `domain_event`.
 *
 * `message` y `fieldValue` NO entran. `fieldValue` es el valor que mandamos devuelto tal cual —el
 * documento del pasajero— y `message` es texto libre del proveedor; los dos acabarían en una
 * tabla append-only que el panel de red muestra a cualquier admin del subárbol.
 */
export function auditableIssues(issues: readonly ProviderIssue[]): Record<string, unknown>[] {
  return issues.map((issue) => ({
    severity: issue.severity,
    category: issue.category,
    type: issue.type,
    ...(issue.fieldPath === undefined ? {} : { fieldPath: issue.fieldPath }),
  }));
}

/**
 * Resumen del desenlace de una creación, sin PII.
 *
 * El PNR sí entra: es el localizador de la reserva, se imprime en el billete y sin él el evento
 * no sirve para investigar nada. No es un dato personal ni un secreto.
 */
export function createdSummary(result: OrderCreateResult): Record<string, unknown> {
  return {
    outcome: result.outcome,
    ...(result.pnr === undefined ? {} : { pnr: result.pnr }),
    ...(result.orderId === undefined ? {} : { orderId: result.orderId }),
    items: result.items.map((item) => ({
      kind: item.kind,
      status: item.status,
      ...(item.providerItemId === undefined ? {} : { providerItemId: item.providerItemId }),
      ...(item.statusCode === undefined ? {} : { statusCode: item.statusCode }),
    })),
    issues: auditableIssues(result.issues),
  };
}
