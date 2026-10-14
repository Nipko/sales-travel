import type { NextResponse } from 'next/server';
import { platformUserAuditTarget } from '../../../../../../lib/platform-users-proxy';
import { forwardRead } from '../../../../../../lib/tenant-admin-proxy-route';

/**
 * El historial de una persona en toda la plataforma, con los eventos sin nodo (ingresos fallidos,
 * pedidos de restablecer la contraseña). Sólo el superadmin: lo decide el API.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const { userId } = await params;
  return forwardRead(platformUserAuditTarget(userId, new URL(req.url).searchParams));
}
