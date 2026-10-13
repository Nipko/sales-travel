import type { NextResponse } from 'next/server';
import { platformUserStatusPlan } from '../../../../../lib/platform-users-proxy';
import { forwardPlan } from '../../../../../lib/tenant-admin-proxy-route';

/**
 * Suspende o reactiva una cuenta en toda la plataforma (sólo el superadmin, lo decide el API). Con
 * chequeo de mismo origen y el cuerpo reconstruido: `{ userId, status }`.
 */
export async function PATCH(req: Request): Promise<NextResponse> {
  return forwardPlan(req, platformUserStatusPlan(await req.json().catch(() => undefined)), 'PATCH');
}
