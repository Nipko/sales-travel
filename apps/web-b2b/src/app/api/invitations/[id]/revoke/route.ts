import type { NextResponse } from 'next/server';
import { invitationActionTarget } from '../../../../../lib/tenant-admin-proxy';
import { forwardAction } from '../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ id: string }> };

/** Revoca una invitación pendiente: su enlace deja de funcionar. El rango lo decide el API. */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  const tenantId = new URL(req.url).searchParams.get('tenantId') ?? '';
  return forwardAction(req, invitationActionTarget(id, tenantId, 'revoke'));
}
