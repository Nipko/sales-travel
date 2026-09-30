import { NextResponse, type NextRequest } from 'next/server';
import { parseIdleMinutes, parseMotivo } from '../../../../lib/session-reasons';
import { loginPath } from '../../../../components/layout/session-guard-state';
import { NO_STORE, clearSessionCookies, isRouterRequest } from '../_lib/session-routes';

/**
 * `GET /api/session/end?motivo=…&minutos=…&next=…`: borra las cookies de la sesión (no `st_trusted`) y manda
 * al login con el aviso del motivo.
 *
 * Existe porque un Server Component no puede borrar cookies: el layout del panel, al ver un 401 del
 * API, hace `redirect()` acá. El `motivo` sólo se acepta de la lista blanca y `next` sólo si es una
 * ruta interna: la URL la puede armar cualquiera.
 *
 * No verifica el origen a propósito: el `redirect()` del layout después de llegar desde un link
 * externo (WhatsApp, un correo) cuenta como cross-site para el navegador, y rechazarlo dejaría al
 * usuario rebotando entre `/login` y el panel con una cookie muerta. Lo peor que logra un tercero
 * con este GET es cerrarte la sesión.
 */
export function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const motivo = parseMotivo(params.get('motivo'));
  const location = loginPath(motivo, params.get('next'), parseIdleMinutes(params.get('minutos')));

  // Si el que pide es el router de Next (el `redirect()` llegó en medio de una navegación de
  // cliente), una respuesta que no es RSC lo obliga a una navegación DURA a esta misma URL. Con un
  // 303 directo al login, en cambio, la navegación seguiría siendo de cliente y el Router Cache
  // guardaría las pantallas de antes: "Atrás" volvería a mostrar clientes u órdenes.
  const res = isRouterRequest(req.headers)
    ? new NextResponse(null, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': NO_STORE },
      })
    : new NextResponse(null, {
        // Relativo a propósito: detrás de Caddy, `req.url` puede no traer el host público.
        status: 303,
        headers: { location, 'cache-control': NO_STORE },
      });
  clearSessionCookies(res.cookies);
  return res;
}
