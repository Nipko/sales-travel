import type { NextResponse } from 'next/server';
import { adminOrderPlan } from '../../../../../lib/platform-orders-proxy';
import { forwardWalletPlan } from '../../../../../lib/wallet-proxy-route';

type Params = { params: Promise<{ orderId: string }> };

/**
 * La ficha de una reserva de cualquier nodo. Sólo lectura; el API deja constancia de que el
 * superadmin la abrió (`platform.order.viewed`, en el nodo de la reserva).
 */
export async function GET(req: Request, { params }: Params): Promise<NextResponse> {
  const { orderId } = await params;
  return forwardWalletPlan(adminOrderPlan(req.method, orderId));
}
