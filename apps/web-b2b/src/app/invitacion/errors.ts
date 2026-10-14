import type { ApiError } from '../../lib/api';
import { PERSON_NAME_MESSAGES } from '../../lib/person-name';
import { INVITATION_MESSAGES } from './invitation-view';

const NAME_MESSAGES: readonly string[] = Object.values(PERSON_NAME_MESSAGES);

/**
 * El error del nombre en un 400 de validación del API (`ZodValidationPipe` resume los campos como
 * "… — name: <mensaje>"), sólo si es uno de los que el panel conoce (PersonNameSchema). El panel
 * valida antes con las mismas reglas, así que esto cubre a un API más estricto que el panel.
 */
function nameProblemIn(message: string): string | null {
  return NAME_MESSAGES.find((m) => message.includes(`name: ${m}`)) ?? null;
}

/**
 * El mensaje de un canje rechazado con el formulario de cuenta nueva. Un 400 con
 * `INVITATION_NO_LONGER_VALID` es una invitación auténtica y vigente que quien la mandó ya no podría
 * mandar (lo suspendieron o le bajaron el rol) o cuyo nodo no opera: hay que pedir otra. Un 400 por
 * el nombre (USR-18) dice qué tiene el nombre. Cualquier otro 400 es un enlace usado, vencido o
 * revocado. Un 409 `INVITATION_SIGN_IN_REQUIRED` es que el correo ya tiene cuenta (la crearon
 * mientras tanto): se ingresa con ella (USR-17).
 */
export function acceptInvitationError(
  error: Pick<ApiError, 'status' | 'message' | 'reason'>,
): string {
  if (error.status === 400) {
    if (error.reason === 'INVITATION_NO_LONGER_VALID') return INVITATION_MESSAGES.noLongerValid;
    return nameProblemIn(error.message) ?? INVITATION_MESSAGES.usedOrExpired;
  }
  if (error.status === 409 && error.reason === 'INVITATION_SIGN_IN_REQUIRED') {
    return INVITATION_MESSAGES.signInRequired;
  }
  return error.message;
}
