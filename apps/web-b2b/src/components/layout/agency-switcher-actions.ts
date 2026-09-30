'use server';

import { LOGIN_MESSAGES, classifyAuthResponse } from '../../app/login/login-state';
import { apiWithStatus } from '../../lib/api';
import { setActiveTenant, setSession } from '../../lib/session';
import {
  SWITCH_MESSAGES,
  afterSwitchRelease,
  classifySwitchResponse,
  isTenantId,
  switchResultFor,
  type SwitchResult,
  type SwitchSeatsState,
} from '../../lib/tenant-switch';

function post(body: Record<string, unknown>): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

/**
 * Deja la sesión nueva en el navegador: el token y el tenant activo se reescriben JUNTOS, así la
 * cabecera `x-tenant-id` nunca apunta a otra agencia que el `tid` de la sesión (el cupo de puestos
 * se cuenta por la sesión, no por la cabecera).
 */
async function adoptSession(auth: {
  token: string;
  expiresAt: string | null;
  tenantId: string | null;
}): Promise<string | null> {
  await setSession(auth.token, auth.expiresAt);
  if (auth.tenantId) await setActiveTenant(auth.tenantId);
  return auth.tenantId;
}

/**
 * Cambia la agencia con la que opera el usuario. La API emite una sesión nueva en el destino y
 * cierra la actual, controlando el cupo de puestos del destino; si está lleno, la actual sigue y
 * se devuelve el cupo para mostrar el panel del login.
 */
export async function switchAgencyAction(tenantId: unknown): Promise<SwitchResult> {
  if (!isTenantId(tenantId)) {
    return { kind: 'error', message: SWITCH_MESSAGES.invalidTarget, refresh: false };
  }
  const res = await apiWithStatus('/auth/switch-tenant', post({ tenantId }));
  const outcome = classifySwitchResponse(res);
  if (outcome.kind !== 'switched') return switchResultFor(outcome);

  const adopted = await adoptSession(outcome.auth);
  return { kind: 'switched', tenantId: adopted ?? tenantId };
}

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Cupo lleno del destino y quien cambia administra ese nodo: desconecta a alguien y entra con su
 * puesto. Es el mismo POST /auth/seats/release del login: el permiso de un solo uso se emitió para
 * el tenant destino, así que la sesión nueva queda en él (y reemplaza a la actual).
 *
 * Firma de `useActionState`, porque lo dispara el formulario de SeatsFullStep.
 */
export async function releaseSeatForSwitchAction(
  prev: SwitchSeatsState,
  formData: FormData,
): Promise<SwitchSeatsState> {
  const attempt = (Number.isSafeInteger(prev.attempt) ? prev.attempt : 0) + 1;
  const releaseToken = asString(formData.get('releaseToken'));
  const sessionId = asString(formData.get('sessionId'));
  // El estado anterior sólo sirve para volver a pintar la lista si algo falla: lo que se manda a la
  // API sale del formulario y la API lo valida.
  const seats = prev.step === 'seats' ? prev.seats : null;

  if (!releaseToken || !seats) {
    return { step: 'retry', attempt, message: SWITCH_MESSAGES.releaseExpired };
  }
  if (!sessionId) {
    return { step: 'seats', attempt, email: '', seats, error: LOGIN_MESSAGES.releaseMissing };
  }

  const res = await apiWithStatus('/auth/seats/release', post({ releaseToken, sessionId }));
  const outcome = classifyAuthResponse('release', res);
  if (outcome.kind !== 'session') return afterSwitchRelease(outcome, { attempt, seats });

  // La sesión ya se emitió (y reemplazó a la actual): pase lo que pase con el tenant, se adopta.
  const tenantId = await adoptSession(outcome.auth);
  return { step: 'switched', attempt, tenantId: tenantId ?? '' };
}
