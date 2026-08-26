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
} as const;

export type OrderEventType = (typeof ORDER_EVENTS)[keyof typeof ORDER_EVENTS];

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
