import type { NextResponse } from 'next/server';
import { seatReleaseTarget } from '../../../../../../../../lib/tenant-admin-proxy';
import { forwardAction } from '../../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string; sessionId: string }> };

/**
 * Un admin desconecta a alguien para liberar su puesto. El API exige que administre el nodo de
 * ESA sesión y que no sea la suya.
 */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId, sessionId } = await params;
  return forwardAction(req, seatReleaseTarget(tenantId, sessionId));
}
