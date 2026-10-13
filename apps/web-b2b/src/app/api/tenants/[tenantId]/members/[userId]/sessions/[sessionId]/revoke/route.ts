import type { NextResponse } from 'next/server';
import { memberSessionRevokeTarget } from '../../../../../../../../../lib/tenant-admin-proxy';
import { forwardAction } from '../../../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string; userId: string; sessionId: string }> };

/**
 * Cierra UNA sesión de la persona desde su ficha; las demás siguen abiertas. Sólo desde el panel
 * (mismo origen). Nunca la propia, y el actor tiene que superarla en rango sobre el nodo de esa
 * sesión: lo decide el API, y su 403 o su 404 ("Esa sesión ya no está abierta.") traen el motivo.
 */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId, userId, sessionId } = await params;
  return forwardAction(req, memberSessionRevokeTarget(tenantId, userId, sessionId));
}
