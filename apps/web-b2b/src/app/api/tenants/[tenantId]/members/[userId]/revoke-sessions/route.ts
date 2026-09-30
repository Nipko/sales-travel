import type { NextResponse } from 'next/server';
import { memberActionTarget } from '../../../../../../../lib/tenant-admin-proxy';
import { forwardAction } from '../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string; userId: string }> };

/**
 * Cierra todas las sesiones de un miembro sin suspenderlo (p. ej. un vendedor que perdió el
 * celular). Misma regla de autorización que restablecer el 2FA; la decide el API.
 */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId, userId } = await params;
  return forwardAction(req, memberActionTarget(tenantId, userId, 'revoke-sessions'));
}
