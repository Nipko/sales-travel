import type { NextResponse } from 'next/server';
import { tenantImpactTarget } from '../../../../../../lib/tenant-admin-proxy';
import { forwardRead } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string }> };

/**
 * Qué arrastraría suspender un nodo con su red (personas, sesiones, reservas vigentes, saldo
 * retenido y depósitos por aprobar), para decirlo antes de confirmarlo. Sólo superadmin.
 */
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId } = await params;
  return forwardRead(tenantImpactTarget(tenantId));
}
