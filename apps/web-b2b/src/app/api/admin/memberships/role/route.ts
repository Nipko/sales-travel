import type { NextResponse } from 'next/server';
import { membershipRolePlan } from '../../../../../lib/tenant-admin-proxy';
import { forwardPlan } from '../../../../../lib/tenant-admin-proxy-route';

/** Cambia el rol de un miembro en un nodo. Quién puede y qué rol lo decide el API. */
export async function PATCH(req: Request): Promise<NextResponse> {
  return forwardPlan(req, membershipRolePlan(await req.json().catch(() => undefined)), 'PATCH');
}
