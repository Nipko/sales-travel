import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../../lib/api';
import {
  bookingPermissionsPlan,
  bookingPermissionsReply,
} from '../../../../../lib/booking-permissions';

type Params = { params: Promise<{ tenantId: string }> };

/**
 * "Puede reservar tarifas no reembolsables" de un nodo, que fija quien lo financia (Gestión de
 * Agencias o Mi Red → nodo → Carteras). Si quien pide financia a ese nodo lo decide el API. El
 * cuerpo se rearma con `bookingPermissionsPlan`: lo que el navegador mande de más no viaja, y el
 * motivo no se registra.
 */
async function handle(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId } = await params;
  const body = req.method === 'PUT' ? await req.json().catch(() => undefined) : undefined;
  const plan = bookingPermissionsPlan(tenantId, req.method, body);
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: plan.status });
  const res = await apiWithStatus(plan.path, {
    method: plan.method,
    ...(plan.body === undefined ? {} : { body: JSON.stringify(plan.body) }),
  });
  const reply = bookingPermissionsReply(res);
  return NextResponse.json(reply.body, { status: reply.status });
}

export const GET = handle;
export const PUT = handle;
