import { NextResponse } from 'next/server';
import { api } from '../../../lib/api';

export async function GET(req: Request) {
  const tenantId = new URL(req.url).searchParams.get('tenantId') ?? '';
  const res = await api<unknown>(`/invitations?tenantId=${encodeURIComponent(tenantId)}`);
  if (!res.ok) {
    return NextResponse.json({ invitations: [] }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}

export async function POST(req: Request) {
  const body = (await req.json()) as unknown;
  const res = await api<unknown>('/invitations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
