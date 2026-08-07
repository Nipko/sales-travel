'use server';

import { api } from '../../lib/api';

export interface ForgotState {
  error?: string;
  sent?: boolean;
}

export async function forgotPasswordAction(
  _prev: ForgotState,
  formData: FormData,
): Promise<ForgotState> {
  const raw = formData.get('email');
  const email = typeof raw === 'string' ? raw.trim() : '';
  if (!email) return { error: 'Ingresá tu correo electrónico.' };

  const res = await api<{ sent: true }>('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });

  if (!res.ok) {
    if (res.error.status === 429) {
      return { error: 'Demasiados pedidos. Esperá un minuto antes de reintentar.' };
    }
    return { error: res.error.message };
  }

  // La API responde igual exista o no la cuenta (anti-enumeración), así que el mensaje
  // que mostramos también tiene que ser neutro.
  return { sent: true };
}
