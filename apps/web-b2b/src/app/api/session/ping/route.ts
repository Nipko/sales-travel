import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';
import { getSession } from '../../../../lib/session';
import { motivoForUnauthorized } from '../../../../lib/session-reasons';
import {
  parseSessionSnapshot,
  type PingResult,
} from '../../../../components/layout/session-guard-state';
import {
  NO_STORE,
  clearSessionCookies,
  isSameOriginRequest,
  parsePingBody,
  unauthorizedEndsSession,
} from '../_lib/session-routes';

function reply(body: PingResult, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': NO_STORE } });
}

/**
 * `POST /api/session/ping` `{ active }`: el estado de la sesión para la guardia del panel.
 *
 * `active: false` (el usuario no hizo nada desde el último ping) consulta con
 * `x-session-ping: passive`, que valida SIN refrescar `last_seen_at`: si no, el propio ping
 * mantendría viva para siempre una pestaña abandonada. `active: true` va con
 * `x-session-ping: active`, que refresca aunque no hayan pasado los 60 s de siempre: "Seguir
 * conectado" tiene que correr el plazo en el momento, no un minuto después.
 *
 * Responde `{ ok: true, ...estado }`, `{ ok: false, motivo }` si la sesión terminó (y ya borra sus
 * cookies), o `{ ok: false, retry: true }` si no se pudo saber: un API caído no es un cierre de
 * sesión, y un 401 sin motivo con el token vigente tampoco (ver {@link unauthorizedEndsSession}).
 * Siempre JSON, nunca la página de error de Next.
 *
 * Con `cerrada` NO borra las cookies: puede ser el cambio de contraseña de este mismo equipo, que
 * revoca todas las sesiones y recién después emite la nueva, cuya cookie llega con la respuesta de
 * la acción. Un ping que salió en esa ventana viaja con el token viejo, y su Set-Cookie, si llegaba
 * después, borraba la cookie NUEVA. La guardia confirma ese cierre con otro ping antes de salir, y
 * si sigue cerrada las borra `/api/session/end`.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOriginRequest(req.headers)) return reply({ ok: false, retry: true }, 403);

    const { active } = parsePingBody(await req.json().catch(() => null));

    const end = (reason: unknown) => {
      const motivo = motivoForUnauthorized(reason);
      const res = reply({ ok: false, motivo }, 401);
      if (motivo !== 'cerrada') clearSessionCookies(res.cookies);
      return res;
    };

    // Sin cookie no hay nada que preguntar: la sesión ya no está en este navegador.
    const token = await getSession();
    if (!token) return end(undefined);

    const res = await api<unknown>('/auth/session', {
      headers: { 'x-session-ping': active ? 'active' : 'passive' },
    });

    if (res.ok) {
      const snapshot = parseSessionSnapshot(res.data);
      return snapshot
        ? reply({ ok: true, ...snapshot }, 200)
        : reply({ ok: false, retry: true }, 502);
    }
    if (res.error.status === 401) {
      return unauthorizedEndsSession(res.error.reason, token, Date.now())
        ? end(res.error.reason)
        : reply({ ok: false, retry: true }, 503);
    }
    return reply({ ok: false, retry: true }, res.error.status);
  } catch {
    return reply({ ok: false, retry: true }, 500);
  }
}
