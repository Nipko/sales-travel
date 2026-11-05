import type { NextResponse } from 'next/server';
import { grantPlan } from '../../../../lib/platform-admins';
import { forwardPlan, forwardRead } from '../../../../lib/tenant-admin-proxy-route';

/** Los superadmins de la plataforma, plenos y supervisados (docs/platform/16). */
export async function GET(): Promise<NextResponse> {
  return forwardRead({ ok: true, path: '/admin/platform-admins' });
}

/**
 * Da acceso de superadmin a una cuenta que ya existe. Pide el 2FA reciente (`MFA_RECENT_REQUIRED`
 * llega a la pantalla) y, si lo pide un supervisado, queda como solicitud (409
 * `CHANGE_REQUEST_PENDING`).
 */
export async function POST(req: Request): Promise<NextResponse> {
  return forwardPlan(req, grantPlan(await req.json().catch(() => undefined)), 'POST');
}
