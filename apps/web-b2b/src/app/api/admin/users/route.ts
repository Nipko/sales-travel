import type { NextResponse } from 'next/server';
import { platformUsersListTarget } from '../../../../lib/platform-users-proxy';
import { forwardRead } from '../../../../lib/tenant-admin-proxy-route';

/**
 * El directorio de usuarios de toda la red (Plataforma → Usuarios). La consulta se reconstruye
 * parámetro por parámetro; el estado y el motivo del API llegan a la pantalla, que distingue un 401
 * de un 403 o de un 5xx. Quién puede (sólo el superadmin) lo decide el API.
 */
export async function GET(req: Request): Promise<NextResponse> {
  return forwardRead(platformUsersListTarget(new URL(req.url).searchParams));
}
