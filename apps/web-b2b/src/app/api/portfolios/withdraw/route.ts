import { NextResponse } from 'next/server';
import { api } from '../../../../lib/api';

export async function POST(req: Request) {
  const body = await req.json();
  const idempotencyKey = req.headers.get('idempotency-key');
  const res = await api<any>('/portfolios/withdraw', {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    body: JSON.stringify(body),
  });
  if (!res.ok) return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  return NextResponse.json(res.data);
}
