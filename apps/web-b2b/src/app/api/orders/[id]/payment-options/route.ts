import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../../lib/api';
import { NO_STORE, proxyPaymentOptions } from '../../../../../lib/order-payment-proxy';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reply = await proxyPaymentOptions(id, apiWithStatus);
  return NextResponse.json(reply.body, { status: reply.status, headers: NO_STORE });
}
