import { NextResponse } from 'next/server';
import { api } from '../../../../../lib/api';
import { tenantUpdatePlan } from '../../../../../lib/tenant-admin-proxy';

type Params = { params: Promise<{ tenantId: string }> };

/** Corrige estado, sucursal o tipo de un nodo. Sólo superadmin: lo decide el API. */
export async function PATCH(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId } = await params;
  const plan = tenantUpdatePlan(tenantId, await req.json().catch(() => undefined));
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });

  const res = await api<unknown>(plan.path, { method: 'PATCH', body: JSON.stringify(plan.body) });
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
