import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';
import { getActiveTenant } from '../../../../lib/session';

export async function GET() {
  const tenantId = await getActiveTenant();
  if (!tenantId) {
    return NextResponse.json({ logoUrl: null, primaryColor: null, accentColor: null });
  }

  const res = await api<unknown>(`/tenants/${tenantId}/branding`);
  if (!res.ok) {
    return NextResponse.json(
      { logoUrl: null, primaryColor: null, accentColor: null },
      { status: res.error.status },
    );
  }

  return NextResponse.json(res.data);
}

export async function PATCH(req: Request) {
  const tenantId = await getActiveTenant();
  if (!tenantId) {
    return NextResponse.json({ error: 'No tenant' }, { status: 400 });
  }

  const body = await req.text();
  const res = await api<unknown>(`/tenants/${tenantId}/branding`, {
    method: 'PATCH',
    body,
  });

  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }

  return NextResponse.json(res.data);
}
