import type { NextResponse } from 'next/server';
import { legacyPasswordsTarget } from '../../../../lib/platform-users-proxy';
import { forwardRead } from '../../../../lib/tenant-admin-proxy-route';

/**
 * Las cuentas heredadas con una contraseña que eligió un admin (Plataforma → Usuarios, USR-14). Sin
 * parámetros: uno de más es 400 sin llegar al API. Quién puede (sólo el superadmin) lo decide el API;
 * el estado y el motivo llegan a la pantalla.
 */
export async function GET(req: Request): Promise<NextResponse> {
  return forwardRead(legacyPasswordsTarget(new URL(req.url).searchParams));
}
