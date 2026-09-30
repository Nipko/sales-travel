import type { NextResponse } from 'next/server';
import { memberActionTarget } from '../../../../../../../lib/tenant-admin-proxy';
import { forwardAction } from '../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string; userId: string }> };

/**
 * Restablece el 2FA de un miembro que perdió el teléfono. Lo puede hacer quien administra TODOS
 * sus nodos y lo supera en rango, o el superadmin: lo decide el API, y su 403 trae el motivo.
 */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId, userId } = await params;
  return forwardAction(req, memberActionTarget(tenantId, userId, 'reset-mfa'));
}
