import type { NextResponse } from 'next/server';
import { membershipStatusPlan } from '../../../../../lib/tenant-admin-proxy';
import { forwardPlan } from '../../../../../lib/tenant-admin-proxy-route';

/**
 * Suspende o reactiva el acceso de un miembro a un nodo (sólo ese nodo y su subárbol). Quién puede
 * lo decide el API.
 */
export async function PATCH(req: Request): Promise<NextResponse> {
  return forwardPlan(req, membershipStatusPlan(await req.json().catch(() => undefined)), 'PATCH');
}
