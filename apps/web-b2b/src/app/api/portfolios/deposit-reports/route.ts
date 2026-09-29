import type { NextResponse } from 'next/server';
import { agencyWalletPlan } from '../../../../lib/wallet-proxy';
import { forwardWalletPlan, walletProxyRequest } from '../../../../lib/wallet-proxy-route';

/** Los depósitos que informó la agencia activa, pendientes y resueltos. */
export async function GET(req: Request): Promise<NextResponse> {
  return forwardWalletPlan(agencyWalletPlan(await walletProxyRequest(req, ['deposit-reports'])));
}

/**
 * La agencia informa un depósito: queda pendiente y no suma saldo hasta que quien la financia lo
 * aprueba. Viaja con la `Idempotency-Key` del formulario, para que un reintento no lo duplique.
 */
export async function POST(req: Request): Promise<NextResponse> {
  return forwardWalletPlan(agencyWalletPlan(await walletProxyRequest(req, ['deposit-reports'])));
}
