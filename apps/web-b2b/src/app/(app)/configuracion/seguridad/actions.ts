'use server';

import { revalidatePath } from 'next/cache';
import { api } from '../../../../lib/api';

const PATH = '/configuracion/seguridad';

export interface ActionResult {
  error?: string;
  ok?: boolean;
}

export interface EnrollResult extends ActionResult {
  secret?: string;
  otpauthUri?: string;
}

export interface ConfirmResult extends ActionResult {
  recoveryCodes?: string[];
}

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

/** Paso 1: pide el secreto. Todavía no activa MFA. */
export async function enrollMfaAction(): Promise<EnrollResult> {
  const res = await api<{ secret: string; otpauthUri: string }>('/auth/mfa/enroll', {
    method: 'POST',
  });
  if (!res.ok) return { error: res.error.message };
  return { ok: true, secret: res.data.secret, otpauthUri: res.data.otpauthUri };
}

/** Paso 2: confirma con el primer código y devuelve los códigos de recuperación. */
export async function confirmMfaAction(
  _prev: ConfirmResult,
  formData: FormData,
): Promise<ConfirmResult> {
  const code = asString(formData.get('code')).trim();
  if (!code) return { error: 'Ingresá el código de tu app.' };

  const res = await api<{ recoveryCodes: string[] }>('/auth/mfa/confirm', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    return {
      error:
        res.error.status === 400
          ? 'El código no es válido. Probá con el siguiente.'
          : res.error.message,
    };
  }

  revalidatePath(PATH);
  return { ok: true, recoveryCodes: res.data.recoveryCodes };
}

export async function disableMfaAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const currentPassword = asString(formData.get('currentPassword'));
  if (!currentPassword) return { error: 'Ingresá tu contraseña actual.' };

  const res = await api<{ ok: true }>('/auth/mfa/disable', {
    method: 'POST',
    body: JSON.stringify({ currentPassword }),
  });
  if (!res.ok) {
    return {
      error: res.error.status === 400 ? 'La contraseña no es correcta.' : res.error.message,
    };
  }

  revalidatePath(PATH);
  return { ok: true };
}

export async function changePasswordAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const currentPassword = asString(formData.get('currentPassword'));
  const newPassword = asString(formData.get('newPassword'));
  const confirm = asString(formData.get('confirm'));

  if (!currentPassword) return { error: 'Ingresá tu contraseña actual.' };
  if (newPassword.length < 12)
    return { error: 'La contraseña nueva debe tener al menos 12 caracteres.' };
  if (newPassword !== confirm) return { error: 'Las contraseñas nuevas no coinciden.' };

  const res = await api<{ ok: true }>('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res.ok) {
    if (res.error.status === 401) return { error: 'La contraseña actual no es correcta.' };
    return { error: res.error.message };
  }

  revalidatePath(PATH);
  return { ok: true };
}

/** Cierra la sesión en todos los dispositivos, incluido el actual. */
export async function revokeAllSessionsAction(): Promise<ActionResult> {
  const res = await api<{ revoked: number }>('/auth/logout-all', { method: 'POST' });
  if (!res.ok) return { error: res.error.message };
  revalidatePath(PATH);
  return { ok: true };
}
