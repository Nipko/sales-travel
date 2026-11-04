import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../../lib/api';
import { proxyPaymentLink } from '../../../../../lib/order-payment-proxy';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reply = await proxyPaymentLink(req, id, apiWithStatus);
  return NextResponse.json(reply.body, { status: reply.status });
}
