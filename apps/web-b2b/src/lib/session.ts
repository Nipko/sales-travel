import { cookies, headers } from 'next/headers';
import { SAFE_NEXT_FALLBACK, safeNextPath } from './safe-next';
import {
  COOKIES_CLEARED_ON_LOGOUT,
  REQUESTED_PATH_HEADER,
  SESSION_COOKIE,
  TENANT_COOKIE,
  TRUSTED_DEVICE_COOKIE,
  sessionCookieMaxAge,
  trustedDeviceCookieMaxAge,
} from './session-cookies';

/** El tenant activo es una preferencia de navegación, no una credencial: puede durar más. */
const TENANT_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

/**
 * Guarda el access token. `expiresAt` es el vencimiento que devuelve la API (`AuthResult.expiresAt`,
 * ISO): la cookie muere con el token. Sin él, 12 h, lo que dura un token.
 */
export async function setSession(token: string, expiresAt?: string | Date | null): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    ...baseCookieOptions(),
    maxAge: sessionCookieMaxAge(expiresAt),
  });
}

export async function getSession(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Borra la sesión y el tenant activo. NO borra `st_trusted`: "recordar este equipo" es del equipo,
 * y cerrar sesión (a mano o por inactividad) no debe volver a pedir el código en el próximo login.
 * Para olvidar el equipo está {@link clearTrustedDevice}.
 */
export async function clearSession(): Promise<void> {
  const jar = await cookies();
  for (const name of COOKIES_CLEARED_ON_LOGOUT) jar.delete(name);
}

export async function setActiveTenant(tenantId: string): Promise<void> {
  const jar = await cookies();
  jar.set(TENANT_COOKIE, tenantId, {
    ...baseCookieOptions(),
    maxAge: TENANT_MAX_AGE_SECONDS,
  });
}

export async function getActiveTenant(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(TENANT_COOKIE)?.value ?? null;
}

/** Token de equipo de confianza: viaja como `trustedDeviceToken` en el login y como `x-trusted-device`. */
export async function getTrustedDevice(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(TRUSTED_DEVICE_COOKIE)?.value ?? null;
}

/** Guarda el token que devolvió la API al pedir "recordar este equipo" (`AuthResult.trustedDevice`). */
export async function setTrustedDevice(token: string, expiresAt: string | Date): Promise<void> {
  const jar = await cookies();
  jar.set(TRUSTED_DEVICE_COOKIE, token, {
    ...baseCookieOptions(),
    maxAge: trustedDeviceCookieMaxAge(expiresAt),
  });
}

/** Olvida este equipo (p. ej. si la API dice que su token ya no vale, o el usuario lo quita). */
export async function clearTrustedDevice(): Promise<void> {
  const jar = await cookies();
  jar.delete(TRUSTED_DEVICE_COOKIE);
}

/**
 * La pantalla que pidió el usuario en este request, para volver a ella después de ingresar de nuevo
 * (`sessionEndPath(motivo, await getRequestedPath())` en el layout). La pone el middleware; `null` si
 * no está o no es una ruta del panel.
 */
export async function getRequestedPath(): Promise<string | null> {
  const store = await headers();
  const path = safeNextPath(store.get(REQUESTED_PATH_HEADER));
  return path === SAFE_NEXT_FALLBACK ? null : path;
}
