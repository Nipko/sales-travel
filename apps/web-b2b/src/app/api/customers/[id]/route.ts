import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const body = await req.json();
  const res = await api<any>(`/customers/${params.id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res.ok) return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  return NextResponse.json(res.data);
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const res = await api<any>(`/customers/${params.id}`, {
    method: 'DELETE',
  });
  if (!res.ok) return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  return NextResponse.json(res.data);
}
