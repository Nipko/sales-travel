import type { ApiError } from '../../lib/api';
import { INVITATION_MESSAGES } from './invitation-view';

/**
 * El mensaje de un canje rechazado con el formulario de cuenta nueva. Un 400 con
 * `INVITATION_NO_LONGER_VALID` es una invitación auténtica y vigente que quien la mandó ya no podría
 * mandar (lo suspendieron o le bajaron el rol) o cuyo nodo no opera: hay que pedir otra. Cualquier
 * otro 400 es un enlace usado, vencido o revocado. Un 409 `INVITATION_SIGN_IN_REQUIRED` es que el
 * correo ya tiene cuenta (la crearon mientras tanto): se ingresa con ella (USR-17).
 */
export function acceptInvitationError(
  error: Pick<ApiError, 'status' | 'message' | 'reason'>,
): string {
  if (error.status === 400) {
    return error.reason === 'INVITATION_NO_LONGER_VALID'
      ? INVITATION_MESSAGES.noLongerValid
      : INVITATION_MESSAGES.usedOrExpired;
  }
  if (error.status === 409 && error.reason === 'INVITATION_SIGN_IN_REQUIRED') {
    return INVITATION_MESSAGES.signInRequired;
  }
  return error.message;
}
