import type { NextResponse } from 'next/server';
import { invitationActionTarget } from '../../../../../lib/tenant-admin-proxy';
import { forwardAction } from '../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ id: string }> };

/**
 * Reenvía una invitación pendiente con un enlace nuevo (el anterior deja de valer). La respuesta
 * dice si el correo salió; el rango lo decide el API.
 */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  const tenantId = new URL(req.url).searchParams.get('tenantId') ?? '';
  return forwardAction(req, invitationActionTarget(id, tenantId, 'resend'));
}
