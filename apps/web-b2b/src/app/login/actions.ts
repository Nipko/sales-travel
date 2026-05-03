'use server';

import { redirect } from 'next/navigation';
import { api } from '../../lib/api';
import { clearSession, setSession } from '../../lib/session';

export interface LoginState {
  error?: string;
}

interface AuthResult {
  token: string;
  userId: string;
  tenantId?: string;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

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
  redirect('/');
}

export async function logoutAction(): Promise<void> {
  await clearSession();
  redirect('/login');
}
