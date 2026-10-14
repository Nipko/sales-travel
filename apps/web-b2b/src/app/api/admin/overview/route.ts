import type { NextResponse } from 'next/server';
import { overviewPlan } from '../../../../lib/platform-overview-proxy';
import { forwardWalletPlan } from '../../../../lib/wallet-proxy-route';

/**
 * Plataforma → Resumen: cómo va la red y qué necesita atención. Sólo lectura; el período con nombre
 * se traduce a días de Bogotá (lib/platform-overview-proxy). Si quien pide es superadmin lo decide
 * el API.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  return forwardWalletPlan(overviewPlan(req.method, url.searchParams, new Date()));
}
