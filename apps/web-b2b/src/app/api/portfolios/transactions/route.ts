import type { NextResponse } from 'next/server';
import { agencyWalletPlan } from '../../../../lib/wallet-proxy';
import { forwardWalletPlan, walletProxyRequest } from '../../../../lib/wallet-proxy-route';

/** Los movimientos de las carteras de la agencia activa; `?currency=USD` para los de una. */
export async function GET(req: Request): Promise<NextResponse> {
  return forwardWalletPlan(agencyWalletPlan(await walletProxyRequest(req, ['transactions'])));
}
