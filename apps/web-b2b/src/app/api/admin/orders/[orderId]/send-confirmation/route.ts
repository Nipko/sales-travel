import type { NextResponse } from 'next/server';
import { adminOrderActionPlan } from '../../../../../../lib/platform-orders-proxy';
import { forwardPlan } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ orderId: string }> };

/**
 * Reenvía la confirmación de una reserva de cualquier nodo al cliente, con la marca y el correo de
 * ese nodo. Sólo desde el panel (mismo origen) y con el cuerpo rearmado: `{ reason }`. Si quien
 * pide es superadmin lo decide el API, que deja el motivo en la auditoría del nodo.
 */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { orderId } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, adminOrderActionPlan(orderId, 'send-confirmation', raw), 'POST');
}
