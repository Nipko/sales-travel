import type { NextResponse } from 'next/server';
import { membershipRemovePlan } from '../../../../../lib/tenant-admin-proxy';
import { forwardPlan } from '../../../../../lib/tenant-admin-proxy-route';

/**
 * Quita a un miembro de un nodo (baja blanda: su historial queda y vuelve sólo con una invitación
 * nueva). Quién puede, y si pide el código del 2FA, lo decide el API.
 */
export async function POST(req: Request): Promise<NextResponse> {
  return forwardPlan(req, membershipRemovePlan(await req.json().catch(() => undefined)), 'POST');
}
