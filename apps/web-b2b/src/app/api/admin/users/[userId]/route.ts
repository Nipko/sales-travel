import type { NextResponse } from 'next/server';
import { platformUserDetailTarget } from '../../../../../lib/platform-users-proxy';
import { forwardRead } from '../../../../../lib/tenant-admin-proxy-route';

/**
 * La ficha de cualquier persona de la plataforma (Plataforma → Usuarios → su nombre), con todos sus
 * nodos, sesiones e invitaciones. Sólo el superadmin: lo decide el API.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const { userId } = await params;
  return forwardRead(platformUserDetailTarget(userId));
}
