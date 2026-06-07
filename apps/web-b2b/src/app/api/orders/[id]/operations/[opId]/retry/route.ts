import { NextResponse } from 'next/server';
import { api } from '../../../../../../../lib/api';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; opId: string }> },
) {
  const { id, opId } = await params;
  const res = await api<unknown>(`/orders/${id}/operations/${opId}/retry`, { method: 'POST' });
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
