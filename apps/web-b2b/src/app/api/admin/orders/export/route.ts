import { NextResponse } from 'next/server';
import { apiDownload } from '../../../../../lib/api';
import { adminOrdersExportTarget } from '../../../../../lib/platform-orders-proxy';
import { tenantAdminProxyReply } from '../../../../../lib/tenant-admin-proxy';
import { isSameOriginRequest } from '../../../session/_lib/session-routes';

/** La cabecera de la exportación que el panel lee (EXPORT_ROWS_HEADER del API). */
const EXPOSED = ['x-export-rows'] as const;

/**
 * Plataforma → Reservas de la red › Exportar CSV: la vista filtrada en un archivo, tal cual lo arma el
 * API (hasta 5.000 reservas, sin pasajeros ni contacto, con el rastro `platform.orders.exported`).
 *
 * Sólo desde el panel (mismo origen): es una exportación con la cookie de quien la pide. La query se
 * rearma con los filtros de la lista (lib/platform-orders-proxy), sin la página. Pide el 2FA de los
 * últimos minutos: el 403 `MFA_RECENT_REQUIRED` vuelve con su `reason` para que el panel pida el
 * código (withStepUp) y la repita; el 422 `EXPORT_TOO_LARGE`, con su mensaje. El archivo pasa en
 * bytes, con el nombre que puso el API (`reservas-AAAA-MM-DD.csv`), sin tocarlo ni registrarlo.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!isSameOriginRequest(req.headers)) {
    return NextResponse.json(
      { error: 'No pudimos confirmar que el pedido venga del panel. Recarga la página.' },
      { status: 403 },
    );
  }
  const target = adminOrdersExportTarget(new URL(req.url).searchParams);
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: 400 });

  const res = await apiDownload(target.path, ['text/csv'], EXPOSED);
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
