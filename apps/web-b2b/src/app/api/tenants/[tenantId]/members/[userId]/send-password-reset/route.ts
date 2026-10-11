import type { NextResponse } from 'next/server';
import { memberActionTarget } from '../../../../../../../lib/tenant-admin-proxy';
import { forwardAction } from '../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string; userId: string }> };

/**
 * Le envía a un miembro el enlace para que elija una contraseña nueva. El admin no ve el enlace: la
 * respuesta sólo dice si el correo salió. Misma regla de autorización que restablecer el 2FA; la
 * decide el API, y su 409 o 429 traen el motivo.
 */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId, userId } = await params;
  return forwardAction(req, memberActionTarget(tenantId, userId, 'send-password-reset'));
}
