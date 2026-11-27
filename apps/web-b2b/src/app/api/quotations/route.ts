import { NextResponse } from 'next/server';
import { api } from '../../../lib/api';
import { listLimitOf } from '../../../lib/list-limit';

export async function GET(req: Request) {
  const limit = listLimitOf(new URL(req.url).searchParams);
  if (limit === null) {
    return NextResponse.json(
      { error: 'El tamaño de la lista tiene que ser de 1 a 1000.' },
      { status: 400 },
    );
  }
  const res = await api<{ quotations: unknown[]; hasMore?: boolean }>(`/quotations?limit=${limit}`);
  if (!res.ok) return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  return NextResponse.json(res.data);
}
