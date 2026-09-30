import { NextResponse } from 'next/server';
import { api, apiWithStatus } from '../../../lib/api';
import { proxyOrderCreate } from './order-create-proxy';

export async function GET() {
  const res = await api<{ orders: unknown[] }>('/orders');
  if (!res.ok) return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  return NextResponse.json(res.data);
}

export async function POST(req: Request) {
  const reply = await proxyOrderCreate(req, apiWithStatus);
  return NextResponse.json(reply.body, { status: reply.status });
}
