'use server';

import { redirect } from 'next/navigation';
import { api } from '../../lib/api';
import { checkPersonName } from '../../lib/person-name';
import { clearSession } from '../../lib/session';
import { acceptInvitationError } from './errors';
import {
  INVITATION_MESSAGES,
  invitationLoginHref,
  invitationTokenFrom,
  joinInvitationFailure,
  type JoinFailure,
} from './invitation-view';

export interface InvitationState {
  error?: string;
  done?: boolean;
  /** El correo ya tiene cuenta: el error lleva a ingresar con ella y volver a la invitación. */
  signInHref?: string;
}

const MIN_PASSWORD = 12;

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

/** Canje con cuenta nueva: nombre y contraseña. */
export async function acceptInvitationAction(
  _prev: InvitationState,
  formData: FormData,
): Promise<InvitationState> {
  const token = asString(formData.get('token'));
  // Las mismas reglas que el API (PersonNameSchema) y que Mi cuenta → Perfil: el error del nombre
  // sale acá, y no como el 400 genérico de "enlace usado o vencido".
  const nameCheck = checkPersonName(formData.get('name'));
  const password = asString(formData.get('password'));
  const confirm = asString(formData.get('confirm'));

  if (!token)
    return { error: 'La invitación no es válida. Pídele a tu administrador que la reenvíe.' };
  if (!nameCheck.ok) return { error: nameCheck.error };
  const name = nameCheck.name;
  if (password.length < MIN_PASSWORD) {
    return { error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` };
  }
  if (password !== confirm) return { error: 'Las contraseñas no coinciden.' };

  const res = await api<{ userId: string; tenantId: string }>('/invitations/accept', {
    method: 'POST',
    body: JSON.stringify({ token, name, password }),
  });

  if (!res.ok) {
    const error = acceptInvitationError(res.error);
    const valid = invitationTokenFrom(token);
    return res.error.reason === 'INVITATION_SIGN_IN_REQUIRED' && valid !== null
      ? { error, signInHref: invitationLoginHref(valid) }
      : { error };
  }

  // No se inicia sesión automáticamente: que entre por /login deja el flujo de MFA y de
  // lockout en un solo lugar, en vez de duplicarlo acá.
  return { done: true };
}

export type JoinState = { joined?: true } & Partial<JoinFailure>;

/**
 * Canje con la sesión abierta (USR-17): quien ya tiene cuenta acepta sin elegir otra contraseña. El
 * API comprueba que la sesión sea la de la cuenta invitada; acá sólo se traduce la respuesta.
 */
export async function joinInvitationAction(
  _prev: JoinState,
  formData: FormData,
): Promise<JoinState> {
  const token = invitationTokenFrom(asString(formData.get('token')));
  if (token === null) return { message: INVITATION_MESSAGES.usedOrExpired };

  const res = await api<{ userId: string; tenantId: string }>('/invitations/join', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
  return res.ok ? { joined: true } : joinInvitationFailure(res.error, token);
}

/**
 * Salir de la sesión abierta (que es de otra cuenta) e ir al login. Con el token de una invitación,
 * el login vuelve a ella; sin él (la cuenta nueva ya creada), al panel de la cuenta que ingrese.
 * Como el logout del panel: revoca la sesión en el API (best-effort) y borra las cookies.
 */
export async function switchAccountAction(formData: FormData): Promise<void> {
  const token = invitationTokenFrom(asString(formData.get('token')));
  await api('/auth/logout', { method: 'POST' });
  await clearSession();
  redirect(token === null ? '/login' : invitationLoginHref(token));
}
