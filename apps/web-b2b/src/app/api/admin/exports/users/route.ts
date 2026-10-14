import type { NextResponse } from 'next/server';
import { forwardUsersExport } from '../../../../../lib/csv-export-route';
import { platformUsersExportTarget } from '../../../../../lib/platform-users-proxy';

/**
 * Plataforma → Usuarios › Exportar CSV (USR-16): el directorio con los mismos filtros que la pantalla,
 * en un archivo, tal cual lo arma el API (hasta 10.000 personas, con el rastro `users.exported`). La
 * consulta se reconstruye parámetro por parámetro, como la de la lista; quién puede (sólo el
 * superadmin) y el 2FA de los últimos minutos los decide el API.
 */
export async function GET(req: Request): Promise<NextResponse> {
  return forwardUsersExport(req, platformUsersExportTarget(new URL(req.url).searchParams));
}
