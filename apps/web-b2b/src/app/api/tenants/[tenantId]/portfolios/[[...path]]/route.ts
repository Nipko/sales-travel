import type { NextResponse } from 'next/server';
import { walletFinancingPlan } from '../../../../../../lib/wallet-proxy';
import { forwardWalletPlan, walletProxyRequest } from '../../../../../../lib/wallet-proxy-route';

type Params = { params: Promise<{ tenantId: string; path?: string[] }> };

/**
 * Las carteras de un nodo, gestionadas por quien lo financia (Gestión de Agencias o Mi Red →
 * nodo → Carteras). Si quien pide financia a ese nodo lo decide el API.
 */
async function handle(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId, path } = await params;
  return forwardWalletPlan(walletFinancingPlan(tenantId, await walletProxyRequest(req, path)));
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
