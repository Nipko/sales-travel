import { NextResponse } from 'next/server';
import { api } from '../../../../../lib/api';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as Record<string, unknown>;
  const res = await api<{ quotation: unknown }>(`/quotations/${id}/customer`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res.ok) return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  return NextResponse.json(res.data);
}
