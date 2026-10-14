import type { NextResponse } from 'next/server';
import { adminOrderCancelPlan } from '../../../../../../lib/platform-orders-proxy';
import { forwardPlan } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ orderId: string }> };

/**
 * Cancela una reserva en nombre de su agencia (FD-1 C). Sólo desde el panel (mismo origen) y con el
 * cuerpo rearmado: `{ reason, orderNumber }`, el número que el superadmin escribió para confirmar.
 * Que coincida con el de la reserva, y quién puede, lo decide el API.
 */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { orderId } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, adminOrderCancelPlan(orderId, raw), 'POST');
}
