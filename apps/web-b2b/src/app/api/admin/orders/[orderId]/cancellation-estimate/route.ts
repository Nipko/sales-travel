import type { NextResponse } from 'next/server';
import { adminOrderEstimateTarget } from '../../../../../../lib/platform-orders-proxy';
import { forwardRead } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ orderId: string }> };

/**
 * La penalidad estimada de cancelar una reserva de hotel de cualquier nodo, para mostrarla antes de
 * confirmar. Sólo lee y no llama al proveedor: sale de la política que se aceptó al reservar.
 */
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { orderId } = await params;
  return forwardRead(adminOrderEstimateTarget(orderId));
}
