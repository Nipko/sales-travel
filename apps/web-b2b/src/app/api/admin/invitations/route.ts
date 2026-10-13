import type { NextResponse } from 'next/server';
import { platformInvitationsListTarget } from '../../../../lib/platform-invitations';
import { forwardRead } from '../../../../lib/tenant-admin-proxy-route';

/**
 * Las invitaciones sin aceptar de toda la red (Plataforma → Usuarios → Invitaciones). La consulta se
 * reconstruye parámetro por parámetro; el estado y el motivo del API llegan a la pantalla. Quién
 * puede (sólo el superadmin) lo decide el API. Reenviar y revocar van por /api/invitations/:id/…, con
 * el nodo de cada fila.
 */
export async function GET(req: Request): Promise<NextResponse> {
  return forwardRead(platformInvitationsListTarget(new URL(req.url).searchParams));
}
