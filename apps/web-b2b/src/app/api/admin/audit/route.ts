import type { NextResponse } from 'next/server';
import { adminAuditTarget } from '../../../../lib/platform-audit-proxy';
import { forwardRead } from '../../../../lib/tenant-admin-proxy-route';

/**
 * Plataforma → Actividad: los eventos de toda la plataforma, filtrados. Sólo lectura; la query se
 * rearma desde una lista blanca (lib/platform-audit-proxy). Si quien pide es superadmin lo decide el
 * API. Los cuerpos no se registran: llevan correos e IPs.
 */
export async function GET(req: Request): Promise<NextResponse> {
  return forwardRead(adminAuditTarget('list', new URL(req.url).searchParams));
}
