import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';

/**
 * Cierra la sesión.
 *
 * Revoca primero del lado servidor y recién después borra la cookie: si sólo se borrara
 * la cookie —como hacía antes— el bearer seguiría siendo válido hasta expirar, así que
 * "cerrar sesión" no cerraba nada para quien tuviera el token.
 *
 * La revocación es best-effort: si la API no responde igual limpiamos la sesión local,
 * porque dejar al usuario con una cookie que cree válida es peor.
 */
export async function POST() {
  await api('/auth/logout', { method: 'POST' }).catch(() => null);

  const jar = await cookies();
  jar.delete('st_session');
  jar.delete('st_tenant');
  return NextResponse.json({ ok: true });
}
