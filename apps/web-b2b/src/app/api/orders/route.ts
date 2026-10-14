import { NextResponse } from 'next/server';
import { api, apiWithStatus } from '../../../lib/api';
import { proxyOrderCreate } from './order-create-proxy';

/** La lista lleva datos de pasajeros (enmascarados, pero de personas): ningún caché la guarda. */
const ORDERS_NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET() {
  const res = await api<{ orders: unknown[] }>('/orders');
  if (!res.ok) {
    return NextResponse.json(
      { error: res.error.message },
      { status: res.error.status, headers: ORDERS_NO_STORE },
    );
  }
  return NextResponse.json(res.data, { headers: ORDERS_NO_STORE });
}

export async function POST(req: Request) {
  const reply = await proxyOrderCreate(req, apiWithStatus);
  return NextResponse.json(reply.body, { status: reply.status });
}
