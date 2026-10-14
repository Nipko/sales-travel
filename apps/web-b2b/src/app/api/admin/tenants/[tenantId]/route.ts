import type { NextResponse } from 'next/server';
import { tenantUpdatePlan } from '../../../../../lib/tenant-admin-proxy';
import { forwardPlan } from '../../../../../lib/tenant-admin-proxy-route';

type Params = { params: Promise<{ tenantId: string }> };

/**
 * Corrige estado, sucursal o tipo de un nodo; suspender lleva el motivo. Sólo superadmin: lo decide
 * el API. Con el chequeo de origen de las rutas del panel: suspender corta una red entera.
 */
export async function PATCH(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId } = await params;
  return forwardPlan(
    req,
    tenantUpdatePlan(tenantId, await req.json().catch(() => undefined)),
    'PATCH',
  );
}
