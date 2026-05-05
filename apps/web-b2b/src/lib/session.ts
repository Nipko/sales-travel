import { cookies } from 'next/headers';

const COOKIE_NAME = 'st_session';
const TENANT_COOKIE = 'st_tenant';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export async function setSession(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function getSession(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(COOKIE_NAME)?.value ?? null;
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
  jar.delete(TENANT_COOKIE);
}

export async function setActiveTenant(tenantId: string): Promise<void> {
  const jar = await cookies();
  jar.set(TENANT_COOKIE, tenantId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function getActiveTenant(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(TENANT_COOKIE)?.value ?? null;
}
