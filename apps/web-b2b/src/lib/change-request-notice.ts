import { toast } from 'sonner';

/**
 * El 409 de un superadmin supervisado (`ChangeRequestPendingError`, apps/api/src/platform-admins):
 * el cambio no falló, quedó esperando que un pleno lo apruebe. Se mostraba en rojo como error en
 * Proveedores, Gobierno, Agencias y Usuarios (QA-H-24); sólo Superadmins lo trataba como aviso.
 *
 * Los clientes de esas pantallas sólo traen el mensaje, que la API escribe siempre igual: se
 * reconoce por su comienzo. platform-admins.errors.ts lo vigila un test del lado de la API.
 */
export const CHANGE_REQUEST_PENDING_PREFIX = 'Tu cambio quedó como solicitud';

export function isChangeRequestPending(message: string | undefined): boolean {
  return message !== undefined && message.startsWith(CHANGE_REQUEST_PENDING_PREFIX);
}

/** Avisa un fallo: el de la solicitud pendiente como información, cualquier otro como error. */
export function toastFailure(message: string): void {
  if (isChangeRequestPending(message)) toast.info(message);
  else toast.error(message);
}

/**
 * Para los diálogos que devuelven el mensaje de error a su formulario: si el «error» es la
 * solicitud pendiente, la anuncia y dice que el diálogo se puede cerrar.
 */
export function announcedPending(res: { ok: true } | { ok: false; message: string }): boolean {
  if (res.ok || !isChangeRequestPending(res.message)) return false;
  toast.info(res.message);
  return true;
}
