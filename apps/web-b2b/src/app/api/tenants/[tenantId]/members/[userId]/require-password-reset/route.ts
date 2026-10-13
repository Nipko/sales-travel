import type { NextResponse } from 'next/server';
import { memberActionTarget } from '../../../../../../../lib/tenant-admin-proxy';
import { forwardAction } from '../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string; userId: string }> };

/**
 * Obliga a un miembro a elegir una contraseña nueva antes de volver a ingresar: el API le cierra las
 * sesiones y le envía el enlace. El admin no ve el enlace: la respuesta sólo dice si el correo salió
 * y cuántas sesiones se cerraron. Misma regla de autorización que enviar el enlace; sus 409 y 429
 * traen el motivo.
 */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId, userId } = await params;
  return forwardAction(req, memberActionTarget(tenantId, userId, 'require-password-reset'));
}
