import { NextResponse } from 'next/server';
import { apiWithStatus } from '../../../../../lib/api';
import { proxyTicketVoid } from './void-proxy';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reply = await proxyTicketVoid(id, apiWithStatus);
  return NextResponse.json(reply.body, { status: reply.status });
}
