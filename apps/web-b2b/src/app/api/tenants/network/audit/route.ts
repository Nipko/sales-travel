import { NextResponse } from 'next/server';
import { api } from '../../../../../lib/api';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get('tenantId') ?? '';
  const limit = url.searchParams.get('limit') ?? '50';
  const res = await api<unknown>(
    `/tenants/network/audit?tenantId=${encodeURIComponent(tenantId)}&limit=${encodeURIComponent(limit)}`,
  );
  if (!res.ok) return NextResponse.json({ events: [] }, { status: res.error.status });
  return NextResponse.json(res.data);
}
