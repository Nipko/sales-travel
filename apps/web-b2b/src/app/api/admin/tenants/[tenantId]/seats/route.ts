import type { NextResponse } from 'next/server';
import { seatPolicyPlan } from '../../../../../../lib/tenant-admin-proxy';
import { forwardPlan } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string }> };

/** Puestos simultáneos e inactividad propios de un nodo (`null` = heredar). Sólo superadmin: lo decide el API. */
export async function PATCH(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId } = await params;
  return forwardPlan(
    req,
    seatPolicyPlan(tenantId, await req.json().catch(() => undefined)),
    'PATCH',
  );
}
