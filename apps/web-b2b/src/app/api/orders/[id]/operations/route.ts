import { NextResponse } from 'next/server';
import { api } from '../../../../../lib/api';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await api<unknown>(`/orders/${id}/operations`);
  if (!res.ok) {
    return NextResponse.json({ operations: [] }, { status: res.error.status });
  }
  return NextResponse.json(res.data);
}
