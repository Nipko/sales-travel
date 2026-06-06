import { NextResponse } from 'next/server';
import { api } from '../../../../../lib/api';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await api<unknown>(`/orders/${id}/send-confirmation`, { method: 'POST' });
  if (!res.ok) return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  return NextResponse.json(res.data);
}
