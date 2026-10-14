import type { NextResponse } from 'next/server';
import { circuitResetPlan } from '../../../../../../../lib/provider-enablement-proxy';
import { forwardPlan } from '../../../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ code: string }> };

/** Cierra el circuito abierto de un proveedor, con motivo. Sólo desde el panel (mismo origen). */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { code } = await params;
  const raw: unknown = await req.json().catch(() => undefined);
  return forwardPlan(req, circuitResetPlan(code, raw), 'POST');
}
