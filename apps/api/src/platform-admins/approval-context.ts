import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * La aprobación en curso: mientras un superadmin pleno aplica la solicitud de un supervisado, todo lo
 * que se audita lleva quién la pidió, quién la aprobó y qué solicitud fue (AuditService lo agrega al
 * payload como `approval`). Además le dice a la puerta de supervisión que no vuelva a frenar el
 * cambio que se está aplicando.
 */
export interface ApprovalContext {
  readonly changeRequestId: string;
  readonly kind: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly note: string | null;
}

export const approvalContextStorage = new AsyncLocalStorage<ApprovalContext>();

export function currentApproval(): ApprovalContext | undefined {
  return approvalContextStorage.getStore();
}

/** Lo que va al payload de cada evento auditado durante la aprobación. */
export function approvalAuditPayload(approval: ApprovalContext): Record<string, unknown> {
  return {
    changeRequestId: approval.changeRequestId,
    requestedBy: approval.requestedBy,
    approvedBy: approval.approvedBy,
    ...(approval.note !== null ? { note: approval.note } : {}),
  };
}
