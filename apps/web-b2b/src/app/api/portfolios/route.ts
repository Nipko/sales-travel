import type { NextResponse } from 'next/server';
import { agencyWalletPlan } from '../../../lib/wallet-proxy';
import { forwardWalletPlan, walletProxyRequest } from '../../../lib/wallet-proxy-route';

/**
 * Las carteras de la agencia activa (Cartera B2B), sólo para leer: el cupo, los depósitos y los
 * ajustes los registra quien la financia (decisión del founder del 2026-09-29, opción A).
 */
export async function GET(req: Request): Promise<NextResponse> {
  return forwardWalletPlan(agencyWalletPlan(await walletProxyRequest(req)));
}
