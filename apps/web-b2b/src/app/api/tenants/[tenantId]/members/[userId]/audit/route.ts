import type { NextResponse } from 'next/server';
import { memberAuditTarget } from '../../../../../../../lib/tenant-admin-proxy';
import { forwardRead } from '../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string; userId: string }> };

/**
 * El historial de una persona del equipo, acotado al subárbol del nodo. La consulta (cursor y
 * tamaño) se reconstruye; un parámetro de más o con otra forma es 400 sin llegar al API.
 */
export async function GET(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId, userId } = await params;
  return forwardRead(memberAuditTarget(tenantId, userId, new URL(req.url).searchParams));
}
