import type { NextResponse } from 'next/server';
import { membershipImpactTarget } from '../../../../../lib/tenant-admin-proxy';
import { forwardRead } from '../../../../../lib/tenant-admin-proxy-route';

/**
 * Qué arrastraría suspender a un miembro o cambiarle el rol (las invitaciones que se revocarían),
 * para decirlo en la confirmación de Equipo antes de aplicarlo. Quién puede preguntarlo lo decide
 * el API: las mismas reglas que el cambio.
 */
export async function GET(req: Request): Promise<NextResponse> {
  return forwardRead(membershipImpactTarget(new URL(req.url).searchParams));
}
