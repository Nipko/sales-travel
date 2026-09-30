import type { ApiError } from '../../lib/api';

/**
 * El mensaje de un canje rechazado. Un 400 con `INVITATION_NO_LONGER_VALID` es una invitación
 * auténtica y vigente que quien la mandó ya no podría mandar (lo suspendieron o le bajaron el rol)
 * o cuyo nodo no opera: hay que pedir otra. Cualquier otro 400 es un enlace usado, vencido o
 * revocado.
 */
export function acceptInvitationError(
  error: Pick<ApiError, 'status' | 'message' | 'reason'>,
): string {
  if (error.status === 400) {
    return error.reason === 'INVITATION_NO_LONGER_VALID'
      ? 'Esta invitación ya no es válida, pide una nueva.'
      : 'La invitación ya se usó, venció o fue revocada. Pídele a tu administrador que te envíe una nueva.';
  }
  return error.message;
}
