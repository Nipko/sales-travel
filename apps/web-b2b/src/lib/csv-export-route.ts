import { NextResponse } from 'next/server';
import { isSameOriginRequest } from '../app/api/session/_lib/session-routes';
import { apiDownload } from './api';
import { tenantAdminProxyReply, type TenantAdminProxyTarget } from './tenant-admin-proxy';

/** Las cabeceras de una exportación de usuarios que el panel lee (EXPORT_*_HEADER del API). */
export const USERS_EXPORT_HEADERS = ['x-export-users', 'x-export-rows', 'x-export-truncated'];

/**
 * Lo común de las rutas del panel que exportan la lista de usuarios a CSV (USR-16): el directorio de
 * la plataforma y el equipo de un nodo.
 *
 * Sólo desde el panel (mismo origen): es una lista de personas que sale con la cookie de quien la
 * pide. El 403 del 2FA (`MFA_RECENT_REQUIRED`) vuelve con su `reason` para que el panel pida el
 * código (withStepUp) y la repita. El archivo pasa en bytes, sin tocarlo ni registrarlo, y nunca
 * queda en una caché.
 */
export async function forwardUsersExport(
  req: Request,
  target: TenantAdminProxyTarget,
): Promise<NextResponse> {
  if (!isSameOriginRequest(req.headers)) {
    return NextResponse.json(
      { error: 'No pudimos confirmar que el pedido venga del panel. Recarga la página.' },
      { status: 403 },
    );
  }
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: 400 });

  const res = await apiDownload(target.path, ['text/csv'], USERS_EXPORT_HEADERS);
  if (res.kind === 'file') {
    const headers = new Headers({
      'content-type': 'text/csv; charset=utf-8',
      'cache-control': 'no-store',
    });
    for (const [name, value] of Object.entries(res.headers)) headers.set(name, value);
    return new NextResponse(res.body, { status: 200, headers });
  }
  const out = tenantAdminProxyReply(res);
  // Un 2xx que no es un CSV no es una exportación: no se le dice "listo" al panel.
  const status = out.status < 400 ? 502 : out.status;
  const body =
    out.status < 400 ? { error: 'El servidor respondió algo que no es un archivo.' } : out.body;
  return NextResponse.json(body, { status });
}
