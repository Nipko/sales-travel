import type { NextResponse } from 'next/server';
import { tenantSummaryTarget } from '../../../../../../lib/tenant-admin-proxy';
import { forwardRead } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string }> };

/**
 * La pestaña Resumen de un nodo en Agencias: quién es, sus ventas de 30 días (él y con su red, por
 * moneda), sus números y las reservas de su red que necesitan a una persona. Sólo superadmin: lo
 * decide el API.
 */
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId } = await params;
  return forwardRead(tenantSummaryTarget(tenantId));
}
