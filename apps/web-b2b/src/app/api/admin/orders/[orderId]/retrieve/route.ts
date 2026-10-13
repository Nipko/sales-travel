import type { NextResponse } from 'next/server';
import { adminOrderActionPlan } from '../../../../../../lib/platform-orders-proxy';
import { forwardPlan } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ orderId: string }> };

/**
 * Consulta al proveedor el estado de una reserva de cualquier nodo, con la cuenta de ese nodo. No
 * cambia nada en el proveedor, pero llama a su API: va por POST, sólo desde el panel y con el motivo
 * (`{ reason }`), que queda en la auditoría.
 */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { orderId } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, adminOrderActionPlan(orderId, 'retrieve', raw), 'POST');
}
