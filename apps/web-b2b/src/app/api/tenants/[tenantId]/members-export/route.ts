import type { NextResponse } from 'next/server';
import { forwardUsersExport } from '../../../../../lib/csv-export-route';
import { teamExportTarget } from '../../../../../lib/tenant-admin-proxy';

type Params = { params: Promise<{ tenantId: string }> };

/**
 * Equipo › Exportar equipo (USR-16): el equipo del nodo en CSV, tal cual lo arma el API. Quién puede
 * (quien administra el nodo) y el 2FA de los últimos minutos los decide el API.
 */
export async function GET(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId } = await params;
  return forwardUsersExport(req, teamExportTarget(tenantId));
}
