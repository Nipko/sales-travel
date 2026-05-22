import { NextResponse } from 'next/server';
import { api } from '../../../../../../lib/api';

export async function POST(req: Request, { params }: { params: { orderId: string } }) {
  const res = await api<any>(`/portfolios/orders/${params.orderId}/approve`, {
    method: 'POST',
  });
  if (!res.ok) return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  return NextResponse.json(res.data);
}
