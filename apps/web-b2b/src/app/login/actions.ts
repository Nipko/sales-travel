'use server';

import { redirect } from 'next/navigation';
import { api, apiWithStatus } from '../../lib/api';
import { safeNextPath } from '../../lib/safe-next';
import {
  clearSession,
  getTrustedDevice,
  setActiveTenant,
  setSession,
  setTrustedDevice,
} from '../../lib/session';
import {
  LOGIN_MESSAGES,
  afterLogin,
  afterMfa,
  afterRelease,
  classifyAuthResponse,
  initialLoginState,
  nextAttempt,
  normalizeRecoveryCode,
  normalizeTotpCode,
  shownSeats,
  type AuthSuccess,
  type LoginState,
  type MfaMode,
} from './login-state';

interface Membership {
  tenantId: string;
}

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Deja la sesión lista y manda al destino. Se borra primero lo que hubiera en el navegador: en una
 * computadora compartida, el tenant activo del usuario anterior no puede quedar pegado al nuevo.
 */
async function finishLogin(auth: AuthSuccess, next: string): Promise<never> {
  await clearSession();
  await setSession(auth.token, auth.expiresAt);
  if (auth.trustedDevice) {
    await setTrustedDevice(auth.trustedDevice.token, auth.trustedDevice.expiresAt);
  }

  if (auth.tenantId) {
    await setActiveTenant(auth.tenantId);
  } else {
    const memberships = await api<Membership[]>('/me/memberships');
    if (memberships.ok && memberships.data.length > 0) {
      await setActiveTenant(memberships.data[0]!.tenantId);
    }
  }

  // Si el rol exige 2FA y todavía no lo configuró, el layout del panel muestra el enrolamiento
  // antes que cualquier pantalla (y después sigue a `next`): no hace falta desviarlo desde acá.
  redirect(next);
}

function post(body: Record<string, unknown>): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

async function submitCredentials(
  prev: LoginState,
  formData: FormData,
  next: string,
): Promise<LoginState> {
  const attempt = nextAttempt(prev);
  const email = asString(formData.get('email')).trim();
  const password = asString(formData.get('password'));

  if (!email || !password) {
    return {
      step: 'credentials',
      attempt,
      email,
      error: { kind: 'missing', message: LOGIN_MESSAGES.missing },
    };
  }

  // Con un equipo de confianza vigente para ESTE usuario la API no pide el código. Si el token es
  // de otra persona que usa la misma computadora, o ya venció, la API lo ignora y pide el código.
  const trustedDeviceToken = await getTrustedDevice();
  const res = await apiWithStatus(
    '/auth/login',
    post({ email, password, ...(trustedDeviceToken ? { trustedDeviceToken } : {}) }),
  );
  const outcome = classifyAuthResponse('login', res);
  if (outcome.kind === 'session') return finishLogin(outcome.auth, next);
  return afterLogin(outcome, { attempt, email });
}

async function submitMfa(prev: LoginState, formData: FormData, next: string): Promise<LoginState> {
  const attempt = nextAttempt(prev);
  const email = asString(formData.get('email')).trim();
  const mfaToken = asString(formData.get('mfaToken'));
  const mode: MfaMode = asString(formData.get('mode')) === 'recovery' ? 'recovery' : 'totp';
  const rememberDevice = asString(formData.get('rememberDevice')) === '1';
  const ctx = { attempt, email, mfaToken, rememberDevice, mode };

  if (!mfaToken) return initialLoginState(email, LOGIN_MESSAGES.mfaLost);

  const raw = asString(formData.get('code'));
  const code = mode === 'recovery' ? normalizeRecoveryCode(raw) : normalizeTotpCode(raw);
  // Un código mal formado no llega a la API: gastaría uno de los 5 intentos del desafío.
  if (code === null) {
    return {
      step: 'mfa',
      ...ctx,
      error: mode === 'recovery' ? LOGIN_MESSAGES.recoveryFormat : LOGIN_MESSAGES.totpFormat,
    };
  }

  const res = await apiWithStatus('/auth/mfa/verify', post({ mfaToken, code, rememberDevice }));
  const outcome = classifyAuthResponse('mfa', res);
  if (outcome.kind === 'session') return finishLogin(outcome.auth, next);
  return afterMfa(outcome, ctx);
}

async function submitRelease(
  prev: LoginState,
  formData: FormData,
  next: string,
): Promise<LoginState> {
  const attempt = nextAttempt(prev);
  const email = asString(formData.get('email')).trim();
  const releaseToken = asString(formData.get('releaseToken'));
  const sessionId = asString(formData.get('sessionId'));
  // El estado anterior sólo sirve para volver a pintar la misma lista si algo falla: lo que se
  // manda a la API sale del formulario y la API lo valida.
  const shown = shownSeats(prev);

  if (!releaseToken || !shown) return initialLoginState(email, LOGIN_MESSAGES.releaseExpired);
  if (!sessionId) {
    return { step: 'seats', attempt, email, ...shown, error: LOGIN_MESSAGES.releaseMissing };
  }

  const res = await apiWithStatus('/auth/seats/release', post({ releaseToken, sessionId }));
  const outcome = classifyAuthResponse('release', res);
  if (outcome.kind === 'session') return finishLogin(outcome.auth, next);
  return afterRelease(outcome, { attempt, email, ...shown });
}

/**
 * Un solo action para los tres pasos (`intent` del formulario), así `useActionState` guarda el
 * paso en curso y la pantalla no tiene que coordinar tres estados.
 */
export async function loginAction(prev: LoginState, formData: FormData): Promise<LoginState> {
  const next = safeNextPath(formData.get('next'));
  switch (asString(formData.get('intent'))) {
    case 'mfa':
      return submitMfa(prev, formData, next);
    case 'release':
      return submitRelease(prev, formData, next);
    default:
      return submitCredentials(prev, formData, next);
  }
}

export async function logoutAction(): Promise<void> {
  // Revocar del lado servidor: borrar la cookie sola dejaba el bearer vivo hasta que
  // expirara. Best-effort — si la API no responde igual limpiamos la sesión local.
  await api('/auth/logout', { method: 'POST' });
  await clearSession();
  redirect('/login');
}
