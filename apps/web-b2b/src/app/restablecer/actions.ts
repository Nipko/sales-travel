'use server';

import { api } from '../../lib/api';

export interface ResetState {
  error?: string;
  done?: boolean;
}

/** Mismo mínimo que exige la API (Zod: min 12). Se valida acá para dar feedback inmediato. */
const MIN_PASSWORD = 12;

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

export async function resetPasswordAction(
  _prev: ResetState,
  formData: FormData,
): Promise<ResetState> {
  const token = asString(formData.get('token'));
  const newPassword = asString(formData.get('newPassword'));
  const confirm = asString(formData.get('confirm'));

  if (!token) return { error: 'El enlace no es válido. Pedí uno nuevo.' };
  if (newPassword.length < MIN_PASSWORD) {
    return { error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` };
  }
  if (newPassword !== confirm) return { error: 'Las contraseñas no coinciden.' };

  const res = await api<{ ok: true }>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  });

  if (!res.ok) {
    if (res.error.status === 400) {
      return { error: 'El enlace ya se usó o venció. Pedí uno nuevo.' };
    }
    return { error: res.error.message };
  }

  return { done: true };
}
