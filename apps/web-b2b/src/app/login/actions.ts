'use server';

import { redirect } from 'next/navigation';
import { api } from '../../lib/api';
import { clearSession, setActiveTenant, setSession } from '../../lib/session';

export interface LoginState {
  error?: string;
}

interface AuthResult {
  token: string;
  userId: string;
  tenantId?: string;
}

interface Membership {
  tenantId: string;
}

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = asString(formData.get('email')).trim();
  const password = asString(formData.get('password'));

  if (!email || !password) {
    return { error: 'Email y contraseña son obligatorios.' };
  }

  const res = await api<AuthResult>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    return { error: res.error.status === 401 ? 'Credenciales inválidas.' : res.error.message };
  }

  await setSession(res.data.token);

  // Set tenant context: use tenantId from login response or fetch first membership
  if (res.data.tenantId) {
    await setActiveTenant(res.data.tenantId);
  } else {
    const memberships = await api<Membership[]>('/me/memberships');
    if (memberships.ok && memberships.data.length > 0) {
      await setActiveTenant(memberships.data[0]!.tenantId);
    }
  }

  redirect('/');
}

export async function logoutAction(): Promise<void> {
  await clearSession();
  redirect('/login');
}
