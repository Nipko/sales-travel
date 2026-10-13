import type { NextResponse } from 'next/server';
import { adminOrderRetryPlan } from '../../../../../../../../lib/platform-orders-proxy';
import { forwardPlan } from '../../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ orderId: string; opId: string }> };

/**
 * Reintenta una cancelación que la agencia ya pidió y falló antes de llegar al proveedor. Sólo desde
 * el panel (mismo origen) y con el cuerpo rearmado: `{ reason }`. Si la operación se puede
 * reintentar, y quién puede, lo decide el API.
 */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { orderId, opId } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, adminOrderRetryPlan(orderId, opId, raw), 'POST');
}
