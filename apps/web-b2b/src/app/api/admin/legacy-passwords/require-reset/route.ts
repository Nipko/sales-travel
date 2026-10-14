import type { NextResponse } from 'next/server';
import { legacyResetPlan } from '../../../../../lib/platform-users-proxy';
import { forwardPlan } from '../../../../../lib/tenant-admin-proxy-route';

/**
 * Fuerza el cambio de contraseña a las cuentas heredadas elegidas (sólo el superadmin, lo decide el
 * API). Con chequeo de mismo origen y el cuerpo reconstruido: `{ userIds }`. El `reason` del API
 * llega a la pantalla: con `MFA_RECENT_REQUIRED` el panel pide el código del 2FA.
 */
export async function POST(req: Request): Promise<NextResponse> {
  return forwardPlan(req, legacyResetPlan(await req.json().catch(() => undefined)), 'POST');
}
