import { NextResponse } from 'next/server';
import { api } from '../../../lib/api';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get('tenantId') ?? '';
  const res = await api<unknown>(`/provider-accounts?tenantId=${encodeURIComponent(tenantId)}`);
  if (!res.ok) {
    return NextResponse.json({ accounts: [] }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}

export async function POST(req: Request) {
  const body = (await req.json()) as unknown;
  const res = await api<unknown>('/provider-accounts', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
