import type { NextResponse } from 'next/server';
import { forwardSeatsView } from '../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string }> };

/**
 * Los puestos simultáneos de un nodo: cupo, de quién lo hereda, inactividad y quiénes lo ocupan
 * (sólo de su subárbol). Si quien pide administra el nodo lo decide el API.
 */
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId } = await params;
  return forwardSeatsView(tenantId);
}
