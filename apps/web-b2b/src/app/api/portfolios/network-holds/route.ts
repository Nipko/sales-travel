import type { NextResponse } from 'next/server';
import { agencyWalletPlan } from '../../../../lib/wallet-proxy';
import { forwardWalletPlan, walletProxyRequest } from '../../../../lib/wallet-proxy-route';

/**
 * Las reservas de la red retenidas en las carteras del nodo activo (0060); `?currency=USD` y
 * `?status=held` para filtrarlas. Si quien pide administra el nodo lo decide el API.
 */
export async function GET(req: Request): Promise<NextResponse> {
  return forwardWalletPlan(agencyWalletPlan(await walletProxyRequest(req, ['network-holds'])));
}
