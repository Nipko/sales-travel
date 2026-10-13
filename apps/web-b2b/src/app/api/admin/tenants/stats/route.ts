import type { NextResponse } from 'next/server';
import { tenantStatsTarget } from '../../../../../lib/tenant-admin-proxy';
import { forwardRead } from '../../../../../lib/tenant-admin-proxy-route';

/**
 * Los números de cada nodo de la red (puestos, ventas de 30 días, última venta y depósitos por
 * aprobar) para la lista de Agencias. Sólo superadmin: lo decide el API. El segmento fijo `stats`
 * gana sobre `[tenantId]`.
 */
export async function GET(): Promise<NextResponse> {
  return forwardRead(tenantStatsTarget());
}
