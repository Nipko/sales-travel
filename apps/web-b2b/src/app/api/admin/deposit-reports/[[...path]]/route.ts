import type { NextResponse } from 'next/server';
import { depositApprovalsPlan } from '../../../../../lib/deposit-approvals-proxy';
import { forwardWalletPlan } from '../../../../../lib/wallet-proxy-route';

type Params = { params: Promise<{ path?: string[] }> };

/**
 * Plataforma → Carteras: la cola de depósitos informados de toda la red y su contador. Sólo
 * lectura; aprobar y rechazar van por `/api/tenants/:id/portfolios/deposit-reports/...`. Si quien
 * pide es superadmin lo decide el API.
 */
export async function GET(req: Request, { params }: Params): Promise<NextResponse> {
  const { path } = await params;
  const url = new URL(req.url);
  return forwardWalletPlan(depositApprovalsPlan(req.method, path ?? [], url.searchParams));
}
