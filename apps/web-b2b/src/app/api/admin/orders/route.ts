import type { NextResponse } from 'next/server';
import { adminOrdersPlan } from '../../../../lib/platform-orders-proxy';
import { forwardWalletPlan } from '../../../../lib/wallet-proxy-route';

/**
 * Plataforma → Reservas de la red: buscar en las reservas de toda la red. Sólo lectura; la query se
 * rearma desde una lista blanca (lib/platform-orders-proxy). Si quien pide es superadmin lo decide
 * el API. Los cuerpos no se registran: llevan referencias de reserva y correos.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  return forwardWalletPlan(adminOrdersPlan(req.method, url.searchParams));
}
