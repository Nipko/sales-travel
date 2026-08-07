'use server';

import { api } from '../../lib/api';

export interface InvitationState {
  error?: string;
  done?: boolean;
}

const MIN_PASSWORD = 12;

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

export async function acceptInvitationAction(
  _prev: InvitationState,
  formData: FormData,
): Promise<InvitationState> {
  const token = asString(formData.get('token'));
  const name = asString(formData.get('name')).trim();
  const password = asString(formData.get('password'));
  const confirm = asString(formData.get('confirm'));

  if (!token)
    return { error: 'La invitación no es válida. Pedile a tu administrador que la reenvíe.' };
  if (!name) return { error: 'Ingresá tu nombre.' };
  if (password.length < MIN_PASSWORD) {
    return { error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` };
  }
  if (password !== confirm) return { error: 'Las contraseñas no coinciden.' };

  const res = await api<{ userId: string; tenantId: string }>('/invitations/accept', {
    method: 'POST',
    body: JSON.stringify({ token, name, password }),
  });

  if (!res.ok) {
    if (res.error.status === 400) {
      return {
        error: 'La invitación ya se usó o venció. Pedile a tu administrador que la reenvíe.',
      };
    }
    return { error: res.error.message };
  }

  // No se inicia sesión automáticamente: que entre por /login deja el flujo de MFA y de
  // lockout en un solo lugar, en vez de duplicarlo acá.
  return { done: true };
}
