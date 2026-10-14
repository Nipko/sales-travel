import type { NextResponse } from 'next/server';
import { memberDetailTarget } from '../../../../../../lib/tenant-admin-proxy';
import { forwardRead } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string; userId: string }> };

/**
 * La ficha de una persona del equipo (Equipo → su nombre): perfil, nodos y roles, seguridad,
 * sesiones abiertas e invitaciones que envió. Quién la ve (administrar el nodo, y la persona tiene
 * que estar en su subárbol) lo decide el API; su 403 y su 404 llegan a la pantalla con el estado.
 */
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId, userId } = await params;
  return forwardRead(memberDetailTarget(tenantId, userId));
}
