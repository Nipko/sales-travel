import type { NextResponse } from 'next/server';
import { platformUserImpactTarget } from '../../../../../../lib/platform-users-proxy';
import { forwardRead } from '../../../../../../lib/tenant-admin-proxy-route';

/**
 * Qué arrastraría suspender una cuenta en toda la plataforma (sus nodos, sus sesiones vivas y las
 * invitaciones que se revocarían), para decirlo en la confirmación antes de aplicarla.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const { userId } = await params;
  return forwardRead(platformUserImpactTarget(userId));
}
