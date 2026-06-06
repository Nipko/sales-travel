import { NextResponse } from 'next/server';
import { api } from '../../../../../lib/api';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get('tenantId') ?? '';
  const res = await api<unknown>(`/tenants/network/users?tenantId=${encodeURIComponent(tenantId)}`);
  if (!res.ok) {
    return NextResponse.json({ users: [] }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
