import { NextResponse } from 'next/server';
import { api } from '../../../../../lib/api';

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenantId = new URL(req.url).searchParams.get('tenantId') ?? '';
  const res = await api<unknown>(
    `/pricing/rules/${encodeURIComponent(id)}?tenantId=${encodeURIComponent(tenantId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  return NextResponse.json(res.data);
}
