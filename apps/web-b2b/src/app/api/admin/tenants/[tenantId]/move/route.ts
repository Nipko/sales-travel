import { NextResponse } from 'next/server';
import { api } from '../../../../../../lib/api';
import { tenantMovePlan } from '../../../../../../lib/tenant-admin-proxy';

type Params = { params: Promise<{ tenantId: string }> };

/** Mueve un nodo con su subárbol bajo otro padre (D6 A). Sólo superadmin: lo decide el API. */
export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { tenantId } = await params;
  const plan = tenantMovePlan(tenantId, await req.json().catch(() => undefined));
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });

  const res = await api<unknown>(plan.path, { method: 'POST', body: JSON.stringify(plan.body) });
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
