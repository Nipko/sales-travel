import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';
import {
  NO_STORE,
  apiLogoutBody,
  clearSessionCookies,
  isSameOriginRequest,
  parseLogoutBody,
} from './session-routes';

/**
 * Cierra la sesión: la revoca en el API (con `reason: 'idle'` si fue por inactividad, para que
 * quede como `idle_timeout` y no como un cierre a mano) y borra las cookies salvo `st_trusted`.
 *
 * Revoca primero y recién después borra la cookie: sólo borrar la cookie dejaba el bearer vivo
 * hasta vencer. La revocación es best-effort: si el API no responde igual se limpia la sesión
 * local, porque dejar al usuario con una cookie que cree válida es peor.
 *
 * Lo usan `/api/session/logout` y `/api/auth/logout` (el de antes, que queda para las pestañas
 * con el JavaScript viejo durante un deploy).
 */
export async function logoutResponse(req: Request): Promise<NextResponse> {
  if (!isSameOriginRequest(req.headers)) {
    return NextResponse.json(
      { ok: false, message: 'Origen no permitido.' },
      { status: 403, headers: { 'cache-control': NO_STORE } },
    );
  }

  let idle = false;
  try {
    idle = parseLogoutBody((await req.json()) as unknown).idle;
  } catch {
    // Sin cuerpo (el botón de antes no mandaba nada): cierre a mano.
  }

  try {
    await api('/auth/logout', { method: 'POST', body: apiLogoutBody(idle) });
  } catch {
    // Ver arriba: best-effort.
  }

  const res = NextResponse.json({ ok: true }, { headers: { 'cache-control': NO_STORE } });
  clearSessionCookies(res.cookies);
  return res;
}
