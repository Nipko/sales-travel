'use server';

import { api } from '../../lib/api';

export interface ResetState {
  error?: string;
  done?: boolean;
}

/** Mismo mínimo que exige la API (Zod: min 12). Se valida acá para dar feedback inmediato. */
const MIN_PASSWORD = 12;

/** El motivo del 400 cuando, con el cambio forzado por un admin, eligió la misma contraseña. */
const PASSWORD_REUSED = 'PASSWORD_REUSED';

const PASSWORD_REUSED_MESSAGE =
  'Elige una contraseña distinta de la anterior: un administrador te pidió cambiarla.';

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

  if (!token) return { error: 'El enlace no es válido. Pide uno nuevo.' };
  if (newPassword.length < MIN_PASSWORD) {
    return { error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` };
  }
  if (newPassword !== confirm) return { error: 'Las contraseñas no coinciden.' };

  const res = await api<{ ok: true }>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  });

  if (!res.ok) {
    // Un admin le pidió cambiarla porque la actual pudo quedar expuesta: el enlace sigue sirviendo.
    if (res.error.reason === PASSWORD_REUSED) return { error: PASSWORD_REUSED_MESSAGE };
    if (res.error.status === 400) {
      return { error: 'El enlace ya se usó o venció. Pide uno nuevo.' };
    }
    return { error: res.error.message };
  }

  return { done: true };
}
