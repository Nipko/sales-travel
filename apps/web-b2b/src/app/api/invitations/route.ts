import type { NextResponse } from 'next/server';
import { invitationsListTarget, invitePlan } from '../../../lib/tenant-admin-proxy';
import { forwardPlan, forwardRead } from '../../../lib/tenant-admin-proxy-route';

/** Las invitaciones pendientes del nodo. Quién puede verlas lo decide el API. */
export async function GET(req: Request): Promise<NextResponse> {
  return forwardRead(invitationsListTarget(new URL(req.url).searchParams.get('tenantId') ?? ''));
}

/**
 * Invitar a alguien a un nodo. El 409 de una invitación ya pendiente trae su id, para que Equipo
 * ofrezca reenviarla; la respuesta de éxito dice si el correo salió.
 */
export async function POST(req: Request): Promise<NextResponse> {
  return forwardPlan(req, invitePlan(await req.json().catch(() => undefined)), 'POST');
}
