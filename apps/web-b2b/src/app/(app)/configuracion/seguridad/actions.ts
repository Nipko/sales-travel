'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { loginPath } from '../../../../components/layout/session-guard-state';
import { clearSession, clearTrustedDevice, setSession } from '../../../../lib/session';
import { callSecurityApi } from './security-api';
import {
  attemptsLeftOf,
  failureMessage,
  sessionEndMotivo,
  type ApiFailure,
  type FailureContext,
} from './security-errors';

const PATH = '/configuracion/seguridad';

export interface ActionResult {
  ok?: boolean;
  error?: string;
}

export interface EnrollResult extends ActionResult {
  secret?: string;
  otpauthUri?: string;
}

export interface CodesResult extends ActionResult {
  recoveryCodes?: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

/** El código de 6 dígitos de la app, o `null`. Acepta espacios o guiones pegados con el código. */
function totpCode(formData: FormData): string | null {
  const raw = asString(formData.get('code')).replace(/[\s-]/g, '');
  return /^\d{6}$/.test(raw) ? raw : null;
}

/**
 * Un código de recuperación (10 hex, se muestran `XXXXX-XXXXX`), en mayúsculas y sin guion: la
 * forma en que se generan. `null` si no tiene esa forma, así un error de tipeo no llega al API.
 */
function recoveryCode(formData: FormData): string | null {
  const raw = asString(formData.get('code'))
    .replace(/[\s-]+/g, '')
    .toUpperCase();
  return /^[0-9A-F]{10}$/.test(raw) ? raw : null;
}

const CODE_MISSING = 'Ingresá los 6 dígitos que muestra tu app de autenticación.';
// Guion que no corta (U+2011), como en el login: partido en dos renglones parecía dos códigos.
const RECOVERY_CODE_MISSING =
  'Revisá el código de recuperación: son 10 caracteres, como A1B2C\u20113D4E5.';
const PASSWORD_MISSING = 'Ingresá tu contraseña actual.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * El error para el formulario. Si el API dice que la sesión ya no existe (otro dispositivo, un
 * admin liberó el puesto, inactividad), no tiene sentido mostrar "error": se borra la cookie y se
 * va al login con el motivo, que es lo que explica qué pasó, y de vuelta a esta pantalla después.
 */
async function fail(failure: ApiFailure, context: FailureContext): Promise<ActionResult> {
  const motivo = sessionEndMotivo(failure);
  if (motivo) {
    await clearSession();
    redirect(loginPath(motivo, PATH));
  }
  let error = failureMessage(failure, context);
  const left = attemptsLeftOf(failure);
  if (left !== null && left > 0 && context !== 'other' && context !== 'password') {
    error += left === 1 ? ' Te queda 1 intento.' : ` Te quedan ${left} intentos.`;
  }
  return { error };
}

/**
 * Después de una operación que según la versión del API puede cerrar también esta sesión (apagar el
 * 2FA revoca todas; un API anterior al token nuevo de cambio de contraseña, también): si ya no hay
 * sesión, al login con motivo en vez de dejar un panel que responde 401 a todo.
 */
async function loginIfSessionGone(): Promise<void> {
  const probe = await callSecurityApi('/auth/mfa', { method: 'GET' });
  if (!probe.ok && probe.failure.status === 401) {
    await clearSession();
    redirect('/login?motivo=cerrada');
  }
}

function toEnrollment(body: unknown): EnrollResult {
  if (
    isRecord(body) &&
    typeof body['secret'] === 'string' &&
    body['secret'] !== '' &&
    typeof body['otpauthUri'] === 'string' &&
    body['otpauthUri'].startsWith('otpauth://')
  ) {
    return { ok: true, secret: body['secret'], otpauthUri: body['otpauthUri'] };
  }
  return { error: 'No pudimos generar el código QR. Intentá de nuevo.' };
}

function toCodes(body: unknown): CodesResult {
  const raw = isRecord(body) ? body['recoveryCodes'] : undefined;
  const codes = Array.isArray(raw)
    ? raw.filter((c): c is string => typeof c === 'string' && c.trim() !== '').map((c) => c.trim())
    : [];
  if (codes.length === 0) {
    return { error: 'No recibimos los códigos de recuperación. Recargá la página.' };
  }
  return { ok: true, recoveryCodes: codes };
}

/** Enrolamiento inicial: pide un secreto nuevo. Todavía no activa nada. */
export async function enrollMfaAction(): Promise<EnrollResult> {
  const res = await callSecurityApi('/auth/mfa/enroll');
  if (!res.ok) return fail(res.failure, 'other');
  return toEnrollment(res.body);
}

/**
 * "Cambiar de teléfono": con el 2FA activo, el API sólo entrega un secreto nuevo con la contraseña
 * y un código de la app actual. El secreto activo sigue valiendo hasta confirmar el nuevo.
 */
export async function startPhoneChangeAction(formData: FormData): Promise<EnrollResult> {
  const currentPassword = asString(formData.get('currentPassword'));
  if (!currentPassword) return { error: PASSWORD_MISSING };
  const code = totpCode(formData);
  if (!code) return { error: CODE_MISSING };

  const res = await callSecurityApi('/auth/mfa/enroll', { body: { currentPassword, code } });
  if (!res.ok) return fail(res.failure, 'password-and-code');
  return toEnrollment(res.body);
}

/**
 * Confirma el secreto pendiente con el primer código y devuelve los códigos de recuperación.
 *
 * NO revalida la página: la re-renderización llegaría en esta misma respuesta con el 2FA ya activo
 * y competiría con los códigos, que hay que mostrar sí o sí. Cuando el usuario dice "Listo", la
 * pantalla hace `router.refresh()`.
 */
export async function confirmMfaAction(formData: FormData): Promise<CodesResult> {
  const code = totpCode(formData);
  if (!code) return { error: CODE_MISSING };

  const res = await callSecurityApi('/auth/mfa/confirm', { body: { code } });
  if (!res.ok) return fail(res.failure, 'code');
  return toCodes(res.body);
}

/** Códigos de recuperación nuevos; los anteriores dejan de servir. Tampoco revalida (ver arriba). */
export async function regenerateRecoveryCodesAction(formData: FormData): Promise<CodesResult> {
  const code = totpCode(formData);
  if (!code) return { error: CODE_MISSING };

  const res = await callSecurityApi('/auth/mfa/recovery-codes', { body: { code } });
  if (!res.ok) return fail(res.failure, 'code');
  return toCodes(res.body);
}

/**
 * Apaga el 2FA (sólo si ningún rol lo exige; si no, el API responde 403). Con `mode=recovery` acepta
 * un código de recuperación en lugar del de la app: el API lo admite para desactivar, y es la salida
 * de quien perdió el teléfono. "Cambiar de teléfono" no: ahí el API exige la app actual.
 */
export async function disableMfaAction(formData: FormData): Promise<ActionResult> {
  const currentPassword = asString(formData.get('currentPassword'));
  if (!currentPassword) return { error: PASSWORD_MISSING };
  const recovery = asString(formData.get('mode')) === 'recovery';
  const code = recovery ? recoveryCode(formData) : totpCode(formData);
  if (!code) return { error: recovery ? RECOVERY_CODE_MISSING : CODE_MISSING };

  const res = await callSecurityApi('/auth/mfa/disable', { body: { currentPassword, code } });
  if (!res.ok) return fail(res.failure, 'password-and-code');

  await loginIfSessionGone();
  revalidatePath(PATH);
  return { ok: true };
}

export async function changePasswordAction(formData: FormData): Promise<ActionResult> {
  const currentPassword = asString(formData.get('currentPassword'));
  const newPassword = asString(formData.get('newPassword'));
  const confirm = asString(formData.get('confirm'));

  if (!currentPassword) return { error: PASSWORD_MISSING };
  if (newPassword.length < PASSWORD_MIN) {
    return { error: `La contraseña nueva debe tener al menos ${PASSWORD_MIN} caracteres.` };
  }
  if (newPassword.length > PASSWORD_MAX) {
    return { error: `La contraseña nueva puede tener hasta ${PASSWORD_MAX} caracteres.` };
  }
  if (newPassword !== confirm) return { error: 'Las contraseñas nuevas no coinciden.' };
  if (newPassword === currentPassword) {
    return { error: 'La contraseña nueva tiene que ser distinta de la actual.' };
  }

  const res = await callSecurityApi('/auth/change-password', {
    body: { currentPassword, newPassword },
  });
  if (!res.ok) return fail(res.failure, 'password');

  // El API cierra todas las sesiones y entrega una NUEVA para este dispositivo: sin guardarla, la
  // cookie seguiría con el token revocado y "Esta se mantiene" sería mentira.
  const token = isRecord(res.body) ? res.body['token'] : undefined;
  const expiresAt = isRecord(res.body) ? res.body['expiresAt'] : undefined;
  if (typeof token === 'string' && token !== '') {
    await setSession(token, typeof expiresAt === 'string' ? expiresAt : null);
  } else {
    await loginIfSessionGone();
  }
  // Los equipos de confianza creados antes del cambio dejan de valer en el API: la cookie de este
  // también, así el próximo login no manda un token muerto.
  await clearTrustedDevice();
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * El 404 de "esa sesión / ese equipo ya no estaba": venció por inactividad, se quitó desde otra
 * pestaña o desde el otro equipo. Lo que el usuario pedía ya pasó, así que cuenta como éxito y se
 * refresca la lista; devolverlo como error dejaba la fila vieja, y cada reintento daba lo mismo.
 */
function alreadyGone(failure: ApiFailure, reason: string): boolean {
  return failure.status === 404 && failure.reason === reason;
}

/** Cierra UNA sesión propia de otro dispositivo (la actual se cierra con "Cerrar sesión"). */
export async function revokeSessionAction(sessionId: string): Promise<ActionResult> {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) {
    return { error: 'No encontramos esa sesión. Recargá la página.' };
  }
  const res = await callSecurityApi(`/auth/sessions/${sessionId}/revoke`);
  if (!res.ok && !alreadyGone(res.failure, 'SESSION_NOT_FOUND')) {
    return fail(res.failure, 'other');
  }
  revalidatePath(PATH);
  return { ok: true };
}

/** Cierra la sesión en todos los dispositivos, incluido éste: vuelve al login. */
export async function revokeAllSessionsAction(): Promise<ActionResult> {
  const res = await callSecurityApi('/auth/logout-all');
  if (!res.ok) return fail(res.failure, 'other');
  await clearSession();
  redirect('/login?motivo=cerrada');
}

/** Quita un equipo de confianza: la próxima vez que se entre desde ahí se pide el código. */
export async function revokeTrustedDeviceAction(
  deviceId: string,
  current: boolean,
): Promise<ActionResult> {
  if (typeof deviceId !== 'string' || !UUID.test(deviceId)) {
    return { error: 'No encontramos ese equipo. Recargá la página.' };
  }
  const res = await callSecurityApi(`/auth/trusted-devices/${deviceId}/revoke`);
  if (!res.ok && !alreadyGone(res.failure, 'TRUSTED_DEVICE_NOT_FOUND')) {
    return fail(res.failure, 'other');
  }
  // También si ya no estaba: la cookie de este navegador tendría un token que el API ya no acepta.
  if (current === true) await clearTrustedDevice();
  revalidatePath(PATH);
  return { ok: true };
}

export async function revokeAllTrustedDevicesAction(): Promise<ActionResult> {
  const res = await callSecurityApi('/auth/trusted-devices/revoke-all');
  if (!res.ok) return fail(res.failure, 'other');
  await clearTrustedDevice();
  revalidatePath(PATH);
  return { ok: true };
}
