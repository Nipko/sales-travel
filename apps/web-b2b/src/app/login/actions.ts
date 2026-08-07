'use server';

import { redirect } from 'next/navigation';
import { api } from '../../lib/api';
import { clearSession, setActiveTenant, setSession } from '../../lib/session';

export interface LoginState {
  error?: string;
  /**
   * Presente cuando la contraseña fue correcta pero falta el segundo factor. El
   * formulario cambia al paso del código; este token vive 5 minutos y no sirve como
   * bearer de API.
   */
  mfaToken?: string;
  /** Email en curso, sólo para mostrarlo en el paso MFA. */
  email?: string;
}

interface AuthResult {
  token: string;
  userId: string;
  tenantId?: string;
  mfaEnrollmentRequired?: boolean;
}

interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
}

interface Membership {
  tenantId: string;
}

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

function isChallenge(data: AuthResult | MfaChallenge): data is MfaChallenge {
  return 'mfaRequired' in data && data.mfaRequired === true;
}

/** Deja la sesión lista y devuelve a dónde mandar al usuario. */
async function establishSession(result: AuthResult): Promise<string> {
  await setSession(result.token);

  if (result.tenantId) {
    await setActiveTenant(result.tenantId);
  } else {
    const memberships = await api<Membership[]>('/me/memberships');
    if (memberships.ok && memberships.data.length > 0) {
      await setActiveTenant(memberships.data[0]!.tenantId);
    }
  }

  // El rol exige MFA y todavía no está enrolado: se entra directo al enrolamiento en
  // lugar de dejarlo operar sin segundo factor.
  return result.mfaEnrollmentRequired ? '/configuracion/seguridad?enrolar=1' : '/';
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const mfaToken = asString(formData.get('mfaToken'));

  // Segundo paso: canjear el desafío MFA por una sesión real.
  if (mfaToken) {
    const code = asString(formData.get('code')).trim();
    if (!code) return { mfaToken, error: 'Ingresá el código de verificación.' };

    const res = await api<AuthResult>('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ mfaToken, code }),
    });

    if (!res.ok) {
      // 401 acá puede ser código malo o desafío vencido; se distinguen para que el
      // usuario sepa si reintentar o volver a empezar.
      if (res.error.status === 401) {
        return {
          mfaToken,
          error: 'El código no es válido o el desafío venció. Probá de nuevo.',
        };
      }
      return { mfaToken, error: res.error.message };
    }

    redirect(await establishSession(res.data));
  }

  const email = asString(formData.get('email')).trim();
  const password = asString(formData.get('password'));

  if (!email || !password) {
    return { error: 'Email y contraseña son obligatorios.' };
  }

  const res = await api<AuthResult | MfaChallenge>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    if (res.error.status === 401) return { error: 'Credenciales inválidas.' };
    if (res.error.status === 429) {
      return { error: 'Demasiados intentos. Esperá un minuto antes de reintentar.' };
    }
    return { error: res.error.message };
  }

  if (isChallenge(res.data)) {
    return { mfaToken: res.data.mfaToken, email };
  }

  redirect(await establishSession(res.data));
}

export async function logoutAction(): Promise<void> {
  // Revocar del lado servidor: borrar la cookie sola dejaba el bearer vivo hasta que
  // expirara. Best-effort — si la API no responde igual limpiamos la sesión local.
  await api('/auth/logout', { method: 'POST' });
  await clearSession();
  redirect('/login');
}
