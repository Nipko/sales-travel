import type { NextResponse } from 'next/server';
import { killSwitchPlan } from '../../../../../../lib/provider-enablement-proxy';
import { forwardPlan } from '../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ code: string }> };

/**
 * Apagado de emergencia de un proveedor para toda la plataforma. Sólo desde el panel (mismo origen)
 * y con el cuerpo rearmado: `{ level, reason, expiresInMinutes }`. Quién puede lo decide el API.
 */
export async function PUT(req: Request, { params }: Params): Promise<NextResponse> {
  const { code } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, killSwitchPlan(code, raw), 'PUT');
}
