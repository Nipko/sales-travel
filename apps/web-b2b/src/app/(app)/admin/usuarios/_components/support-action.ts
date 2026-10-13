import { toast } from 'sonner';
import type { useConfirm } from '../../../../../components/ui/dialog';
import {
  ACTION_CANCELLED,
  ACTION_DONE,
  type SheetActionOutcome,
} from '../../../../../lib/member-detail';
import { isStepUpCancelled } from '../../../../../lib/step-up';
import { runMemberAction } from '../../../../../lib/tenant-admin-seats-client';
import {
  memberActionCopy,
  memberActionDoneMessage,
  memberActionNoticeTone,
  type MemberAction,
  type NetworkMember,
} from '../../../../../lib/tenant-admin-team';

export type Confirm = ReturnType<typeof useConfirm>[0];

/**
 * Una acción de soporte sobre un miembro por el nodo `tenantId` (enviar el enlace, forzar el cambio
 * de contraseña, desbloquear, cerrar sus sesiones, restablecer el 2FA): la confirmación con lo que
 * implica, la llamada y el aviso. La usan el menú de la fila de Equipo y las dos fichas (Equipo y
 * el directorio de la plataforma), para que digan y hagan lo mismo.
 *
 * `onBusy` se prende recién después de confirmar. Un rechazo vuelve como `failed` con el motivo del
 * API: quien llama decide dónde mostrarlo (la fila, o la ficha si se pidió desde ahí).
 *
 * Las de alto impacto pueden pedir el código del 2FA en el medio (USR-13): `runMemberAction` abre el
 * diálogo y repite la acción. Cerrarlo es cancelar, sin error.
 */
export async function supportMember(
  confirm: Confirm,
  tenantId: string,
  member: NetworkMember,
  action: MemberAction,
  onBusy: (busy: boolean) => void,
): Promise<SheetActionOutcome> {
  const copy = memberActionCopy(action, member);
  const ok = await confirm({
    title: copy.title,
    description: copy.description,
    confirmLabel: copy.confirmLabel,
    // Enviar el enlace y desbloquear le devuelven el acceso, no se lo cortan: confirmación neutra.
    destructive: action !== 'send-password-reset' && action !== 'unlock',
  });
  if (!ok) return ACTION_CANCELLED;
  onBusy(true);
  const res = await runMemberAction(tenantId, member.userId, action);
  onBusy(false);
  if (isStepUpCancelled(res)) return ACTION_CANCELLED;
  // Un aviso que queda (no un toast que se va): el 403 dice a quién hay que pedírselo.
  if (!res.ok) return { status: 'failed', message: res.message };
  const notify =
    memberActionNoticeTone(action, res.data) === 'warning' ? toast.warning : toast.success;
  notify(memberActionDoneMessage(action, member, res.data));
  return ACTION_DONE;
}
