import type { NextResponse } from 'next/server';
import { networkAuditTarget } from '../../../../../lib/tenant-admin-proxy';
import { forwardRead } from '../../../../../lib/tenant-admin-proxy-route';

/**
 * La Actividad de la red (Mi Red). La consulta se reconstruye parámetro por parámetro (nodo,
 * tamaño, cursor, categoría y persona); el estado y el motivo del API llegan a la pantalla, que
 * distingue un 403 de un 5xx. Quién puede verla (administrar el nodo) lo decide el API.
 */
export async function GET(req: Request): Promise<NextResponse> {
  return forwardRead(networkAuditTarget(new URL(req.url).searchParams));
}
